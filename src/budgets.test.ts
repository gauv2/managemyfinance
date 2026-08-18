import { describe, it, expect } from "vitest";
import { annualBudgetStatuses, budgetForMonth, suggestedBudget, budgetStatuses, currentMonth, oneOffBudgetStatus } from "./budgets";
import type { KpiStore } from "./kpi";
import type { Category, OneOffBudget, Transaction } from "./types";

const ACCOUNT_ID = "acc-checking";
const CREDIT_ID = "acc-credit";
const CAT_FOOD = "cat-food";

let nextId = 0;
function tx(date: string, amount: number, categoryId = CAT_FOOD, extra: Partial<Transaction> = {}): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, date, accountId: ACCOUNT_ID, amount, currency: "EUR", categoryId, description: "test", source: "manual", ...extra };
}

function cat(overrides: Partial<Category> & { id: string }): Category {
	return { name: overrides.id, color: "#000", icon: "tag", aliases: [], ...overrides };
}

function store(transactions: Transaction[], categories: Category[] = [cat({ id: CAT_FOOD, name: "Food" })]): KpiStore {
	return {
		accounts: [
			{ id: ACCOUNT_ID, name: "Checking", type: "debit", currency: "EUR" },
			{ id: CREDIT_ID, name: "Credit card", type: "credit", currency: "EUR" },
		],
		categories,
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
		const categories = [
			cat({ id: CAT_FOOD, budgetHistory: { "2024-06": 100 } }),
			cat({ id: "cat-unbudgeted", budgetHistory: undefined }),
		];
		const s = store([tx("2024-06-05", -40), tx("2024-06-10", -20)], categories);
		const statuses = budgetStatuses(s, categories, "2024-06");
		expect(statuses).toHaveLength(1);
		expect(statuses[0]).toMatchObject({ categoryId: CAT_FOOD, budget: 100, spent: 60, remaining: 40, tone: "good" });
	});

	it("flags warn at 80%+ and bad at 100%+ of budget", () => {
		const budgeted = [cat({ id: CAT_FOOD, budgetHistory: { "2024-06": 100 } })];
		const warnStore = store([tx("2024-06-05", -85)], budgeted);
		expect(budgetStatuses(warnStore, budgeted, "2024-06")[0].tone).toBe("warn");

		const badStore = store([tx("2024-06-05", -120)], budgeted);
		const bad = budgetStatuses(badStore, budgeted, "2024-06")[0];
		expect(bad.tone).toBe("bad");
		expect(bad.remaining).toBe(-20);
	});

	it("scopes spend to the given month only", () => {
		const budgeted = [cat({ id: CAT_FOOD, budgetHistory: { "2024-06": 100 } })];
		const s = store([tx("2024-05-05", -999), tx("2024-06-05", -10)], budgeted);
		const [status] = budgetStatuses(s, budgeted, "2024-06");
		expect(status.spent).toBe(10);
	});

	it("only counts the budget planned for that specific month, not other months' plans", () => {
		const budgeted = [cat({ id: CAT_FOOD, budgetHistory: { "2024-05": 50, "2024-07": 200 } })];
		const s = store([tx("2024-06-05", -10)], budgeted);
		const statuses = budgetStatuses(s, budgeted, "2024-06");
		expect(statuses).toHaveLength(0);
	});

	it("rolls up a secondary category's spend into its primary's total", () => {
		const primary = cat({ id: CAT_FOOD, name: "Food", budgetHistory: { "2024-06": 100 } });
		const secondary = cat({ id: "cat-groceries", name: "Groceries", parentId: CAT_FOOD });
		const categories = [primary, secondary];
		const s = store([tx("2024-06-05", -40, CAT_FOOD), tx("2024-06-10", -20, "cat-groceries")], categories);
		const [status] = budgetStatuses(s, categories, "2024-06");
		expect(status.spent).toBe(60);
	});
});

