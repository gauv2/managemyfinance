import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { ACCOUNT_TYPE_META } from "../constants";
import { netWorth, snapshotAsOf } from "../kpi";
import type FinancePlugin from "../main";
import { formatMoney } from "../money";
import { isLiabilityType, type Account, type BalanceSnapshot } from "../types";
import { icon, moneyInput } from "../ui/dom";

/**
 * Record what an account was actually worth on a date.
 *
 * This is what makes net worth true for everything money doesn't visibly flow through. A pension, a
 * house, a savings account you never export and a brokerage whose market value has drifted far from
 * what you paid all share one problem: their value can't be derived from transactions. Without a
 * recorded balance they sit at whatever opening figure was typed once, unchanged, in every year —
 * which is why an untracked savings account used to make a good saving year look flat.
 *
 * A snapshot supersedes every assumption before its date and lets the transactions after it carry on
 * from there, so recording one occasionally is enough to keep the headline number honest.
 */
export class BalanceSnapshotModal extends FinanceModal {
	private date = new Date().toISOString().slice(0, 10);
	private accountId: string;
	private note = "";

	constructor(
		app: App,
		private plugin: FinancePlugin,
		private opts: { accountId?: string; prefillBalance?: number; prefillNote?: string; onSaved?: () => void } = {}
	) {
		super(app);
		this.accountId = opts.accountId ?? plugin.store.accounts[0]?.id ?? "";
		if (opts.prefillNote) this.note = opts.prefillNote;
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		this.contentEl.addClass("fp-account-modal");
		this.render();
	}

	private account(): Account | undefined {
		return this.plugin.store.accounts.find((a) => a.id === this.accountId);
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();
		const store = this.plugin.store;

		c.createEl("h3", { text: "Record a balance" });
		c.createDiv({
			cls: "fp-step-desc",
			text: "For anything whose value can't be worked out from transactions — a house, a pension, a mortgage, a savings account you don't import, or a brokerage worth more than you put in.",
		});

		if (store.accounts.length === 0) {
			c.createEl("p", { cls: "fp-step-desc", text: "Add an account first." });
			return;
		}

		const form = c.createDiv({ cls: "fp-form" });

		const accountRow = form.createDiv({ cls: "fp-form-row" });
		accountRow.createEl("label", { text: "Account" });
		const accountSelect = accountRow.createEl("select");
		store.accounts.forEach((acc) => {
			const opt = accountSelect.createEl("option", { text: `${acc.name} (${ACCOUNT_TYPE_META[acc.type].label})`, value: acc.id });
			if (acc.id === this.accountId) opt.selected = true;
		});
		accountSelect.addEventListener("change", () => {
			this.accountId = accountSelect.value;
			this.render();
		});

		const account = this.account();
		const liability = account ? isLiabilityType(account.type) : false;

		const dateRow = form.createDiv({ cls: "fp-form-row" });
		dateRow.createEl("label", { text: "As of" });
		const dateInput = dateRow.createEl("input", { type: "date" });
		dateInput.value = this.date;
		dateInput.addEventListener("change", () => (this.date = dateInput.value));

		const balanceRow = form.createDiv({ cls: "fp-form-row" });
		balanceRow.createEl("label", { text: liability ? "Amount owed" : "Balance" });
		const balanceControl = balanceRow.createDiv({ cls: "fp-field-control" });
		const balanceField = moneyInput(balanceControl, {
			currency: account?.currency,
			// Only for the account this was launched pre-filled for — switching the dropdown to a
			// different account shouldn't carry a computed figure over to somewhere it doesn't apply.
			value: this.accountId === this.opts.accountId ? this.opts.prefillBalance : undefined,
			// A debt is entered the way anyone says it out loud — "€240,000 left" — and negated
			// internally. See signedOpeningBalance in kpi.ts.
			allowNegative: !liability,
		});
		balanceControl.createDiv({
			cls: "fp-field-hint",
			text: liability
				? "How much is still owed on this, as a positive number. It counts against your net worth."
				: `In ${account?.currency ?? "the account's currency"}. Transactions dated after this balance are applied on top of it.`,
		});

		const noteRow = form.createDiv({ cls: "fp-form-row" });
		noteRow.createEl("label", { text: "Note" });
		const noteInput = noteRow.createEl("input", { type: "text", attr: { placeholder: "Optional — e.g. \"annual valuation\"" } });
		noteInput.value = this.note;
		noteInput.addEventListener("input", () => (this.note = noteInput.value));

		if (account) {
			const existing = snapshotAsOf(store, account.id, "9999-12-31");
			const current = netWorth(store, account.id);
			c.createDiv({
				cls: "fp-step-desc",
				text: existing
					? `Currently valued at ${formatMoney(current)} — from the balance recorded on ${existing.date}${
							existing.note ? ` (${existing.note})` : ""
					  }, plus everything since.`
					: `Currently valued at ${formatMoney(current)}, from its opening balance and transactions alone.`,
			});
		}

		const history = store.snapshots.filter((s) => s.accountId === this.accountId).sort((a, b) => b.date.localeCompare(a.date));
		if (history.length > 0) {
			c.createEl("h4", { text: "Recorded balances" });
			const wrap = c.createDiv({ cls: "fp-table-scroll" });
			const table = wrap.createEl("table", { cls: "fp-table" });
			const headRow = table.createEl("thead").createEl("tr");
			["Date", "Balance", "Note", ""].forEach((h) => headRow.createEl("th", { text: h }));
			const tbody = table.createEl("tbody");
			history.forEach((snap) => {
				const tr = tbody.createEl("tr");
				tr.createEl("td", { text: snap.date });
				tr.createEl("td", { cls: "fp-table-num fp-money", text: formatMoney(snap.balance, { currency: account?.currency }) });
				tr.createEl("td", { text: snap.note ?? "" });
				const cell = tr.createEl("td");
				const removeBtn = cell.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
				icon(removeBtn, "trash-2");
				removeBtn.setAttribute("title", "Remove this recorded balance");
				removeBtn.addEventListener("click", async () => {
					store.snapshots = store.snapshots.filter((s) => s.id !== snap.id);
					await store.saveSnapshots();
					this.plugin.refreshViews();
					this.opts.onSaved?.();
					this.render();
				});
			});
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const cancelBtn = right.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Close" });
		cancelBtn.addEventListener("click", () => this.close());
		const saveBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(saveBtn, "check");
		saveBtn.createSpan({ text: "Record balance" });
		saveBtn.addEventListener("click", async () => {
			const balance = balanceField.value();
			if (balance === undefined) {
				new Notice("Enter a balance.");
				return;
			}
			if (!this.accountId || !this.date) {
				new Notice("Pick an account and a date.");
				return;
			}

			// One balance per account per date: recording again for the same day is a correction, not a
			// second opinion, so it replaces rather than stacking two answers the reader has to pick from.
			const snapshot: BalanceSnapshot = {
				id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
				accountId: this.accountId,
				date: this.date,
				balance,
				note: this.note.trim() || undefined,
			};
			store.snapshots = store.snapshots.filter((s) => !(s.accountId === this.accountId && s.date === this.date));
			store.snapshots.push(snapshot);
			await store.saveSnapshots();

			new Notice(`Balance recorded for ${this.account()?.name ?? "account"}`);
			this.plugin.refreshViews();
			this.opts.onSaved?.();
			this.render();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
