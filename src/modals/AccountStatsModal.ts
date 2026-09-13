import { App } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { accountStats, allAccountStats, orphanedTransactions, type AccountStats } from "../accountStats";
import { tracksBalance } from "../accounts";
import { ACCOUNT_TYPE_META } from "../constants";
import type FinancePlugin from "../main";
import { formatMoney } from "../money";
import type { Account } from "../types";
import { badge, icon } from "../ui/dom";

/**
 * What an account holds, and how every account compares.
 *
 * The questions this answers all come from the same place: importing history one statement at a time
 * and losing track of what has actually landed. Which period is covered, whether there is a hole in
 * the middle of it, how much is still unfiled, how many payees are in there. A balance cannot say any
 * of that, and until now neither could anything else.
 *
 * One dialog serves both the per-account and the overall case, because they are the same figures at
 * two zoom levels and keeping them in two places is how they end up disagreeing.
 */
export class AccountStatsModal extends FinanceModal {
	constructor(app: App, private plugin: FinancePlugin, private accountId?: string) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal", "fp-stats-modal");
		this.render();
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();
		const store = this.plugin.store;
		const account = this.accountId ? store.accounts.find((a) => a.id === this.accountId) : undefined;

		const head = c.createDiv({ cls: "fp-detail-header" });
		const headText = head.createDiv();
		headText.createDiv({ cls: "fp-detail-desc", text: account ? account.name : "Data coverage" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: account
				? "What this account holds — the period covered and how much of it is filed."
				: "What each account holds, and the period it covers.",
		});

		if (account) this.renderDetail(c, account, accountStats(store.transactions, account.id));
		this.renderTable(c, !!account);
		this.renderOrphans(c);

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const close = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(close, "check");
		close.createSpan({ text: "Close" });
		close.addEventListener("click", () => this.close());
	}

	private renderDetail(c: HTMLElement, account: Account, s: AccountStats): void {
		const grid = c.createDiv({ cls: "fp-stats-grid" });

		const stat = (label: string, value: string, hint?: string): void => {
			const cell = grid.createDiv({ cls: "fp-stats-cell" });
			cell.createDiv({ cls: "fp-stats-value", text: value });
			cell.createDiv({ cls: "fp-stats-label", text: label });
			if (hint) cell.createDiv({ cls: "fp-stats-hint", text: hint });
		};

		stat("Transactions", s.transactions.toLocaleString(), s.undated > 0 ? `${s.undated} with no date` : undefined);
		stat(
			"Covered",
			s.firstDate && s.lastDate ? `${s.firstDate} → ${s.lastDate}` : "Nothing dated",
			// The gap between the two is the shape of a missing statement, so both are shown rather
			// than a single "months of history" that would hide it.
			s.monthsSpanned > 0 ? `${s.monthsWithActivity} of ${s.monthsSpanned} months have activity` : undefined
		);
		stat("Payees", s.uniqueMerchants.toLocaleString(), "distinct merchant keys");
		stat(
			"Filed",
			s.transactions > 0 ? `${Math.round((s.categorized / s.transactions) * 100)}%` : "—",
			s.uncategorized > 0 ? `${s.uncategorized.toLocaleString()} still uncategorized` : "everything categorized"
		);

		const currency = s.currencies.length === 1 ? s.currencies[0] : account.currency || "EUR";
		stat("Money in", formatMoney(s.moneyIn, { currency }));
		stat("Money out", formatMoney(s.moneyOut, { currency }));

		const meta = c.createDiv({ cls: "fp-stats-meta" });
		meta.createSpan({ text: ACCOUNT_TYPE_META[account.type].label });
		if (account.archived) badge(meta, "Closed", "neutral");
		if (!tracksBalance(account)) badge(meta, "Register only \u2014 no balance tracked", "neutral");
		if (account.iban) meta.createSpan({ cls: "fp-sensitive", text: account.iban });
		if (s.sources.length > 0) meta.createSpan({ text: `imported from ${s.sources.join(", ")}` });
		if (s.currencies.length > 1) {
			// Totals in mixed currencies are added up as raw numbers here; saying so beats quietly
			// presenting a sum of euros and dollars as if it meant something.
			badge(meta, `${s.currencies.length} currencies — totals not converted`, "warn");
		}
	}

	private renderTable(c: HTMLElement, hasDetail: boolean): void {
		const store = this.plugin.store;
		if (store.accounts.length === 0) return;
		if (hasDetail) c.createDiv({ cls: "fp-form-section-label", text: "Every account" });

		const stats = allAccountStats(store.transactions, store.accounts);
		const wrap = c.createDiv({ cls: "fp-table-scroll" });
		const table = wrap.createEl("table", { cls: "fp-table" });
		const headRow = table.createEl("thead").createEl("tr");
		["Account", "Covered", "Transactions", "Payees", "Unfiled"].forEach((h, i) =>
			headRow.createEl("th", { text: h, cls: i >= 2 ? "fp-table-num" : "" })
		);

		const tbody = table.createEl("tbody");
		store.accounts.forEach((account, i) => {
			const s = stats[i];
			const tr = tbody.createEl("tr", { cls: account.id === this.accountId ? "is-selected" : "" });
			const nameCell = tr.createEl("td");
			nameCell.createSpan({ text: account.name });
			if (account.archived) badge(nameCell, "Closed", "neutral");
			tr.createEl("td", {
				cls: "fp-cell-date",
				text: s.firstDate && s.lastDate ? `${s.firstDate} → ${s.lastDate}` : "—",
			});
			tr.createEl("td", { cls: "fp-table-num", text: s.transactions.toLocaleString() });
			tr.createEl("td", { cls: "fp-table-num", text: s.uniqueMerchants.toLocaleString() });
			tr.createEl("td", { cls: "fp-table-num", text: s.uncategorized > 0 ? s.uncategorized.toLocaleString() : "—" });
		});
	}

	/** Rows whose account was deleted out from under them — invisible everywhere else. */
	private renderOrphans(c: HTMLElement): void {
		const store = this.plugin.store;
		const orphans = orphanedTransactions(store.transactions, store.accounts);
		if (orphans.length === 0) return;
		const row = c.createDiv({ cls: "fp-stats-orphans" });
		badge(row, `${orphans.length.toLocaleString()} transactions belong to an account that no longer exists`, "warn");
		row.createDiv({
			cls: "fp-field-hint",
			text: "They still count toward every total. Deleting an account leaves its transactions behind — recreating an account with the same id, or deleting these rows from the ledger, are the two ways out.",
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
