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
	investingRealizedPnLAsOf,
	investingOpenCostBasisAsOf,
	investmentStateAsOf,
	netWorthAsOf,
	fiProjection,
	fiExpenseBase,
	accountBalanceParts,
	type KpiStore,
} from "./kpi";
import { lastCompleteMonthKey, shiftMonthKey } from "./period";
import type { Account, Category, Transaction } from "./types";

// ---------- fixtures ----------

const checking: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR", openingBalance: 0 };
const savings: Account = { id: "acc-savings", name: "Savings", type: "saving", currency: "EUR", openingBalance: 0 };
const investing: Account = { id: "acc-investing", name: "Investing", type: "investing", currency: "EUR", openingBalance: 0 };
const crypto: Account = { id: "acc-crypto", name: "Crypto", type: "crypto", currency: "EUR", openingBalance: 0 };
const credit: Account = { id: "acc-credit", name: "Credit card", type: "credit", currency: "EUR", openingBalance: 0 };
const mortgage: Account = { id: "acc-mortgage", name: "Mortgage", type: "mortgage", currency: "EUR", openingBalance: 200000 };

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
		accounts: [checking, savings, investing, crypto],
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

	// FIN-009 contract change: savingsRate is no longer clamped to [-100%, 100%], and no longer
	// substitutes 0 for a non-meaningful denominator — both silently stated a real, calculable-looking
	// percentage in place of "not applicable". Income barely above zero produces a raw (huge, negative)
	// ratio; income at or below zero produces undefined, which UI layers render as "N/A" (see
	// formatPct). These two tests previously encoded the old, financially-wrong clamp/zero behavior;
	// per the audit's coding-agent contract, they're updated to the correct contract rather than kept
	// green by preserving the bug.
	it("savingsRate is the raw, unclamped ratio when income is near zero, not clamped to -100%", () => {
		const s = store({
			transactions: [
				tx({ date: "2018-01-01", accountId: checking.id, amount: 0.02, categoryId: catIncome.id }),
				tx({ date: "2018-01-02", accountId: checking.id, amount: -1000, categoryId: catFood.id }),
			],
		});
		const [year] = summarizeByYear(s);
		// (0.02 - 1000) / 0.02 = -49999 exactly — a real number a caller may choose to clamp for display,
		// but not one this function should misrepresent as -100%.
		expect(year.savingsRate).toBeCloseTo(-49999, 6);
	});

	it("savingsRate is undefined when there's no income at all, not a fabricated 0", () => {
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: checking.id, amount: -100, categoryId: catFood.id })],
		});
		const [year] = summarizeByYear(s);
		expect(year.savingsRate).toBeUndefined();
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

	it("does not divide by 12 for a year a range filter clips to fewer months (FIN-010)", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
				tx({ date: "2024-02-01", accountId: checking.id, amount: -300, categoryId: catFood.id }),
			],
		});
		const [year] = summarizeByYear(s, undefined, { from: "2024-01-01", to: "2024-03-31" });
		// liquid balance = 1000 - 300 = 700. The range only covers 3 months, so monthly expenses =
		// 300 / 3 = 100, not 300 / 12 = 25 — the old bug would read runway as 700/25 = 28 months instead
		// of the correct 700/100 = 7.
		expect(year.runwayMonths).toBeCloseTo(700 / 100, 6);
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

	it("counts a genuinely zero-spend month inside the tracked window in the divisor (FIN-010)", () => {
		// Spend in January and March, nothing at all in February — the old behavior only divided by the
		// 2 months that had a matching row, overstating the average as (100+300)/2 = 200.
		const s = store({
			transactions: [
				tx({ date: "2024-01-05", accountId: checking.id, amount: -100, categoryId: catFood.id }),
				tx({ date: "2024-03-05", accountId: checking.id, amount: -300, categoryId: catFood.id }),
			],
		});
		expect(averageMonthlyExpenses(s)).toBeCloseTo((100 + 300) / 3, 6);
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

// ---------- debtPrincipal (FIN-012) ----------

describe("summarizeByYear — debtPrincipal", () => {
	it("tracks a credit-card payment as debt-principal, separate from (and not folded into) income", () => {
		const s = store({
			accounts: [credit],
			transactions: [
				tx({ date: "2024-01-05", accountId: credit.id, amount: -80, categoryId: catFood.id }), // a purchase
				tx({ date: "2024-01-20", accountId: credit.id, amount: 500 }), // a payment, uncategorized
			],
		});
		const [year] = summarizeByYear(s, credit.id);
		expect(year.income).toBe(0); // a card payment is not income to the card account
		expect(year.debtPrincipal).toBe(500);
		expect(year.expenses).toBe(80);
		expect(year.savingsRate).toBeUndefined(); // no income to divide by — see savingsRateOf
	});

	it("sums debtPrincipal across years in summarizeTotal", () => {
		const s = store({
			accounts: [credit],
			transactions: [
				tx({ date: "2024-01-20", accountId: credit.id, amount: 300 }),
				tx({ date: "2025-01-20", accountId: credit.id, amount: 200 }),
			],
		});
		const years = summarizeByYear(s, credit.id);
		const total = summarizeTotal(years)!;
		expect(total.debtPrincipal).toBe(500);
	});
});

// ---------- debt principal/interest/fee splitting (v1.2.7 remediation Phase 4, FIN-012) ----------

describe("summarizeByYear / categoryTotals — split debt payments", () => {
	it("mortgage split: only the interest counts as expense, only the principal counts as debtPrincipal", () => {
		const s = store({
			accounts: [mortgage],
			transactions: [
				tx({ date: "2024-01-05", accountId: mortgage.id, amount: 1000, principalAmount: 700, interestAmount: 300, categoryId: catFood.id }),
			],
		});
		const [year] = summarizeByYear(s, mortgage.id);
		expect(year.expenses).toBeCloseTo(300, 6);
		expect(year.debtPrincipal).toBeCloseTo(700, 6);
		expect(year.income).toBe(0);
		// categoryTotals must agree with the year summary on the same figure, not double- or under-count.
		expect(categoryTotals(s, "2024", mortgage.id).get(catFood.id)).toBeCloseTo(300, 6);
	});

	it("loan with fee: principal, interest, and fee all coexist correctly in one payment", () => {
		const s = store({
			accounts: [mortgage],
			transactions: [
				tx({ date: "2024-01-05", accountId: mortgage.id, amount: 1050, principalAmount: 900, interestAmount: 100, feeAmount: 50 }),
			],
		});
		const [year] = summarizeByYear(s, mortgage.id);
		expect(year.expenses).toBeCloseTo(150, 6); // interest + fee, not principal
		expect(year.debtPrincipal).toBeCloseTo(900, 6);
	});

	it("a credit-card payment with no split recorded stays fully net-worth-neutral, exactly as before Phase 4", () => {
		const s = store({
			accounts: [credit],
			transactions: [tx({ date: "2024-01-05", accountId: credit.id, amount: 500 })],
		});
		const [year] = summarizeByYear(s, credit.id);
		expect(year.income).toBe(0);
		expect(year.expenses).toBe(0);
		expect(year.debtPrincipal).toBe(500);
	});

	it("sums correctly across several split payments in the same year", () => {
		const s = store({
			accounts: [mortgage],
			transactions: [
				tx({ date: "2024-01-05", accountId: mortgage.id, amount: 1000, principalAmount: 700, interestAmount: 300 }),
				tx({ date: "2024-02-05", accountId: mortgage.id, amount: 1005, principalAmount: 705, interestAmount: 300 }),
			],
		});
		const [year] = summarizeByYear(s, mortgage.id);
		expect(year.expenses).toBeCloseTo(600, 6);
		expect(year.debtPrincipal).toBeCloseTo(1405, 6);
	});

	it("the aggregate (all-accounts, no-snapshots) net-worth walk still reconstructs the same total netWorthAsOf computes directly, with a split payment in the mix", () => {
		// Regression found by an independent review: bucket.transferAmount used to only track the fully-
		// neutral case, so a split payment's principal portion (neutral) fell out of the
		// income-expenses+transferAmount walk entirely once its interest portion made the row no longer
		// fully neutral — silently drifting the walked netWorthEOY away from the real total. This only
		// shows up with no accountId (aggregate) and no snapshots anywhere (summarizeByYear routes to the
		// walking-cumulative branch only then) — a single-account call like the tests above never
		// exercised the walk at all, which is exactly why this slipped through.
		const s = store({
			accounts: [checking, mortgage],
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: 5000, categoryId: catIncome.id }),
				tx({ date: "2024-01-05", accountId: mortgage.id, amount: 1000, principalAmount: 700, interestAmount: 300 }),
			],
		});
		const years = summarizeByYear(s); // no accountId -> aggregate, useNetSavingsOnly path
		const [year] = years;
		// netWorthAsOf sums every account's raw ledger balance directly (liability-signed opening
		// balance plus every transaction's raw amount, unconditionally — it has no notion of a
		// principal/interest split at all). The walked reconstruction must land on exactly the same
		// total despite going through the classifier and the income/expenses/transferAmount split to get
		// there — that agreement is the actual regression test; before the fix, the walk read €300 too
		// low (the interest expense was subtracted from the walk without the matching +300 that
		// netWorthAsOf's raw sum never subtracted out in the first place).
		expect(year.netWorthEOY).toBeCloseTo(netWorthAsOf(s, "2024-12-31"), 6);
	});
});

