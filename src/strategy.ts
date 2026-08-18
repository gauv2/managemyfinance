import { resolvePrimaryId } from "./categories";
import { convert } from "./currency";
import { classifyTransaction, isEconomicallyNeutral } from "./finance/semantics";
import { averageMonthlyExpenses, netWorth, type KpiStore } from "./kpi";
import { lastCompleteMonthKey, monthKeysBetween, monthsInRange } from "./period";
import { isLiabilityType, isLiquidType, type Account, type DebtPayoffStrategy, type FinancialGoal, type ReservePlan, type ReviewCadence, type Strategy } from "./types";

/** A fresh, unfinished strategy — the wizard fills this in; `completedAt` stays unset until Finish. */
export function defaultStrategy(): Strategy {
	return {
		reserve: { bufferTarget: 0, incomeLossMonths: 3 },
		debtPlan: { strategy: "avalanche", includedAccountIds: [] },
		goals: [],
		savingsPolicy: { targetSavingsRatePct: 20 },
		rules: [],
		review: { cadence: "quarterly" },
	};
}

function isoToday(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function liquidBalance(store: KpiStore): number {
	return store.accounts.filter((a) => isLiquidType(a.type)).reduce((sum, a) => sum + netWorth(store, a.id), 0);
}

/** Whether a category (or the primary it's nested under) has been flagged as a non-negotiable living cost. */
function isEssentialCategory(store: KpiStore, categoryId: string | undefined): boolean {
	if (!categoryId) return false;
	const own = store.categories.find((c) => c.id === categoryId);
	if (own?.essential) return true;
	const primaryId = resolvePrimaryId(store.categories, categoryId);
	return !!store.categories.find((c) => c.id === primaryId)?.essential;
}

/** Average monthly spend across categories flagged `essential`, converted to base currency the same
 *  way every other KPI figure is. Mirrors kpi.ts's averageMonthlyExpenses — including the same
 *  complete-month observation window (FIN-010): averaged over every calendar month between the
 *  earliest and latest (complete) essential-spend activity, not just the months that happen to contain
 *  an essential transaction, so a genuinely zero-spend month doesn't silently shrink the divisor and
 *  inflate the average — and the same transfer/trade/debt-principal exclusion via the shared classifier,
 *  so a transfer into an essential-flagged category can't inflate the reserve target. */
function essentialMonthlyAverage(store: KpiStore): number {
	let earliestMonth: string | undefined;
	let latestMonth: string | undefined;
	const byMonth = new Map<string, number>();
	for (const tx of store.transactions) {
		if (!isEssentialCategory(store, tx.categoryId)) continue;
		const month = tx.date?.slice(0, 7);
		if (!month) continue;
		if (!earliestMonth || month < earliestMonth) earliestMonth = month;
		if (!latestMonth || month > latestMonth) latestMonth = month;
		if (isEconomicallyNeutral(classifyTransaction(store, tx))) continue;
		if (tx.amount >= 0) continue;
		const amount = store.fx ? convert(tx.amount, tx.currency, store.fx) : tx.amount;
		byMonth.set(month, (byMonth.get(month) ?? 0) - amount);
	}
	if (!earliestMonth || !latestMonth) return 0;

	const endMonth = latestMonth < lastCompleteMonthKey() ? latestMonth : lastCompleteMonthKey();
	const months = monthKeysBetween(earliestMonth, endMonth);
	if (months.length === 0) return 0;
	const total = months.reduce((sum, m) => sum + (byMonth.get(m) ?? 0), 0);
	return total / months.length;
}

/** The monthly figure an income-loss reserve is measured in months of. Essential-only spend once any
 *  category has been flagged essential; every category's spend otherwise, since a target of "0 months
 *  of €0" is worse than a rough number from total spend. */
function reserveBasis(store: KpiStore): number {
	const essential = essentialMonthlyAverage(store);
	return essential > 0 ? essential : averageMonthlyExpenses(store);
}

/**
 * The book's stated range (three to six months of essential spending) as a floor and ceiling — kept
 * constant rather than derived, since nothing in this app's data model (employment type, number of
 * incomes, dependants) is available to justify narrowing it any further than the book already does.
 * A false-precision number here would be worse than an honest range.
 */
export function suggestReserveMonths(_store: KpiStore): { low: number; high: number } {
	return { low: 3, high: 6 };
}

/** Current liquid cash against both reserve targets — the same pool of money read two ways, since this
 *  app doesn't require separate accounts per bucket the way a more elaborate cash-management setup might. */
export function reserveStatus(store: KpiStore, plan: ReservePlan): { bufferHave: number; incomeLossHave: number; incomeLossTarget: number } {
	const have = liquidBalance(store);
	return { bufferHave: have, incomeLossHave: have, incomeLossTarget: plan.incomeLossMonths * reserveBasis(store) };
}

/** Every debt-carrying account (credit, loan or mortgage type) with a positive balance owed, in base currency. */
export function debtByAccount(store: KpiStore): { account: Account; balanceOwed: number }[] {
	return store.accounts
		.filter((a) => isLiabilityType(a.type) || a.type === "credit")
		.map((account) => ({ account, balanceOwed: Math.max(0, -netWorth(store, account.id)) }))
		.filter((d) => d.balanceOwed > 0);
}

/** Included debts ordered by the chosen strategy — avalanche pays the highest APR first (cheapest total
 *  interest), snowball pays the smallest balance first (fastest wins, for the people the book notes
 *  respond better to momentum than to arithmetic). Ties keep their original relative order. */
export function orderDebtPayoff(
	debts: { account: Account; balanceOwed: number }[],
	strategy: DebtPayoffStrategy,
	includedAccountIds: string[]
): { account: Account; balanceOwed: number }[] {
	const included = new Set(includedAccountIds);
	return debts
		.filter((d) => included.has(d.account.id))
		.slice()
		.sort((a, b) => (strategy === "avalanche" ? (b.account.apr ?? 0) - (a.account.apr ?? 0) : a.balanceOwed - b.balanceOwed));
}

/**
 * A goal's current progress, per its tracking mode. "computed" reserve goals read the same liquid
 * balance the reserve meters show; a computed debt-payoff goal reads progress as (target − remaining),
 * where target is the debt total the goal was created against — this app has no separate "starting
 * balance" to diff against otherwise, and debt can grow as well as shrink.
 */
export function goalCurrentAmount(store: KpiStore, goal: FinancialGoal): number {
	if (goal.trackingMode === "manual") return goal.manualCurrentAmount ?? 0;
	if (goal.trackingMode === "account") return goal.linkedAccountId ? Math.max(0, netWorth(store, goal.linkedAccountId)) : 0;
	// trackingMode === "computed"
	if (goal.kind === "debt-payoff") {
		const remaining = debtByAccount(store).reduce((sum, d) => sum + d.balanceOwed, 0);
		return Math.max(0, goal.targetAmount - remaining);
	}
	return liquidBalance(store);
}

/** Monthly amount required to close the gap between current and target by the deadline — the inverse
 *  of kpi.ts's fiProjection, which solves for time given a contribution; this solves for the
 *  contribution given a fixed horizon instead, so it isn't a wrapper around that function. Undefined
 *  when there's no deadline, or the deadline has already passed without the target being met. */
export function goalMonthlyRequired(current: number, target: number, deadline: string | undefined, today: string = isoToday()): number | undefined {
	if (!deadline) return undefined;
	const remaining = target - current;
	if (remaining <= 0) return 0;
	if (deadline < today) return undefined;
	return remaining / monthsInRange({ from: today, to: deadline });
}

export type GoalStatus = "ahead" | "on-track" | "behind" | "no-deadline";

/** How a goal's real savings pace compares to what its deadline requires. A goal with no deadline has
 *  nothing to be behind or ahead of, so it reads as its own state rather than defaulting to either. */
export function goalStatus(store: KpiStore, goal: FinancialGoal, actualMonthlyNet: number): GoalStatus {
	if (!goal.deadline) return "no-deadline";
	const current = goalCurrentAmount(store, goal);
	if (current >= goal.targetAmount) return "ahead";
	const required = goalMonthlyRequired(current, goal.targetAmount, goal.deadline);
	if (required === undefined) return "behind"; // deadline passed, target not met
	if (required <= 0) return "ahead";
	const ratio = actualMonthlyNet / required;
	if (ratio >= 1.05) return "ahead";
	if (ratio >= 0.95) return "on-track";
	return "behind";
}

/** The next date a cadence lands on, counting forward from `referenceDate` (defaults to today). Uses a
 *  local (not UTC) Date so month/year rollovers land on the calendar day the user actually sees. */
export function nextReviewDate(cadence: ReviewCadence, referenceDate: string = isoToday()): string {
	const months = cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12;
	const [y, m, d] = referenceDate.split("-").map(Number);
	const next = new Date(y, m - 1 + months, d);
	return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
}
