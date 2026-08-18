import { primaryCategories, resolvePrimaryId, secondaryCategoriesOf } from "./categories";
import { classifyTransaction } from "./finance/semantics";
import { categoryTotals, monthlySpendFor, primaryCategoryIncomeTotals, primaryCategoryTotals, type KpiStore } from "./kpi";
import { shiftMonthKey } from "./period";
import type { Category, OneOffBudget } from "./types";

/** "YYYY-MM" for the current calendar month — budgets are simple and monthly, no rollover. */
export function currentMonth(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export const shiftMonth = shiftMonthKey;

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
	/** Carried in from earlier months, when the category has rollover on. Zero otherwise. */
	rollover: number;
	/** budget + rollover — what's actually spendable this month. Equals `budget` without rollover. */
	available: number;
	/** True for a category whose budget is a target to reach rather than a ceiling to stay under. */
	isIncome: boolean;
}

/**
 * How a percentage of budget should read, which is the opposite thing for the two kinds of category:
 * 110% of a grocery budget is a problem, 110% of a freelance-income target is a good month.
 */
export function budgetTone(pct: number, isIncome: boolean): BudgetTone {
	if (isIncome) return pct >= 1 ? "good" : pct >= 0.8 ? "warn" : "bad";
	return pct >= 1 ? "bad" : pct >= 0.8 ? "warn" : "good";
}

export function isIncomeCategory(category: Pick<Category, "kind">): boolean {
	return category.kind === "income";
}

/** How far back a rollover chain is walked. Two years is more history than any envelope meaningfully
 *  carries, and it keeps this bounded rather than walking to the beginning of the ledger every render. */
const MAX_ROLLOVER_MONTHS = 24;

/**
 * What earlier months left behind for this one.
 *
 * Rollover is the difference between a budget and a *pot*: without it, an envelope you underspend in
 * January is simply gone in February, which makes saving up inside a category impossible — the exact
 * thing anyone budgeting for an annual bill or an occasional big purchase is trying to do. Each
 * earlier month contributes whatever its own budget plus its own carried-in balance had left over,
 * and an overspend carries forward as a negative, so the pot can genuinely run dry.
 *
 * Only counts months that actually had a budget planned: a category you started budgeting in March
 * doesn't arrive in March with credit for January and February.
 */
export function rolloverInto(store: KpiStore, categories: Category[], category: Category, month: string): number {
	if (!category.rollover) return 0;

	// One pass over the ledger for the whole chain, rather than one per month walked: this runs for
	// every rollover category on every render of the budgets page, and reading the entire transaction
	// list once per month walked would mean twenty-four passes before drawing a single row.
	const spendByMonth = monthlySpendFor(store, category.id);

	let carried = 0;
	// Walked oldest-first so each month's leftover is computed against what it had actually inherited.
	for (let i = MAX_ROLLOVER_MONTHS; i >= 1; i--) {
		const past = shiftMonth(month, -i);
		const planned = budgetForMonth(categories, category, past);
		if (planned === undefined) continue;
		carried = planned + carried - (spendByMonth.get(past) ?? 0);
	}
	return carried;
}

/** Budget-vs-actual for every *primary* category that has a planned budget for this specific month —
 *  spend is rolled up across a primary and all of its secondary categories, and in "breakdown" mode
 *  the budget itself is the sum of the secondaries' own numbers (see `budgetForMonth`). Categories with
 *  rollover on are scored against budget + whatever earlier months left over (see `rolloverInto`).
 *
 *  An income-kind category's "spent" comes from money actually earned into it (FIN-006) — sourcing it
 *  from the same expense-only totals every other category uses would read a €3,000 freelance-income
 *  target as permanently 0% met, since nothing ever counts as "spent" against an income category under
 *  that path. */
