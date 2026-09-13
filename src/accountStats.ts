import { merchantKey } from "./import/merchantKey";
import type { Account, Transaction } from "./types";

/**
 * What an account actually holds — the question "have I imported everything?" turned into numbers.
 *
 * Coverage, not performance. A balance tells you where an account stands; none of the figures here
 * do. They answer the questions you ask while importing years of statements one file at a time: what
 * period is covered, is there a gap in the middle, how much of it is filed, and how much of it is
 * still a wall of merchants the plugin has never seen. A closed account being brought in from 2014
 * has no other way to say "you have 2014 through 2019 and nothing since".
 */
export interface AccountStats {
	accountId: string;
	transactions: number;
	/** ISO dates of the first and last *dated* row. Undefined when the account has none. */
	firstDate?: string;
	lastDate?: string;
	/** Rows whose date never parsed — they still count in every total, so they are reported, not hidden. */
	undated: number;
	/** Calendar months between first and last date inclusive, and how many of them hold a row. A gap
	 *  between the two is the shape of a missing statement. */
	monthsSpanned: number;
	monthsWithActivity: number;
	/** Distinct `merchantKey`s — the same identity merchant memory files against, so this is "how many
	 *  payees the plugin is tracking here", not "how many shops". Branch numbers collapse; city names
	 *  do not, because merchantKey under-merges on purpose. */
	uniqueMerchants: number;
	categorized: number;
	uncategorized: number;
	/** Signed sums, in each transaction's own currency — no FX, since this is about what is *there*. */
	moneyIn: number;
	moneyOut: number;
	/** Distinct import sources seen on these rows, e.g. "revolut", "knab". */
	sources: string[];
	/** Distinct currencies seen. More than one means the totals above are not comparable. */
	currencies: string[];
}

function monthKey(date: string): string {
	return date.slice(0, 7);
}

/** Whole months from `from` to `to` inclusive; 0 when either is missing. */
function monthsBetween(from: string | undefined, to: string | undefined): number {
	if (!from || !to) return 0;
	const [fy, fm] = from.slice(0, 7).split("-").map(Number);
	const [ty, tm] = to.slice(0, 7).split("-").map(Number);
	if (!fy || !fm || !ty || !tm) return 0;
	return (ty - fy) * 12 + (tm - fm) + 1;
}

export function accountStats(transactions: Transaction[], accountId: string): AccountStats {
	const rows = transactions.filter((t) => t.accountId === accountId);
	const dated = rows.filter((t) => !!t.date).map((t) => t.date).sort();
	const merchants = new Set<string>();
	const months = new Set<string>();
	const sources = new Set<string>();
	const currencies = new Set<string>();
	let moneyIn = 0;
	let moneyOut = 0;
	let categorized = 0;

	for (const tx of rows) {
		const key = merchantKey(tx);
		if (key) merchants.add(key);
		if (tx.date) months.add(monthKey(tx.date));
		if (tx.source) sources.add(tx.source);
		if (tx.currency) currencies.add(tx.currency);
		if (tx.categoryId) categorized++;
		if (tx.amount >= 0) moneyIn += tx.amount;
		else moneyOut += tx.amount;
	}

	const firstDate = dated[0];
	const lastDate = dated[dated.length - 1];
	return {
		accountId,
		transactions: rows.length,
		firstDate,
		lastDate,
		undated: rows.length - dated.length,
		monthsSpanned: monthsBetween(firstDate, lastDate),
		monthsWithActivity: months.size,
		uniqueMerchants: merchants.size,
		categorized,
		uncategorized: rows.length - categorized,
		moneyIn,
		moneyOut,
		sources: [...sources].sort(),
		currencies: [...currencies].sort(),
	};
}

/** Every account's coverage, in the order the accounts are given. */
export function allAccountStats(transactions: Transaction[], accounts: Account[]): AccountStats[] {
	return accounts.map((a) => accountStats(transactions, a.id));
}

/**
 * Rows filed against an account that no longer exists.
 *
 * `ManageAccountsModal` deletes an account without touching its transactions, so this is reachable in
 * ordinary use and is invisible everywhere else: the rows keep counting toward totals while belonging
 * to nothing you can open.
 */
export function orphanedTransactions(transactions: Transaction[], accounts: Account[]): Transaction[] {
	const known = new Set(accounts.map((a) => a.id));
	return transactions.filter((t) => !known.has(t.accountId));
}
