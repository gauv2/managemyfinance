import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { ACCOUNT_TYPE_META, ACCOUNT_TYPE_ORDER, CURRENCIES } from "../constants";
import { accountBalanceParts, type AccountBalanceParts } from "../kpi";
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
 * That sum comes from accountBalanceParts, the same function the dashboard totals go through, because
 * summing it here by hand is how this dialog came to show a different current balance than every other
 * view of the same account. Where a recorded balance exists it supersedes the opening one and the
 * current field goes read-only — the opening balance no longer feeds that total, so back-solving it
 * would rewrite every historical figure while moving nothing you can see.
 *
 * Changing the type is a pure relabel: it changes which dashboard the account gets and how it's
 * treated in transfer detection, and touches no transaction.
 */
export class EditAccountModal extends FinanceModal {
	private name: string;
	private type: AccountType;
	private currency: string;
	private iban: string;
	private openingBalance: number | undefined;

	private openingField!: MoneyInputHandle;
	private currentField!: MoneyInputHandle;
	/** Guards the two balance fields against re-entrantly rewriting each other. */
	private syncing = false;
	private partsCache?: { currency: string; parts: AccountBalanceParts };

	constructor(app: App, private plugin: FinancePlugin, private account: Account, private onSaved?: () => void) {
		super(app);
		this.name = account.name;
		this.type = account.type;
		this.currency = account.currency || "EUR";
		this.iban = account.iban ?? "";
		this.archived = !!account.archived;
		this.trackBalance = account.trackBalance !== false;
		this.openingBalance = account.openingBalance ?? 0;
		this.creditLimit = account.creditLimit;
		this.statementDay = account.statementDay !== undefined ? String(account.statementDay) : "";
		this.paymentDueDay = account.paymentDueDay !== undefined ? String(account.paymentDueDay) : "";
		this.apr = account.apr !== undefined ? String(account.apr) : "";
		this.minPaymentPct = account.minPaymentPct !== undefined ? String(account.minPaymentPct) : "";
	}

	/**
	 * The balance equation's fixed half, straight from the same function the dashboard totals go
	 * through — so this dialog can't quietly disagree with every other view of the same account.
	 * Recomputed only when the currency dropdown moves; the balance fields re-read it on every keystroke.
	 */
	private get balanceParts(): AccountBalanceParts {
		if (!this.partsCache || this.partsCache.currency !== this.currency) {
			this.partsCache = { currency: this.currency, parts: accountBalanceParts(this.plugin.store, this.account.id, this.currency) };
		}
		return this.partsCache.parts;
	}

	/** Everything already imported for this account — the fixed part of the balance equation. */
	private get transactionsTotal(): number {
		return this.balanceParts.movement;
	}

	private get transactionCount(): number {
		return this.balanceParts.counted;
	}

