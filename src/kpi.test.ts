import { describe, it, expect } from "vitest";
import {
	summarizeByYear,
	summarizeByMonth,
	yearSummaryFor,
	netWorth,
	categoryTotals,
	primaryCategoryTotals,
	categoryTransactions,
	accountStats,
	averageMonthlyExpenses,
	investingHoldings,
	investingActivityByYear,
	fiProjection,
	type KpiStore,
} from "./kpi";
import type { Account, Category, Transaction } from "./types";

// ---------- fixtures ----------

const checking: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR", openingBalance: 0 };
const savings: Account = { id: "acc-savings", name: "Savings", type: "saving", currency: "EUR", openingBalance: 0 };
const investing: Account = { id: "acc-investing", name: "Investing", type: "investing", currency: "EUR", openingBalance: 0 };

const catFood: Category = { id: "cat-food", name: "Food", color: "#000", icon: "utensils", aliases: [] };
const catIncome: Category = { id: "cat-income", name: "Income", color: "#000", icon: "coins", aliases: [] };
const catTransfers: Category = { id: "cat-transfers", name: "Transfers", color: "#000", icon: "arrow", aliases: [] };
const catCashAtm: Category = { id: "cat-cash-atm", name: "Cash/ATM", color: "#000", icon: "atm", aliases: [] };

let nextId = 0;
function tx(partial: Partial<Transaction> & Pick<Transaction, "date" | "accountId" | "amount">): Transaction {
	nextId++;
	return {
		id: `tx-${nextId}`,
		description: partial.description ?? "test",
		currency: "EUR",
		source: "manual",
		...partial,
	};
}

function store(overrides: Partial<KpiStore> = {}): KpiStore {
	return {
		accounts: [checking, savings, investing],
		categories: [catFood, catIncome, catTransfers, catCashAtm],
		transactions: [],
		...overrides,
	};
}

// ---------- isTransfer (exercised indirectly via summarizeByYear/summarizeByMonth/categoryTotals) ----------

describe("transfer detection", () => {
	it("excludes a transaction categorized as Transfers from both income and expenses", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: 100, categoryId: catTransfers.id }),
				tx({ date: "2024-01-02", accountId: checking.id, amount: -40, categoryId: catFood.id }),
			],
		});
		const [year] = summarizeByYear(s);
		expect(year.income).toBe(0);
		expect(year.expenses).toBe(40);
	});

	it("matches the transfer category name case-insensitively and trimmed", () => {
		const weirdCasing: Category = { ...catTransfers, id: "cat-weird", name: "  TRANSFERS  " };
		const s = store({
			categories: [weirdCasing],
			transactions: [tx({ date: "2024-01-01", accountId: checking.id, amount: 100, categoryId: weirdCasing.id })],
		});
		const [year] = summarizeByYear(s);
		expect(year.income).toBe(0);
	});

	it("treats a saving account's ING-style Withdrawal/Deposit `type` as a transfer even when miscategorized", () => {
		// Regression: this exact pattern (withdrawal from a savings account tagged "Cash/ATM" instead of
		// "Transfers") was found live in a user's ledger and caused real income to look near-zero.
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: savings.id, amount: -50, categoryId: catCashAtm.id, type: "Withdrawal" }),
				tx({ date: "2024-01-02", accountId: savings.id, amount: 50, categoryId: catTransfers.id, type: "Deposit" }),
			],
		});
		const [year] = summarizeByYear(s);
		expect(year.income).toBe(0);
		expect(year.expenses).toBe(0);
	});

	it("treats an investing account's Trade-Republic-style deposit/withdraw `action` as a transfer", () => {
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: investing.id, amount: 500, action: "deposit" })],
		});
		const [year] = summarizeByYear(s);
		expect(year.income).toBe(0);
	});

	it("does NOT treat an uncategorized checking-account transaction as a transfer", () => {
		// There's no account-to-account link on Transaction, so a genuine uncategorized transfer between
		// two everyday accounts is indistinguishable from real income/expense — documented limitation.
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: checking.id, amount: 100 })],
		});
		const [year] = summarizeByYear(s);
		expect(year.income).toBe(100);
	});

	it("does not treat a plain Withdrawal/Deposit type on an everyday (non-saving/investing) account as a transfer", () => {
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: checking.id, amount: -50, type: "Withdrawal" })],
		});
		const [year] = summarizeByYear(s);
		expect(year.expenses).toBe(50);
	});
});

// ---------- summarizeByYear ----------