// ---------- moving-average cost basis + realized P/L (FIN-001) ----------

describe("moving-average cost basis on sell", () => {
	it("removes basis at the pre-sale average unit cost, not at the sale proceeds, on a profitable sell", () => {
		// Buy 10 @ 100 = 1000 cost basis, avg cost 100/share. Sell 4 @ 150 = 600 proceeds.
		// Old (wrong) formula: netInvested -= proceeds (600) -> 400 basis left for 6 shares (avg 66.67 — nonsense).
		// Correct: costRemoved = avgCost(100) * 4 = 400 -> 600 basis left for 6 shares (avg 100, unchanged).
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: 600, action: "sell", ticker: "VWCE", shares: 4 }),
			],
		});
		const holdings = investingHoldings(s, investing.id);
		expect(holdings).toHaveLength(1);
		expect(holdings[0].shares).toBeCloseTo(6, 6);
		expect(holdings[0].netInvested).toBeCloseTo(600, 6);
		expect(holdings[0].avgCost).toBeCloseTo(100, 6);
		// Realized gain = proceeds(600) - costRemoved(400) = 200.
		expect(holdings[0].realizedPnL).toBeCloseTo(200, 6);
	});

	it("removes basis at the pre-sale average unit cost on a loss-making sell, and still tracks a negative realizedPnL", () => {
		// Buy 10 @ 100 = 1000. Sell 4 @ 50 = 200 proceeds (a loss).
		// Correct: costRemoved = 100 * 4 = 400 -> 600 basis left for 6 shares (avg still 100).
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: 200, action: "sell", ticker: "VWCE", shares: 4 }),
			],
		});
		const holdings = investingHoldings(s, investing.id);
		expect(holdings[0].netInvested).toBeCloseTo(600, 6);
		expect(holdings[0].avgCost).toBeCloseTo(100, 6);
		expect(holdings[0].realizedPnL).toBeCloseTo(-200, 6); // 200 proceeds - 400 costRemoved
	});

	it("keeps realized P/L for a fully closed position even though it's dropped from open holdings", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: -100, action: "buy", ticker: "AAPL", shares: 1 }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: 120, action: "sell", ticker: "AAPL", shares: 1 }),
			],
		});
		expect(investingHoldings(s, investing.id)).toHaveLength(0);
		expect(investingRealizedPnLAsOf(s, investing.id)).toBeCloseTo(20, 6);
	});

	it("processes buys/sells in date order regardless of their order in the transactions array", () => {
		// Sell listed BEFORE its corresponding buy in the array — store.transactions carries no ordering
		// guarantee (import order, manual entry order), so this must sort by date internally rather than
		// trusting array order, or the sell would see 0 pre-sale shares and compute nonsense.
		const s = store({
			transactions: [
				tx({ date: "2024-02-01", accountId: investing.id, amount: 600, action: "sell", ticker: "VWCE", shares: 4 }),
				tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
			],
		});
		const holdings = investingHoldings(s, investing.id);
		expect(holdings[0].shares).toBeCloseTo(6, 6);
		expect(holdings[0].netInvested).toBeCloseTo(600, 6);
		expect(holdings[0].realizedPnL).toBeCloseTo(200, 6);
	});

	it("sums realized P/L across a mix of open and closed tickers", () => {
		const s = store({
			transactions: [
				// AAPL: fully closed at a 20 gain.
				tx({ date: "2024-01-01", accountId: investing.id, amount: -100, action: "buy", ticker: "AAPL", shares: 1 }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: 120, action: "sell", ticker: "AAPL", shares: 1 }),
				// VWCE: still open, no realized P/L yet.
				tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
			],
		});
		expect(investingRealizedPnLAsOf(s, investing.id)).toBeCloseTo(20, 6);
		expect(investingOpenCostBasisAsOf(s, investing.id)).toBeCloseTo(1000, 6);
	});
});

