import { describe, expect, it } from "vitest";
import { buildComparison, cagr, pctChange, topCategories, type CategoryMeta } from "./compare";

const meta = new Map<string, CategoryMeta>([
	["food", { id: "food", label: "Food", color: "#f00" }],
	["travel", { id: "travel", label: "Travel", color: "#0f0" }],
	["kids", { id: "kids", label: "Kids", color: "#00f" }],
]);

const year = (entries: [string, number][]): Map<string, number> => new Map(entries);

describe("pctChange", () => {
	it("is the relative change against the previous value", () => {
		expect(pctChange(150, 100)).toBeCloseTo(0.5);
		expect(pctChange(50, 100)).toBeCloseTo(-0.5);
	});

	it("has no answer without a previous value", () => {
		expect(pctChange(100, undefined)).toBeUndefined();
	});

	it("refuses to divide by zero rather than reporting infinite growth", () => {
		expect(pctChange(100, 0)).toBeUndefined();
	});
});

describe("cagr", () => {
	it("is the per-year rate that compounds first into last", () => {
		// 100 -> 121 over two years is 10% a year.
		expect(cagr(100, 121, 2)).toBeCloseTo(0.1, 5);
	});

	it("distinguishes the same total growth over different spans", () => {
		const short = cagr(100, 160, 2);
		const long = cagr(100, 160, 5);
		expect(short).toBeDefined();
		expect(long).toBeDefined();
		expect(short as number).toBeGreaterThan(long as number);
	});

	it("has no answer when either end is zero or negative", () => {
		expect(cagr(0, 100, 2)).toBeUndefined();
		expect(cagr(100, 0, 2)).toBeUndefined();
		expect(cagr(-100, 100, 2)).toBeUndefined();
	});

	it("has no answer without a span", () => {
		expect(cagr(100, 200, 0)).toBeUndefined();
	});
});

describe("buildComparison", () => {
	const years = ["2024", "2025", "2026"];
	const totals = [
		year([["food", 1000], ["travel", 500]]),
		year([["food", 1200], ["travel", 400], ["kids", 100]]),
		year([["food", 1500], ["travel", 300], ["kids", 250]]),
	];

	it("zero-fills a category missing from a year rather than dropping it", () => {
		const c = buildComparison(years, totals, meta);
		const kids = c.rows.find((r) => r.categoryId === "kids");
		expect(kids?.values).toEqual([0, 100, 250]);
	});

	it("keeps every row the same width as the year list", () => {
		const c = buildComparison(years, totals, meta);
		c.rows.forEach((r) => expect(r.values).toHaveLength(years.length));
	});

	it("sorts by total spend so the biggest bill is first", () => {
		const c = buildComparison(years, totals, meta);
		expect(c.rows.map((r) => r.categoryId)).toEqual(["food", "travel", "kids"]);
	});

	it("totals each year down the column", () => {
		const c = buildComparison(years, totals, meta);
		expect(c.totals).toEqual([1500, 1700, 2050]);
	});

	it("reports change against the previous year, not the first", () => {
		const c = buildComparison(years, totals, meta);
		const food = c.rows.find((r) => r.categoryId === "food");
		expect(food?.changeAbs).toBe(300); // 1500 - 1200
		expect(food?.changePct).toBeCloseTo(0.25);
	});

	it("reports span change across the whole selection", () => {
		const c = buildComparison(years, totals, meta);
		const food = c.rows.find((r) => r.categoryId === "food");
		expect(food?.spanChangePct).toBeCloseTo(0.5); // 1000 -> 1500
	});

	it("gives a category that started at zero a change but no percentage", () => {
		const c = buildComparison(years, totals, meta);
		const kids = c.rows.find((r) => r.categoryId === "kids");
		expect(kids?.changeAbs).toBe(150);
		expect(kids?.spanChangePct).toBeUndefined();
		expect(kids?.cagr).toBeUndefined();
	});

	it("expresses each category as a share of the final year", () => {
		const c = buildComparison(years, totals, meta);
		const food = c.rows.find((r) => r.categoryId === "food");
		expect(food?.shareOfLast).toBeCloseTo(1500 / 2050);
	});

	it("separates risers from fallers by direction of travel", () => {
		const c = buildComparison(years, totals, meta);
		expect(c.risers.map((r) => r.categoryId)).toEqual(["food", "kids"]);
		expect(c.fallers.map((r) => r.categoryId)).toEqual(["travel"]);
	});

	it("labels an unknown category id rather than rendering a raw id", () => {
		const c = buildComparison(["2026"], [year([["mystery", 10]])], meta);
		expect(c.rows[0].label).toBe("Uncategorized");
	});

	it("has no comparisons at all for a single year", () => {
		const c = buildComparison(["2026"], [year([["food", 100]])], meta);
		expect(c.rows[0].changePct).toBeUndefined();
		expect(c.rows[0].spanChangePct).toBeUndefined();
		expect(c.totalChangePct).toBeUndefined();
	});

	it("survives a year with no spending at all", () => {
		const c = buildComparison(["2025", "2026"], [year([]), year([["food", 100]])], meta);
		expect(c.totals).toEqual([0, 100]);
		expect(c.rows[0].changePct).toBeUndefined();
		expect(c.rows[0].shareOfLast).toBeCloseTo(1);
	});
});

describe("topCategories", () => {
	it("takes the biggest spenders, in order", () => {
		const c = buildComparison(
			["2026"],
			[year([["food", 10], ["travel", 90], ["kids", 50]])],
			meta
		);
		expect(topCategories(c, 2)).toEqual(["travel", "kids"]);
	});

	it("asking for more than exists returns what there is", () => {
		const c = buildComparison(["2026"], [year([["food", 10]])], meta);
		expect(topCategories(c, 10)).toEqual(["food"]);
	});
});

describe("a long span", () => {
	// The page is meant to grow as older years get imported, so the maths has to hold over a span
	// several times longer than the default selection rather than just the recent two or three.
	const years = ["2020", "2021", "2022", "2023", "2024", "2025", "2026"];
	const totals = years.map((_y, i) => new Map([["food", 1000 + i * 100], ["travel", 2000 - i * 200]]));

	it("keeps every row as wide as the span", () => {
		const c = buildComparison(years, totals, meta);
		c.rows.forEach((r) => expect(r.values).toHaveLength(7));
	});

	it("compares the last year against the previous one, not the oldest", () => {
		const c = buildComparison(years, totals, meta);
		const food = c.rows.find((r) => r.categoryId === "food");
		expect(food?.changeAbs).toBe(100); // 1600 - 1500
	});

	it("measures the span end to end", () => {
		const c = buildComparison(years, totals, meta);
		const food = c.rows.find((r) => r.categoryId === "food");
		expect(food?.spanChangePct).toBeCloseTo(0.6); // 1000 -> 1600
	});

	it("spreads the growth rate over every step of the span", () => {
		const c = buildComparison(years, totals, meta);
		const food = c.rows.find((r) => r.categoryId === "food");
		// Six steps from 1000 to 1600, not one.
		expect(food?.cagr).toBeCloseTo(Math.pow(1.6, 1 / 6) - 1, 6);
	});

	it("still sorts by total across the whole span", () => {
		const c = buildComparison(years, totals, meta);
		// travel declines but starts high; over seven years it still outspends food.
		expect(c.rows[0].categoryId).toBe("travel");
	});

	it("catches a falling category even while the total rises", () => {
		const c = buildComparison(years, totals, meta);
		expect(c.fallers.map((r) => r.categoryId)).toContain("travel");
		expect(c.risers.map((r) => r.categoryId)).toContain("food");
	});
});
