import { describe, expect, it } from "vitest";
import { oneOffBudgetStatus } from "../budgets";
import { categoryTotals, isTransfer, primaryCategoryTotals, summarizeByYear, type KpiStore } from "../kpi";
import { isTransferLike } from "../recurring";
import { runReport, type ReportSource } from "../reports/query";
import type { Account, Category, OneOffBudget, Transaction } from "../types";
import { classifyTransaction, isEconomicallyNeutral } from "./semantics";

/**
 * One fixture ledger, run through every module that used to keep its own copy of "is this a
 * transfer/trade/debt-principal payment" logic — kpi.ts, recurring.ts (and insights.ts
 * transitively, since it delegates to recurring.ts), reports/query.ts, and budgets.ts — asserting
 * they all agree on the same rows. This is the literal deliverable the audit spec's FIN-005 asks
 * for: a cross-module consistency fixture, not just "we're pretty sure they can't disagree because
 * they all call the same function". If a future edit reintroduces a local copy of this logic in any
 * one module, this test is the one that catches the two modules quietly drifting apart again.
 */

const checking: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR" };
const savings: Account = { id: "acc-savings", name: "Savings", type: "saving", currency: "EUR" };
const investing: Account = { id: "acc-investing", name: "Investing", type: "investing", currency: "EUR" };
const creditCard: Account = { id: "acc-credit", name: "Credit card", type: "credit", currency: "EUR" };

const catFood: Category = { id: "cat-food", name: "Food", color: "#000", icon: "utensils", aliases: [] };
const catIncome: Category = { id: "cat-income", name: "Income", color: "#000", icon: "coins", aliases: [], kind: "income" };

function tx(partial: Partial<Transaction> & Pick<Transaction, "id" | "date" | "accountId" | "amount">): Transaction {
	return { description: "test", currency: "EUR", source: "manual", ...partial };
}

// Deliberately one of each kind the classifier distinguishes, so every module below is exercised
// against the full range at once rather than one case at a time.
const income = tx({ id: "tx-income", date: "2024-01-05", accountId: checking.id, amount: 2000, categoryId: catIncome.id });
const expense = tx({ id: "tx-expense", date: "2024-01-10", accountId: checking.id, amount: -300, categoryId: catFood.id });
const refund = tx({ id: "tx-refund", date: "2024-01-15", accountId: checking.id, amount: 50, categoryId: catFood.id });
const transfer = tx({ id: "tx-transfer", date: "2024-01-20", accountId: checking.id, amount: -500, transferGroupId: "g1" });
const trade = tx({ id: "tx-trade", date: "2024-01-25", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 });
const debtPrincipal = tx({ id: "tx-debt", date: "2024-01-28", accountId: creditCard.id, amount: 200 });

const transactions = [income, expense, refund, transfer, trade, debtPrincipal];
const accounts = [checking, savings, investing, creditCard];
const categories = [catFood, catIncome];

const kpiStore: KpiStore = { accounts, categories, transactions };
const reportSource: ReportSource = { accounts, categories, transactions };

describe("cross-module classification consistency (FIN-005)", () => {
	it("the classifier itself puts exactly the transfer/trade/debt-principal rows in the economically-neutral set", () => {
		const neutral = transactions.filter((t) => isEconomicallyNeutral(classifyTransaction(kpiStore, t)));
		expect(neutral.map((t) => t.id).sort()).toEqual(["tx-debt", "tx-trade", "tx-transfer"]);
	});

	it("kpi.ts's isTransfer and recurring.ts's isTransferLike agree on every row", () => {
		for (const t of transactions) {
			expect(isTransferLike(kpiStore, t)).toBe(isTransfer(kpiStore, t));
		}
	});

	it("categoryTotals/primaryCategoryTotals net the refund against the expense and exclude the rest", () => {
		// 300 charged - 50 refunded = 250 net expense in Food; the transfer/trade/debt-principal rows
		// never touch this category, and wouldn't count even if they did.
		expect(categoryTotals(kpiStore, "2024").get(catFood.id)).toBeCloseTo(250, 6);
		expect(primaryCategoryTotals(kpiStore, "2024").get(catFood.id)).toBeCloseTo(250, 6);
	});

	it("summarizeByYear's income/expenses agree with categoryTotals' net-of-refund reading", () => {
		const [year] = summarizeByYear(kpiStore);
		expect(year.income).toBeCloseTo(2000, 6); // only the income row — not the debt-principal credit
		expect(year.expenses).toBeCloseTo(250, 6); // matches categoryTotals(kpiStore, "2024") above exactly
		expect(year.debtPrincipal).toBeCloseTo(200, 6);
	});

	it("reports/query.ts's runReport excludes the same three rows by default, and its byCategory total for Food agrees in magnitude with kpi.ts's", () => {
		const result = runReport(reportSource, {});
		expect(result.rows.map((r) => r.id).sort()).toEqual(["tx-expense", "tx-income", "tx-refund"]);
		const foodGroup = result.byCategory.find((g) => g.key === catFood.id);
		// ReportGroup.total is signed the opposite way (negative = money out) from categoryTotals'
		// positive-expense convention — both describe the same net €250, just read in opposite directions.
		expect(Math.abs(foodGroup!.total)).toBeCloseTo(250, 6);
	});

	it("reports/query.ts's runReport includes the transfer/trade/debt-principal rows when includeTransfers is set", () => {
		const result = runReport(reportSource, { includeTransfers: true });
		expect(result.rows).toHaveLength(transactions.length);
	});

	it("budgets.ts's oneOffBudgetStatus, scoped to Food, lands on the exact same net-of-refund figure", () => {
		const budget: OneOffBudget = { id: "b1", name: "Groceries plan", amount: 1000, startDate: "2024-01-01", endDate: "2024-01-31", categoryIds: [catFood.id] };
		const status = oneOffBudgetStatus(kpiStore, budget, new Date("2024-02-01T00:00:00Z"));
		expect(status.spent).toBeCloseTo(250, 6);
	});

	it("budgets.ts's oneOffBudgetStatus, unrestricted, excludes the transfer/trade/debt-principal rows the same way categoryTotals does", () => {
		const budget: OneOffBudget = { id: "b2", name: "January, everything", amount: 5000, startDate: "2024-01-01", endDate: "2024-01-31" };
		const status = oneOffBudgetStatus(kpiStore, budget, new Date("2024-02-01T00:00:00Z"));
		// Only the expense (300) nets against the refund (50) — income doesn't add to "spent", and the
		// transfer/trade/debt-principal rows are excluded even though nothing scoped this budget to Food.
		expect(status.spent).toBeCloseTo(250, 6);
	});
});