// ---------- snapshot-anchored investment valuation (FIN-003) ----------

describe("netWorthAsOf — investing/crypto accounts without a snapshot", () => {
	it("adds open cost basis back on top of raw cash, instead of leaving a Buy looking like money that vanished", () => {
		// Buy 1000 worth of VWCE: raw cash-only balance would read -1000 (money left the account), but
		// the account still holds 1000 of cost-basis value in the position.
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 })],
		});
		expect(netWorthAsOf(s, "2024-12-31", investing.id)).toBeCloseTo(0, 6); // -1000 cash + 1000 open cost basis
	});

	it("reflects a realized gain in the raw cash balance once a position is sold, without double-counting via open cost basis", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
				tx({ date: "2024-06-01", accountId: investing.id, amount: 1200, action: "sell", ticker: "VWCE", shares: 10 }),
			],
		});
		// Fully sold out: open cost basis is 0, so total value is just the raw cash balance, which
		// already includes the realized 200 gain (-1000 + 1200 = 200).
		expect(netWorthAsOf(s, "2024-12-31", investing.id)).toBeCloseTo(200, 6);
	});

	it("applies the same open-cost-basis fallback to a crypto account, not just investing", () => {
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: crypto.id, amount: -500, action: "buy", ticker: "BTC", shares: 0.01 })],
		});
		expect(netWorthAsOf(s, "2024-12-31", crypto.id)).toBeCloseTo(0, 6);
	});

	it("defers entirely to a recorded snapshot once one exists, ignoring the cost-basis fallback", () => {
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 })],
			snapshots: [{ id: "snap-1", accountId: investing.id, date: "2024-06-01", balance: 5000 }],
		});
		expect(netWorthAsOf(s, "2024-12-31", investing.id)).toBeCloseTo(5000, 6);
	});

	it("treats a Buy after the snapshot date as neutral, not as money that drains the account (regression: a prior fix only applied the cost-basis fallback when NO snapshot existed at all, so once any snapshot was recorded, post-snapshot trades went right back to draining net worth by their full cash amount)", () => {
		const s = store({
			transactions: [tx({ date: "2024-07-01", accountId: investing.id, amount: -2000, action: "buy", ticker: "VWCE", shares: 20 })],
			snapshots: [{ id: "snap-1", accountId: investing.id, date: "2024-06-01", balance: 20000 }],
		});
		// The buy converts cash into a security assumed worth what was paid — total value stays 20000,
		// not 18000 (the bug: snapshot minus the buy's full raw cash amount).
		expect(netWorthAsOf(s, "2024-12-31", investing.id)).toBeCloseTo(20000, 6);
	});

	it("realizes only the gain/loss (not the full proceeds) from a Sell after the snapshot date", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-07-01", accountId: investing.id, amount: -2000, action: "buy", ticker: "VWCE", shares: 20 }),
				tx({ date: "2024-08-01", accountId: investing.id, amount: 1200, action: "sell", ticker: "VWCE", shares: 10 }),
			],
			snapshots: [{ id: "snap-1", accountId: investing.id, date: "2024-06-01", balance: 20000 }],
		});
		// Buy is neutral (value stays 20000 through the purchase). Sell 10 @ avg cost 100 = 1000 basis
		// removed, proceeds 1200 -> realized gain 200. Total value = 20000 + 200 = 20200, not
		// 20000 - 2000 + 1200 = 19200 (the raw-cash-only bug) and not 20000 + 1200 (double-counting proceeds).
		expect(netWorthAsOf(s, "2024-12-31", investing.id)).toBeCloseTo(20200, 6);
	});

	it("still counts a deposit or dividend after the snapshot date as real cash movement, not as a neutral trade", () => {
		const s = store({
			transactions: [tx({ date: "2024-07-01", accountId: investing.id, amount: 500, action: "dividend", ticker: "VWCE" })],
			snapshots: [{ id: "snap-1", accountId: investing.id, date: "2024-06-01", balance: 20000 }],
		});
		expect(netWorthAsOf(s, "2024-12-31", investing.id)).toBeCloseTo(20500, 6);
	});
});

