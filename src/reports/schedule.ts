import type { ReportQuery } from "./query";

/**
 * Recurring report delivery: what a schedule is, which period it covers, and whether it is due.
 *
 * One constraint shapes all of this and can't be engineered away: an Obsidian plugin has no
 * background process. Nothing runs while Obsidian is closed, so "every Monday" really means "on the
 * first launch on or after Monday". The design leans into that rather than pretending otherwise —
 * due-ness is derived from *which period was last delivered*, not from a timer that has to be
 * running at the right moment. A laptop shut for three weeks still produces exactly one report on
 * the next launch, for the most recent completed period, because the period key it compares against
 * simply hasn't been recorded yet.
 *
 * Every report covers a *completed* period. A monthly report generated on the 3rd is a report about
 * last month, not a third of this one — a partial period presented as a period is a wrong number,
 * and the whole point of sending it out is that it can be relied on.
 */

export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";

export const CADENCE_LABEL: Record<Cadence, string> = {
	weekly: "Weekly",
	monthly: "Monthly",
	quarterly: "Quarterly",
	yearly: "Yearly",
};

/** What a schedule attaches to its delivery. PDF is the default; the rest are for spreadsheet users. */
export type AttachmentKind = "pdf" | "csv" | "xls";

/**
 * How much of the report the *document* carries.
 *
 * A year of a real ledger is thousands of rows, and a PDF that lists every one of them is a fifty-page
 * attachment nobody opens twice. The numbers people actually read a recurring report for are the
 * totals and the breakdowns; the transaction list is reference material, and reference material
 * belongs in the CSV.
 *
 * Only affects PDF and the summary body. CSV and Excel always carry every row — that is what a data
 * file is for, and truncating one would make it quietly wrong.
 */
export type ReportDetail = "summary" | "standard" | "full";

export const DETAIL_LABEL: Record<ReportDetail, string> = {
	summary: "Summary only",
	standard: "Standard",
	full: "Everything",
};

export const DETAIL_HINT: Record<ReportDetail, string> = {
	summary: "Totals and breakdowns, no transaction list — a page or two",
	standard: "Totals, breakdowns and the 100 largest transactions",
	full: "Every matching transaction, however many that is",
};

/** How many transaction rows each level puts in the document. Infinity means "all of them". */
export const DETAIL_ROW_LIMIT: Record<ReportDetail, number> = {
	summary: 0,
	standard: 100,
	full: Number.POSITIVE_INFINITY,
};

/**
 * The period currently *in progress* — "August so far", "2026 so far".
 *
 * Distinct from completedPeriod() and deliberately so: a scheduled report must cover a finished
 * period, but a test send is about recognising your own recent data, and last month's numbers tell
 * you nothing about whether today's ledger arrives intact.
 */