describe("summarizeByYear", () => {
	it("buckets income and expenses per year and computes net/savingsRate", () => {
		const s = store({
			transactions: [
				tx({ date: "2023-01-01", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
				tx({ date: "2023-01-02", accountId: checking.id, amount: -600, categoryId: catFood.id }),
				tx({ date: "2024-01-01", accountId: checking.id, amount: 2000, categoryId: catIncome.id }),
			],
		});
		const years = summarizeByYear(s);
		expect(years.map((y) => y.year)).toEqual(["2023", "2024"]);
		expect(years[0]).toMatchObject({ income: 1000, expenses: 600, net: 400, savingsRate: 0.4 });
		expect(years[1]).toMatchObject({ income: 2000, expenses: 0 });
	});

	it("the final year's netWorthEOY always equals netWorth(store) — every transaction counted exactly once", () => {
		const s = store({
			accounts: [{ ...checking, openingBalance: 500 }],
			transactions: [
				tx({ date: "2022-06-01", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
				tx({ date: "2022-06-02", accountId: checking.id, amount: -300, categoryId: catFood.id }),
				tx({ date: "2023-06-01", accountId: checking.id, amount: 50, categoryId: catTransfers.id }),
				tx({ date: "2024-06-01", accountId: checking.id, amount: -75, categoryId: catFood.id }),
			],
		});
		const years = summarizeByYear(s);
		expect(years.at(-1)!.netWorthEOY).toBeCloseTo(netWorth(s), 6);
	});

	it("an early year's netWorthEOY never includes a later year's transfers (regression: 2016 showing ~60K)", () => {
		const s = store({
			accounts: [{ ...checking, openingBalance: 100 }],
			transactions: [
				tx({ date: "2016-01-01", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
				tx({ date: "2016-01-02", accountId: checking.id, amount: -500, categoryId: catFood.id }),
				tx({ date: "2016-01-03", accountId: checking.id, amount: 200, categoryId: catTransfers.id }),
				// A large transfer that only happens in a later year must not leak backward into 2016.
				tx({ date: "2020-01-01", accountId: checking.id, amount: -900, categoryId: catTransfers.id }),
				tx({ date: "2020-01-02", accountId: checking.id, amount: 2000, categoryId: catIncome.id }),
				tx({ date: "2020-01-03", accountId: checking.id, amount: -300, categoryId: catFood.id }),
			],
		});
		const years = summarizeByYear(s);
		const y2016 = years.find((y) => y.year === "2016")!;
		// opening 100 + income 1000 - expenses 500 + that year's own +200 transfer = 800, NOT dragged
		// down by 2020's -900 transfer.
		expect(y2016.netWorthEOY).toBe(800);
		const y2020 = years.find((y) => y.year === "2020")!;
		expect(y2020.netWorthEOY).toBeCloseTo(netWorth(s), 6);
	});

	it("savingsRate is clamped to [-100%, 100%] instead of blowing up when income is near zero (regression)", () => {
		const s = store({
			transactions: [
				tx({ date: "2018-01-01", accountId: checking.id, amount: 0.02, categoryId: catIncome.id }),
				tx({ date: "2018-01-02", accountId: checking.id, amount: -1000, categoryId: catFood.id }),
			],
		});
		const [year] = summarizeByYear(s);
		expect(year.savingsRate).toBe(-1);
	});

	it("savingsRate is 0 when there's no income at all (not NaN/Infinity)", () => {
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: checking.id, amount: -100, categoryId: catFood.id })],
		});
		const [year] = summarizeByYear(s);
		expect(year.savingsRate).toBe(0);
	});

	it("scopes to a single account when accountId is given", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
				tx({ date: "2024-01-01", accountId: savings.id, amount: 5000, categoryId: catIncome.id }),
			],
		});
		const [year] = summarizeByYear(s, checking.id);
		expect(year.income).toBe(1000);
	});
});

describe("yearSummaryFor", () => {
	it("returns the matching year", () => {
		const years = summarizeByYear(
			store({ transactions: [tx({ date: "2024-03-01", accountId: checking.id, amount: 100 })] })
		);
		expect(yearSummaryFor(years, "2024")?.income).toBe(100);
	});

	it("returns undefined for a year with no data, rather than silently falling back to the last year", () => {
		const years = summarizeByYear(
			store({ transactions: [tx({ date: "2020-03-01", accountId: checking.id, amount: 100 })] })
		);
		expect(yearSummaryFor(years, "2099")).toBeUndefined();
	});
});

// ---------- summarizeByMonth ----------

