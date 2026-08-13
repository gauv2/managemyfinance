import { describe, it, expect } from "vitest";
import {
	describeRange,
	emptyPeriodSelection,
	monthOptions,
	monthRange,
	monthsInRange,
	periodOptions,
	periodRange,
	resolvePeriodRange,
	selectionRange,
	transactionYears,
	weekOptions,
	weekRangeFrom,
	PERIOD_ALL,
	PERIOD_CUSTOM,
} from "./period";

/** Local-time construction throughout, matching what periodRange does internally. */
const on = (year: number, month: number, day: number): Date => new Date(year, month - 1, day);

describe("periodRange — weeks", () => {
	it("runs Monday to Sunday around a midweek day", () => {
		// Thursday 13 August 2026.
		expect(periodRange("week", on(2026, 8, 13))).toEqual({ from: "2026-08-10", to: "2026-08-16" });
	});

	it("keeps Monday itself at the start of its own week", () => {
		expect(periodRange("week", on(2026, 8, 10))).toEqual({ from: "2026-08-10", to: "2026-08-16" });
	});

	it("keeps Sunday at the end of the week that preceded it, not the start of the next one", () => {
		expect(periodRange("week", on(2026, 8, 16))).toEqual({ from: "2026-08-10", to: "2026-08-16" });
	});

	it("spans the month boundary when the week straddles one", () => {
		// Wednesday 1 July 2026 sits in a week that starts in June.
		expect(periodRange("week", on(2026, 7, 1))).toEqual({ from: "2026-06-29", to: "2026-07-05" });
	});

	it("spans the year boundary", () => {
		// Friday 1 January 2027.
		expect(periodRange("week", on(2027, 1, 1))).toEqual({ from: "2026-12-28", to: "2027-01-03" });
	});
});

