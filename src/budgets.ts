import { categoryTotals, type KpiStore } from "./kpi";

/** "YYYY-MM" for the current calendar month — budgets are simple and monthly, no rollover. */
export function currentMonth(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(month: string, delta: number): string {
	const [y, m] = month.split("-").map(Number);
	const d = new Date(Date.UTC(y, m - 1 + delta, 1));
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * A monthly budget suggestion for one category, extracted from its own recent spending pattern —
 * the average of the last `lookbackMonths` months that actually have transaction history (so a
 * category with no spend before the user started tracking isn't dragged toward zero by "months"
 * that never existed). Rounded to the nearest €5 so it reads as a suggestion, not a false-precision
 * calculation. Returns undefined when there's no spending history to extract a pattern from at all.
 */
export function suggestedBudget(store: KpiStore, categoryId: string, referenceMonth: string, lookbackMonths = 3): number | undefined {
	const earliest = store.transactions.reduce<string | undefined>(
		(min, t) => (t.date && (!min || t.date < min) ? t.date : min),
		undefined
	);
	if (!earliest) return undefined;
	const earliestMonth = earliest.slice(0, 7);

	const amounts: number[] = [];
	for (let i = 1; i <= lookbackMonths; i++) {
		const month = shiftMonth(referenceMonth, -i);
		if (month < earliestMonth) continue;
		amounts.push(categoryTotals(store, month).get(categoryId) ?? 0);
	}
	if (amounts.length === 0) return undefined;

	const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
	if (avg <= 0) return undefined;
	return Math.round(avg / 5) * 5;
}

export type BudgetTone = "good" | "warn" | "bad";

export interface CategoryBudgetStatus {
	categoryId: string;
	budget: number;
	spent: number;
	remaining: number;
	/** spent / budget — not clamped, so "250% over" is still visible in the raw number if a caller wants it. */
	pct: number;
	tone: BudgetTone;
}

/** Budget-vs-actual for every category that has a budget set, for one month. No rollover: each month
 *  is scored purely on its own spend against its own limit. */
export function budgetStatuses(store: KpiStore, categories: { id: string; budget?: number }[], month: string): CategoryBudgetStatus[] {
	const spend = categoryTotals(store, month);
	return categories
		.filter((c) => (c.budget ?? 0) > 0)
		.map((c) => {
			const budget = c.budget!;
			const spent = spend.get(c.id) ?? 0;
			const pct = spent / budget;
			return {
				categoryId: c.id,
				budget,
				spent,
				remaining: budget - spent,
				pct,
				tone: pct >= 1 ? "bad" : pct >= 0.8 ? "warn" : "good",
			};
		});
}
