import type { Transaction } from "./types";

/**
 * The records buried in a ledger — the firsts, the biggests, the busiest.
 *
 * Everything else in the plugin aggregates: totals per category, per month, per year. Aggregation is
 * what you want for a budget and precisely what buries the individual facts a ledger accumulates
 * quietly over years — the first row ever imported, the day the most money left, the shop visited more
 * often than any other. None of it changes a decision; all of it is the reason someone keeps records
 * for six years, and it costs one pass over the ledger to surface.
 *
 * Pure, and takes plain transactions, so the arithmetic is testable without a vault and the caller
 * decides the scope — one account or all of them, one currency or the base.
 */

export interface Extreme {
	transaction: Transaction;
	amount: number;
}

export interface MerchantTally {
	name: string;
	total: number;
	count: number;
}

export interface DayTally {
	date: string;
	count: number;
	total: number;
}

export interface MonthTally {
	month: string;
	total: number;
}

export interface LedgerStats {
	/** Oldest and newest dated rows. Undefined only when nothing has a usable date. */
	first?: Transaction;
	latest?: Transaction;
	/** Whole days between the two, inclusive of neither end — the span the ledger actually covers. */
	spanDays?: number;
	counted: number;
	/** Rows excluded from every figure here because they carry no usable date. */
	undated: number;
	totalSpent: number;
	totalReceived: number;
	biggestExpense?: Extreme;
	biggestIncome?: Extreme;
	/** Most transactions on a single calendar day. */
	busiestDay?: DayTally;
	/** Most money out in a single calendar day, which is rarely the same day. */
	heaviestDay?: DayTally;
	costliestMonth?: MonthTally;
	/** Most money spent at one payee across the whole ledger. */
	topMerchantBySpend?: MerchantTally;
	/** Most visits, which is a different shop from the one above more often than not. */
	topMerchantByVisits?: MerchantTally;
	distinctMerchants: number;
	/** Longest run of consecutive days with no money going out. */
	longestQuietStreakDays: number;
	/** Mean size of a single expense — the typical row, not the typical day. */
	averageExpense: number;
}

const isDated = (tx: Transaction): boolean => typeof tx.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(tx.date);

const dayOf = (tx: Transaction): string => (tx.date ?? "").slice(0, 10);
const monthOf = (tx: Transaction): string => (tx.date ?? "").slice(0, 7);

/** Whole days between two ISO dates. UTC on both sides, so a DST boundary cannot shift the count. */
export function daysBetween(fromIso: string, toIso: string): number {
	const from = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
	const to = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
	if (Number.isNaN(from) || Number.isNaN(to)) return 0;
	return Math.round((to - from) / 86_400_000);
}

/**
 * Longest run of consecutive days with nothing going out, between the first and last spending day.
 *
 * Measured against spending days only: a day with income but no expense is still a day you spent
 * nothing, which is the thing being counted. Leading and trailing silence is excluded because it says
 * more about when the ledger starts and stops than about any habit.
 */
export function longestQuietStreak(spendDays: string[]): number {
	const unique = Array.from(new Set(spendDays)).sort();
	if (unique.length < 2) return 0;
	let longest = 0;
	for (let i = 1; i < unique.length; i++) {
		// One day apart means no gap at all; the quiet run is whatever sits strictly between them.
		longest = Math.max(longest, daysBetween(unique[i - 1], unique[i]) - 1);
	}
	return Math.max(0, longest);
}

/**
 * `isTransfer` excludes movements between the owner's own accounts. Without it the records are simply
 * a list of the largest transfers: money swept into a savings account is the biggest "spend", and the
 * savings account itself is the most-visited "shop" — both true, neither interesting, and both
 * crowding out the real answer.
 */
export function buildStats(
	transactions: Transaction[],
	merchantNameOf: (tx: Transaction) => string | undefined,
	isTransfer: (tx: Transaction) => boolean = () => false
): LedgerStats {
	const dated = transactions.filter((t) => isDated(t) && !isTransfer(t));
	const undated = transactions.filter((t) => !isDated(t) && !isTransfer(t)).length;

	const stats: LedgerStats = {
		counted: dated.length,
		undated,
		totalSpent: 0,
		totalReceived: 0,
		distinctMerchants: 0,
		longestQuietStreakDays: 0,
		averageExpense: 0,
	};
	if (dated.length === 0) return stats;

	const byDay = new Map<string, DayTally>();
	const byMonth = new Map<string, number>();
	const byMerchant = new Map<string, MerchantTally>();
	const spendDays: string[] = [];
	let expenseCount = 0;

	for (const tx of dated) {
		const day = dayOf(tx);
		const tally = byDay.get(day) ?? { date: day, count: 0, total: 0 };
		tally.count++;

		if (tx.amount < 0) {
			const out = -tx.amount;
			stats.totalSpent += out;
			expenseCount++;
			tally.total += out;
			spendDays.push(day);
			byMonth.set(monthOf(tx), (byMonth.get(monthOf(tx)) ?? 0) + out);

			if (!stats.biggestExpense || out > stats.biggestExpense.amount) stats.biggestExpense = { transaction: tx, amount: out };

			const name = merchantNameOf(tx);
			if (name) {
				const m = byMerchant.get(name) ?? { name, total: 0, count: 0 };
				m.total += out;
				m.count++;
				byMerchant.set(name, m);
			}
		} else if (tx.amount > 0) {
			stats.totalReceived += tx.amount;
			if (!stats.biggestIncome || tx.amount > stats.biggestIncome.amount) stats.biggestIncome = { transaction: tx, amount: tx.amount };
		}

		byDay.set(day, tally);
	}

	// Sorted rather than min/max'd so first and latest are the actual rows, not just their dates —
	// the description is half of what makes "the first thing in here" worth showing.
	const chronological = [...dated].sort((a, b) => (dayOf(a) < dayOf(b) ? -1 : dayOf(a) > dayOf(b) ? 1 : 0));
	stats.first = chronological[0];
	stats.latest = chronological[chronological.length - 1];
	stats.spanDays = daysBetween(dayOf(stats.first), dayOf(stats.latest));

	for (const tally of byDay.values()) {
		if (!stats.busiestDay || tally.count > stats.busiestDay.count) stats.busiestDay = tally;
		if (!stats.heaviestDay || tally.total > stats.heaviestDay.total) stats.heaviestDay = tally;
	}
	if (stats.heaviestDay && stats.heaviestDay.total === 0) stats.heaviestDay = undefined;

	for (const [month, total] of byMonth) {
		if (!stats.costliestMonth || total > stats.costliestMonth.total) stats.costliestMonth = { month, total };
	}

	for (const m of byMerchant.values()) {
		if (!stats.topMerchantBySpend || m.total > stats.topMerchantBySpend.total) stats.topMerchantBySpend = m;
		if (!stats.topMerchantByVisits || m.count > stats.topMerchantByVisits.count) stats.topMerchantByVisits = m;
	}

	stats.distinctMerchants = byMerchant.size;
	stats.longestQuietStreakDays = longestQuietStreak(spendDays);
	stats.averageExpense = expenseCount > 0 ? stats.totalSpent / expenseCount : 0;

	return stats;
}
