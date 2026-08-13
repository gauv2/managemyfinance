import { App, Modal, Notice } from "obsidian";
import { ACCOUNT_TYPE_META, ACCOUNT_TYPE_ORDER, CURRENCIES } from "../constants";
import type FinancePlugin from "../main";
import { formatMoney, parseMoney } from "../money";
import type { Account, AccountType } from "../types";
import { icon, moneyInput, type MoneyInputHandle } from "../ui/dom";

/** A 1–31 day of the month, or undefined when the field is blank or nonsense. */
function dayOfMonth(raw: string): number | undefined {
	const n = parseInt(raw.trim(), 10);
	return isNaN(n) || n < 1 || n > 31 ? undefined : n;
}

/** A rate entered as a fraction (0.1999 = 19.99%). Values above 1 are read as percentages typed by
 *  someone who thought in percent — "19.99" clearly isn't a 1999% APR. */
function fraction(raw: string): number | undefined {
	const n = parseMoney(raw);
	if (n === undefined || n < 0) return undefined;
	return n > 1 ? n / 100 : n;
}

/**
 * Edits an account after the fact — including its type, which was previously fixed at creation and
 * could only be changed by deleting the account (and every card attached to it) and re-importing.
 *
 * The balance half of this dialog exists because an account's stored number is its *opening* balance,
 * while the number you can actually check against your bank is the *current* one. Rather than make
 * you do that subtraction yourself, both are editable and each recomputes the other live:
 *
 *     opening balance + sum of imported transactions = current balance
 *
 * Changing the type is a pure relabel: it changes which dashboard the account gets and how it's
 * treated in transfer detection, and touches no transaction.
 */
export class EditAccountModal extends Modal {
	private name: string;
	private type: AccountType;
	private currency: string;
	private iban: string;
	private openingBalance: number | undefined;

	private openingField!: MoneyInputHandle;
	private currentField!: MoneyInputHandle;
	/** Guards the two balance fields against re-entrantly rewriting each other. */
	private syncing = false;

	constructor(app: App, private plugin: FinancePlugin, private account: Account, private onSaved?: () => void) {
		super(app);
		this.name = account.name;
		this.type = account.type;
		this.currency = account.currency || "EUR";
		this.iban = account.iban ?? "";
		this.openingBalance = account.openingBalance ?? 0;
		this.creditLimit = account.creditLimit;
		this.statementDay = account.statementDay !== undefined ? String(account.statementDay) : "";
		this.paymentDueDay = account.paymentDueDay !== undefined ? String(account.paymentDueDay) : "";
		this.apr = account.apr !== undefined ? String(account.apr) : "";
		this.minPaymentPct = account.minPaymentPct !== undefined ? String(account.minPaymentPct) : "";
	}

	/** Everything already imported for this account — the fixed part of the balance equation. */
	private get transactionsTotal(): number {
		return this.plugin.store.transactions.filter((t) => t.accountId === this.account.id).reduce((sum, t) => sum + t.amount, 0);
	}

