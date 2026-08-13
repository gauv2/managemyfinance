import { describe, expect, it } from "vitest";
import { netWorth, netWorthAsOf, primaryCategoryTotals, snapshotAsOf, summarizeByYear, type KpiStore } from "./kpi";
import type { Account, Category, Transaction } from "./types";

/**
 * The three things that changed about how figures are calculated: money in more than one currency,
 * balances recorded by hand, and accounts that represent what you owe rather than what you hold.
 * (The original kpi.test.ts still covers everything that came before.)
 */

const checking: Account = { id: "checking", name: "Checking", type: "debit", currency: "EUR", openingBalance: 0 };
const dollars: Account = { id: "dollars", name: "US brokerage", type: "investing", currency: "USD", openingBalance: 0 };
const house: Account = { id: "house", name: "House", type: "property", currency: "EUR", openingBalance: 0 };
const mortgage: Account = { id: "mortgage", name: "Mortgage", type: "mortgage", currency: "EUR", openingBalance: 0 };

const catFood: Category = { id: "cat-food", name: "Food", color: "#000", icon: "utensils", aliases: [] };

let nextId = 0;
function tx(partial: Partial<Transaction> & Pick<Transaction, "date" | "accountId" | "amount">): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, description: "test", currency: "EUR", source: "manual", ...partial };
}

function store(overrides: Partial<KpiStore> = {}): KpiStore {
	return { accounts: [checking], categories: [catFood], transactions: [], ...overrides };
}

describe("multi-currency totals", () => {
	const fx = { baseCurrency: "EUR", rates: { USD: 0.9 } };

	it("converts a foreign-currency transaction into the base currency", () => {
		const s = store({
			accounts: [checking, dollars],
			transactions: [tx({ date: "2024-01-01", accountId: dollars.id, amount: 1000, currency: "USD" })],
		});
		expect(netWorth({ ...s, fx })).toBeCloseTo(900, 6);
	});

	it("adds dollars to euros as dollars only when no rate is set", () => {
		// Documented behaviour: an unknown rate passes through 1:1 rather than dropping the row.
		const s = store({
			accounts: [checking, dollars],
			transactions: [tx({ date: "2024-01-01", accountId: dollars.id, amount: 1000, currency: "USD" })],
		});
		expect(netWorth({ ...s, fx: { baseCurrency: "EUR" } })).toBe(1000);
	});

	it("converts income, expenses and category totals alike", () => {
		const s = {
			...store({
				accounts: [checking, dollars],
				transactions: [
					tx({ date: "2024-01-01", accountId: dollars.id, amount: 200, currency: "USD" }),
					tx({ date: "2024-01-02", accountId: dollars.id, amount: -100, currency: "USD", categoryId: catFood.id }),
				],
			}),
			fx,
		};
		const year = summarizeByYear(s)[0];
		expect(year.income).toBeCloseTo(180, 6);
		expect(year.expenses).toBeCloseTo(90, 6);
		expect(primaryCategoryTotals(s).get(catFood.id)).toBeCloseTo(90, 6);
	});

	it("converts an account's opening balance from the account's own currency", () => {
		const s = store({ accounts: [{ ...dollars, openingBalance: 1000 }], transactions: [] });
		expect(netWorth({ ...s, fx })).toBeCloseTo(900, 6);
	});
});

