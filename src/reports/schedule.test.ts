import { describe, expect, it } from "vitest";
import {
	completedPeriod,
	describeSchedule,
	hasAnyChannel,
	initialPeriodKey,
	isDue,
	nextDueAt,
	periodsMissed,
	type Cadence,
	type ReportSchedule,
} from "./schedule";

function schedule(over: Partial<ReportSchedule> = {}): ReportSchedule {
	return {
		id: "s1",
		name: "Monthly spending",
		enabled: true,
		cadence: "monthly",
		query: {},
		attachments: ["pdf"],
		channels: { email: ["me@example.com"] },
		...over,
	};
}

/** Local-time date, so the tests read in the same timezone the period math works in. */
function at(y: number, m: number, d: number, h = 12): Date {
	return new Date(y, m - 1, d, h);
}

describe("completedPeriod — always the period before this one", () => {
	it("monthly reports on last month, not a partial this month", () => {
		const p = completedPeriod("monthly", at(2025, 3, 3));
		expect(p).toEqual({ key: "2025-02", from: "2025-02-01", to: "2025-02-28", label: "February 2025" });
	});

	it("gets February right in a leap year", () => {
		expect(completedPeriod("monthly", at(2024, 3, 15)).to).toBe("2024-02-29");
	});

	it("rolls the year back on the 1st of January", () => {
		const p = completedPeriod("monthly", at(2025, 1, 1));
		expect(p.key).toBe("2024-12");
		expect(p.from).toBe("2024-12-01");
		expect(p.to).toBe("2024-12-31");
	});

	it("quarterly reports on the previous quarter", () => {
		expect(completedPeriod("quarterly", at(2025, 5, 20))).toEqual({
			key: "2025-Q1",
			from: "2025-01-01",
			to: "2025-03-31",
			label: "Q1 2025",
		});
	});

	it("quarterly rolls into the previous year in Q1", () => {
		const p = completedPeriod("quarterly", at(2025, 2, 10));
		expect(p.key).toBe("2024-Q4");
		expect(p.from).toBe("2024-10-01");
		expect(p.to).toBe("2024-12-31");
	});

	it("yearly reports on last year", () => {
		expect(completedPeriod("yearly", at(2025, 6, 6))).toEqual({
			key: "2024",
			from: "2024-01-01",
			to: "2024-12-31",
			label: "2024",
		});
	});

	it("weekly reports on the previous Monday-to-Sunday", () => {
		// Wednesday 12 March 2025; the completed week is Mon 3rd – Sun 9th.
		const p = completedPeriod("weekly", at(2025, 3, 12));
		expect(p.from).toBe("2025-03-03");
		expect(p.to).toBe("2025-03-09");
	});

	it("treats Sunday as the end of its week, not the start of the next", () => {
		// Sunday 9 March: still inside the 3rd–9th week, so the completed one is 24 Feb – 2 Mar.
		const p = completedPeriod("weekly", at(2025, 3, 9));
		expect(p.from).toBe("2025-02-24");
		expect(p.to).toBe("2025-03-02");
	});

	it("treats Monday as the start of a new week", () => {
		const p = completedPeriod("weekly", at(2025, 3, 10));
		expect(p.from).toBe("2025-03-03");
		expect(p.to).toBe("2025-03-09");
	});

	it("spans exactly seven days, whichever day it is asked on", () => {
		for (let day = 1; day <= 28; day++) {
			const p = completedPeriod("weekly", at(2025, 4, day));
			const from = new Date(`${p.from}T00:00:00`);
			const to = new Date(`${p.to}T00:00:00`);
			expect((to.getTime() - from.getTime()) / (24 * 3600 * 1000)).toBe(6);
			expect(from.getDay()).toBe(1);
			expect(to.getDay()).toBe(0);
		}
	});

	// ISO week numbering is where naive week maths double-sends or skips a report.
	it("numbers ISO weeks the way a calendar does around New Year", () => {
		// The week of 30 Dec 2024 – 5 Jan 2025 is ISO week 1 of 2025.
		expect(completedPeriod("weekly", at(2025, 1, 8)).key).toBe("2025-W01");
		// The week before that is week 52 of 2024.
		expect(completedPeriod("weekly", at(2025, 1, 1)).key).toBe("2024-W52");
	});

	it("gives every cadence a distinctly-shaped key", () => {
		// Mon 5 May 2025 — the completed week is Mon 28 Apr – Sun 4 May, ISO week 18.
		const keys = (["weekly", "monthly", "quarterly", "yearly"] as Cadence[]).map((c) => completedPeriod(c, at(2025, 5, 5)).key);
		expect(keys).toEqual(["2025-W18", "2025-04", "2025-Q1", "2024"]);
		expect(new Set(keys).size).toBe(4);
	});
});