describe("summarizeByMonth", () => {
	it("always returns all 12 months, even with no activity", () => {
		const months = summarizeByMonth(store(), "2024");
		expect(months).toHaveLength(12);
		expect(months.map((m) => m.month)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]);
	});

	it("buckets by month and excludes other years / transfers", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-03-15", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
				tx({ date: "2024-03-20", accountId: checking.id, amount: -200, categoryId: catFood.id }),
				tx({ date: "2024-04-01", accountId: checking.id, amount: -50, categoryId: catFood.id }),
				tx({ date: "2023-03-01", accountId: checking.id, amount: 9999, categoryId: catIncome.id }),
				tx({ date: "2024-03-10", accountId: checking.id, amount: 300, categoryId: catTransfers.id }),
			],
		});
		const months = summarizeByMonth(s, "2024");
		expect(months[2]).toMatchObject({ income: 1000, expenses: 200 }); // March
		expect(months[3]).toMatchObject({ income: 0, expenses: 50 }); // April
	});
});

// ---------- netWorth ----------

describe("netWorth", () => {
	it("sums opening balances plus every transaction amount", () => {
		const s = store({
			accounts: [{ ...checking, openingBalance: 100 }, { ...savings, openingBalance: 50 }],
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: 200 }),
				tx({ date: "2024-01-02", accountId: savings.id, amount: -20 }),
			],
		});
		expect(netWorth(s)).toBe(330);
	});

	it("scopes to a single account", () => {
		const s = store({
			accounts: [{ ...checking, openingBalance: 100 }, { ...savings, openingBalance: 50 }],
			transactions: [tx({ date: "2024-01-01", accountId: checking.id, amount: 200 })],
		});
		expect(netWorth(s, checking.id)).toBe(300);
		expect(netWorth(s, savings.id)).toBe(50);
	});
});

// ---------- categoryTotals ----------

describe("categoryTotals", () => {
	it("sums only expenses, grouped by category, excluding transfers and income", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: -30, categoryId: catFood.id }),
				tx({ date: "2024-01-02", accountId: checking.id, amount: -20, categoryId: catFood.id }),
				tx({ date: "2024-01-03", accountId: checking.id, amount: 500, categoryId: catIncome.id }),
				tx({ date: "2024-01-04", accountId: checking.id, amount: -100, categoryId: catTransfers.id }),
				tx({ date: "2024-01-05", accountId: checking.id, amount: -15 }), // uncategorized
			],
		});
		const totals = categoryTotals(s);
		expect(totals.get(catFood.id)).toBe(50);
		expect(totals.get(catIncome.id)).toBeUndefined();
		expect(totals.get(catTransfers.id)).toBeUndefined();
		expect(totals.get("uncategorized")).toBe(15);
	});

	it("filters by year", () => {
		const s = store({
			transactions: [
				tx({ date: "2023-01-01", accountId: checking.id, amount: -30, categoryId: catFood.id }),
				tx({ date: "2024-01-01", accountId: checking.id, amount: -10, categoryId: catFood.id }),
			],
		});
		expect(categoryTotals(s, "2024").get(catFood.id)).toBe(10);
	});
});

// ---------- primaryCategoryTotals & secondary-category rollup ----------

const catGroceries: Category = { id: "cat-groceries", name: "Groceries", color: "#000", icon: "shopping-cart", aliases: [], parentId: catFood.id };
const catTransfersSecondary: Category = {
	id: "cat-savings-transfer",
	name: "Savings Transfer",
	color: "#000",
	icon: "repeat",
	aliases: [],
	parentId: catTransfers.id,
};

describe("primaryCategoryTotals", () => {
	it("rolls a secondary category's spend up into its primary", () => {
		const s = store({
			categories: [catFood, catGroceries],
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: -20, categoryId: catFood.id }),
				tx({ date: "2024-01-02", accountId: checking.id, amount: -30, categoryId: catGroceries.id }),
			],
		});
		expect(primaryCategoryTotals(s).get(catFood.id)).toBe(50);
		expect(primaryCategoryTotals(s).has(catGroceries.id)).toBe(false);
	});
});

describe("categoryTransactions", () => {
	it("includes transactions tagged with a descendant secondary category when queried by the primary", () => {
		const s = store({
			categories: [catFood, catGroceries],
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: -20, categoryId: catFood.id }),
				tx({ date: "2024-01-02", accountId: checking.id, amount: -30, categoryId: catGroceries.id }),
			],
		});
		const txs = categoryTransactions(s, catFood.id, "2024-01");
		expect(txs).toHaveLength(2);
	});
});