	private get transactionCount(): number {
		return this.plugin.store.transactions.filter((t) => t.accountId === this.account.id).length;
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		const c = this.contentEl;
		c.addClass("fp-account-modal");

		c.createEl("h3", { text: `Edit "${this.account.name}"` });
		c.createEl("p", {
			cls: "fp-step-desc",
			text: "Changing the type or currency only changes how this account is presented and totalled — no transaction is altered or moved.",
		});

		const form = c.createDiv({ cls: "fp-form" });

		const nameRow = form.createDiv({ cls: "fp-form-row" });
		nameRow.createEl("label", { text: "Name" });
		const nameInput = nameRow.createEl("input", { type: "text" });
		nameInput.value = this.name;
		nameInput.addEventListener("input", () => (this.name = nameInput.value));

		const typeRow = form.createDiv({ cls: "fp-form-row" });
		typeRow.createEl("label", { text: "Type" });
		const typeSelect = typeRow.createEl("select");
		ACCOUNT_TYPE_ORDER.forEach((t) => typeSelect.createEl("option", { text: ACCOUNT_TYPE_META[t].label, value: t }));
		typeSelect.value = this.type;
		const typeHint = typeRow.createDiv({ cls: "fp-form-hint" });
		const describeType = (): void =>
			typeHint.setText(
				this.type === this.account.type
					? `Currently a ${ACCOUNT_TYPE_META[this.account.type].label.toLowerCase()} account.`
					: `Will switch from ${ACCOUNT_TYPE_META[this.account.type].label} to ${ACCOUNT_TYPE_META[this.type].label} — this account's page will show the ${ACCOUNT_TYPE_META[this.type].label.toLowerCase()} dashboard instead.`
			);
		typeSelect.addEventListener("change", () => {
			this.type = typeSelect.value as AccountType;
			describeType();
		});
		describeType();

		const currencyRow = form.createDiv({ cls: "fp-form-row" });
		currencyRow.createEl("label", { text: "Currency" });
		const currencySelect = currencyRow.createEl("select");
		CURRENCIES.forEach((code) => currencySelect.createEl("option", { text: code, value: code }));
		if (!CURRENCIES.includes(this.currency)) currencySelect.createEl("option", { text: this.currency, value: this.currency });
		currencySelect.value = this.currency;
		currencySelect.addEventListener("change", () => {
			this.currency = currencySelect.value;
			this.openingField.setCurrency(this.currency);
			this.currentField.setCurrency(this.currency);
			this.renderBalanceSummary();
		});

		const ibanRow = form.createDiv({ cls: "fp-form-row" });
		ibanRow.createEl("label", { text: "IBAN (optional)" });
		const ibanInput = ibanRow.createEl("input", { type: "text", attr: { placeholder: "Auto-matches combined CSV/Excel exports" } });
		ibanInput.value = this.iban;
		ibanInput.addClass("fp-iban");
		ibanInput.addEventListener("input", () => (this.iban = ibanInput.value));

		form.createDiv({ cls: "fp-form-section-label", text: "Balance" });

		const openingRow = form.createDiv({ cls: "fp-form-row" });
		openingRow.createEl("label", { text: "Opening balance" });
		this.openingField = moneyInput(openingRow, {
			value: this.openingBalance,
			currency: this.currency,
			onChange: (v) => {
				if (this.syncing) return;
				this.openingBalance = v;
				this.syncing = true;
				this.currentField.setValue(v === undefined ? undefined : v + this.transactionsTotal);
				this.syncing = false;
				this.renderBalanceSummary();
			},
		});
		openingRow.createDiv({
			cls: "fp-form-hint",
			text: "What this account held before the first imported transaction.",
		});

		const currentRow = form.createDiv({ cls: "fp-form-row" });
		currentRow.createEl("label", { text: "Current balance" });
		this.currentField = moneyInput(currentRow, {
			value: (this.openingBalance ?? 0) + this.transactionsTotal,
			currency: this.currency,
			onChange: (v) => {
				if (this.syncing) return;
				// Type what your bank actually shows and the opening balance is back-computed to match,
				// which is the usual case when only part of the history has been imported.
				this.openingBalance = v === undefined ? undefined : v - this.transactionsTotal;
				this.syncing = true;
				this.openingField.setValue(this.openingBalance);
				this.syncing = false;
				this.renderBalanceSummary();
			},
		});
		currentRow.createDiv({
			cls: "fp-form-hint",
			text: "Type the figure your bank shows — the opening balance above is adjusted to match.",
		});

		this.summaryEl = form.createDiv({ cls: "fp-form-balance-summary" });
		this.renderBalanceSummary();

		// Credit terms live on the account because they're facts about the card, not about any
		// transaction — and the credit dashboard can't say anything useful about utilization, a
		// statement or a minimum payment without them.
		this.termsEl = form.createDiv();
		this.renderCreditTerms();
		typeSelect.addEventListener("change", () => this.renderCreditTerms());

		const snapshotRow = form.createDiv({ cls: "fp-form-row" });
		snapshotRow.createEl("label", { text: "Recorded balances" });
		const snapshotControl = snapshotRow.createDiv({ cls: "fp-field-control" });
		const snapshotCount = this.plugin.store.snapshots.filter((sn) => sn.accountId === this.account.id).length;
		const snapshotBtn = snapshotControl.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(snapshotBtn, "scale");
		snapshotBtn.createSpan({ text: snapshotCount > 0 ? `${snapshotCount} recorded — manage` : "Record a balance" });
		snapshotBtn.addEventListener("click", () => {
			this.close();
			this.plugin.openBalanceSnapshot(this.account.id);
		});
		snapshotControl.createDiv({
			cls: "fp-field-hint",
			text: "For an account whose value can't be worked out from transactions. A recorded balance supersedes the opening balance above from its date onwards.",
		});

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const cancel = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel" });
		cancel.addEventListener("click", () => this.close());

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const save = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(save, "check");
		save.createSpan({ text: "Save changes" });
		save.addEventListener("click", () => void this.submit());

		nameInput.focus();
	}

	private summaryEl!: HTMLElement;
	private termsEl!: HTMLElement;
	private creditLimit: number | undefined;
	private statementDay = "";
	private paymentDueDay = "";
	private apr = "";
	private minPaymentPct = "";

