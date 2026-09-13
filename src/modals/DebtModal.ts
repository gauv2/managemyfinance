import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { activeAccounts } from "../accounts";
import type FinancePlugin from "../main";
import type { Debt, DebtCounterpartyKind, DebtDirection } from "../types";
import { icon, moneyInput, type MoneyInputHandle } from "../ui/dom";

const KINDS: { value: DebtCounterpartyKind; label: string }[] = [
	{ value: "person", label: "Person" },
	{ value: "company", label: "Company" },
	{ value: "bank", label: "Bank" },
	{ value: "other", label: "Other" },
];

/** Adding or editing one entry in the debts register. */
export class DebtModal extends FinanceModal {
	private counterparty: string;
	private kind: DebtCounterpartyKind;
	private direction: DebtDirection;
	private amount: number | undefined;
	private paid: number | undefined;
	private currency: string;
	private date: string;
	private dueDate: string;
	private notes: string;
	private accountId: string;
	private settled: boolean;
	private amountField!: MoneyInputHandle;
	private paidField!: MoneyInputHandle;

	constructor(app: App, private plugin: FinancePlugin, private existing: Debt | undefined, private onSaved: () => void) {
		super(app);
		this.counterparty = existing?.counterparty ?? "";
		this.kind = existing?.kind ?? "person";
		this.direction = existing?.direction ?? "owe";
		this.amount = existing?.amount;
		this.paid = existing?.paid;
		this.currency = existing?.currency ?? "EUR";
		this.date = existing?.date ?? new Date().toISOString().slice(0, 10);
		this.dueDate = existing?.dueDate ?? "";
		this.notes = existing?.notes ?? "";
		this.accountId = existing?.accountId ?? "";
		this.settled = !!existing?.settledDate;
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		this.contentEl.addClass("fp-account-modal");
		this.render();
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();

		const head = c.createDiv({ cls: "fp-detail-header" });
		const headText = head.createDiv();
		headText.createDiv({ cls: "fp-detail-desc", text: this.existing ? "Edit debt" : "Add a debt" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: "A record of who owes what. Nothing here touches net worth, budgets or any report.",
		});

		const form = c.createDiv({ cls: "fp-form" });

		const dirRow = form.createDiv({ cls: "fp-form-row" });
		dirRow.createEl("label", { text: "Direction" });
		const dirSelect = dirRow.createEl("select");
		dirSelect.createEl("option", { text: "I owe them", value: "owe" });
		dirSelect.createEl("option", { text: "They owe me", value: "owed" });
		dirSelect.value = this.direction;
		dirSelect.addEventListener("change", () => (this.direction = dirSelect.value as DebtDirection));

		const whoRow = form.createDiv({ cls: "fp-form-row" });
		whoRow.createEl("label", { text: "With" });
		const whoControl = whoRow.createDiv({ cls: "fp-field-control" });
		const whoInput = whoControl.createEl("input", { type: "text", attr: { placeholder: "e.g. ABN AMRO, a landlord, a friend" } });
		whoInput.value = this.counterparty;
		whoInput.addEventListener("input", () => (this.counterparty = whoInput.value));
		const kindSelect = whoControl.createEl("select", { cls: "fp-setup-select" });
		KINDS.forEach((k) => kindSelect.createEl("option", { text: k.label, value: k.value }));
		kindSelect.value = this.kind;
		kindSelect.addEventListener("change", () => (this.kind = kindSelect.value as DebtCounterpartyKind));

		const amountRow = form.createDiv({ cls: "fp-form-row" });
		amountRow.createEl("label", { text: "Amount" });
		this.amountField = moneyInput(amountRow, {
			value: this.amount,
			currency: this.currency,
			allowNegative: false,
			onChange: (v) => (this.amount = v),
		});

		const paidRow = form.createDiv({ cls: "fp-form-row" });
		paidRow.createEl("label", { text: "Repaid so far" });
		const paidControl = paidRow.createDiv({ cls: "fp-field-control" });
		this.paidField = moneyInput(paidControl, {
			value: this.paid,
			currency: this.currency,
			allowNegative: false,
			onChange: (v) => (this.paid = v),
		});
		paidControl.createDiv({ cls: "fp-field-hint", text: "Leave blank if nothing has been paid back yet." });

		const dateRow = form.createDiv({ cls: "fp-form-row" });
		dateRow.createEl("label", { text: "Since" });
		const dateInput = dateRow.createEl("input", { type: "date" });
		dateInput.value = this.date;
		dateInput.addEventListener("change", () => (this.date = dateInput.value));

		const dueRow = form.createDiv({ cls: "fp-form-row" });
		dueRow.createEl("label", { text: "Due (optional)" });
		const dueControl = dueRow.createDiv({ cls: "fp-field-control" });
		const dueInput = dueControl.createEl("input", { type: "date" });
		dueInput.value = this.dueDate;
		dueInput.addEventListener("change", () => (this.dueDate = dueInput.value));
		dueControl.createDiv({ cls: "fp-field-hint", text: "Only a due date can make a debt overdue; without one it simply stays open." });

		const accRow = form.createDiv({ cls: "fp-form-row" });
		accRow.createEl("label", { text: "Related account" });
		const accControl = accRow.createDiv({ cls: "fp-field-control" });
		const accSelect = accControl.createEl("select");
		accSelect.createEl("option", { text: "— none —", value: "" });
		activeAccounts(this.plugin.store.accounts, this.accountId).forEach((a) =>
			accSelect.createEl("option", { text: a.name, value: a.id })
		);
		accSelect.value = this.accountId;
		accSelect.addEventListener("change", () => (this.accountId = accSelect.value));
		accControl.createDiv({ cls: "fp-field-hint", text: "A reference only — no balance anywhere moves because of it." });

		const notesRow = form.createDiv({ cls: "fp-form-row" });
		notesRow.createEl("label", { text: "Notes" });
		const notesInput = notesRow.createEl("textarea", { attr: { rows: "2" } });
		notesInput.value = this.notes;
		notesInput.addEventListener("input", () => (this.notes = notesInput.value));

		const settledLabel = form.createEl("label", { cls: "fp-checkbox-row fp-form-inline-check" });
		const settledInput = settledLabel.createEl("input", { type: "checkbox" });
		settledInput.checked = this.settled;
		settledLabel.createSpan({ text: "Settled" });
		settledInput.addEventListener("change", () => (this.settled = settledInput.checked));

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		if (this.existing) {
			const del = left.createEl("button", { cls: "fp-btn fp-btn-ghost" });
			icon(del, "trash-2");
			del.createSpan({ text: "Delete" });
			del.addEventListener("click", () => void this.remove());
		}
		const cancel = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel" });
		cancel.addEventListener("click", () => this.close());

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const save = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(save, "check");
		save.createSpan({ text: this.existing ? "Save debt" : "Add debt" });
		save.addEventListener("click", () => void this.submit());

		whoInput.focus();
	}