// ---------- pre-snapshot position sold post-snapshot (v1.2.7 remediation Phase 1) ----------
//
// A snapshot states real market value, which historical cost is not. Selling a position that already
// existed *before* the snapshot, for a price that matches (or differs from) the value the snapshot had
// already assigned it, must not add the historical-cost gain/loss on top of a snapshot that already
// contains it — that was a real bug in the fallback above (it only handled positions opened *after*
// the snapshot correctly). Fixtures include an explicit deposit before the buy, matching a real
// checking-then-invest sequence, so pureCashAsOf's "cash at snapshot time" reads as the deposit-minus-buy
// figure a real vault would have, not an unrealistic bare negative balance.
describe("netWorthAsOf — selling a pre-snapshot position after the snapshot", () => {
	it("Test A: selling a fully appreciated pre-snapshot position at exactly its snapshot-implied value is net-worth neutral", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: 1000, action: "deposit" }),
				tx({ date: "2024-01-02", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
				tx({ date: "2024-08-01", accountId: investing.id, amount: 1500, action: "sell", ticker: "VWCE", shares: 10 }),
			],
			snapshots: [{ id: "snap-1", accountId: investing.id, date: "2024-06-01", balance: 1500 }],
		});
		// Nothing financially happened at the sale: €1,500 of shares became €1,500 of cash.
		expect(netWorthAsOf(s, "2024-12-31", investing.id)).toBeCloseTo(1500, 6);
		// Historical-cost realized P/L (a separate, "for your records" figure) still shows the true
		// all-time gain against what was actually paid — untouched by the valuation-side reset.
		expect(investingRealizedPnLAsOf(s, investing.id)).toBeCloseTo(500, 6);
	});

	it("Test B: selling a depreciated pre-snapshot position at exactly its snapshot-implied value is net-worth neutral, and the loss isn't subtracted twice", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: 1000, action: "deposit" }),
				tx({ date: "2024-01-02", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
				tx({ date: "2024-08-01", accountId: investing.id, amount: 700, action: "sell", ticker: "VWCE", shares: 10 }),
			],
			snapshots: [{ id: "snap-1", accountId: investing.id, date: "2024-06-01", balance: 700 }],
		});
		expect(netWorthAsOf(s, "2024-12-31", investing.id)).toBeCloseTo(700, 6);
		expect(investingRealizedPnLAsOf(s, investing.id)).toBeCloseTo(-300, 6);
	});

	it("Test C: a partial disposal at the snapshot-implied per-share price leaves total value unchanged", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: 1000, action: "deposit" }),
				tx({ date: "2024-01-02", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
				// Snapshot implies €150/share (1500 total / 10 shares); selling 5 at that same rate (€750)
				// is just converting half the position to cash, not a gain or loss.
				tx({ date: "2024-08-01", accountId: investing.id, amount: 750, action: "sell", ticker: "VWCE", shares: 5 }),
			],
			snapshots: [{ id: "snap-1", accountId: investing.id, date: "2024-06-01", balance: 1500 }],
		});
		expect(netWorthAsOf(s, "2024-12-31", investing.id)).toBeCloseTo(1500, 6);
	});

	it("a sale above the snapshot-implied price still books the genuinely new gain since the snapshot", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: 1000, action: "deposit" }),
				tx({ date: "2024-01-02", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
				// Snapshot implies €150/share; sold for €160/share (€1,600) — €100 of genuinely new gain
				// accrued after the snapshot, on top of the €500 the snapshot already captured.
				tx({ date: "2024-08-01", accountId: investing.id, amount: 1600, action: "sell", ticker: "VWCE", shares: 10 }),
			],
			snapshots: [{ id: "snap-1", accountId: investing.id, date: "2024-06-01", balance: 1500 }],
		});
		expect(netWorthAsOf(s, "2024-12-31", investing.id)).toBeCloseTo(1600, 6);
	});

	it("degenerate case: a near-zero (free-share) cost basis at snapshot time still doesn't double-count on a later sell", () => {
		// Shares recorded at zero cost (e.g. a stock grant) held at snapshot time: the proportional
		// reset factor (impliedValue / originalCostBasis) is undefined when the denominator is ~0. Falling
		// back to a no-op reset (factor of 1) would leave the original ~€0 cost basis in place, and
		// selling later would book the *entire* sale price as a "gain" — reproducing the exact
		// double-counting bug this mechanism exists to prevent, for exactly the positions where its
		// effect is largest.
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: 0, action: "buy", ticker: "VWCE", shares: 10 }),
				tx({ date: "2024-08-01", accountId: investing.id, amount: 1500, action: "sell", ticker: "VWCE", shares: 10 }),
			],
			snapshots: [{ id: "snap-1", accountId: investing.id, date: "2024-06-01", balance: 1500 }],
		});
		// Selling at exactly the snapshot-implied value is net-worth neutral, same as every other "sold
		// at the snapshot's own price" case — not a windfall €1,500 gain.
		expect(netWorthAsOf(s, "2024-12-31", investing.id)).toBeCloseTo(1500, 6);
	});
});

