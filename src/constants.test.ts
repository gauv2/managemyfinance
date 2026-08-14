import { describe, it, expect } from "vitest";
import { budgetTone, isIncomeCategory } from "./budgets";
import { defaultCategories, defaultSecondaryCategories } from "./constants";

/**
 * The default category set. Mostly inert data, with one flag that actually changes how a number is
 * read: `kind`, which decides whether a budget is a ceiling to stay under or a target to reach.
 */
describe("defaultCategories", () => {
	const defaults = defaultCategories();

	it("marks Income as an income category", () => {
		const income = defaults.find((c) => c.name === "Income");
		expect(income).toBeDefined();
		expect(isIncomeCategory(income!)).toBe(true);
	});

	it("reads a met income budget as good news rather than an overrun", () => {
		// The bug this pins: without `kind`, Income fell through to the expense branch of budgetTone,
		// where being at or over budget is "bad" — so earning your target lit up red.
		const income = defaults.find((c) => c.name === "Income")!;
		expect(budgetTone(1.2, isIncomeCategory(income))).toBe("good");
		expect(budgetTone(0.5, isIncomeCategory(income))).toBe("bad");
	});

	it("leaves every other default as an expense category", () => {
		const flagged = defaults.filter((c) => c.kind === "income").map((c) => c.name);
		expect(flagged).toEqual(["Income"]);
	});

	it("omits the key entirely on expense categories rather than storing undefined", () => {
		// Keeps an untouched category serialising byte-for-byte as it always did.
		const food = defaults.find((c) => c.name === "Food")!;
		expect("kind" in food).toBe(false);
	});

	it("still produces unique ids and no accidental parents", () => {
		const ids = defaults.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(defaults.every((c) => c.parentId === undefined)).toBe(true);
	});

	it("seeds secondaries that inherit their primary's colour and point back at it", () => {
		const food = defaults.find((c) => c.name === "Food")!;
		const subs = defaultSecondaryCategories([food]);
		expect(subs.length).toBeGreaterThan(0);
		expect(subs.every((s) => s.parentId === food.id)).toBe(true);
		expect(subs.every((s) => s.color === food.color)).toBe(true);
	});
});
