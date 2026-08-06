import type { FinanceStore } from "./store";
import type { Transaction } from "./types";

export interface YearSummary {
	year: string;
	income: number;
	expenses: number;
	net: number;
	savingsRate: number;
}

/** Moving your own money between your own accounts (e.g. checking → savings) is neither income nor expense. */
function isTransfer(store: FinanceStore, tx: Transaction): boolean {
	if (!tx.categoryId) return false;
	const cat = store.categories.find((c) => c.id === tx.categoryId);
	return cat?.name === "Savings & Transfers";
}

export function summarizeByYear(store: FinanceStore): YearSummary[] {
	const map = new Map<string, { income: number; expenses: number }>();
	for (const tx of store.transactions) {
		const year = tx.date?.slice(0, 4);
		if (!year) continue;
		if (isTransfer(store, tx)) continue;
		if (!map.has(year)) map.set(year, { income: 0, expenses: 0 });
		const bucket = map.get(year)!;
		if (tx.amount >= 0) bucket.income += tx.amount;
		else bucket.expenses += -tx.amount;
	}
	return Array.from(map.entries())
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([year, { income, expenses }]) => ({
			year,
			income,
			expenses,
			net: income - expenses,
			savingsRate: income > 0 ? (income - expenses) / income : 0,
		}));
}

export function netWorth(store: FinanceStore): number {
	let total = 0;
	for (const acc of store.accounts) total += acc.openingBalance ?? 0;
	for (const tx of store.transactions) total += tx.amount;
	return total;
}

/** Simulates monthly compounding to estimate years until `netWorthNow` reaches `target`. */
export function fiProjection(
	netWorthNow: number,
	monthlyContribution: number,
	annualReturn: number,
	target: number
): number | undefined {
	if (target <= 0) return undefined;
	if (netWorthNow >= target) return 0;
	if (monthlyContribution <= 0 && annualReturn <= 0) return undefined;

	const monthlyReturn = annualReturn / 12;
	let balance = netWorthNow;
	for (let month = 1; month <= 12 * 60; month++) {
		balance = balance * (1 + monthlyReturn) + monthlyContribution;
		if (balance >= target) return month / 12;
	}
	return undefined;
}

export function categoryTotals(store: FinanceStore, year?: string): Map<string, number> {
	const totals = new Map<string, number>();
	for (const tx of store.transactions) {
		if (tx.amount >= 0) continue;
		if (year && !tx.date?.startsWith(year)) continue;
		if (isTransfer(store, tx)) continue;
		const key = tx.categoryId ?? "uncategorized";
		totals.set(key, (totals.get(key) ?? 0) + -tx.amount);
	}
	return totals;
}
