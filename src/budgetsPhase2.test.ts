import { describe, expect, it } from "vitest";
import {
	annualBudgetStatuses,
	budgetAlerts,
	budgetStatuses,
	budgetTone,
	oneOffBudgetStatus,
	rolloverInto,
	yearReview,
} from "./budgets";
import type { KpiStore } from "./kpi";
import type { Account, Category, OneOffBudget, Transaction } from "./types";

const account: Account = { id: "acc", name: "Checking", type: "debit", currency: "EUR", openingBalance: 0 };
const food: Category = { id: "cat-food", name: "Food", color: "#000", icon: "utensils", aliases: [] };
const salary: Category = { id: "cat-salary", name: "Salary", color: "#000", icon: "coins", aliases: [], kind: "income" };
const travel: Category = { id: "cat-travel", name: "Travel", color: "#000", icon: "plane", aliases: [] };
const flights: Category = { id: "cat-flights", name: "Flights", color: "#000", icon: "plane", aliases: [], parentId: travel.id };

let nextId = 0;
function tx(date: string, amount: number, categoryId?: string): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, date, accountId: account.id, description: "test", amount, currency: "EUR", source: "manual", categoryId };
}

function store(transactions: Transaction[], categories: Category[] = [food, salary, travel, flights]): KpiStore {
	return { accounts: [account], categories, transactions };
}

describe("rollover", () => {
	it("carries an unspent month into the next one", () => {
		const cat: Category = { ...food, rollover: true, budgetHistory: { "2024-01": 300, "2024-02": 300 } };
		const s = store([tx("2024-01-10", -100, cat.id)], [cat]);

		// January planned 300 and spent 100, so February has its own 300 plus 200 carried in.
		expect(rolloverInto(s, [cat], cat, "2024-02")).toBe(200);
		const status = budgetStatuses(s, [cat], "2024-02")[0];
		expect(status.available).toBe(500);
		expect(status.remaining).toBe(500);
	});

	it("carries an overspend forward as a negative, so the pot can genuinely run dry", () => {
		const cat: Category = { ...food, rollover: true, budgetHistory: { "2024-01": 300, "2024-02": 300 } };
		const s = store([tx("2024-01-10", -500, cat.id)], [cat]);

		expect(rolloverInto(s, [cat], cat, "2024-02")).toBe(-200);
		expect(budgetStatuses(s, [cat], "2024-02")[0].available).toBe(100);
	});

	it("only counts months that actually had a budget planned", () => {
		const cat: Category = { ...food, rollover: true, budgetHistory: { "2024-03": 300 } };
		const s = store([], [cat]);
		// Started budgeting in March, so March doesn't arrive with credit for January and February.
		expect(rolloverInto(s, [cat], cat, "2024-03")).toBe(0);
	});

	it("does nothing at all when rollover is off", () => {
		const cat: Category = { ...food, budgetHistory: { "2024-01": 300, "2024-02": 300 } };
		const s = store([], [cat]);
		expect(rolloverInto(s, [cat], cat, "2024-02")).toBe(0);
		expect(budgetStatuses(s, [cat], "2024-02")[0].available).toBe(300);
	});

	it("accumulates across several months", () => {
		const cat: Category = { ...food, rollover: true, budgetHistory: { "2024-01": 100, "2024-02": 100, "2024-03": 100 } };
		const s = store([], [cat]);
		expect(rolloverInto(s, [cat], cat, "2024-03")).toBe(200);
	});
});

describe("income categories", () => {
	it("reads a percentage the opposite way round from an expense category", () => {
		expect(budgetTone(1.2, false)).toBe("bad");
		expect(budgetTone(1.2, true)).toBe("good");
		expect(budgetTone(0.5, false)).toBe("good");
		expect(budgetTone(0.5, true)).toBe("bad");
	});

	it("marks an income category's status as such, sourced from money actually earned into it (FIN-006)", () => {
		// A positive amount — money actually coming in — not the negative-amount fixture this test used
		// to have: that predates the FIN-006 fix and relied on the old expense-only "spent" path reading
		// a -1200 transaction as 1200 of income "earned" purely because of its category's kind, which is
		// exactly the financially-wrong reading FIN-006 replaced. See kpi.ts's primaryCategoryIncomeTotals.
		const cat: Category = { ...salary, budgetHistory: { "2024-01": 1000 } };
		const s = store([tx("2024-01-10", 1200, cat.id)], [cat]);
		const status = budgetStatuses(s, [cat], "2024-01")[0];
		expect(status.isIncome).toBe(true);
		expect(status.spent).toBe(1200);
		expect(status.tone).toBe("good");
	});
});

describe("budgetAlerts", () => {
	it("reports categories at or past the threshold, worst first", () => {
		const a: Category = { ...food, budgetHistory: { "2024-01": 100 } };
		const b: Category = { ...travel, budgetHistory: { "2024-01": 100 } };
		const s = store([tx("2024-01-10", -95, a.id), tx("2024-01-10", -150, b.id)], [a, b]);

		const alerts = budgetAlerts(s, [a, b], "2024-01", 0.9);
		expect(alerts.map((x) => x.categoryName)).toEqual(["Travel", "Food"]);
		expect(alerts[0].severity).toBe("over");
		expect(alerts[1].severity).toBe("near");
	});

	it("stays quiet below the threshold", () => {
		const cat: Category = { ...food, budgetHistory: { "2024-01": 100 } };
		const s = store([tx("2024-01-10", -50, cat.id)], [cat]);
		expect(budgetAlerts(s, [cat], "2024-01", 0.9)).toEqual([]);
	});

	it("never warns about an income target — a notification can't help you earn more", () => {
		const cat: Category = { ...salary, budgetHistory: { "2024-01": 1000 } };
		const s = store([tx("2024-01-10", -2000, cat.id)], [cat]);
		expect(budgetAlerts(s, [cat], "2024-01", 0.9)).toEqual([]);
	});
});

