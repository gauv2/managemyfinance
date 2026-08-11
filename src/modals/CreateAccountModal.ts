import { App, Modal, Notice } from "obsidian";
import { ACCOUNT_TYPE_META } from "../constants";
import type FinancePlugin from "../main";
import type { Account, AccountType } from "../types";
import { icon } from "../ui/dom";

/** Quick "add a container" flow — a new account starts empty; its transactions arrive via the next import. */
export class CreateAccountModal extends Modal {
	private name = "";
	private type: AccountType = "debit";
	private iban = "";
	private openingBalance = "0";

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
		(Object.keys(ACCOUNT_TYPE_META) as AccountType[]).forEach((t) => typeSelect.createEl("option", { text: ACCOUNT_TYPE_META[t].label, value: t }));
		typeSelect.value = this.type;
		typeSelect.addEventListener("change", () => (this.type = typeSelect.value as AccountType));

		const ibanRow = form.createDiv({ cls: "fp-form-row" });
		ibanRow.createEl("label", { text: "IBAN (optional)" });
		const ibanInput = ibanRow.createEl("input", { type: "text", attr: { placeholder: "Auto-matches combined CSV/Excel exports" } });
		ibanInput.addEventListener("input", () => (this.iban = ibanInput.value));

		const balRow = form.createDiv({ cls: "fp-form-row" });
		balRow.createEl("label", { text: "Opening balance" });
		const balInput = balRow.createEl("input", { type: "number", attr: { step: "0.01" } });
		balInput.value = this.openingBalance;
		balInput.addEventListener("input", () => (this.openingBalance = balInput.value));

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
			openingBalance: parseFloat(this.openingBalance) || 0,
			iban: this.iban.trim() || undefined,
		};
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
