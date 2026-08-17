import { describe, it, expect } from "vitest";
import {
	summarizeByYear,
	summarizeByMonth,
	summarizeTotal,
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
	accountBalanceParts,
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

	it("treats a 'buy' in an investing account as a transfer, not an expense — cash exchanged for a share of equal value, not spent", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: 2000, action: "deposit" }),
				tx({ date: "2024-01-02", accountId: investing.id, amount: -500, action: "buy", ticker: "VWCE" }),
			],
		});
		const [year] = summarizeByYear(s);
		expect(year.expenses).toBe(0);
	});

	it("treats a 'sell' in an investing account as a transfer, not income — the asset converting back to cash, not a realized gain", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: -500, action: "buy", ticker: "VWCE" }),
				tx({ date: "2024-06-01", accountId: investing.id, amount: 600, action: "sell", ticker: "VWCE" }),
			],
		});
		const [year] = summarizeByYear(s);
		expect(year.income).toBe(0);
	});

	it("still counts a 'buy' as an expense outside an investing account (the type gate matters)", () => {
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: checking.id, amount: -500, action: "buy" })],
		});
		const [year] = summarizeByYear(s);
		expect(year.expenses).toBe(500);
	});

	it("leaves dividends counted as real income — a trade converts cash and securities, a dividend is money actually earned", () => {
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: investing.id, amount: 25, action: "dividend" })],
		});
		const [year] = summarizeByYear(s);
		expect(year.income).toBe(25);
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

describe("runwayMonths", () => {
	it("divides liquid balance at year-end by that year's own monthly spend", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
				tx({ date: "2024-06-01", accountId: checking.id, amount: -600, categoryId: catFood.id }),
			],
		});
		const [year] = summarizeByYear(s);
		// liquid balance = 1000 - 600 = 400; monthly expenses = 600/12 = 50; runway = 400/50 = 8 months
		expect(year.runwayMonths).toBe(8);
	});

	it("excludes investing balances from the liquid figure it draws from", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: 100, categoryId: catIncome.id }),
				tx({ date: "2024-01-02", accountId: checking.id, amount: -50, categoryId: catFood.id }),
				// A much larger balance lands in investing, which must not inflate the runway figure.
				tx({ date: "2024-01-03", accountId: investing.id, amount: 10000, categoryId: catIncome.id }),
			],
		});
		const [year] = summarizeByYear(s);
		expect(year.runwayMonths).toBeCloseTo(50 / (50 / 12), 6);
	});

	it("is 0, not Infinity, for a year with no recorded expenses", () => {
		const s = store({ transactions: [tx({ date: "2024-01-01", accountId: checking.id, amount: 1000, categoryId: catIncome.id })] });
		const [year] = summarizeByYear(s);
		expect(year.runwayMonths).toBe(0);
	});

	it("summarizeTotal takes the last year's own runway rather than summing across years", () => {
		const years = summarizeByYear(
			store({
				transactions: [
					tx({ date: "2024-01-01", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
					tx({ date: "2024-01-02", accountId: checking.id, amount: -100, categoryId: catFood.id }),
					tx({ date: "2025-01-02", accountId: checking.id, amount: -200, categoryId: catFood.id }),
				],
			})
		);
		const total = summarizeTotal(years)!;
		expect(total.runwayMonths).toBe(years.at(-1)!.runwayMonths);
	});
});

// ---------- summarizeByYear under a period filter ----------