describe("annual budgets", () => {
	it("scores a whole year's spend against a whole-year envelope", () => {
		const cat: Category = { ...food, annualBudgets: { "2024": 1200 } };
		const s = store([tx("2024-01-10", -400, cat.id), tx("2024-09-10", -200, cat.id)], [cat]);

		const status = annualBudgetStatuses(s, [cat], "2024")[0];
		expect(status.budget).toBe(1200);
		expect(status.spent).toBe(600);
		expect(status.remaining).toBe(600);
		expect(status.tone).toBe("good");
	});

	it("is independent of any month — one big January payment isn't a January problem", () => {
		const cat: Category = { ...food, annualBudgets: { "2024": 1200 }, budgetHistory: { "2024-01": 100 } };
		const s = store([tx("2024-01-10", -1200, cat.id)], [cat]);

		expect(annualBudgetStatuses(s, [cat], "2024")[0].pct).toBe(1);
		expect(budgetStatuses(s, [cat], "2024-01")[0].pct).toBe(12);
	});

	it("ignores years with no envelope set", () => {
		const cat: Category = { ...food, annualBudgets: { "2024": 1200 } };
		expect(annualBudgetStatuses(store([], [cat]), [cat], "2023")).toEqual([]);
	});
});

describe("one-off budgets", () => {
	const budget: OneOffBudget = {
		id: "o1",
		name: "Japan",
		amount: 3000,
		startDate: "2024-03-01",
		endDate: "2024-04-30",
	};

	it("counts every expense inside its window when no categories are set", () => {
		const s = store([tx("2024-03-15", -500), tx("2024-04-01", -700), tx("2024-05-01", -900)]);
		const status = oneOffBudgetStatus(s, budget, new Date("2024-04-15T00:00:00Z"));
		expect(status.spent).toBe(1200);
		expect(status.transactionCount).toBe(2);
		expect(status.remaining).toBe(1800);
	});

	it("restricts to the chosen categories, including their subcategories", () => {
		const scoped: OneOffBudget = { ...budget, categoryIds: [travel.id] };
		const s = store([tx("2024-03-15", -500, travel.id), tx("2024-03-16", -300, flights.id), tx("2024-03-17", -100, food.id)]);

		const status = oneOffBudgetStatus(s, scoped, new Date("2024-04-15T00:00:00Z"));
		expect(status.spent).toBe(800);
	});

	it("ignores income inside the window", () => {
		const s = store([tx("2024-03-15", 5000), tx("2024-03-16", -100)]);
		expect(oneOffBudgetStatus(s, budget, new Date("2024-04-15T00:00:00Z")).spent).toBe(100);
	});

	it("reports days left, negative once the window has closed", () => {
		const s = store([]);
		expect(oneOffBudgetStatus(s, budget, new Date("2024-04-20T00:00:00Z")).daysLeft).toBe(10);
		expect(oneOffBudgetStatus(s, budget, new Date("2024-05-10T00:00:00Z")).daysLeft).toBe(-10);
	});
});

describe("yearReview", () => {
	it("pairs each month's plan with what actually happened", () => {
		const cat: Category = { ...food, budgetHistory: { "2024-01": 300, "2024-02": 300 } };
		const s = store([tx("2024-01-10", -250, cat.id), tx("2024-02-10", -400, cat.id)], [cat]);

		const rows = yearReview(s, [cat], "2024");
		expect(rows).toHaveLength(1);
		expect(rows[0].plannedTotal).toBe(600);
		expect(rows[0].actualTotal).toBe(650);
		expect(rows[0].variance).toBe(-50);
		expect(rows[0].monthsPlanned).toBe(2);
		expect(rows[0].monthsOnTarget).toBe(1);
	});

	it("leaves out categories with neither a plan nor any spend", () => {
		const s = store([tx("2024-01-10", -100, food.id)], [food, travel]);
		expect(yearReview(s, [food, travel], "2024").map((r) => r.categoryId)).toEqual([food.id]);
	});

	it("still lists a category that was never planned but was spent on", () => {
		const s = store([tx("2024-01-10", -100, food.id)], [food]);
		const row = yearReview(s, [food], "2024")[0];
		expect(row.plannedTotal).toBe(0);
		expect(row.monthsPlanned).toBe(0);
		expect(row.actualTotal).toBe(100);
	});
});

describe("rollover consistency with the rest of the app", () => {
	it("excludes a transfer from the carried-forward balance, same as every other total does", () => {
		const transfers: Category = { id: "cat-transfers", name: "Transfers", color: "#000", icon: "x", aliases: [] };
		const cat: Category = { ...food, rollover: true, budgetHistory: { "2024-01": 300, "2024-02": 300 } };
		// A row categorized as a transfer isn't spending, so January's envelope is untouched by it.
		const s = store([tx("2024-01-10", -100, transfers.id)], [cat, transfers]);

		expect(rolloverInto(s, [cat, transfers], cat, "2024-02")).toBe(300);
	});

	it("converts foreign-currency spend before carrying the remainder forward", () => {
		const cat: Category = { ...food, rollover: true, budgetHistory: { "2024-01": 300, "2024-02": 300 } };
		const s = {
			...store([{ ...tx("2024-01-10", -100, cat.id), currency: "USD" }], [cat]),
			fx: { baseCurrency: "EUR", rates: { USD: 0.9 } },
		};
		// 100 USD is 90 EUR of the January envelope, so 210 carries forward, not 200.
		expect(rolloverInto(s, [cat], cat, "2024-02")).toBeCloseTo(210, 6);
	});
});