describe("recorded balances", () => {
	it("uses the balance you recorded instead of opening balance plus transactions", () => {
		const s = store({
			accounts: [{ ...checking, openingBalance: 100 }],
			transactions: [tx({ date: "2024-01-05", accountId: checking.id, amount: -50 })],
			snapshots: [{ id: "s1", accountId: checking.id, date: "2024-06-30", balance: 5000 }],
		});
		expect(netWorth(s)).toBe(5000);
	});

	it("applies transactions dated after the snapshot on top of it", () => {
		const s = store({
			accounts: [checking],
			transactions: [
				tx({ date: "2024-06-01", accountId: checking.id, amount: -999 }),
				tx({ date: "2024-07-01", accountId: checking.id, amount: -100 }),
			],
			snapshots: [{ id: "s1", accountId: checking.id, date: "2024-06-30", balance: 5000 }],
		});
		// The June transaction is already reflected in the recorded balance; only July's applies.
		expect(netWorth(s)).toBe(4900);
	});

	it("values an account at the most recent snapshot on or before the date asked about", () => {
		const s = store({
			accounts: [checking],
			snapshots: [
				{ id: "s1", accountId: checking.id, date: "2023-12-31", balance: 1000 },
				{ id: "s2", accountId: checking.id, date: "2024-12-31", balance: 2000 },
			],
		});
		expect(netWorthAsOf(s, "2024-06-01")).toBe(1000);
		expect(netWorthAsOf(s, "2025-01-01")).toBe(2000);
		expect(snapshotAsOf(s, checking.id, "2024-06-01")!.id).toBe("s1");
		expect(snapshotAsOf(s, checking.id, "2020-01-01")).toBeUndefined();
	});

	it("moves a year's closing net worth once balances are on file, instead of a flat opening figure", () => {
		const s = store({
			accounts: [checking],
			transactions: [
				tx({ date: "2023-06-01", accountId: checking.id, amount: 100 }),
				tx({ date: "2024-06-01", accountId: checking.id, amount: 100 }),
			],
			snapshots: [
				{ id: "s1", accountId: checking.id, date: "2023-12-31", balance: 10_000 },
				{ id: "s2", accountId: checking.id, date: "2024-12-31", balance: 25_000 },
			],
		});
		const years = summarizeByYear(s);
		expect(years.find((y) => y.year === "2023")!.netWorthEOY).toBe(10_000);
		expect(years.find((y) => y.year === "2024")!.netWorthEOY).toBe(25_000);
	});

	it("converts a recorded balance from the account's own currency", () => {
		const s = store({
			accounts: [dollars],
			snapshots: [{ id: "s1", accountId: dollars.id, date: "2024-01-01", balance: 1000 }],
			fx: { baseCurrency: "EUR", rates: { USD: 0.9 } },
		});
		expect(netWorth(s)).toBeCloseTo(900, 6);
	});
});

describe("liabilities and non-bank assets", () => {
	it("counts a mortgage balance against net worth, entered as the amount owed", () => {
		const s = store({
			accounts: [
				{ ...house, openingBalance: 400_000 },
				{ ...mortgage, openingBalance: 250_000 },
			],
		});
		expect(netWorth(s)).toBe(150_000);
	});

	it("moves a liability toward zero as repayments are recorded", () => {
		const s = store({
			accounts: [{ ...mortgage, openingBalance: 250_000 }],
			// A repayment arrives with an ordinary positive ledger sign on the loan account.
			transactions: [tx({ date: "2024-01-01", accountId: mortgage.id, amount: 1000 })],
		});
		expect(netWorth(s)).toBe(-249_000);
	});

	it("negates a recorded liability balance too", () => {
		const s = store({
			accounts: [mortgage],
			snapshots: [{ id: "s1", accountId: mortgage.id, date: "2024-01-01", balance: 240_000 }],
		});
		expect(netWorth(s)).toBe(-240_000);
	});

	it("still adds an ordinary asset account's balance", () => {
		expect(netWorth(store({ accounts: [{ ...house, openingBalance: 400_000 }] }))).toBe(400_000);
	});
});

describe("linked transfers", () => {
	it("excludes both legs from income and expenses", () => {
		const s = store({
			accounts: [checking, { ...house, id: "savings", type: "saving" }],
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: -500, transferGroupId: "g1" }),
				tx({ date: "2024-01-01", accountId: "savings", amount: 500, transferGroupId: "g1" }),
				tx({ date: "2024-01-02", accountId: checking.id, amount: -40, categoryId: catFood.id }),
			],
		});
		const year = summarizeByYear(s)[0];
		expect(year.income).toBe(0);
		expect(year.expenses).toBe(40);
	});

	it("leaves combined net worth unchanged by a transfer", () => {
		const s = store({
			accounts: [checking, { ...house, id: "savings", type: "saving" }],
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: -500, transferGroupId: "g1" }),
				tx({ date: "2024-01-01", accountId: "savings", amount: 500, transferGroupId: "g1" }),
			],
		});
		expect(netWorth(s)).toBe(0);
	});

	it("keeps a linked transfer out of category spending totals", () => {
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: checking.id, amount: -500, categoryId: catFood.id, transferGroupId: "g1" })],
		});
		expect(primaryCategoryTotals(s).get(catFood.id)).toBeUndefined();
	});
});