describe("periodRange — months", () => {
	it("covers the whole current month", () => {
		expect(periodRange("month", on(2026, 8, 13))).toEqual({ from: "2026-08-01", to: "2026-08-31" });
	});

	it("gets a 30-day month's last day right", () => {
		expect(periodRange("month", on(2026, 4, 7))).toEqual({ from: "2026-04-01", to: "2026-04-30" });
	});

	it("handles February in a leap year", () => {
		expect(periodRange("month", on(2028, 2, 3))).toEqual({ from: "2028-02-01", to: "2028-02-29" });
	});

	it("handles February in a common year", () => {
		expect(periodRange("month", on(2026, 2, 3))).toEqual({ from: "2026-02-01", to: "2026-02-28" });
	});

	it("returns the previous month for last-month", () => {
		expect(periodRange("last-month", on(2026, 8, 13))).toEqual({ from: "2026-07-01", to: "2026-07-31" });
	});

	it("rolls last-month back into the previous December from January", () => {
		expect(periodRange("last-month", on(2026, 1, 15))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
	});

	it("clamps last-month to the shorter month's own end", () => {
		// From 31 March, "last month" is February — not 1–31 February.
		expect(periodRange("last-month", on(2026, 3, 31))).toEqual({ from: "2026-02-01", to: "2026-02-28" });
	});
});

describe("periodRange — years and non-ranges", () => {
	it("expands a four-digit preset to the whole calendar year", () => {
		expect(periodRange("2025", on(2026, 8, 13))).toEqual({ from: "2025-01-01", to: "2025-12-31" });
	});

	it("expands the current year the same way as any other", () => {
		expect(periodRange("2026", on(2026, 8, 13))).toEqual({ from: "2026-01-01", to: "2026-12-31" });
	});

	it("returns no range for all-time and custom", () => {
		expect(periodRange(PERIOD_ALL, on(2026, 8, 13))).toBeUndefined();
		expect(periodRange(PERIOD_CUSTOM, on(2026, 8, 13))).toBeUndefined();
	});

	it("returns no range for anything it doesn't recognise", () => {
		expect(periodRange("quarter", on(2026, 8, 13))).toBeUndefined();
		expect(periodRange("20260", on(2026, 8, 13))).toBeUndefined();
	});
});

describe("transactionYears", () => {
	it("returns distinct years, newest first", () => {
		expect(transactionYears(["2024-03-01", "2026-01-09", "2024-12-31", "2025-06-15"])).toEqual(["2026", "2025", "2024"]);
	});

	it("skips blanks and malformed dates", () => {
		expect(transactionYears(["2026-02-02", undefined, "", "not a date", "2026", "13.08.2026"])).toEqual(["2026"]);
	});

	it("returns nothing for an empty ledger", () => {
		expect(transactionYears([])).toEqual([]);
	});
});

describe("periodOptions", () => {
	it("puts the relative presets above the years the data covers", () => {
		const options = periodOptions(["2026", "2024"]);
		expect(options.map((o) => o.value)).toEqual(["", "week", "month", "last-month", "2026", "2024", "custom"]);
		expect(options.map((o) => o.label)).toEqual(["All time", "This week", "This month", "Last month", "2026", "2024", "Custom range…"]);
	});

	it("still offers the presets and custom range on an empty ledger", () => {
		expect(periodOptions([]).map((o) => o.value)).toEqual(["", "week", "month", "last-month", "custom"]);
	});
});

describe("monthRange", () => {
	it("covers a whole month", () => {
		expect(monthRange("2026-08")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
	});

	it("gets short and leap-year months right", () => {
		expect(monthRange("2026-04")).toEqual({ from: "2026-04-01", to: "2026-04-30" });
		expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
		expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
	});

	it("rejects anything that isn't a YYYY-MM", () => {
		expect(monthRange("2026")).toBeUndefined();
		expect(monthRange("2026-13")).toBeUndefined();
		expect(monthRange("2026-00")).toBeUndefined();
		expect(monthRange("")).toBeUndefined();
	});
});

describe("weekRangeFrom", () => {
	it("spans the seven days from the given Monday", () => {
		expect(weekRangeFrom("2026-08-10")).toEqual({ from: "2026-08-10", to: "2026-08-16" });
	});

	it("keeps a straddling week's real span rather than clipping it to a month", () => {
		expect(weekRangeFrom("2026-07-27")).toEqual({ from: "2026-07-27", to: "2026-08-02" });
	});

	it("crosses a year end", () => {
		expect(weekRangeFrom("2026-12-28")).toEqual({ from: "2026-12-28", to: "2027-01-03" });
	});

	it("rejects a non-date", () => {
		expect(weekRangeFrom("2026-08")).toBeUndefined();
	});
});

describe("monthOptions", () => {
	const dates = ["2026-08-13", "2026-08-02", "2026-03-19", "2025-11-04", "2026-01-01"];

	it("lists only months of the chosen year that have transactions, in calendar order", () => {
		const options = monthOptions(dates, "2026");
		expect(options.map((o) => o.value)).toEqual(["", "2026-01", "2026-03", "2026-08"]);
		expect(options.map((o) => o.label)).toEqual(["All of 2026", "January", "March", "August"]);
	});

	it("scopes to the year asked for", () => {
		expect(monthOptions(dates, "2025").map((o) => o.value)).toEqual(["", "2025-11"]);
	});

	it("offers just the all-of-year default when that year has nothing", () => {
		expect(monthOptions(dates, "2019")).toEqual([{ value: "", label: "All of 2019" }]);
	});

	it("ignores malformed dates", () => {
		expect(monthOptions(["2026-13-01", "not a date", undefined, "2026-06-01"], "2026").map((o) => o.value)).toEqual(["", "2026-06"]);
	});
});

describe("weekOptions", () => {
	it("lists the Monday–Sunday weeks overlapping the month that have transactions", () => {
		// August 2026 starts on a Saturday, so its first week begins 27 July.
		const options = weekOptions(["2026-07-28", "2026-08-05", "2026-08-13", "2026-08-31"], "2026-08");
		expect(options.map((o) => o.value)).toEqual(["", "2026-07-27", "2026-08-03", "2026-08-10", "2026-08-31"]);
		expect(options.map((o) => o.label)).toEqual(["All of August", "27 Jul – 2 Aug", "3 – 9 Aug", "10 – 16 Aug", "31 Aug – 6 Sep"]);
	});

	it("skips weeks with nothing in them, so no week can select an empty table", () => {
		const options = weekOptions(["2026-08-13"], "2026-08");
		expect(options.map((o) => o.value)).toEqual(["", "2026-08-10"]);
	});

	it("counts a transaction in the part of a straddling week that falls outside the month", () => {
		// 28 July is in the week that carries into August, and nothing else that week is in August.
		expect(weekOptions(["2026-07-28"], "2026-08").map((o) => o.value)).toEqual(["", "2026-07-27"]);
	});

	it("labels a week that straddles the turn of a year", () => {
		expect(weekOptions(["2026-12-30"], "2026-12").map((o) => o.label)).toEqual(["All of December", "28 Dec – 3 Jan"]);
	});

	it("offers just the all-of-month default when the month is empty", () => {
		expect(weekOptions([], "2026-08")).toEqual([{ value: "", label: "All of August" }]);
	});

	it("returns nothing for a malformed month", () => {
		expect(weekOptions(["2026-08-13"], "2026")).toEqual([]);
		expect(weekOptions(["2026-08-13"], "2026-13")).toEqual([]);
	});
});

describe("resolvePeriodRange", () => {
	const at = (period: string, month = "", week = ""): ReturnType<typeof resolvePeriodRange> =>
		resolvePeriodRange({ period, month, week }, on(2026, 8, 13));

	it("takes the year when nothing under it is chosen", () => {
		expect(at("2025")).toEqual({ from: "2025-01-01", to: "2025-12-31" });
	});

	it("lets a month beat the year it sits in", () => {
		expect(at("2026", "2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
	});

	it("lets a week beat the month it sits in, spilling past the month's end", () => {
		expect(at("2026", "2026-08", "2026-08-31")).toEqual({ from: "2026-08-31", to: "2026-09-06" });
	});

	it("resolves the relative presets against the day it is given", () => {
		expect(at("week")).toEqual({ from: "2026-08-10", to: "2026-08-16" });
		expect(at("month")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
		expect(at("last-month")).toEqual({ from: "2026-07-01", to: "2026-07-31" });
	});

	it("names no range for all time or a custom range", () => {
		expect(at(PERIOD_ALL)).toBeUndefined();
		expect(at(PERIOD_CUSTOM)).toBeUndefined();
	});
});

describe("selectionRange", () => {
	it("is undefined for a fresh selection", () => {
		expect(selectionRange(emptyPeriodSelection())).toBeUndefined();
	});

	it("carries a half-open range through as it was typed", () => {
		expect(selectionRange({ ...emptyPeriodSelection(), period: PERIOD_CUSTOM, from: "2026-03-01" })).toEqual({
			from: "2026-03-01",
			to: "",
		});
	});
});

describe("describeRange", () => {
	it("says All time when there is no range", () => {
		expect(describeRange()).toBe("All time");
		expect(describeRange({ from: "", to: "" })).toBe("All time");
	});

	it("names whole years by their year alone", () => {
		expect(describeRange({ from: "2026-01-01", to: "2026-12-31" })).toBe("2026");
		expect(describeRange({ from: "2024-01-01", to: "2026-12-31" })).toBe("2024–2026");
	});

	it("names a whole month", () => {
		expect(describeRange({ from: "2026-02-01", to: "2026-02-28" })).toBe("February 2026");
	});

	it("does not call a part of a month the whole month", () => {
		expect(describeRange({ from: "2026-02-01", to: "2026-02-14" })).toBe("1 – 14 Feb 2026");
	});

	it("falls back to days for anything shorter", () => {
		expect(describeRange({ from: "2026-08-10", to: "2026-08-16" })).toBe("10 – 16 Aug 2026");
		expect(describeRange({ from: "2026-07-27", to: "2026-08-02" })).toBe("27 Jul – 2 Aug 2026");
		expect(describeRange({ from: "2026-12-28", to: "2027-01-03" })).toBe("28 Dec 2026 – 3 Jan 2027");
	});

	it("describes an open end for a half-typed custom range", () => {
		expect(describeRange({ from: "2026-03-01", to: "" })).toBe("from 2026-03-01");
		expect(describeRange({ from: "", to: "2026-03-01" })).toBe("up to 2026-03-01");
	});
});

describe("monthsInRange", () => {
	it("counts the calendar months a range touches, both ends included", () => {
		expect(monthsInRange({ from: "2026-01-01", to: "2026-12-31" })).toBe(12);
		expect(monthsInRange({ from: "2026-03-01", to: "2026-04-30" })).toBe(2);
		expect(monthsInRange({ from: "2025-11-01", to: "2026-02-28" })).toBe(4);
	});

	it("never divides by less than one month, however short the range", () => {
		expect(monthsInRange({ from: "2026-08-10", to: "2026-08-16" })).toBe(1);
		expect(monthsInRange({ from: "2026-08-10", to: "2026-08-10" })).toBe(1);
	});

	it("falls back to the end that is set when the other is open", () => {
		expect(monthsInRange({ from: "2026-08-01", to: "" })).toBe(1);
		expect(monthsInRange({ from: "", to: "" })).toBe(1);
	});
});
