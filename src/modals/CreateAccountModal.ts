import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { ACCOUNT_TYPE_META, ACCOUNT_TYPE_ORDER } from "../constants";
import type FinancePlugin from "../main";
import type { Account, AccountType } from "../types";
import { icon, moneyInput } from "../ui/dom";

/** Quick "add a container" flow — a new account starts empty; its transactions arrive via the next import. */
export class CreateAccountModal extends FinanceModal {
	private name = "";
	private type: AccountType = "debit";
	private iban = "";
	private openingBalance: number | undefined = 0;
	private trackBalance = true;

	constructor(app: App, private plugin: FinancePlugin, private onCreated?: (account: Account) => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		const c = this.contentEl;
		c.addClass("fp-account-modal");

		c.createEl("h3", { text: "Create account" });
		c.createEl("p", {
			cls: "fp-step-desc",
			text: "A separate container for this account's transactions and totals — e.g. one per card or bank.",
		});

		const form = c.createDiv({ cls: "fp-form" });

		const nameRow = form.createDiv({ cls: "fp-form-row" });
		nameRow.createEl("label", { text: "Name" });
		const nameInput = nameRow.createEl("input", { type: "text", attr: { placeholder: "e.g. Amex Gold" } });
		nameInput.addEventListener("input", () => (this.name = nameInput.value));

		const typeRow = form.createDiv({ cls: "fp-form-row" });
		typeRow.createEl("label", { text: "Type" });
		const typeSelect = typeRow.createEl("select");
		ACCOUNT_TYPE_ORDER.forEach((t) => typeSelect.createEl("option", { text: ACCOUNT_TYPE_META[t].label, value: t }));
		typeSelect.value = this.type;
		// The last four types (property, pension, loan, mortgage) don't behave like the others at all,
		// so the picker says what each one is rather than leaving you to infer it from a word.
		const typeHint = typeRow.createDiv({ cls: "fp-form-hint", text: ACCOUNT_TYPE_META[this.type].desc });
		typeSelect.addEventListener("change", () => {
			this.type = typeSelect.value as AccountType;
			typeHint.setText(ACCOUNT_TYPE_META[this.type].desc);
		});

		const ibanRow = form.createDiv({ cls: "fp-form-row" });
		ibanRow.createEl("label", { text: "IBAN (optional)" });
		const ibanInput = ibanRow.createEl("input", { type: "text", attr: { placeholder: "Auto-matches combined CSV/Excel exports" } });
		ibanInput.addEventListener("input", () => (this.iban = ibanInput.value));

		// Offered at creation, not only in the editor: the accounts most likely to want this are the
		// ones you are adding right now to hold imported history, and being asked for an opening balance
		// you do not have is the moment the tool starts feeling like bookkeeping.
		const trackLabel = form.createEl("label", { cls: "fp-checkbox-row fp-form-inline-check" });
		const trackInput = trackLabel.createEl("input", { type: "checkbox" });
		trackLabel.createSpan({ text: "Don\u2019t track a balance \u2014 register only" });
		form.createDiv({
			cls: "fp-field-hint",
			text: "For an account you keep for its history rather than its balance. It stays out of net worth \u2014 left out, not counted as zero \u2014 while its transactions still feed spending, budgets and reports.",
		});

		const balanceFields = form.createDiv();
		const balRow = balanceFields.createDiv({ cls: "fp-form-row" });
		balRow.createEl("label", { text: "Opening balance" });
		moneyInput(balRow, {
			value: this.openingBalance,
			onChange: (v) => (this.openingBalance = v),
		});
		trackInput.addEventListener("change", () => {
			this.trackBalance = !trackInput.checked;
			balanceFields.toggle(this.trackBalance);
		});

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const cancel = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel" });
		cancel.addEventListener("click", () => this.close());

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const create = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(create, "plus");
		create.createSpan({ text: "Create account" });
		create.addEventListener("click", () => void this.submit());

		nameInput.focus();
	}

	private async submit(): Promise<void> {
		if (!this.name.trim()) {
			new Notice("Give the account a name first");
			return;
		}
		const account: Account = {
			id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			name: this.name.trim(),
			type: this.type,
			currency: "EUR",
			openingBalance: this.trackBalance ? this.openingBalance ?? 0 : 0,
			iban: this.iban.trim() || undefined,
		};
		if (!this.trackBalance) account.trackBalance = false;
		this.plugin.store.accounts.push(account);
		await this.plugin.store.saveAccounts();
		new Notice(`Created account "${account.name}"`);
		this.onCreated?.(account);
		this.plugin.refreshViews();
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