	/** Credit-card terms — rendered only for a credit account, and re-rendered if the type changes. */
	private renderCreditTerms(): void {
		if (!this.termsEl) return;
		this.termsEl.empty();
		if (this.type !== "credit") return;

		this.termsEl.createDiv({ cls: "fp-form-section-label", text: "Card terms" });

		const limitRow = this.termsEl.createDiv({ cls: "fp-form-row" });
		limitRow.createEl("label", { text: "Credit limit" });
		moneyInput(limitRow, {
			value: this.creditLimit,
			currency: this.currency,
			allowNegative: false,
			onChange: (v) => (this.creditLimit = v),
		});

		const numberField = (label: string, value: string, hint: string, onChange: (v: string) => void): void => {
			const row = this.termsEl.createDiv({ cls: "fp-form-row" });
			row.createEl("label", { text: label });
			const control = row.createDiv({ cls: "fp-field-control" });
			const input = control.createEl("input", { type: "text", attr: { inputmode: "decimal", autocomplete: "off" } });
			input.value = value;
			input.addEventListener("input", () => onChange(input.value));
			control.createDiv({ cls: "fp-field-hint", text: hint });
		};

		numberField("Statement day", this.statementDay, "Day of the month the statement closes, 1–31.", (v) => (this.statementDay = v));
		numberField("Payment due day", this.paymentDueDay, "Day of the month payment is due, 1–31.", (v) => (this.paymentDueDay = v));
		numberField("APR", this.apr, "As a fraction — 0.1999 means 19.99%. Used to show what carrying a balance costs.", (v) => (this.apr = v));
		numberField("Minimum payment", this.minPaymentPct, "Fraction of the statement balance — 0.02 means 2%.", (v) => (this.minPaymentPct = v));
	}

	/** Spells the balance equation out in full, so a back-computed opening balance is never a mystery. */
	private renderBalanceSummary(): void {
		if (!this.summaryEl) return;
		this.summaryEl.empty();
		const opening = this.openingBalance ?? 0;
		const total = this.transactionsTotal;
		const count = this.transactionCount;

		const line = this.summaryEl.createDiv({ cls: "fp-form-balance-line" });
		line.createSpan({ cls: "fp-money", text: formatMoney(opening, { currency: this.currency }) });
		line.createSpan({ cls: "fp-form-balance-op", text: total < 0 ? "−" : "+" });
		line.createSpan({ cls: "fp-money", text: formatMoney(Math.abs(total), { currency: this.currency }) });
		line.createSpan({ cls: "fp-form-balance-op", text: "=" });
		line.createSpan({
			cls: "fp-money fp-form-balance-result",
			text: formatMoney(opening + total, { currency: this.currency }),
		});
		this.summaryEl.createDiv({
			cls: "fp-form-hint",
			text: `opening balance ${total < 0 ? "less" : "plus"} ${count} imported transaction${count === 1 ? "" : "s"} = current balance`,
		});
	}

	private async submit(): Promise<void> {
		if (!this.name.trim()) {
			new Notice("Give the account a name first");
			return;
		}
		if (!this.openingField.isValid() || !this.currentField.isValid()) {
			new Notice("That balance isn't a number I can read — check the amount fields.");
			return;
		}

		const account = this.plugin.store.accounts.find((a) => a.id === this.account.id);
		if (!account) {
			new Notice("That account no longer exists.");
			this.close();
			return;
		}

		const typeChanged = account.type !== this.type;
		account.name = this.name.trim();
		account.type = this.type;
		account.currency = this.currency;
		account.iban = this.iban.trim() || undefined;
		account.openingBalance = this.openingBalance ?? 0;

		// Card terms are only meaningful on a credit account; switching an account away from credit
		// clears them rather than leaving a stale limit attached to a savings account.
		if (this.type === "credit") {
			account.creditLimit = this.creditLimit;
			account.statementDay = dayOfMonth(this.statementDay);
			account.paymentDueDay = dayOfMonth(this.paymentDueDay);
			account.apr = fraction(this.apr);
			account.minPaymentPct = fraction(this.minPaymentPct);
		} else {
			delete account.creditLimit;
			delete account.statementDay;
			delete account.paymentDueDay;
			delete account.apr;
			delete account.minPaymentPct;
		}

		await this.plugin.store.saveAccounts();
		new Notice(
			typeChanged
				? `Updated "${account.name}" — now a ${ACCOUNT_TYPE_META[this.type].label.toLowerCase()} account`
				: `Updated "${account.name}"`
		);
		this.onSaved?.();
		this.plugin.refreshViews();
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
