import type { Debt } from "./types";

/**
 * The arithmetic of the debts register, kept out of the view so it can be tested without one.
 *
 * Nothing here reaches any other total. The register answers its own questions — what do I owe, what
 * am I owed, what is overdue — and stops there, on purpose: see `Debt`.
 */

/** Still outstanding on a debt: the original amount less whatever has been repaid, never below zero. */
export function outstanding(debt: Debt): number {
	return Math.max(0, debt.amount - (debt.paid ?? 0));
}

/**
 * Settled means settled, whether that was recorded as a date or reached by repaying it in full.
 *
 * Both are real: marking one settled is the deliberate act, and paying off the last of it is the same
 * statement arrived at from the other end. A register that only understood the first would keep
 * showing a fully-repaid debt as outstanding.
 */
export function isSettled(debt: Debt): boolean {
	return !!debt.settledDate || outstanding(debt) === 0;
}

export function isOverdue(debt: Debt, today: string): boolean {
	if (isSettled(debt) || !debt.dueDate) return false;
	return debt.dueDate < today;
}

export interface DebtTotals {
	/** Outstanding, by direction, per currency — never summed across currencies, since no rate here
	 *  would be honest about a personal IOU. */
	owe: Record<string, number>;
	owed: Record<string, number>;
	openCount: number;
	settledCount: number;
	overdueCount: number;
}

export function debtTotals(debts: Debt[], today: string): DebtTotals {
	const totals: DebtTotals = { owe: {}, owed: {}, openCount: 0, settledCount: 0, overdueCount: 0 };
	for (const debt of debts) {
		if (isSettled(debt)) {
			totals.settledCount++;
			continue;
		}
		totals.openCount++;
		if (isOverdue(debt, today)) totals.overdueCount++;
		const bucket = debt.direction === "owe" ? totals.owe : totals.owed;
		const currency = debt.currency || "EUR";
		bucket[currency] = (bucket[currency] ?? 0) + outstanding(debt);
	}
	return totals;
}

/**
 * Open debts first, overdue at the very top, then by due date and finally by size.
 *
 * The order answers "what needs attention" rather than "what happened when": a register you keep for
 * the sake of not forgetting should lead with the thing you are most likely to have forgotten.
 */
export function sortDebts(debts: Debt[], today: string): Debt[] {
	return [...debts].sort((a, b) => {
		const settledA = isSettled(a);
		const settledB = isSettled(b);
		if (settledA !== settledB) return settledA ? 1 : -1;
		const overdueA = isOverdue(a, today);
		const overdueB = isOverdue(b, today);
		if (overdueA !== overdueB) return overdueA ? -1 : 1;
		// A debt with a due date is more actionable than one without, so it sorts ahead of it.
		if (!!a.dueDate !== !!b.dueDate) return a.dueDate ? -1 : 1;
		if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
		if (outstanding(a) !== outstanding(b)) return outstanding(b) - outstanding(a);
		return (b.date || "").localeCompare(a.date || "");
	});
}