export function budgetStatuses(store: KpiStore, categories: Category[], month: string): CategoryBudgetStatus[] {
	const spend = primaryCategoryTotals(store, month);
	const income = primaryCategoryIncomeTotals(store, month);
	return primaryCategories(categories)
		.filter((c) => (budgetForMonth(categories, c, month) ?? 0) > 0)
		.map((c) => {
			const budget = budgetForMonth(categories, c, month)!;
			const rollover = rolloverInto(store, categories, c, month);
			const available = budget + rollover;
			const isIncome = isIncomeCategory(c);
			const spent = (isIncome ? income : spend).get(c.id) ?? 0;
			// Divided by what's actually spendable, so a category carrying a surplus doesn't read as
			// overspent the moment it passes this month's own line.
			const pct = available > 0 ? spent / available : spent > 0 ? Infinity : 0;
			return {
				categoryId: c.id,
				budget,
				spent,
				remaining: available - spent,
				pct,
				tone: budgetTone(pct, isIncome),
				rollover,
				available,
				isIncome,
			};
		});
}

export interface BudgetAlert {
	categoryId: string;
	categoryName: string;
	pct: number;
	spent: number;
	available: number;
	/** "over" once the budget is genuinely blown; "near" while it's only approaching the threshold. */
	severity: "near" | "over";
}

/**
 * Categories worth interrupting someone about this month. Income categories are excluded — falling
 * short of an income target isn't something a notification can help with, and a warning that fires
 * every month until payday is a warning nobody reads.
 */
export function budgetAlerts(store: KpiStore, categories: Category[], month: string, threshold = 0.9): BudgetAlert[] {
	const byId = new Map(categories.map((c) => [c.id, c]));
	return budgetStatuses(store, categories, month)
		.filter((status) => !status.isIncome && status.pct >= threshold)
		.map((status) => ({
			categoryId: status.categoryId,
			categoryName: byId.get(status.categoryId)?.name ?? "Unknown",
			pct: status.pct,
			spent: status.spent,
			available: status.available,
			severity: (status.pct >= 1 ? "over" : "near") as BudgetAlert["severity"],
		}))
		.sort((a, b) => b.pct - a.pct);
}

export interface AnnualBudgetStatus {
	categoryId: string;
	year: string;
	budget: number;
	spent: number;
	remaining: number;
	pct: number;
	tone: BudgetTone;
	isIncome: boolean;
}

/**
 * A whole-year envelope, for the costs that don't divide into months without lying about them —
 * annual insurance, road tax, a yearly software renewal. Scored against the year's total spend in
 * that category rather than against any month, so a single large January payment isn't a January
 * overspend followed by eleven months of surplus.
 */
export function annualBudgetStatuses(store: KpiStore, categories: Category[], year: string): AnnualBudgetStatus[] {
	const spend = primaryCategoryTotals(store, year);
	const income = primaryCategoryIncomeTotals(store, year);
	return primaryCategories(categories)
		.filter((c) => (c.annualBudgets?.[year] ?? 0) > 0)
		.map((c) => {
			const budget = c.annualBudgets![year];
			const isIncome = isIncomeCategory(c);
			const spent = (isIncome ? income : spend).get(c.id) ?? 0;
			const pct = spent / budget;
			return { categoryId: c.id, year, budget, spent, remaining: budget - spent, pct, tone: budgetTone(pct, isIncome), isIncome };
		});
}

export interface OneOffBudgetStatus {
	budgetId: string;
	name: string;
	budget: number;
	spent: number;
	remaining: number;
	pct: number;
	tone: BudgetTone;
	/** Days until the window closes; negative once it has. */
	daysLeft: number;
	transactionCount: number;
}

/**
 * A named pot for one specific thing over one specific window — a holiday, a kitchen, a wedding.
 *
 * Deliberately scored independently of the monthly envelopes rather than carved out of them: a
 * €3,000 holiday isn't a €3,000 overspend in Travel, it's a separate plan that happens to spend
 * through the same categories. Both readings are useful, and neither should overwrite the other.
 *
 * Nets refunds against the spend they returned against, and excludes transfers/trades/debt-principal
 * via the shared classifier (FIN-007). The previous version skipped every non-negative row outright —
 * so a store credit or a returned purchase inside the window never reduced `spent` at all, and an
 * unrestricted pot (no `categoryIds`) had no way to exclude a transfer or investment buy landing on the
 * same account in that window either.
 */
