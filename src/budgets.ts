import { primaryCategories, secondaryCategoriesOf } from "./categories";
import { categoryTotals, primaryCategoryTotals, type KpiStore } from "./kpi";
import type { Category } from "./types";

/** "YYYY-MM" for the current calendar month — budgets are simple and monthly, no rollover. */
export function currentMonth(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function shiftMonth(month: string, delta: number): string {
	const [y, m] = month.split("-").map(Number);
	const d = new Date(Date.UTC(y, m - 1 + delta, 1));
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The planned budget on record for one category in one specific month — undefined if never set for
 * that month. A primary category in "breakdown" mode has no number of its own: its budget is the sum
 * of its secondary categories' own budgetHistory for that month (undefined if none of them have one
 * set yet, so an empty breakdown still reads as "no budget planned" rather than "€0 planned").
 */
export function budgetForMonth(categories: Category[], category: Category, month: string): number | undefined {
	if (category.budgetMode === "breakdown") {
		const children = secondaryCategoriesOf(categories, category.id);
		if (children.length === 0) return category.budgetHistory?.[month];
		let sum = 0;
		let anySet = false;
		for (const child of children) {
			const v = child.budgetHistory?.[month];
			if (v !== undefined) {
				sum += v;
				anySet = true;
			}
		}
		return anySet ? sum : undefined;
	}
	return category.budgetHistory?.[month];
}

/**
 * A monthly budget suggestion for one category, extracted from its own recent spending pattern —
 * the average of the last `lookbackMonths` months that actually have transaction history (so a
 * category with no spend before the user started tracking isn't dragged toward zero by "months"
 * that never existed). Rounded to the nearest €5 so it reads as a suggestion, not a false-precision
 * calculation. Returns undefined when there's no spending history to extract a pattern from at all.
 *
 * `scope` controls whether a primary category's history includes its secondaries' spend too: pass
 * "rollup" when suggesting a primary category's own total-mode budget (so the suggestion reflects
 * everything spent under it, not just transactions tagged directly to the primary); the default
 * "leaf" is correct for a secondary category's own line-item suggestion.
 */
export function suggestedBudget(
	store: KpiStore,
	categoryId: string,
	referenceMonth: string,
	lookbackMonths = 3,
	scope: "leaf" | "rollup" = "leaf"
): number | undefined {
	const earliest = store.transactions.reduce<string | undefined>(
		(min, t) => (t.date && (!min || t.date < min) ? t.date : min),
		undefined
	);
	if (!earliest) return undefined;
	const earliestMonth = earliest.slice(0, 7);

	const totalsFor = scope === "rollup" ? primaryCategoryTotals : categoryTotals;
	const amounts: number[] = [];
	for (let i = 1; i <= lookbackMonths; i++) {
		const month = shiftMonth(referenceMonth, -i);
		if (month < earliestMonth) continue;
		amounts.push(totalsFor(store, month).get(categoryId) ?? 0);
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

/** Budget-vs-actual for every *primary* category that has a planned budget for this specific month —
 *  spend is rolled up across a primary and all of its secondary categories, and in "breakdown" mode
 *  the budget itself is the sum of the secondaries' own numbers (see `budgetForMonth`). No rollover:
 *  each month is scored purely on its own spend against its own limit for that same month. */
export function budgetStatuses(store: KpiStore, categories: Category[], month: string): CategoryBudgetStatus[] {
	const spend = primaryCategoryTotals(store, month);
	return primaryCategories(categories)
		.filter((c) => (budgetForMonth(categories, c, month) ?? 0) > 0)
		.map((c) => {
			const budget = budgetForMonth(categories, c, month)!;
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