describe("isDue", () => {
	it("is due when the completed period has not been delivered", () => {
		expect(isDue(schedule({ lastPeriodKey: "2025-01" }), at(2025, 3, 3))).toBe(true);
	});

	it("is not due once that period has been delivered", () => {
		expect(isDue(schedule({ lastPeriodKey: "2025-02" }), at(2025, 3, 3))).toBe(false);
	});

	it("stays not-due for the rest of the period, however many times it is checked", () => {
		const s = schedule({ lastPeriodKey: "2025-02" });
		for (const day of [3, 10, 20, 31]) expect(isDue(s, at(2025, 3, day))).toBe(false);
	});

	it("becomes due again when the next period completes", () => {
		expect(isDue(schedule({ lastPeriodKey: "2025-02" }), at(2025, 4, 1))).toBe(true);
	});

	it("is never due while disabled", () => {
		expect(isDue(schedule({ enabled: false, lastPeriodKey: "2025-01" }), at(2025, 3, 3))).toBe(false);
	});

	it("is never due with nowhere to send", () => {
		expect(isDue(schedule({ channels: {}, lastPeriodKey: "2025-01" }), at(2025, 3, 3))).toBe(false);
		expect(isDue(schedule({ channels: { email: [] }, lastPeriodKey: "2025-01" }), at(2025, 3, 3))).toBe(false);
	});

	// The whole point of keying on the delivered period rather than on a timer.
	it("fires exactly once after a long closure, not once per missed period", () => {
		const s = schedule({ lastPeriodKey: "2024-10" });
		expect(isDue(s, at(2025, 3, 3))).toBe(true);
		// Delivering the latest completed period settles it, however many were missed.
		const after = { ...s, lastPeriodKey: completedPeriod("monthly", at(2025, 3, 3)).key };
		expect(isDue(after, at(2025, 3, 3))).toBe(false);
	});
});

describe("initialPeriodKey", () => {
	// Saving a schedule must not itself send a report.
	it("starts a new schedule settled, so the first delivery is the next period", () => {
		const created = schedule({ lastPeriodKey: initialPeriodKey("monthly", at(2025, 3, 3)) });
		expect(isDue(created, at(2025, 3, 3))).toBe(false);
		expect(isDue(created, at(2025, 4, 1))).toBe(true);
	});
});

describe("nextDueAt", () => {
	it("points at the start of the next period for every cadence", () => {
		expect(nextDueAt("monthly", at(2025, 3, 15))).toEqual(new Date(2025, 3, 1));
		expect(nextDueAt("quarterly", at(2025, 5, 15))).toEqual(new Date(2025, 6, 1));
		expect(nextDueAt("yearly", at(2025, 5, 15))).toEqual(new Date(2026, 0, 1));
	});

	it("points at next Monday for a weekly schedule", () => {
		const next = nextDueAt("weekly", at(2025, 3, 12));
		expect(next.getDay()).toBe(1);
		expect(next.getDate()).toBe(17);
	});

	it("is always in the future", () => {
		const now = at(2025, 3, 12);
		for (const cadence of ["weekly", "monthly", "quarterly", "yearly"] as Cadence[]) {
			expect(nextDueAt(cadence, now).getTime()).toBeGreaterThan(now.getTime());
		}
	});
});

describe("periodsMissed", () => {
	it("is zero when up to date", () => {
		expect(periodsMissed(schedule({ lastPeriodKey: "2025-02" }), at(2025, 3, 3))).toBe(0);
	});

	// Delivering February right after January is on time, not one period late. Otherwise every
	// healthy monthly report would carry a "generated late" warning and nobody would read it.
	it("is zero when delivering the very next period", () => {
		expect(periodsMissed(schedule({ lastPeriodKey: "2025-01" }), at(2025, 3, 3))).toBe(0);
	});

	it("counts only the periods actually skipped", () => {
		// Delivered November, now delivering February: December and January were missed.
		expect(periodsMissed(schedule({ lastPeriodKey: "2024-11" }), at(2025, 3, 3))).toBe(2);
	});

	it("counts quarters and years too", () => {
		// Delivered Q2, now delivering Q1 next year: Q3 and Q4 were missed.
		expect(periodsMissed(schedule({ cadence: "quarterly", lastPeriodKey: "2024-Q2" }), at(2025, 5, 5))).toBe(2);
		// Delivered 2022, now delivering 2024: only 2023 was missed.
		expect(periodsMissed(schedule({ cadence: "yearly", lastPeriodKey: "2022" }), at(2025, 5, 5))).toBe(1);
	});

	it("reports nothing missed for a schedule that has never run", () => {
		expect(periodsMissed(schedule({ lastPeriodKey: undefined }), at(2025, 3, 3))).toBe(0);
	});

	it("terminates on a key that will never match", () => {
		expect(periodsMissed(schedule({ lastPeriodKey: "not-a-period" }), at(2025, 3, 3))).toBe(64);
	});
});

describe("hasAnyChannel", () => {
	it("needs at least one recipient or Telegram", () => {
		expect(hasAnyChannel(schedule({ channels: {} }))).toBe(false);
		expect(hasAnyChannel(schedule({ channels: { email: [] } }))).toBe(false);
		expect(hasAnyChannel(schedule({ channels: { telegram: true } }))).toBe(true);
		expect(hasAnyChannel(schedule({ channels: { email: ["a@b.c"] } }))).toBe(true);
	});
});

describe("describeSchedule", () => {
	it("says the cadence, the formats and where it goes", () => {
		const line = describeSchedule(schedule({ attachments: ["pdf", "csv"], channels: { email: ["a@b.c"], telegram: true } }));
		expect(line).toBe("Monthly · PDF + CSV to 1 email address and Telegram");
	});

	it("is honest about a schedule with nowhere to send", () => {
		expect(describeSchedule(schedule({ channels: {} }))).toContain("nowhere yet");
	});
});
