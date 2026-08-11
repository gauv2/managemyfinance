import { describe, it, expect } from "vitest";
import { suggestedBudget, budgetStatuses, currentMonth } from "./budgets";
import type { KpiStore } from "./kpi";
import type { Transaction } from "./types";

const ACCOUNT_ID = "acc-checking";
const CAT_FOOD = "cat-food";

let nextId = 0;
function tx(date: string, amount: number, categoryId = CAT_FOOD): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, date, accountId: ACCOUNT_ID, amount, currency: "EUR", categoryId, description: "test", source: "manual" };
}

function store(transactions: Transaction[]): KpiStore {
	return {
		accounts: [{ id: ACCOUNT_ID, name: "Checking", type: "debit", currency: "EUR" }],
		categories: [{ id: CAT_FOOD, name: "Food", color: "#000", icon: "utensils", aliases: [] }],
		transactions,
	};
}

describe("currentMonth", () => {
	it("returns a YYYY-MM string", () => {
		expect(currentMonth()).toMatch(/^\d{4}-\d{2}$/);
	});
});

describe("suggestedBudget", () => {
	it("averages the last 3 months' spend and rounds to the nearest €5", () => {
		const s = store([
			tx("2024-03-05", -100),
			tx("2024-04-05", -120),
			tx("2024-05-05", -95),
		]);
		// avg = (100+120+95)/3 = 105 -> already a multiple of 5
		expect(suggestedBudget(s, CAT_FOOD, "2024-06")).toBe(105);
	});

	it("rounds a non-multiple-of-5 average to the nearest 5", () => {
		const s = store([tx("2024-05-05", -101), tx("2024-04-05", -101), tx("2024-03-05", -101)]);
		expect(suggestedBudget(s, CAT_FOOD, "2024-06")).toBe(100); // 101 rounds down to 100
	});

	it("returns undefined when there's no transaction history at all", () => {
		expect(suggestedBudget(store([]), CAT_FOOD, "2024-06")).toBeUndefined();
	});

	it("does not count months before the user's earliest transaction as zero-spend", () => {
		// Only one month of history exists; a naive 3-month average would wrongly divide by 3.
		const s = store([tx("2024-05-05", -300)]);
		expect(suggestedBudget(s, CAT_FOOD, "2024-06")).toBe(300);
	});

	it("returns undefined when average spend is zero or negative (nothing to suggest)", () => {
		const s = store([tx("2024-05-05", 50)]); // positive amount, not an expense
		expect(suggestedBudget(s, CAT_FOOD, "2024-06")).toBeUndefined();
	});

	it("only considers the given category", () => {
		const s = store([tx("2024-05-05", -100, "cat-other")]);
		expect(suggestedBudget(s, CAT_FOOD, "2024-06")).toBeUndefined();
	});
});

describe("budgetStatuses", () => {
	it("computes spent/remaining/pct/tone for budgeted categories only", () => {
		const s = store([tx("2024-06-05", -40), tx("2024-06-10", -20)]);
		const categories = [
			{ id: CAT_FOOD, budgetHistory: { "2024-06": 100 } },
			{ id: "cat-unbudgeted", budgetHistory: undefined },
		];
		const statuses = budgetStatuses(s, categories, "2024-06");
		expect(statuses).toHaveLength(1);
		expect(statuses[0]).toMatchObject({ categoryId: CAT_FOOD, budget: 100, spent: 60, remaining: 40, tone: "good" });
	});

	it("flags warn at 80%+ and bad at 100%+ of budget", () => {
		const warnStore = store([tx("2024-06-05", -85)]);
		expect(budgetStatuses(warnStore, [{ id: CAT_FOOD, budgetHistory: { "2024-06": 100 } }], "2024-06")[0].tone).toBe("warn");

		const badStore = store([tx("2024-06-05", -120)]);
		const bad = budgetStatuses(badStore, [{ id: CAT_FOOD, budgetHistory: { "2024-06": 100 } }], "2024-06")[0];
		expect(bad.tone).toBe("bad");
		expect(bad.remaining).toBe(-20);
	});

	it("scopes spend to the given month only", () => {
		const s = store([tx("2024-05-05", -999), tx("2024-06-05", -10)]);
		const [status] = budgetStatuses(s, [{ id: CAT_FOOD, budgetHistory: { "2024-06": 100 } }], "2024-06");
		expect(status.spent).toBe(10);
	});

	it("only counts the budget planned for that specific month, not other months' plans", () => {
		const s = store([tx("2024-06-05", -10)]);
		const statuses = budgetStatuses(s, [{ id: CAT_FOOD, budgetHistory: { "2024-05": 50, "2024-07": 200 } }], "2024-06");
		expect(statuses).toHaveLength(0);
	});
});
