import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { oneOffBudgetStatus } from "../budgets";
import { primaryCategories } from "../categories";
import type FinancePlugin from "../main";
import { formatMoney } from "../money";
import type { OneOffBudget } from "../types";
import { icon, moneyInput } from "../ui/dom";

/**
 * Create or edit a one-off budget: a named pot for one specific plan over one specific window.
 *
 * The category scope is deliberately optional and multi-select. A holiday isn't one category — it's
 * flights, hotels, restaurants and a few taxis — and a renovation isn't either. Restricting to a set
 * of categories is what makes the pot measurable without needing a category invented per project.
 */
export class OneOffBudgetModal extends FinanceModal {
	private name: string;
	private startDate: string;
	private endDate: string;
	private notes: string;
	private categoryIds: Set<string>;
	private amountField?: ReturnType<typeof moneyInput>;

	constructor(app: App, private plugin: FinancePlugin, private opts: { budget?: OneOffBudget; onSaved?: () => void } = {}) {
		super(app);
		const budget = opts.budget;
		const today = new Date();
		const inThreeMonths = new Date(today);
		inThreeMonths.setMonth(inThreeMonths.getMonth() + 3);

		this.name = budget?.name ?? "";
		this.startDate = budget?.startDate ?? today.toISOString().slice(0, 10);
		this.endDate = budget?.endDate ?? inThreeMonths.toISOString().slice(0, 10);
		this.notes = budget?.notes ?? "";
		this.categoryIds = new Set(budget?.categoryIds ?? []);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		this.contentEl.addClass("fp-account-modal");
		this.render();
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();
		const store = this.plugin.store;
		const isEdit = !!this.opts.budget;

		c.createEl("h3", { text: isEdit ? "Edit one-off budget" : "New one-off budget" });
		c.createDiv({
			cls: "fp-step-desc",
			text: "Tracked on its own, over its own dates — it never eats into the monthly envelopes it spends through, so both readings stay true.",
		});

		const form = c.createDiv({ cls: "fp-form" });

		const nameRow = form.createDiv({ cls: "fp-form-row" });
		nameRow.createEl("label", { text: "Name" });
		const nameInput = nameRow.createEl("input", { type: "text", attr: { placeholder: "e.g. Japan trip" } });
		nameInput.value = this.name;
		nameInput.addEventListener("input", () => (this.name = nameInput.value));

		const amountRow = form.createDiv({ cls: "fp-form-row" });
		amountRow.createEl("label", { text: "Budget" });
		this.amountField = moneyInput(amountRow.createDiv({ cls: "fp-field-control" }), {
			value: this.opts.budget?.amount,
			currency: this.plugin.settings.baseCurrency ?? "EUR",
			allowNegative: false,
		});

		const startRow = form.createDiv({ cls: "fp-form-row" });
		startRow.createEl("label", { text: "From" });
		const startInput = startRow.createEl("input", { type: "date" });
		startInput.value = this.startDate;
		startInput.addEventListener("change", () => (this.startDate = startInput.value));

		const endRow = form.createDiv({ cls: "fp-form-row" });
		endRow.createEl("label", { text: "To" });
		const endInput = endRow.createEl("input", { type: "date" });
		endInput.value = this.endDate;
		endInput.addEventListener("change", () => (this.endDate = endInput.value));

		const notesRow = form.createDiv({ cls: "fp-form-row" });
		notesRow.createEl("label", { text: "Notes" });
		const notesInput = notesRow.createEl("input", { type: "text", attr: { placeholder: "Optional" } });
		notesInput.value = this.notes;
		notesInput.addEventListener("input", () => (this.notes = notesInput.value));

		c.createEl("h4", { text: "Which spending counts" });
		c.createDiv({
			cls: "fp-step-desc",
			text:
				this.categoryIds.size === 0
					? "Nothing selected — every expense inside the dates counts toward this budget."
					: `${this.categoryIds.size} categor${this.categoryIds.size === 1 ? "y" : "ies"} selected. Transactions in their subcategories count too.`,
		});

		const chips = c.createDiv({ cls: "fp-category-chips" });
		primaryCategories(store.categories.filter((cat) => !cat.archived)).forEach((cat) => {
			const selected = this.categoryIds.has(cat.id);
			const chip = chips.createEl("button", { cls: "fp-rule-suggestion" + (selected ? " is-active" : "") });
			chip.style.setProperty("--fp-chip-color", cat.color);
			icon(chip, cat.icon, "fp-chip-icon");
			chip.createSpan({ text: cat.name });
			chip.addEventListener("click", () => {
				if (selected) this.categoryIds.delete(cat.id);
				else this.categoryIds.add(cat.id);
				this.render();
			});
		});

		if (this.opts.budget) {
			const status = oneOffBudgetStatus(store, this.opts.budget);
			c.createDiv({
				cls: "fp-step-desc",
				text: `So far: ${formatMoney(status.spent)} of ${formatMoney(status.budget)} across ${status.transactionCount} transaction${
					status.transactionCount === 1 ? "" : "s"
				}.`,
			});
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		if (isEdit) {
			const deleteBtn = left.createEl("button", { cls: "fp-btn fp-btn-danger" });
			icon(deleteBtn, "trash-2");
			deleteBtn.createSpan({ text: "Delete" });
			deleteBtn.addEventListener("click", async () => {
				store.oneOffBudgets = store.oneOffBudgets.filter((b) => b.id !== this.opts.budget!.id);
				await store.saveOneOffBudgets();
				new Notice(`Removed "${this.opts.budget!.name}"`);
				this.plugin.refreshViews();
				this.opts.onSaved?.();
				this.close();
			});
		}

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const cancelBtn = right.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
		const saveBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(saveBtn, "check");
		saveBtn.createSpan({ text: isEdit ? "Save" : "Create" });
		saveBtn.addEventListener("click", () => void this.save());
	}

	private async save(): Promise<void> {
		const store = this.plugin.store;
		const amount = this.amountField?.value();

		if (!this.name.trim()) {
			new Notice("Give it a name.");
			return;
		}
		if (amount === undefined || amount <= 0) {
			new Notice("Enter how much you're planning to spend.");
			return;
		}
		if (this.endDate < this.startDate) {
			new Notice("The end date is before the start date.");
			return;
		}

		const categoryIds = Array.from(this.categoryIds);
		if (this.opts.budget) {
			Object.assign(this.opts.budget, {
				name: this.name.trim(),
				amount,
				startDate: this.startDate,
				endDate: this.endDate,
				notes: this.notes.trim() || undefined,
				categoryIds: categoryIds.length > 0 ? categoryIds : undefined,
			});
		} else {
			store.oneOffBudgets.push({
				id: `oneoff-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
				name: this.name.trim(),
				amount,
				startDate: this.startDate,
				endDate: this.endDate,
				notes: this.notes.trim() || undefined,
				categoryIds: categoryIds.length > 0 ? categoryIds : undefined,
			});
		}

		await store.saveOneOffBudgets();
		new Notice(`Saved "${this.name.trim()}"`);
		this.plugin.refreshViews();
		this.opts.onSaved?.();
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