describe("investmentStateAsOf", () => {
	it("reports cash, holdings, open cost basis, and realized P/L as separate, non-overlapping figures", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: 600, action: "sell", ticker: "VWCE", shares: 4 }),
			],
		});
		const state = investmentStateAsOf(s, investing.id, "2024-12-31");
		expect(state.cash).toBeCloseTo(-400, 6); // -1000 + 600 raw cash
		expect(state.openCostBasis).toBeCloseTo(600, 6);
		expect(state.realizedPnL).toBeCloseTo(200, 6);
		expect(state.marketValue).toBeUndefined();
		expect(state.totalValue).toBeCloseTo(200, 6); // cash(-400) + openCostBasis(600)
	});

	it("uses the snapshot as marketValue and totalValue when one exists, without adding open cost basis on top", () => {
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 })],
			snapshots: [{ id: "snap-1", accountId: investing.id, date: "2024-06-01", balance: 1800 }],
		});
		const state = investmentStateAsOf(s, investing.id, "2024-12-31");
		expect(state.marketValue).toBeCloseTo(1800, 6);
		expect(state.totalValue).toBeCloseTo(1800, 6);
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

	it("converts a fee in a foreign currency into the base currency, not the raw figure (v1.2.7 Phase 5.3)", () => {
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", currency: "USD", fee: 10 })],
			fx: { baseCurrency: "EUR", rates: { USD: 0.9 } },
		});
		const [year] = investingActivityByYear(s, investing.id);
		// $10 fee at 0.9 EUR/USD = €9, not the raw $10 figure.
		expect(year.fees).toBeCloseTo(9, 6);
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

	it("uses the monthly rate that actually compounds to the stated annual rate, not annualReturn/12 (FIN-011)", () => {
		// No contributions — pure compounding, so the year count is exactly log(target/start) / log(1+monthlyReturn) / 12.
		// The true monthly rate for a 7% annual return is (1.07)^(1/12) - 1 ≈ 0.5654%, not 7%/12 ≈ 0.5833%.
		const correctMonthlyReturn = Math.pow(1.07, 1 / 12) - 1;
		const naiveMonthlyReturn = 0.07 / 12;
		expect(correctMonthlyReturn).toBeLessThan(naiveMonthlyReturn); // sanity check on the two formulas

		const years = fiProjection(100_000, 0, 0.07, 200_000);
		// Reaching double the starting balance takes ln(2)/ln(1+r) months at the correct monthly rate.
		const expectedMonths = Math.ceil(Math.log(2) / Math.log(1 + correctMonthlyReturn));
		expect(years).toBeCloseTo(expectedMonths / 12, 6);
		// The naive (annualReturn/12) formula would reach the target measurably sooner, since it compounds faster.
		const naiveMonths = Math.ceil(Math.log(2) / Math.log(1 + naiveMonthlyReturn));
		expect(naiveMonths).toBeLessThan(expectedMonths);
	});
});

