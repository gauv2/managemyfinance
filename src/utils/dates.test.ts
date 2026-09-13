import { describe, expect, it } from "vitest";
import { detectDateOrder, parseFlexibleDate } from "./dates";

describe("parseFlexibleDate", () => {
	it("reads YYYYMMDD straight through", () => {
		expect(parseFlexibleDate("20260812")).toBe("2026-08-12");
	});

	it("passes an already-ISO date through unchanged", () => {
		expect(parseFlexibleDate("2026-08-12")).toBe("2026-08-12");
	});

	it("defaults slash dates to day-first, matching ING/Trade Republic's own exports", () => {
		expect(parseFlexibleDate("27/07/2026")).toBe("2026-07-27");
	});

	it("reads month-first when explicitly told to", () => {
		expect(parseFlexibleDate("08/12/2026", "mdy")).toBe("2026-08-12");
	});

	it("expands a two-digit year the same way regardless of order", () => {
		expect(parseFlexibleDate("05/06/99", "dmy")).toBe("1999-06-05");
		expect(parseFlexibleDate("05/06/24", "mdy")).toBe("2024-05-06");
	});
});

describe("detectDateOrder", () => {
	it("settles day-first from a single unambiguous date", () => {
		expect(detectDateOrder(["08/08/2026", "27/07/2026", "05/06/2026"])).toBe("dmy");
	});

	it("settles month-first from a single unambiguous date — the AMEX bug this exists to catch", () => {
		// A real AMEX (US-format) export: every date here is "08/DD/2026" (August), but 18 and 17 can
		// only be days, proving the whole batch is month-first even though most rows look D/M-plausible.
		expect(detectDateOrder(["08/12/2026", "08/09/2026", "08/08/2026", "08/07/2026", "08/05/2026", "08/18/2026", "08/17/2026"])).toBe("mdy");
	});

	it("falls back to day-first when every date in the batch is genuinely ambiguous", () => {
		expect(detectDateOrder(["01/05/2026", "02/06/2026"])).toBe("dmy");
	});

	it("ignores non-slash values (8-digit or ISO) when settling the order", () => {
		expect(detectDateOrder(["20260101", "2026-01-01", "08/18/2026"])).toBe("mdy");
	});
});

describe("dates with separators other than slash", () => {
	it("reads a dash-separated European date day-first", () => {
		// KNAB writes 28-10-2014. This used to fall through to `new Date`, which cannot read it at all,
		// so the raw string was handed to the ledger as if it were a date.
		expect(parseFlexibleDate("28-10-2014", "dmy")).toBe("2014-10-28");
		expect(parseFlexibleDate("07-12-2019", "dmy")).toBe("2019-12-07");
	});

	it("does not transpose a dash date that `new Date` would read month-first", () => {
		// The dangerous half: 12-08-2019 is 12 August, but `new Date` calls it 8 December and then
		// `toISOString` moved it back a day to 2019-12-07 — wrong month and wrong day, looking valid.
		expect(parseFlexibleDate("12-08-2019", "dmy")).toBe("2019-08-12");
	});

	it("reads dot-separated dates too", () => {
		expect(parseFlexibleDate("28.10.2014", "dmy")).toBe("2014-10-28");
	});

	it("still honours month-first when the batch says so", () => {
		expect(parseFlexibleDate("12-08-2019", "mdy")).toBe("2019-12-08");
	});

	it("passes an ISO date through untouched, whatever the timezone", () => {
		expect(parseFlexibleDate("2019-08-12")).toBe("2019-08-12");
		expect(parseFlexibleDate("2019-08-12T09:30:00Z")).toBe("2019-08-12");
	});

	it("detects the order from dash-separated dates as well as slashes", () => {
		expect(detectDateOrder(["05-06-2019", "28-10-2014"])).toBe("dmy");
		expect(detectDateOrder(["05-06-2019", "10-28-2014"])).toBe("mdy");
		expect(detectDateOrder(["05.06.2019", "28.10.2014"])).toBe("dmy");
	});

	it("leaves something that is not a date alone", () => {
		expect(parseFlexibleDate("not a date")).toBe("not a date");
		expect(parseFlexibleDate("")).toBe("");
	});
});
