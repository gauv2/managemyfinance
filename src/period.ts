/**
 * The period drill-down behind the ledger's date filter: a year, then a month inside that year, then
 * a week inside that month. Each level only ever offers what the data actually has, so no choice in
 * any of the three can produce an empty table.
 *
 * Every level resolves to a plain from/to pair rather than being carried through the filter as a mode
 * of its own: the ledger already compares ISO date strings, so "August" is just two dates it would
 * otherwise have had you type. It also means switching to "Custom range…" leaves you holding the
 * range you were already looking at, instead of clearing back to nothing.
 */

export const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** "Jan", "Feb", … — derived so the two lists can never drift apart. */
export const MONTH_ABBR = MONTH_NAMES.map((name) => name.slice(0, 3));

export interface DateRange {
	/** Inclusive ISO "YYYY-MM-DD". */
	from: string;
	/** Inclusive ISO "YYYY-MM-DD". */
	to: string;
}

export interface PeriodOption {
	value: string;
	label: string;
}

/** No date filter at all — the ledger's default, and what "Clear filters" returns to. */
export const PERIOD_ALL = "";
/** Reveals the raw from/to inputs and stops touching them. */
export const PERIOD_CUSTOM = "custom";
export const PERIOD_THIS_WEEK = "week";
export const PERIOD_THIS_MONTH = "month";
export const PERIOD_LAST_MONTH = "last-month";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** Local date → "YYYY-MM-DD". Deliberately not toISOString(), which shifts into UTC and hands back
 *  yesterday for anyone east of Greenwich for part of the day. */
function isoDate(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function validDates(dates: (string | undefined)[]): string[] {
	return dates.filter((d): d is string => !!d && ISO_DATE.test(d));
}

/** The Monday of the week containing `date`. Weeks run Monday–Sunday; getDay() calls Sunday 0, so it
 *  gets rotated to the end of the week rather than the start. */
function mondayOf(date: Date): Date {
	const offset = (date.getDay() + 6) % 7;
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset);
}

/** "27 Jul – 2 Aug" for a straddling week, "3 – 9 Aug" when both ends share a month. */
function weekLabel(from: string, to: string): string {
	const fromDay = Number(from.slice(8, 10));
	const fromMonth = Number(from.slice(5, 7));
	const toDay = Number(to.slice(8, 10));
	const toMonth = Number(to.slice(5, 7));
	if (fromMonth === toMonth) return `${fromDay} – ${toDay} ${MONTH_ABBR[toMonth - 1]}`;
	return `${fromDay} ${MONTH_ABBR[fromMonth - 1]} – ${toDay} ${MONTH_ABBR[toMonth - 1]}`;
}

/** The distinct years present in a set of transaction dates, newest first. Malformed dates are skipped. */
export function transactionYears(dates: (string | undefined)[]): string[] {
	const years = new Set<string>();
	for (const date of validDates(dates)) years.add(date.slice(0, 4));
	return Array.from(years).sort((a, b) => b.localeCompare(a));
}

/**
 * The from/to a top-level choice stands for, or undefined for the two that don't name a range —
 * "All time" and "Custom range…". A four-digit value is a whole calendar year.
 */
export function periodRange(preset: string, today: Date = new Date()): DateRange | undefined {
	if (/^\d{4}$/.test(preset)) return { from: `${preset}-01-01`, to: `${preset}-12-31` };

	const year = today.getFullYear();
	const month = today.getMonth();

	switch (preset) {
		case PERIOD_THIS_WEEK: {
			const monday = mondayOf(today);
			const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
			return { from: isoDate(monday), to: isoDate(sunday) };
		}
		case PERIOD_THIS_MONTH:
			// Day 0 of the next month is the last day of this one, leap years included.
			return { from: isoDate(new Date(year, month, 1)), to: isoDate(new Date(year, month + 1, 0)) };
		case PERIOD_LAST_MONTH:
			// month - 1 goes negative in January; the Date constructor rolls it back into December.
			return { from: isoDate(new Date(year, month - 1, 1)), to: isoDate(new Date(year, month, 0)) };
		default:
			return undefined;
	}
}

/** The whole of a "YYYY-MM". */
export function monthRange(month: string): DateRange | undefined {
	if (!/^\d{4}-\d{2}$/.test(month)) return undefined;
	const year = Number(month.slice(0, 4));
	const monthNo = Number(month.slice(5, 7));
	if (monthNo < 1 || monthNo > 12) return undefined;
	return { from: `${month}-01`, to: isoDate(new Date(year, monthNo, 0)) };
}

/**
 * The seven days starting at `monday`. Weeks are never clipped to the month they were listed under:
 * a week that straddles the turn of a month filters to its true span, which is what its label says it
 * covers — a total that quietly dropped three days would be worse than one that spills.
 */
export function weekRangeFrom(monday: string): DateRange | undefined {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(monday)) return undefined;
	const [year, month, day] = monday.split("-").map(Number);
	return { from: monday, to: isoDate(new Date(year, month - 1, day + 6)) };
}

/**
 * The top-level dropdown: the relative presets that stay right as the calendar moves, then the years
 * the data actually covers, then the manual escape hatch.
 */
export function periodOptions(years: string[]): PeriodOption[] {
	return [
		{ value: PERIOD_ALL, label: "All time" },
		{ value: PERIOD_THIS_WEEK, label: "This week" },
		{ value: PERIOD_THIS_MONTH, label: "This month" },
		{ value: PERIOD_LAST_MONTH, label: "Last month" },
		...years.map((year) => ({ value: year, label: year })),
		{ value: PERIOD_CUSTOM, label: "Custom range…" },
	];
}

/** The months of `year` that have transactions, in calendar order, behind an "all of it" default. */
export function monthOptions(dates: (string | undefined)[], year: string): PeriodOption[] {
	const months = new Set<string>();
	for (const date of validDates(dates)) {
		const monthNo = Number(date.slice(5, 7));
		if (date.startsWith(`${year}-`) && monthNo >= 1 && monthNo <= 12) months.add(date.slice(0, 7));
	}
	return [
		{ value: "", label: `All of ${year}` },
		...Array.from(months)
			.sort()
			.map((month) => ({ value: month, label: MONTH_NAMES[Number(month.slice(5, 7)) - 1] })),
	];
}

/**
 * The Monday–Sunday weeks overlapping `month` that have transactions somewhere in their span, keyed
 * by their Monday. A week is listed under every month it touches, so the last days of July are
 * reachable from either July or August rather than falling down the gap between them.
 */
export function weekOptions(dates: (string | undefined)[], month: string): PeriodOption[] {
	if (!/^\d{4}-\d{2}$/.test(month)) return [];
	const year = Number(month.slice(0, 4));
	const monthNo = Number(month.slice(5, 7));
	if (monthNo < 1 || monthNo > 12) return [];

	const options: PeriodOption[] = [{ value: "", label: `All of ${MONTH_NAMES[monthNo - 1]}` }];
	const present = validDates(dates);
	const lastDay = new Date(year, monthNo, 0);
	const monday = mondayOf(new Date(year, monthNo - 1, 1));

	while (monday <= lastDay) {
		const from = isoDate(monday);
		const to = isoDate(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6));
		if (present.some((date) => date >= from && date <= to)) options.push({ value: from, label: weekLabel(from, to) });
		monday.setDate(monday.getDate() + 7);
	}
	return options;
}