export function currentPeriod(cadence: Exclude<Cadence, "weekly">, now: Date = new Date()): Period {
	switch (cadence) {
		case "monthly": {
			const start = new Date(now.getFullYear(), now.getMonth(), 1);
			const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
			return {
				key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`,
				from: iso(start),
				to: iso(end),
				label: `${MONTHS[start.getMonth()]} ${start.getFullYear()} so far`,
			};
		}
		case "quarterly": {
			const start = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
			const end = new Date(start.getFullYear(), start.getMonth() + 3, 0);
			return {
				key: `${start.getFullYear()}-Q${quarterOf(start.getMonth())}`,
				from: iso(start),
				to: iso(end),
				label: `Q${quarterOf(start.getMonth())} ${start.getFullYear()} so far`,
			};
		}
		case "yearly":
		default: {
			const year = now.getFullYear();
			return { key: String(year), from: `${year}-01-01`, to: `${year}-12-31`, label: `${year} so far` };
		}
	}
}

export interface ScheduleChannels {
	/** Recipients. Empty or absent means email is off for this schedule. */
	email?: string[];
	/** Uses the single bot token + chat id from settings. */
	telegram?: boolean;
}

export interface ScheduleRun {
	/** ISO timestamp of the attempt. */
	at: string;
	periodKey: string;
	ok: boolean;
	/** Per-channel outcome, already rendered for display. */
	detail: string;
}

export interface ReportSchedule {
	id: string;
	name: string;
	enabled: boolean;
	cadence: Cadence;
	/** The report's filters. Dates are supplied by the period, so `from`/`to` here are ignored. */
	query: Omit<ReportQuery, "from" | "to">;
	/** How much detail the PDF carries. Absent means "standard" — see ReportDetail. */
	detail?: ReportDetail;
	attachments: AttachmentKind[];
	channels: ScheduleChannels;
	/**
	 * The most recent period actually delivered. Absent means "never sent", which is why a new
	 * schedule records the current completed period on creation — otherwise saving one would fire a
	 * report for last month within seconds, which nobody asked for by pressing Save.
	 */
	lastPeriodKey?: string;
	lastRun?: ScheduleRun;
}

export interface Period {
	/** Stable identifier for "which period is this", e.g. "2025-W10", "2025-03", "2025-Q1", "2025". */
	key: string;
	/** Inclusive "YYYY-MM-DD" bounds, ready to drop into a ReportQuery. */
	from: string;
	to: string;
	/** Human label for the subject line and the report's own title. */
	label: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function iso(date: Date): string {
	// Local components, not toISOString(): a ledger date is a calendar date in the user's own
	// timezone, and UTC conversion silently shifts every boundary by a day for half the world.
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Midnight on the Monday of `date`'s week. */
function startOfWeek(date: Date): Date {
	const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	// getDay() is 0 for Sunday; ISO weeks start Monday, so Sunday is 6 days into its week.
	const offset = (d.getDay() + 6) % 7;
	d.setDate(d.getDate() - offset);
	return d;
}

/**
 * The ISO-8601 week number: weeks start Monday, and week 1 is the one containing the first Thursday
 * of the year. Naive "day of year / 7" numbering disagrees with every calendar app around New Year,
 * which is precisely when a weekly report would be double-sent or skipped.
 */
function isoWeek(date: Date): { year: number; week: number } {
	const thursday = startOfWeek(date);
	thursday.setDate(thursday.getDate() + 3);
	const year = thursday.getFullYear();
	const firstThursday = startOfWeek(new Date(year, 0, 4));
	firstThursday.setDate(firstThursday.getDate() + 3);
	const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
	return { year, week };
}

function quarterOf(month: number): number {
	return Math.floor(month / 3) + 1;
}

/**
 * The most recent *completed* period of this cadence as of `now`.
 *
 * Always the one before the period `now` sits in, never the current one — see the note at the top
 * about partial periods.
 */
export function completedPeriod(cadence: Cadence, now: Date = new Date()): Period {
	switch (cadence) {
		case "weekly": {
			const start = startOfWeek(now);
			start.setDate(start.getDate() - 7);
			const end = new Date(start);
			end.setDate(end.getDate() + 6);
			const { year, week } = isoWeek(start);
			return {
				key: `${year}-W${String(week).padStart(2, "0")}`,
				from: iso(start),
				to: iso(end),
				label: `Week ${week}, ${year} (${iso(start)} – ${iso(end)})`,
			};
		}
		case "monthly": {
			const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
			// Day 0 of the next month is the last day of this one, leap years included.
			const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
			return {
				key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`,
				from: iso(start),
				to: iso(end),
				label: `${MONTHS[start.getMonth()]} ${start.getFullYear()}`,
			};
		}
		case "quarterly": {
			const currentQuarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
			const start = new Date(currentQuarterStart.getFullYear(), currentQuarterStart.getMonth() - 3, 1);
			const end = new Date(start.getFullYear(), start.getMonth() + 3, 0);
			return {
				key: `${start.getFullYear()}-Q${quarterOf(start.getMonth())}`,
				from: iso(start),
				to: iso(end),
				label: `Q${quarterOf(start.getMonth())} ${start.getFullYear()}`,
			};
		}
		case "yearly": {
			const year = now.getFullYear() - 1;
			return { key: String(year), from: `${year}-01-01`, to: `${year}-12-31`, label: String(year) };
		}
	}
}