// ---------- fiExpenseBase ----------

describe("fiExpenseBase", () => {
	it("annualizes the trailing 12 complete months, including a genuinely zero-spend month in the average", () => {
		// The window is always anchored to the real "today" (there's no injectable clock), so the
		// fixture dates are built relative to lastCompleteMonthKey() rather than hardcoded — otherwise
		// this test would silently start failing once "now" moves far enough past a fixed year.
		const end = lastCompleteMonthKey();
		const threeMonthsAgo = shiftMonthKey(end, -2);
		const s = store({
			transactions: [
				tx({ date: `${threeMonthsAgo}-05`, accountId: checking.id, amount: -1200, categoryId: catFood.id }),
				// The month in between has nothing at all — a real zero-spend month, must still count.
				tx({ date: `${end}-05`, accountId: checking.id, amount: -1200, categoryId: catFood.id }),
			],
		});
		const base = fiExpenseBase(s);
		// Exactly 3 months of history (threeMonthsAgo, the empty month between, and end):
		// (1200 + 0 + 1200) / 3 * 12 = 9600.
		expect(base.annual).toBeCloseTo(9600, 6);
		expect(base.monthsCovered).toBe(3);
		expect(base.complete).toBe(false);
	});

	it("is 0/incomplete with no transaction history at all", () => {
		const base = fiExpenseBase(store());
		expect(base.annual).toBe(0);
		expect(base.complete).toBe(false);
	});

	it("annualizes net (income - expenses) over the same window as the expense figure", () => {
		const end = lastCompleteMonthKey();
		const oneMonthAgo = shiftMonthKey(end, -1);
		const s = store({
			transactions: [
				tx({ date: `${oneMonthAgo}-05`, accountId: checking.id, amount: 3000, categoryId: catIncome.id }),
				tx({ date: `${oneMonthAgo}-06`, accountId: checking.id, amount: -1000, categoryId: catFood.id }),
				tx({ date: `${end}-05`, accountId: checking.id, amount: -500, categoryId: catFood.id }),
			],
		});
		const base = fiExpenseBase(s);
		// 2 months of history: income (3000 + 0)/2*12 = 18000, expenses (1000+500)/2*12 = 9000.
		expect(base.annual).toBeCloseTo(9000, 6);
		expect(base.netAnnual).toBeCloseTo(18000 - 9000, 6);
	});

	it("excludes a transfer/trade/debt-principal row from both the expense and income sides", () => {
		const end = lastCompleteMonthKey();
		const s = store({
			transactions: [tx({ date: `${end}-05`, accountId: checking.id, amount: 500, transferGroupId: "g1" })],
		});
		const base = fiExpenseBase(s);
		expect(base.annual).toBe(0);
		expect(base.netAnnual).toBe(0);
	});
});