	/** The figure the current-balance field counts up from — a recorded balance outranks the opening one. */
	private get balanceAnchor(): number {
		const { snapshot } = this.balanceParts;
		return snapshot ? snapshot.balance : this.openingBalance ?? 0;
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
			// Foreign rows convert into whichever currency this account is now read in, so the total
			// they add up to moves with the dropdown — not just the symbol in front of it.
			this.syncing = true;
			this.currentField.setValue(this.balanceAnchor + this.transactionsTotal);
			this.syncing = false;
			this.renderBalanceSummary();
		});

		const ibanRow = form.createDiv({ cls: "fp-form-row" });
		ibanRow.createEl("label", { text: "IBAN (optional)" });
		const ibanInput = ibanRow.createEl("input", { type: "text", attr: { placeholder: "Auto-matches combined CSV/Excel exports" } });
		ibanInput.value = this.iban;
		ibanInput.addClass("fp-iban");
		ibanInput.addEventListener("input", () => (this.iban = ibanInput.value));

		const statusRow = form.createDiv({ cls: "fp-form-row" });
		statusRow.createEl("label", { text: "Status" });
		const statusControl = statusRow.createDiv({ cls: "fp-field-control" });
		const archivedLabel = statusControl.createEl("label", { cls: "fp-checkbox-row" });
		const archivedInput = archivedLabel.createEl("input", { type: "checkbox" });
		archivedInput.checked = this.archived;
		archivedLabel.createSpan({ text: "Closed / cancelled" });
		archivedInput.addEventListener("change", () => (this.archived = archivedInput.checked));
		statusControl.createDiv({
			cls: "fp-field-hint",
			text: "Moves the account into a \u201cClosed\u201d group in the sidebar and stops offering it when filing new activity. Every transaction, balance and report stays exactly as it is — ticking this never changes a number.",
		});

		const balanceHeader = form.createDiv({ cls: "fp-form-section-label", text: "Balance" });
		const trackLabel = form.createEl("label", { cls: "fp-checkbox-row fp-form-inline-check" });
		const trackInput = trackLabel.createEl("input", { type: "checkbox" });
		trackInput.checked = !this.trackBalance;
		trackLabel.createSpan({ text: "Don\u2019t track a balance \u2014 register only" });
		const trackHint = form.createDiv({
			cls: "fp-field-hint",
			text: "For an account you keep for its history rather than its balance. It stops counting toward net worth \u2014 left out, not counted as zero \u2014 while its transactions go on feeding spending, budgets, categories and reports exactly as before.",
		});
		// The balance fields are meaningless once the account isn't reconciled, so they go rather than
		// sitting there greyed out inviting you to wonder what they would have done.
		const balanceFields = form.createDiv({ cls: "fp-form-balance-fields" });
		const syncTracking = (): void => {
			balanceFields.toggle(this.trackBalance);
			balanceHeader.setText(this.trackBalance ? "Balance" : "Balance \u2014 not tracked");
		};
		trackInput.addEventListener("change", () => {
			this.trackBalance = !trackInput.checked;
			syncTracking();
		});
		void trackHint;
		syncTracking();

		const openingRow = balanceFields.createDiv({ cls: "fp-form-row" });
		openingRow.createEl("label", { text: "Opening balance" });
		this.openingField = moneyInput(openingRow, {
			value: this.openingBalance,
			currency: this.currency,
			onChange: (v) => {
				if (this.syncing) return;
				this.openingBalance = v;
				this.syncing = true;
				// A recorded balance supersedes the opening one, so with one on file the opening balance
				// no longer moves the current total and writing to that field would be a lie.
				if (!this.balanceParts.snapshot) {
					this.currentField.setValue(v === undefined ? undefined : v + this.transactionsTotal);
				}
				this.syncing = false;
				this.renderBalanceSummary();
			},
		});
		openingRow.createDiv({
			cls: "fp-form-hint",
			text: "What this account held before the first imported transaction.",
		});

		const anchoredTo = this.balanceParts.snapshot;
		const currentRow = balanceFields.createDiv({ cls: "fp-form-row" });
		currentRow.createEl("label", { text: "Current balance" });
		this.currentField = moneyInput(currentRow, {
			value: this.balanceAnchor + this.transactionsTotal,
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
		// Back-solving the opening balance from a total the opening balance doesn't feed would write a
		// number that changes every historical figure and moves nothing you can see, so don't offer it.
		if (anchoredTo) this.currentField.input.disabled = true;
		currentRow.createDiv({
			cls: "fp-form-hint",
			text: anchoredTo
				? `Counted from the balance you recorded on ${anchoredTo.date} — edit that recorded balance to change it.`
				: "Type the figure your bank shows — the opening balance above is adjusted to match.",
		});

		this.summaryEl = balanceFields.createDiv({ cls: "fp-form-balance-summary" });
		this.renderBalanceSummary();

		// Credit terms live on the account because they're facts about the card, not about any
		// transaction — and the credit dashboard can't say anything useful about utilization, a
		// statement or a minimum payment without them.
		this.termsEl = form.createDiv();
		this.renderCreditTerms();
		typeSelect.addEventListener("change", () => this.renderCreditTerms());

		const snapshotRow = balanceFields.createDiv({ cls: "fp-form-row" });
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
	private archived = false;
	private trackBalance = true;

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
		const { snapshot, ignored } = this.balanceParts;
		const anchor = this.balanceAnchor;
		const total = this.transactionsTotal;
		const count = this.transactionCount;

		const line = this.summaryEl.createDiv({ cls: "fp-form-balance-line" });
		line.createSpan({ cls: "fp-money", text: formatMoney(anchor, { currency: this.currency }) });
		line.createSpan({ cls: "fp-form-balance-op", text: total < 0 ? "−" : "+" });
		line.createSpan({ cls: "fp-money", text: formatMoney(Math.abs(total), { currency: this.currency }) });
		line.createSpan({ cls: "fp-form-balance-op", text: "=" });
		line.createSpan({
			cls: "fp-money fp-form-balance-result",
			text: formatMoney(anchor + total, { currency: this.currency }),
		});
		const anchorLabel = snapshot ? `balance recorded on ${snapshot.date}` : "opening balance";
		const since = snapshot ? " since" : " imported";
		this.summaryEl.createDiv({
			cls: "fp-form-hint",
			text: `${anchorLabel} ${total < 0 ? "less" : "plus"} ${count}${since} transaction${count === 1 ? "" : "s"} = current balance`,
		});
		// Rows a total can't honestly include are worth saying out loud rather than leaving as a gap
		// between this figure and the transaction count on the account page.
		if (ignored > 0) {
			this.summaryEl.createDiv({
				cls: "fp-form-hint",
				text: snapshot
					? `${ignored} earlier or undated transaction${ignored === 1 ? "" : "s"} already covered by that recorded balance.`
					: `${ignored} transaction${ignored === 1 ? " has" : "s have"} no readable date and can't be counted.`,
			});
		}
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
		account.archived = this.archived || undefined;
		account.trackBalance = this.trackBalance ? undefined : false;
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