/** When the next period will complete — what the settings panel shows as "next due". */
export function nextDueAt(cadence: Cadence, now: Date = new Date()): Date {
	switch (cadence) {
		case "weekly": {
			const next = startOfWeek(now);
			next.setDate(next.getDate() + 7);
			return next;
		}
		case "monthly":
			return new Date(now.getFullYear(), now.getMonth() + 1, 1);
		case "quarterly":
			return new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 + 3, 1);
		case "yearly":
			return new Date(now.getFullYear() + 1, 0, 1);
	}
}

/** Whether a schedule has a completed period it hasn't delivered yet. */
export function isDue(schedule: ReportSchedule, now: Date = new Date()): boolean {
	if (!schedule.enabled) return false;
	if (!hasAnyChannel(schedule)) return false;
	return completedPeriod(schedule.cadence, now).key !== schedule.lastPeriodKey;
}

/** A schedule with nowhere to send is not a schedule; it's a setting nobody finished. */
export function hasAnyChannel(schedule: ReportSchedule): boolean {
	return (schedule.channels.email?.length ?? 0) > 0 || !!schedule.channels.telegram;
}

/**
 * The period key a freshly-created schedule should start from: the one that has *already* completed.
 *
 * Recording it means the first delivery is the next period, not an instant one for last month. The
 * edit dialog offers a "Send now" button for anyone who wants that immediately, which is a decision
 * rather than a side effect of pressing Save.
 */
export function initialPeriodKey(cadence: Cadence, now: Date = new Date()): string {
	return completedPeriod(cadence, now).key;
}

/**
 * How many periods were *skipped* between the last delivery and the one being delivered now — 0 for
 * a schedule that is running on time.
 *
 * The period currently being reported on is not itself a miss, which is the distinction that makes
 * this worth a function: a monthly schedule that delivered January and is now delivering February is
 * behaving exactly as designed, and a report stamped "generated 1 period late" every single month
 * would make the warning meaningless on the one occasion it matters.
 *
 * Only ever used for messaging. A report is never back-filled per missed period: one launch produces
 * one report, for the latest completed period, and says how long it had been waiting.
 */
export function periodsMissed(schedule: ReportSchedule, now: Date = new Date()): number {
	if (!schedule.lastPeriodKey) return 0;
	const current = completedPeriod(schedule.cadence, now);
	if (current.key === schedule.lastPeriodKey) return 0;

	let count = 0;
	const probe = new Date(now.getTime());
	// Walk back a period at a time until the last delivered key turns up, capped so an unparseable or
	// hand-edited key can't spin here.
	for (let i = 0; i < 64; i++) {
		const period = completedPeriod(schedule.cadence, probe);
		// -1 because the first step off `now` is the period being delivered, not one that was missed.
		if (period.key === schedule.lastPeriodKey) return Math.max(0, count - 1);
		count++;
		switch (schedule.cadence) {
			case "weekly":
				probe.setDate(probe.getDate() - 7);
				break;
			case "monthly":
				probe.setMonth(probe.getMonth() - 1);
				break;
			case "quarterly":
				probe.setMonth(probe.getMonth() - 3);
				break;
			case "yearly":
				probe.setFullYear(probe.getFullYear() - 1);
				break;
		}
	}
	return count;
}

/** "Weekly · PDF to 2 addresses and Telegram" — one line describing a schedule in a list. */
export function describeSchedule(schedule: ReportSchedule): string {
	const targets: string[] = [];
	const emails = schedule.channels.email?.length ?? 0;
	if (emails > 0) targets.push(`${emails} email address${emails === 1 ? "" : "es"}`);
	if (schedule.channels.telegram) targets.push("Telegram");

	const formats = schedule.attachments.map((a) => a.toUpperCase()).join(" + ") || "no attachment";
	return `${CADENCE_LABEL[schedule.cadence]} · ${formats} to ${targets.join(" and ") || "nowhere yet"}`;
}
