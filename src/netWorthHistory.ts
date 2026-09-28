import { tracksBalance } from "./accounts";
import { netWorthAsOf, type KpiStore } from "./kpi";
import { addDaysIso, addMonthsIso } from "./recurring";
import type { Account, AccountType } from "./types";

/**
 * Net worth over a window, per account and in total, for the Net worth page — the figure the dashboard
 * already shows for today (netWorthAsOf), sampled at enough dates to draw a line.
 *
 * Every point is netWorthAsOf for one account on one date, so each account is valued exactly as it is
 * everywhere else: snapshots supersede opening balances, investing accounts carry their holdings, a
 * register-only account contributes nothing. The total is the sum of the accounts, never computed
 * separately, so the lines can't drift apart.
 */

export type WorthRange = "1d" | "1w" | "1m" | "3m" | "6m" | "1y" | "all";
export const WORTH_RANGES: WorthRange[] = ["1d", "1w", "1m", "3m", "6m", "1y", "all"];

export type WorthBucket = "cash" | "investments" | "retirement" | "property" | "credit" | "loans";

export const BUCKET_OF: Record<AccountType, WorthBucket> = {
	debit: "cash",
	saving: "cash",
	cash: "cash",
	investing: "investments",
	crypto: "investments",
	pension: "retirement",
	property: "property",
	credit: "credit",
	loan: "loans",
	mortgage: "loans",
};

export const BUCKET_ORDER: WorthBucket[] = ["cash", "investments", "retirement", "property", "credit", "loans"];

export const BUCKET_LABEL: Record<WorthBucket, string> = {
	cash: "Cash",
	investments: "Investments",
	retirement: "Retirement",
	property: "Property",
	credit: "Credit cards",
	loans: "Loans",
};

export interface AccountWorth {
	account: Account;
	bucket: WorthBucket;
	/** One value per entry in `WorthHistory.dates`, base currency. */
	values: number[];
	start: number;
	end: number;
}

export interface WorthHistory {
	dates: string[];
	accounts: AccountWorth[];
	total: number[];
}

/**
 * The dates a window is sampled at, oldest first, always ending today. Daily up to three months (a
 * month drawn weekly hides the payday bump the chart exists to show), weekly up to a year, monthly
 * beyond. "all" starts at the first transaction; any window is clipped to it, since before then there
 * is nothing to plot but opening balances.
 */
export function sampleDates(range: WorthRange, today: string, earliest?: string): string[] {
	const start: Record<Exclude<WorthRange, "all">, string> = {
		"1d": addDaysIso(today, -1),
		"1w": addDaysIso(today, -7),
		"1m": addMonthsIso(today, -1),
		"3m": addMonthsIso(today, -3),
		"6m": addMonthsIso(today, -6),
		"1y": addMonthsIso(today, -12),
	};
	let from = range === "all" ? earliest ?? addMonthsIso(today, -12) : start[range];
	if (earliest && from < earliest && range !== "1d") from = earliest;
	if (from >= today) return [addDaysIso(today, -1), today];

	// Each date is counted from `from` rather than from the previous date, so month steps anchored on
	// the 31st don't clamp to the 28th in February and stay there.
	const step = range === "all" ? "month" : range === "6m" || range === "1y" ? "week" : "day";
	const nth = (i: number) => (step === "day" ? addDaysIso(from, i) : step === "week" ? addDaysIso(from, 7 * i) : addMonthsIso(from, i));
	const dates: string[] = [];
	for (let i = 0, d = from; d < today && i <= 1000; d = nth(++i)) dates.push(d);
	dates.push(today);
	return dates;
}

export function worthHistory(store: KpiStore, dates: string[]): WorthHistory {
	const accounts: AccountWorth[] = store.accounts
		.filter((a) => tracksBalance(a))
		.map((account) => {
			const values = dates.map((d) => netWorthAsOf(store, d, account.id));
			return { account, bucket: BUCKET_OF[account.type] ?? "cash", values, start: values[0] ?? 0, end: values[values.length - 1] ?? 0 };
		});
	const total = dates.map((_, i) => accounts.reduce((sum, a) => sum + a.values[i], 0));
	return { dates, accounts, total };
}

/** Each bucket's value on the last sampled date, in BUCKET_ORDER, zero buckets left out. */
export function bucketTotals(history: WorthHistory): { bucket: WorthBucket; value: number }[] {
	return BUCKET_ORDER.map((bucket) => ({
		bucket,
		value: history.accounts.filter((a) => a.bucket === bucket).reduce((sum, a) => sum + a.end, 0),
	})).filter((b) => Math.abs(b.value) >= 0.005);
}

/** The change across the window, and as a share of where it started. The share is undefined when it
 *  started at zero, where any percentage would be meaningless. */
export function change(values: number[]): { amount: number; pct?: number } {
	const first = values[0] ?? 0;
	const last = values[values.length - 1] ?? 0;
	const amount = last - first;
	return { amount, pct: Math.abs(first) < 0.005 ? undefined : amount / Math.abs(first) };
}