// ---------- flow vs stock FX end-to-end (v1.2.7 remediation Phase 3) ----------

describe("netWorthAsOf — historical (dated) FX wiring", () => {
	const usDollar: Account = { id: "acc-usd", name: "US account", type: "debit", currency: "USD" };

	it("converts a flow (a transaction) at its own date, not today's rate", () => {
		const s = store({
			accounts: [usDollar],
			transactions: [tx({ date: "2020-01-01", accountId: usDollar.id, amount: 1000, currency: "USD" })],
			fx: { baseCurrency: "EUR", rates: { USD: 0.9 }, history: { "2020-01-01": { USD: 0.8 } } },
		});
		// Historical rate (0.8) applies, not today's (0.9): 1000 * 0.8 = 800, not 900.
		expect(netWorthAsOf(s, "2024-12-31", usDollar.id)).toBeCloseTo(800, 6);
	});

	it("converts a snapshot (a stock, but a dated observation) at the snapshot's own date, not today's rate", () => {
		const s = store({
			accounts: [usDollar],
			transactions: [],
			snapshots: [{ id: "snap-1", accountId: usDollar.id, date: "2022-06-01", balance: 1000 }],
			fx: { baseCurrency: "EUR", rates: { USD: 0.9 }, history: { "2022-06-01": { USD: 0.85 } } },
		});
		expect(netWorthAsOf(s, "2024-12-31", usDollar.id)).toBeCloseTo(850, 6);
	});

	it("an opening balance (no date of its own) always uses today's rate, not history", () => {
		const withOpeningBalance: Account = { ...usDollar, openingBalance: 1000 };
		const s = store({
			accounts: [withOpeningBalance],
			transactions: [],
			fx: { baseCurrency: "EUR", rates: { USD: 0.9 }, history: { "2020-01-01": { USD: 0.8 } } },
		});
		expect(netWorthAsOf(s, "2024-12-31", withOpeningBalance.id)).toBeCloseTo(900, 6);
	});

	it("reads as incomplete rather than a plausible number when a flow's own date has no historical rate and no current rate exists either", () => {
		const s = store({
			accounts: [usDollar],
			transactions: [tx({ date: "2020-01-01", accountId: usDollar.id, amount: 1000, currency: "USD" })],
			fx: { baseCurrency: "EUR" }, // no rates at all
		});
		expect(netWorthAsOf(s, "2024-12-31", usDollar.id)).toBeNaN();
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

describe("register-only accounts and net worth", () => {
	it("leaves an untracked account out instead of counting it as zero", () => {
		// Zero is a claim that the account holds nothing. "Not tracked" is a claim that nobody knows,
		// and the two must not produce the same total.
		const tracked: Account = { id: "acc-t", name: "Tracked", type: "debit", currency: "EUR", openingBalance: 100 };
		const register: Account = {
			id: "acc-r",
			name: "Register only",
			type: "debit",
			currency: "EUR",
			openingBalance: 5000,
			trackBalance: false,
		};
		const store = {
			accounts: [tracked, register],
			categories: [],
			transactions: [
				{ id: "t1", date: "2026-01-05", accountId: "acc-t", description: "Shop", amount: -10, currency: "EUR", source: "manual" },
				{ id: "t2", date: "2026-01-06", accountId: "acc-r", description: "Shop", amount: -900, currency: "EUR", source: "manual" },
			],
			snapshots: [],
		} as unknown as Parameters<typeof netWorthAsOf>[0];

		// Only the tracked account: 100 opening less 10 spent.
		expect(netWorthAsOf(store, "2026-12-31")).toBe(90);
	});

	it("reports zero for an untracked account asked about by name", () => {
		const register: Account = { id: "acc-r", name: "R", type: "debit", currency: "EUR", openingBalance: 5000, trackBalance: false };
		const store = { accounts: [register], categories: [], transactions: [], snapshots: [] } as unknown as Parameters<
			typeof netWorthAsOf
		>[0];
		// Callers that want to say "N/A" rather than "€0.00" read the flag; this only guarantees the
		// figure never leaks into a total.
		expect(netWorthAsOf(store, "2026-12-31", "acc-r")).toBe(0);
	});

	it("still counts a tracked account exactly as before", () => {
		const tracked: Account = { id: "acc-t", name: "T", type: "debit", currency: "EUR", openingBalance: 250 };
		const store = { accounts: [tracked], categories: [], transactions: [], snapshots: [] } as unknown as Parameters<
			typeof netWorthAsOf
		>[0];
		expect(netWorthAsOf(store, "2026-12-31")).toBe(250);
	});
});
