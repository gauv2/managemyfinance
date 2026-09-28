import { categoryChain } from "./categories";
import { isTransfer, type KpiStore } from "./kpi";
import { addCycleIso, addDaysIso, amountSpread, CYCLE_MAX_DAYS, recurringSeries, type RecurringCycle, type RecurringSeries } from "./recurring";

/**
 * A month of recurring money laid out by day, for the Cash flow page's bills timeline: every regular
 * charge as a pin on the day it lands (or is expected to), regular income as dots above, and the
 * weekly habits — too frequent to pin — as a list underneath.
 *
 * Everything comes from recurringSeries, so nothing has to be set up by hand: a charge that has hit
 * the ledger on a steady cycle three times is a bill. A pin is "paid" when this month's charge has
 * actually posted, and otherwise sits on the day the series says it's next due.
 */

export interface BillPin {
	key: string;
	name: string;
	date: string;
	day: number;
	/** Positive. The actual charge once paid; the last one while still expected. */
	amount: number;
	/** The amount moves around from charge to charge, so an expected one is a guess. */
	approx: boolean;
	cycle: RecurringCycle;
	paid: boolean;
	color: string;
}

export interface WeeklyBill {
	key: string;
	name: string;
	amount: number;
	approx: boolean;
}

export interface MonthBills {
	month: string;
	daysInMonth: number;
	bills: BillPin[];
	income: BillPin[];
	weekly: WeeklyBill[];
}

export interface MonthBillsOptions {
	maxBills?: number;
	maxIncome?: number;
	/** How irregular a series' gaps may be and still count as a bill. See RecurringSeries.gapSpread. */
	maxGapSpread?: number;
}

const FALLBACK_COLOR = "#8b93a1";

function daysIn(month: string): number {
	const [y, m] = month.split("-").map(Number);
	return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function billsForMonth(store: KpiStore, month: string, today: string, opts: MonthBillsOptions = {}): MonthBills {
	const maxBills = opts.maxBills ?? 14;
	const maxIncome = opts.maxIncome ?? 3;
	const maxGapSpread = opts.maxGapSpread ?? 0.3;
	const monthStart = `${month}-01`;
	const dim = daysIn(month);
	const monthEnd = `${month}-${String(dim).padStart(2, "0")}`;
	const txById = new Map(store.transactions.map((t) => [t.id, t]));

	const colorOf = (series: RecurringSeries): string => {
		const last = series.occurrences[series.occurrences.length - 1];
		const tx = last && txById.get(last.id);
		return categoryChain(store.categories, tx?.categoryId).primary?.color ?? FALLBACK_COLOR;
	};
	const varies = (series: RecurringSeries) => amountSpread(series.occurrences.slice(-6).map((o) => Math.abs(o.amount))) > 0.02;
	// Still running: seen within a cycle and a half of the month (plus a week of slack for a late
	// charge), and not starting after it.
	const live = (series: RecurringSeries) =>
		series.firstDate <= monthEnd && series.lastDate >= addDaysIso(monthStart, -Math.round(CYCLE_MAX_DAYS[series.cycle] * 1.5 + 7));

	const pinsFor = (series: RecurringSeries): BillPin[] => {
		const base = { key: series.key, name: series.displayName, cycle: series.cycle, color: colorOf(series) };
		const posted = series.occurrences.filter((o) => o.date >= monthStart && o.date <= monthEnd);
		if (posted.length > 0) {
			return posted.map((o) => ({ ...base, date: o.date, day: Number(o.date.slice(8, 10)), amount: Math.abs(o.amount), approx: false, paid: true }));
		}
		// Nothing posted yet: project forward from the last charge, but only for a month that isn't over
		// — a past month without the charge is a skipped bill, not an upcoming one.
		if (monthEnd < today) return [];
		let next = series.lastDate;
		for (let guard = 0; next < monthStart && guard < 60; guard++) next = addCycleIso(next, series.cycle);
		if (next > monthEnd || next <= series.lastDate) return [];
		return [{ ...base, date: next, day: Number(next.slice(8, 10)), amount: series.lastAmount, approx: varies(series), paid: false }];
	};

	const all = recurringSeries(store, 3, { isTransfer }).filter((s) => s.gapSpread <= maxGapSpread && live(s));
	const monthly = all.filter((s) => s.cycle !== "weekly");

	const bills = monthly
		.filter((s) => s.direction === "debit")
		.flatMap(pinsFor)
		.sort((a, b) => b.amount - a.amount)
		.slice(0, maxBills)
		.sort((a, b) => a.day - b.day || b.amount - a.amount);
	// Interest that pays out cents on a steady schedule is regular income by the letter, and a dot
	// labelled "€0.06/yr" beside your salary is noise — so income has to be worth pinning on its own.
	const credits = monthly.filter((s) => s.direction === "credit").flatMap(pinsFor);
	const biggest = Math.max(0, ...credits.map((p) => p.amount));
	const income = credits
		.filter((p) => p.amount >= Math.max(10, biggest * 0.02))
		.sort((a, b) => b.amount - a.amount)
		.slice(0, maxIncome)
		.sort((a, b) => a.day - b.day);
	const weekly = all
		.filter((s) => s.cycle === "weekly" && s.direction === "debit")
		.map((s) => ({ key: s.key, name: s.displayName, amount: s.medianAmount, approx: varies(s) }))
		.sort((a, b) => b.amount - a.amount)
		.slice(0, 6);

	return { month, daysInMonth: dim, bills, income, weekly };
}