describe("budgetForMonth", () => {
	it("reads the category's own budgetHistory in total mode (the default)", () => {
		const category = cat({ id: CAT_FOOD, budgetHistory: { "2024-06": 100 } });
		expect(budgetForMonth([category], category, "2024-06")).toBe(100);
	});

	it("sums the secondary categories' own budgets in breakdown mode", () => {
		const primary = cat({ id: CAT_FOOD, budgetMode: "breakdown" });
		const groceries = cat({ id: "cat-groceries", parentId: CAT_FOOD, budgetHistory: { "2024-06": 60 } });
		const diningOut = cat({ id: "cat-dining", parentId: CAT_FOOD, budgetHistory: { "2024-06": 40 } });
		const categories = [primary, groceries, diningOut];
		expect(budgetForMonth(categories, primary, "2024-06")).toBe(100);
	});

	it("is undefined in breakdown mode when no secondary has a budget set for that month", () => {
		const primary = cat({ id: CAT_FOOD, budgetMode: "breakdown" });
		const groceries = cat({ id: "cat-groceries", parentId: CAT_FOOD });
		const categories = [primary, groceries];
		expect(budgetForMonth(categories, primary, "2024-06")).toBeUndefined();
	});

	it("falls back to its own budgetHistory in breakdown mode when it has no secondaries yet", () => {
		const primary = cat({ id: CAT_FOOD, budgetMode: "breakdown", budgetHistory: { "2024-06": 75 } });
		expect(budgetForMonth([primary], primary, "2024-06")).toBe(75);
	});
});

// ---------- income-actual budgeting (FIN-006) ----------

describe("budgetStatuses — income-kind categories", () => {
	it("sources spent from money actually earned into the category, not the expense-only path", () => {
		const CAT_FREELANCE = "cat-freelance";
		const categories = [cat({ id: CAT_FREELANCE, name: "Freelance income", kind: "income", budgetHistory: { "2024-06": 3000 } })];
		const s = store([tx("2024-06-05", 1800, CAT_FREELANCE), tx("2024-06-20", 700, CAT_FREELANCE)], categories);
		const [status] = budgetStatuses(s, categories, "2024-06");
		// Under the old expense-only path this would read spent: 0, pct: 0, tone: "bad" forever, since
		// nothing ever counts as "spent" against an income category on that path.
		expect(status.spent).toBe(2500);
		expect(status.pct).toBeCloseTo(2500 / 3000, 6);
		expect(status.tone).toBe("warn"); // 83% of an income target
	});

	it("doesn't let a trade or transfer mis-categorized under an income category count as earned", () => {
		const CAT_FREELANCE = "cat-freelance";
		const categories = [cat({ id: CAT_FREELANCE, name: "Freelance income", kind: "income", budgetHistory: { "2024-06": 1000 } })];
		// A transfer between the user's own accounts, tagged (mistakenly) under the income category.
		const s = store([tx("2024-06-05", 500, CAT_FREELANCE, { transferGroupId: "g1" })], categories);
		const [status] = budgetStatuses(s, categories, "2024-06");
		expect(status.spent).toBe(0);
	});
});

describe("annualBudgetStatuses — income-kind categories", () => {
	it("sources spent from earned income for the whole year, same as the monthly path", () => {
		const CAT_FREELANCE = "cat-freelance";
		const categories = [cat({ id: CAT_FREELANCE, name: "Freelance income", kind: "income", annualBudgets: { "2024": 10000 } })];
		const s = store([tx("2024-03-05", 4000, CAT_FREELANCE), tx("2024-09-10", 3000, CAT_FREELANCE)], categories);
		const [status] = annualBudgetStatuses(s, categories, "2024");
		expect(status.spent).toBe(7000);
	});
});

// ---------- oneOffBudgetStatus (FIN-007) ----------

describe("oneOffBudgetStatus", () => {
	function budget(overrides: Partial<OneOffBudget> = {}): OneOffBudget {
		return { id: "budget-1", name: "Wedding", amount: 3000, startDate: "2024-06-01", endDate: "2024-06-30", ...overrides };
	}

	it("nets a refund against the spend it returned, instead of ignoring positive-amount rows entirely", () => {
		// Refunds are only distinguishable from income once the vault has at least one income-kind
		// category (see refundsDistinguishable in semantics.ts) — a realistic vault has one.
		const categories = [cat({ id: CAT_FOOD, name: "Food" }), cat({ id: "cat-income", name: "Income", kind: "income" })];
		const s = store([tx("2024-06-05", -500), tx("2024-06-10", 120)], categories); // returned part of a purchase
		const status = oneOffBudgetStatus(s, budget());
		expect(status.spent).toBe(380); // 500 - 120, not 500
	});

	it("excludes a transfer between the user's own accounts from an unrestricted pot", () => {
		const s = store([tx("2024-06-05", -500), tx("2024-06-10", -1000, undefined, { transferGroupId: "g1" })]);
		const status = oneOffBudgetStatus(s, budget());
		expect(status.spent).toBe(500);
	});

	it("excludes a debt-principal payment (a credit-card payoff) from an unrestricted pot", () => {
		const s = store([tx("2024-06-05", -500), tx("2024-06-10", 800, undefined, { accountId: CREDIT_ID })]);
		const status = oneOffBudgetStatus(s, budget());
		expect(status.spent).toBe(500);
	});
});