describe("transfer detection through a secondary category", () => {
	it("excludes a transaction tagged with a secondary nested under Transfers", () => {
		const s = store({
			categories: [catTransfers, catTransfersSecondary],
			transactions: [tx({ date: "2024-01-01", accountId: checking.id, amount: -50, categoryId: catTransfersSecondary.id })],
		});
		const [year] = summarizeByYear(s);
		expect(year.income).toBe(0);
		expect(year.expenses).toBe(0);
	});
});

// ---------- accountStats ----------

describe("accountStats", () => {
	it("counts transactions and reports net worth for one account", () => {
		const s = store({
			accounts: [{ ...checking, openingBalance: 100 }],
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: 50 }),
				tx({ date: "2024-01-02", accountId: checking.id, amount: -20 }),
				tx({ date: "2024-01-03", accountId: savings.id, amount: 999 }),
			],
		});
		expect(accountStats(s, checking.id)).toEqual({ count: 2, netWorth: 130 });
	});
});

// ---------- averageMonthlyExpenses ----------

describe("averageMonthlyExpenses", () => {
	it("averages expenses across months that had any spend, excluding transfers", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-05", accountId: checking.id, amount: -100, categoryId: catFood.id }),
				tx({ date: "2024-02-05", accountId: checking.id, amount: -300, categoryId: catFood.id }),
				tx({ date: "2024-02-06", accountId: checking.id, amount: -500, categoryId: catTransfers.id }),
			],
		});
		expect(averageMonthlyExpenses(s)).toBe(200); // (100 + 300) / 2 months
	});

	it("returns 0 when there are no expenses at all", () => {
		expect(averageMonthlyExpenses(store())).toBe(0);
	});

	it("filters by accountIds when given", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-05", accountId: checking.id, amount: -100, categoryId: catFood.id }),
				tx({ date: "2024-01-05", accountId: savings.id, amount: -400, categoryId: catFood.id }),
			],
		});
		expect(averageMonthlyExpenses(s, [checking.id])).toBe(100);
	});
});

// ---------- investingHoldings ----------

describe("investingHoldings", () => {
	it("nets buys and sells per ticker into shares/cost basis", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: -500, action: "buy", ticker: "VWCE", shares: 5 }),
				tx({ date: "2024-03-01", accountId: investing.id, amount: 400, action: "sell", ticker: "VWCE", shares: 4 }),
			],
		});
		const holdings = investingHoldings(s, investing.id);
		expect(holdings).toHaveLength(1);
		expect(holdings[0]).toMatchObject({ ticker: "VWCE", shares: 11 });
		expect(holdings[0].netInvested).toBeCloseTo(1100, 6); // 1000 + 500 - 400
	});

	it("drops a ticker once its position is fully closed", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: -100, action: "buy", ticker: "AAPL", shares: 1 }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: 120, action: "sell", ticker: "AAPL", shares: 1 }),
			],
		});
		expect(investingHoldings(s, investing.id)).toHaveLength(0);
	});

	it("ignores CASH pseudo-ticker rows and non-buy/sell actions", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: 500, action: "deposit", ticker: "CASH" }),
				tx({ date: "2024-01-02", accountId: investing.id, amount: 5, action: "dividend", ticker: "VWCE" }),
			],
		});
		expect(investingHoldings(s, investing.id)).toHaveLength(0);
	});
});

// ---------- investingActivityByYear ----------

describe("investingActivityByYear", () => {
	it("buckets deposits, withdrawals, dividends and fees by year", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: 1000, action: "deposit" }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: -200, action: "withdraw" }),
				tx({ date: "2024-03-01", accountId: investing.id, amount: 5, action: "dividend", fee: 1 }),
			],
		});
		const [year] = investingActivityByYear(s, investing.id);
		expect(year).toMatchObject({ year: "2024", deposits: 1000, withdrawals: 200, dividends: 5, fees: 1 });
	});
});

// ---------- fiProjection ----------

describe("fiProjection", () => {
	it("returns 0 when already at or past the target", () => {
		expect(fiProjection(100_000, 0, 0.07, 50_000)).toBe(0);
	});

	it("returns undefined for a non-positive target", () => {
		expect(fiProjection(1000, 500, 0.07, 0)).toBeUndefined();
	});

	it("returns undefined when there's neither contribution nor growth to ever reach the target", () => {
		expect(fiProjection(0, 0, 0, 100_000)).toBeUndefined();
	});

	it("returns a positive number of years when contributions alone can reach the target", () => {
		const years = fiProjection(0, 1000, 0, 12_000);
		expect(years).toBeCloseTo(1, 1);
	});
});
