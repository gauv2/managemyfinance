import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { activeAccounts } from "../accounts";
import type FinancePlugin from "../main";
import { formatMoney } from "../money";
import { goalCurrentAmount } from "../strategy";
import type { FinancialGoal } from "../types";
import { icon, moneyInput } from "../ui/dom";

/**
 * Create or edit one goal-register row. Kind is fixed at "custom" for anything created here — the
 * three "computed" starter goals (emergency buffer, income-loss reserve, debt-to-zero) are only ever
 * created by the Strategy wizard itself, since their current amount is derived from live account data
 * rather than typed by hand. Opening one of those here still allows editing its name/target/deadline/
 * priority; its tracking mode simply isn't offered as a choice.
 */
export class GoalModal extends FinanceModal {
	private name: string;
	private deadline: string;
	private priority: number;
	private trackingMode: FinancialGoal["trackingMode"];
	private linkedAccountId: string;
	private notes: string;
	private amountField?: ReturnType<typeof moneyInput>;
	private manualAmountField?: ReturnType<typeof moneyInput>;

	constructor(app: App, private plugin: FinancePlugin, private opts: { goal?: FinancialGoal; onSaved?: () => void } = {}) {
		super(app);
		const goal = opts.goal;
		const nextPriority = Math.max(0, ...plugin.store.strategy.goals.map((g) => g.priority)) + 1;

		this.name = goal?.name ?? "";
		this.deadline = goal?.deadline ?? "";
		this.priority = goal?.priority ?? nextPriority;
		this.trackingMode = goal?.trackingMode ?? "manual";
		this.linkedAccountId = goal?.linkedAccountId ?? "";
		this.notes = goal?.notes ?? "";
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
		const isEdit = !!this.opts.goal;
		const isComputed = this.opts.goal?.trackingMode === "computed";

		c.createEl("h3", { text: isEdit ? "Edit goal" : "New goal" });

		const form = c.createDiv({ cls: "fp-form" });

		const nameRow = form.createDiv({ cls: "fp-form-row" });
		nameRow.createEl("label", { text: "Name" });
		const nameInput = nameRow.createEl("input", { type: "text", attr: { placeholder: "e.g. Home deposit" } });
		nameInput.value = this.name;
		nameInput.addEventListener("input", () => (this.name = nameInput.value));

		const amountRow = form.createDiv({ cls: "fp-form-row" });
		amountRow.createEl("label", { text: "Target amount" });
		this.amountField = moneyInput(amountRow.createDiv({ cls: "fp-field-control" }), {
			value: this.opts.goal?.targetAmount,
			currency: this.plugin.settings.baseCurrency ?? "EUR",
			allowNegative: false,
		});

		const deadlineRow = form.createDiv({ cls: "fp-form-row" });
		deadlineRow.createEl("label", { text: "Deadline (optional)" });
		const deadlineInput = deadlineRow.createEl("input", { type: "date" });
		deadlineInput.value = this.deadline;
		deadlineInput.addEventListener("change", () => (this.deadline = deadlineInput.value));

		const priorityRow = form.createDiv({ cls: "fp-form-row" });
		priorityRow.createEl("label", { text: "Priority (lower = higher priority)" });
		const priorityInput = priorityRow.createEl("input", { type: "number", attr: { min: "1", step: "1" } });
		priorityInput.value = String(this.priority);
		priorityInput.addEventListener("input", () => (this.priority = Number(priorityInput.value) || this.priority));

		if (isComputed) {
			c.createDiv({
				cls: "fp-step-desc",
				text: `Current amount is calculated automatically (currently ${formatMoney(goalCurrentAmount(store, this.opts.goal!))}) — this goal follows your reserve or debt payoff plan rather than a number you enter here.`,
			});
		} else {
			const trackingRow = form.createDiv({ cls: "fp-form-row" });
			trackingRow.createEl("label", { text: "Track progress by" });
			const trackingSelect = trackingRow.createEl("select");
			trackingSelect.createEl("option", { text: "Entering it myself", value: "manual" });
			trackingSelect.createEl("option", { text: "Following one of my accounts", value: "account" });
			trackingSelect.value = this.trackingMode;
			trackingSelect.addEventListener("change", () => {
				this.trackingMode = trackingSelect.value as FinancialGoal["trackingMode"];
				this.render();
			});

			if (this.trackingMode === "account") {
				const accountRow = form.createDiv({ cls: "fp-form-row" });
				accountRow.createEl("label", { text: "Account" });
				const accountSelect = accountRow.createEl("select");
				accountSelect.createEl("option", { text: "Choose an account…", value: "" });
				activeAccounts(store.accounts, this.linkedAccountId).forEach((a) => accountSelect.createEl("option", { text: a.name, value: a.id }));
				accountSelect.value = this.linkedAccountId;
				accountSelect.addEventListener("change", () => (this.linkedAccountId = accountSelect.value));
			} else {
				const manualRow = form.createDiv({ cls: "fp-form-row" });
				manualRow.createEl("label", { text: "Current amount" });
				this.manualAmountField = moneyInput(manualRow.createDiv({ cls: "fp-field-control" }), {
					value: this.opts.goal?.manualCurrentAmount,
					currency: this.plugin.settings.baseCurrency ?? "EUR",
					allowNegative: false,
				});
			}
		}

		const notesRow = form.createDiv({ cls: "fp-form-row" });
		notesRow.createEl("label", { text: "Notes (optional)" });
		const notesInput = notesRow.createEl("input", { type: "text", attr: { placeholder: "Optional" } });
		notesInput.value = this.notes;
		notesInput.addEventListener("input", () => (this.notes = notesInput.value));

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		if (isEdit) {
			const deleteBtn = left.createEl("button", { cls: "fp-btn fp-btn-danger" });
			icon(deleteBtn, "trash-2");
			deleteBtn.createSpan({ text: "Delete" });
			deleteBtn.addEventListener("click", async () => {
				store.strategy.goals = store.strategy.goals.filter((g) => g.id !== this.opts.goal!.id);
				await store.saveStrategy();
				new Notice(`Removed "${this.opts.goal!.name}"`);
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
		const targetAmount = this.amountField?.value();

		if (!this.name.trim()) {
			new Notice("Give it a name.");
			return;
		}
		if (targetAmount === undefined || targetAmount <= 0) {
			new Notice("Enter a target amount.");
			return;
		}
		if (this.trackingMode === "account" && !this.linkedAccountId) {
			new Notice("Choose an account to follow.");
			return;
		}

		if (this.opts.goal) {
			Object.assign(this.opts.goal, {
				name: this.name.trim(),
				targetAmount,
				deadline: this.deadline || undefined,
				priority: this.priority,
				trackingMode: this.opts.goal.trackingMode === "computed" ? "computed" : this.trackingMode,
				manualCurrentAmount: this.trackingMode === "manual" ? this.manualAmountField?.value() : undefined,
				linkedAccountId: this.trackingMode === "account" ? this.linkedAccountId : undefined,
				notes: this.notes.trim() || undefined,
			});
		} else {
			store.strategy.goals.push({
				id: `goal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
				name: this.name.trim(),
				targetAmount,
				deadline: this.deadline || undefined,
				priority: this.priority,
				trackingMode: this.trackingMode,
				manualCurrentAmount: this.trackingMode === "manual" ? this.manualAmountField?.value() : undefined,
				linkedAccountId: this.trackingMode === "account" ? this.linkedAccountId : undefined,
				kind: "custom",
				notes: this.notes.trim() || undefined,
				createdAt: new Date().toISOString(),
			});
		}

		await store.saveStrategy();
		new Notice(`Saved "${this.name.trim()}"`);
		this.plugin.refreshViews();
		this.opts.onSaved?.();
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