export function oneOffBudgetStatus(store: KpiStore, budget: OneOffBudget, today = new Date()): OneOffBudgetStatus {
	const wanted = budget.categoryIds && budget.categoryIds.length > 0 ? new Set(budget.categoryIds) : undefined;
	let spent = 0;
	let transactionCount = 0;

	for (const tx of store.transactions) {
		const date = (tx.date || "").slice(0, 10);
		if (!date || date < budget.startDate || date > budget.endDate) continue;
		if (wanted) {
			// Matched against the transaction's own category *and* its primary, so a pot scoped to
			// "Travel" still counts a payment tagged with the "Flights" secondary underneath it.
			const own = tx.categoryId;
			const primary = resolvePrimaryId(store.categories, tx.categoryId);
			if (!(own && wanted.has(own)) && !(primary && wanted.has(primary))) continue;
		}
		const classified = classifyTransaction(store, tx);
		// A transfer/trade/debt-principal row (affectsExpense === 0, isEconomicallyNeutral) and a
		// straight income-kind row landing in the window both fall out here: neither is spend, and
		// neither is a refund against spend.
		if (classified.affectsExpense === 0) continue;
		spent += classified.affectsExpense; // positive for an expense, negative for a net refund
		transactionCount++;
	}

	const pct = budget.amount > 0 ? spent / budget.amount : 0;
	const endMs = Date.parse(`${budget.endDate}T00:00:00Z`);
	const todayMs = Date.parse(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
	return {
		budgetId: budget.id,
		name: budget.name,
		budget: budget.amount,
		spent,
		remaining: budget.amount - spent,
		pct,
		tone: budgetTone(pct, false),
		daysLeft: isNaN(endMs) ? 0 : Math.round((endMs - todayMs) / 86_400_000),
		transactionCount,
	};
}

export interface YearReviewRow {
	categoryId: string;
	categoryName: string;
	/** 12 planned figures, undefined where nothing was budgeted that month. */
	planned: (number | undefined)[];
	actual: number[];
	plannedTotal: number;
	actualTotal: number;
	/** planned − actual across the year: positive means you came in under what you planned. */
	variance: number;
	/** Months that had a plan at all — the denominator for "how often did I get this right". */
	monthsPlanned: number;
	/** Of those, how many came in at or under plan. */
	monthsOnTarget: number;
}

/**
 * Plan versus actual for every month of a year, per category.
 *
 * This is the payoff for keeping `budgetHistory` per month instead of overwriting one number: a
 * year's worth of what you *intended* survives alongside what happened, so "which categories do I
 * consistently under-budget" becomes answerable instead of being a feeling. Categories with neither
 * a plan nor any spend in the year are left out entirely.
 */
export function yearReview(store: KpiStore, categories: Category[], year: string): YearReviewRow[] {
	const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
	const spendByMonth = months.map((m) => primaryCategoryTotals(store, m));

	const rows: YearReviewRow[] = [];
	for (const category of primaryCategories(categories)) {
		const planned = months.map((m) => budgetForMonth(categories, category, m));
		const actual = spendByMonth.map((totals) => totals.get(category.id) ?? 0);
		const plannedTotal = planned.reduce<number>((sum, p) => sum + (p ?? 0), 0);
		const actualTotal = actual.reduce((sum, a) => sum + a, 0);
		if (plannedTotal === 0 && actualTotal === 0) continue;

		let monthsPlanned = 0;
		let monthsOnTarget = 0;
		planned.forEach((p, i) => {
			if (p === undefined) return;
			monthsPlanned++;
			if (actual[i] <= p) monthsOnTarget++;
		});

		rows.push({
			categoryId: category.id,
			categoryName: category.name,
			planned,
			actual,
			plannedTotal,
			actualTotal,
			variance: plannedTotal - actualTotal,
			monthsPlanned,
			monthsOnTarget,
		});
	}
	return rows.sort((a, b) => b.actualTotal - a.actualTotal);
}