describe("summarizeByYear — ranges", () => {
	const spanningStore = (): KpiStore =>
		store({
			accounts: [{ ...checking, openingBalance: 100 }],
			transactions: [
				tx({ date: "2024-05-01", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
				tx({ date: "2024-05-02", accountId: checking.id, amount: -400, categoryId: catFood.id }),
				tx({ date: "2025-03-01", accountId: checking.id, amount: 2000, categoryId: catIncome.id }),
				tx({ date: "2025-09-01", accountId: checking.id, amount: -500, categoryId: catFood.id }),
			],
		});

	it("returns only the years the range covers", () => {
		const years = summarizeByYear(spanningStore(), undefined, { from: "2025-01-01", to: "2025-12-31" });
		expect(years.map((y) => y.year)).toEqual(["2025"]);
		expect(years[0]).toMatchObject({ income: 2000, expenses: 500 });
	});

	it("counts only the transactions inside the range within a year it clips", () => {
		const years = summarizeByYear(spanningStore(), undefined, { from: "2025-01-01", to: "2025-06-30" });
		expect(years[0]).toMatchObject({ income: 2000, expenses: 0, partial: true });
	});

	it("marks a year the range covers in full as not partial", () => {
		const years = summarizeByYear(spanningStore(), undefined, { from: "2025-01-01", to: "2025-12-31" });
		expect(years[0].partial).toBe(false);
	});

	it("carries everything before the range into the opening position rather than starting from zero", () => {
		// Opening 100, then 2024 leaves 700 on the books — 2025's closing worth has to build on that.
		const years = summarizeByYear(spanningStore(), undefined, { from: "2025-01-01", to: "2025-12-31" });
		expect(years[0].netWorthEOY).toBe(2200);
	});

	it("closes a clipped year at the end of the range, not at a year end the range never reached", () => {
		const years = summarizeByYear(spanningStore(), undefined, { from: "2025-01-01", to: "2025-06-30" });
		// The September expense is outside the range, so it hasn't happened yet as far as this reads.
		expect(years[0].netWorthEOY).toBe(2700);
	});

	it("leaves an unfiltered call exactly as it was", () => {
		const years = summarizeByYear(spanningStore());
		expect(years.map((y) => y.year)).toEqual(["2024", "2025"]);
		expect(years.at(-1)!.netWorthEOY).toBeCloseTo(netWorth(spanningStore()), 6);
		expect(years[0].partial).toBe(false);
	});

	it("takes a clipped year's closing worth from the snapshot path too", () => {
		const s: KpiStore = {
			...spanningStore(),
			snapshots: [{ id: "snap-1", accountId: checking.id, date: "2025-02-01", balance: 5000 }],
		};
		const years = summarizeByYear(s, undefined, { from: "2025-01-01", to: "2025-06-30" });
		// Snapshot of 5000 on 1 February, plus the March income that followed it.
		expect(years[0].netWorthEOY).toBe(7000);
	});

	it("comes back empty when the range contains nothing", () => {
		expect(summarizeByYear(spanningStore(), undefined, { from: "2019-01-01", to: "2019-12-31" })).toEqual([]);
	});
});

describe("summarizeTotal", () => {
	it("rolls several years into one summary spanning them", () => {
		const years = summarizeByYear(
			store({
				transactions: [
					tx({ date: "2024-01-01", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
					tx({ date: "2024-01-02", accountId: checking.id, amount: -400, categoryId: catFood.id }),
					tx({ date: "2025-01-01", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
					tx({ date: "2025-01-02", accountId: checking.id, amount: -600, categoryId: catFood.id }),
				],
			})
		);
		expect(summarizeTotal(years)).toMatchObject({
			year: "2024–2025",
			income: 2000,
			expenses: 1000,
			net: 1000,
			savingsRate: 0.5,
			// Where the period ends, i.e. the last year's closing figure — not the sum of them.
			netWorthEOY: 1000,
		});
	});

	it("keeps a single year's own label", () => {
		const years = summarizeByYear(store({ transactions: [tx({ date: "2025-01-01", accountId: checking.id, amount: 100 })] }));
		expect(summarizeTotal(years)?.year).toBe("2025");
	});

	it("is undefined when the period holds nothing", () => {
		expect(summarizeTotal([])).toBeUndefined();
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

	it("still matches a plain year or month as a date prefix", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-15", accountId: checking.id, amount: -20, categoryId: catFood.id }),
				tx({ date: "2024-02-15", accountId: checking.id, amount: -30, categoryId: catFood.id }),
				tx({ date: "2025-01-15", accountId: checking.id, amount: -40, categoryId: catFood.id }),
			],
		});
		expect(primaryCategoryTotals(s, "2024").get(catFood.id)).toBe(50);
		expect(primaryCategoryTotals(s, "2024-02").get(catFood.id)).toBe(30);
	});

	it("takes a date range, so a page period filter can drive it", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-15", accountId: checking.id, amount: -20, categoryId: catFood.id }),
				tx({ date: "2024-03-10", accountId: checking.id, amount: -30, categoryId: catFood.id }),
				tx({ date: "2024-06-01", accountId: checking.id, amount: -40, categoryId: catFood.id }),
			],
		});
		expect(primaryCategoryTotals(s, { from: "2024-02-01", to: "2024-04-30" }).get(catFood.id)).toBe(30);
		// Either end can be left open — a half-typed custom range still filters on the end that's set.
		expect(primaryCategoryTotals(s, { from: "2024-03-01", to: "" }).get(catFood.id)).toBe(70);
		expect(primaryCategoryTotals(s, { from: "", to: "2024-02-01" }).get(catFood.id)).toBe(20);
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

// ---------- accountBalanceParts ----------

describe("accountBalanceParts", () => {
	const revolut: Account = { id: "acc-revolut", name: "Revolut", type: "debit", currency: "EUR", openingBalance: -2278.38 };
	const fx = { baseCurrency: "EUR", rates: { USD: 0.9, GBP: 1.2 } };

	function multiCurrencyStore(overrides: Partial<KpiStore> = {}): KpiStore {
		return {
			accounts: [revolut],
			categories: [],
			fx,
			transactions: [
				tx({ date: "2025-01-01", accountId: revolut.id, amount: 1000 }),
				tx({ date: "2025-01-02", accountId: revolut.id, amount: 500, currency: "USD" }),
				tx({ date: "2025-01-03", accountId: revolut.id, amount: 200, currency: "GBP" }),
			],
			...overrides,
		};
	}

	it("converts foreign rows instead of adding them in at face value", () => {
		const parts = accountBalanceParts(multiCurrencyStore(), revolut.id, "EUR");
		// 1000 EUR + (500 USD * 0.9) + (200 GBP * 1.2) = 1000 + 450 + 240.
		expect(parts.movement).toBeCloseTo(1690, 6);
		// The naive sum this replaced would have read 1700 — dollars and pounds counted as euros.
		expect(parts.movement).not.toBeCloseTo(1700, 6);
		expect(parts.counted).toBe(3);
		expect(parts.ignored).toBe(0);
	});

	it("agrees with the net worth the dashboard shows for the same account", () => {
		const s = multiCurrencyStore();
		const parts = accountBalanceParts(s, revolut.id, "EUR");
		expect(parts.anchor + parts.movement).toBeCloseTo(netWorth(s, revolut.id), 6);
	});

	it("leaves out rows whose date never parsed, exactly as net worth does", () => {
		const s = multiCurrencyStore({
			transactions: [
				tx({ date: "2025-01-01", accountId: revolut.id, amount: 1000 }),
				tx({ date: "", accountId: revolut.id, amount: -1445.79 }),
			],
		});
		const parts = accountBalanceParts(s, revolut.id, "EUR");
		expect(parts.movement).toBeCloseTo(1000, 6);
		expect(parts.counted).toBe(1);
		expect(parts.ignored).toBe(1);
		expect(parts.anchor + parts.movement).toBeCloseTo(netWorth(s, revolut.id), 6);
	});

	it("counts from a recorded balance rather than the opening one, ignoring what it already covers", () => {
		const s = multiCurrencyStore({
			snapshots: [{ id: "snap-1", accountId: revolut.id, date: "2025-01-02", balance: 5000 }],
		});
		const parts = accountBalanceParts(s, revolut.id, "EUR");
		expect(parts.snapshot?.balance).toBe(5000);
		expect(parts.anchor).toBe(5000);
		// Only the 200 GBP row on 3 January falls after the snapshot: 200 * 1.2.
		expect(parts.movement).toBeCloseTo(240, 6);
		expect(parts.counted).toBe(1);
		expect(parts.ignored).toBe(2);
		expect(parts.anchor + parts.movement).toBeCloseTo(netWorth(s, revolut.id), 6);
	});

	it("reads the same account in another currency without touching the stored opening balance", () => {
		const parts = accountBalanceParts(multiCurrencyStore(), revolut.id, "USD");
		// Into dollars: 1000 EUR / 0.9, 500 USD as-is, 200 GBP * 1.2 / 0.9.
		expect(parts.movement).toBeCloseTo(1000 / 0.9 + 500 + (200 * 1.2) / 0.9, 6);
		expect(parts.anchor).toBe(-2278.38);
	});

	it("falls through untouched when the store has no rate table at all", () => {
		const s = multiCurrencyStore({ fx: undefined });
		const parts = accountBalanceParts(s, revolut.id, "EUR");
		expect(parts.movement).toBeCloseTo(1700, 6);
		expect(parts.anchor + parts.movement).toBeCloseTo(netWorth(s, revolut.id), 6);
	});

	it("reports an account it has never heard of as empty rather than throwing", () => {
		const parts = accountBalanceParts(multiCurrencyStore(), "acc-nope", "EUR");
		expect(parts).toEqual({ anchor: 0, movement: 0, snapshot: undefined, counted: 0, ignored: 0 });
	});
});

// ---------- refunds vs income ----------

describe("money coming in against an expense category", () => {
	const income: Category = { ...catIncome, kind: "income" };
	/** A store that has opted in by flagging one category as income. */
	function flagged(transactions: Transaction[]): KpiStore {
		return { ...store({ transactions }), categories: [catFood, income, catTransfers, catCashAtm] };
	}

	it("is treated as income when nothing is flagged, exactly as before", () => {
		// Backwards compatibility: a vault that never set `kind` can't tell salary from a refund, so it
		// must keep the old sign-only reading rather than reclassify someone's salary.
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: -100, categoryId: catFood.id }),
				tx({ date: "2024-01-02", accountId: checking.id, amount: 30, categoryId: catFood.id }),
			],
		});
		const y = summarizeByYear(s)[0];
		expect(y.income).toBe(30);
		expect(y.expenses).toBe(100);
	});

	it("reduces that category's expenses instead of counting as income", () => {
		const s = flagged([
			tx({ date: "2024-01-01", accountId: checking.id, amount: -100, categoryId: catFood.id }),
			tx({ date: "2024-01-02", accountId: checking.id, amount: 30, categoryId: catFood.id }),
		]);
		const y = summarizeByYear(s)[0];
		expect(y.income).toBe(0);
		expect(y.expenses).toBe(70);
	});

	it("still counts a credit in the income category as income", () => {
		const s = flagged([tx({ date: "2024-01-01", accountId: checking.id, amount: 2500, categoryId: income.id })]);
		const y = summarizeByYear(s)[0];
		expect(y.income).toBe(2500);
		expect(y.expenses).toBe(0);
	});

	it("leaves an uncategorized credit as income, having nothing to net it against", () => {
		const s = flagged([tx({ date: "2024-01-01", accountId: checking.id, amount: 40 })]);
		expect(summarizeByYear(s)[0].income).toBe(40);
	});

	it("stops a refund flattering the savings rate", () => {
		const s = flagged([
			tx({ date: "2024-01-01", accountId: checking.id, amount: 1000, categoryId: income.id }),
			tx({ date: "2024-01-02", accountId: checking.id, amount: -500, categoryId: catFood.id }),
			tx({ date: "2024-01-03", accountId: checking.id, amount: 100, categoryId: catFood.id }),
		]);
		const y = summarizeByYear(s)[0];
		// Earned 1000, spent 500 and got 100 back: 600 kept of 1000, not 1100/600 of an inflated 1100.
		expect(y.income).toBe(1000);
		expect(y.expenses).toBe(400);
		expect(y.savingsRate).toBeCloseTo(0.6, 6);
	});

	it("nets the refund off the category total too, so the two views agree", () => {
		const s = flagged([
			tx({ date: "2024-01-01", accountId: checking.id, amount: -100, categoryId: catFood.id }),
			tx({ date: "2024-01-02", accountId: checking.id, amount: 30, categoryId: catFood.id }),
		]);
		expect(categoryTotals(s).get(catFood.id)).toBe(70);
		expect(primaryCategoryTotals(s).get(catFood.id)).toBe(70);
		// The headline expense figure and the category breakdown must not disagree.
		expect(summarizeByYear(s)[0].expenses).toBe(categoryTotals(s).get(catFood.id));
	});

	it("applies the same rule month by month", () => {
		const s = flagged([
			tx({ date: "2024-03-01", accountId: checking.id, amount: -80, categoryId: catFood.id }),
			tx({ date: "2024-03-05", accountId: checking.id, amount: 20, categoryId: catFood.id }),
		]);
		const march = summarizeByMonth(s, "2024")[2];
		expect(march.income).toBe(0);
		expect(march.expenses).toBe(60);
	});
});