	private async submit(): Promise<void> {
		if (!this.counterparty.trim()) {
			new Notice("Say who the debt is with first");
			return;
		}
		if (!this.amountField.isValid() || !this.paidField.isValid()) {
			new Notice("That amount isn't a number I can read");
			return;
		}
		if (!this.amount || this.amount <= 0) {
			new Notice("Give the debt an amount");
			return;
		}

		const store = this.plugin.store;
		const debt: Debt = this.existing ?? {
			id: `debt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			counterparty: "",
			direction: "owe",
			amount: 0,
			currency: this.currency,
			date: this.date,
		};
		debt.counterparty = this.counterparty.trim();
		debt.kind = this.kind;
		debt.direction = this.direction;
		debt.amount = this.amount;
		debt.paid = this.paid && this.paid > 0 ? this.paid : undefined;
		debt.currency = this.currency;
		debt.date = this.date;
		debt.dueDate = this.dueDate || undefined;
		debt.notes = this.notes.trim() || undefined;
		debt.accountId = this.accountId || undefined;
		// Kept as the date it was settled rather than a bare flag, so the register can still say when.
		// Re-opening clears it; an existing date survives so ticking and unticking doesn't rewrite history.
		if (this.settled) debt.settledDate = debt.settledDate ?? new Date().toISOString().slice(0, 10);
		else debt.settledDate = undefined;

		if (!this.existing) store.debts.push(debt);
		await store.saveDebts();
		new Notice(this.existing ? `Updated the debt with ${debt.counterparty}` : `Added a debt with ${debt.counterparty}`);
		this.close();
		this.onSaved();
	}

	private async remove(): Promise<void> {
		if (!this.existing) return;
		const store = this.plugin.store;
		store.debts = store.debts.filter((d) => d.id !== this.existing!.id);
		await store.saveDebts();
		new Notice(`Removed the debt with ${this.existing.counterparty}`);
		this.close();
		this.onSaved();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
