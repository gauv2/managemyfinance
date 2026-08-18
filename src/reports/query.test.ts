import { describe, expect, it } from "vitest";
import { summarizeByYear } from "../kpi";
import { describePeriod, describeQuery, expandCategoryIds, reportSlug, runReport, UNCATEGORIZED, type ReportSource } from "./query";
import type { Account, Category, Transaction } from "../types";

const food: Category = { id: "food", name: "Food", color: "#1", icon: "utensils", aliases: [] };
const restaurants: Category = { id: "rest", name: "Restaurants", color: "#2", icon: "utensils", aliases: [], parentId: "food" };
const groceries: Category = { id: "groc", name: "Groceries", color: "#3", icon: "cart", aliases: [], parentId: "food" };
const transport: Category = { id: "trans", name: "Transport", color: "#4", icon: "car", aliases: [] };
const fuel: Category = { id: "fuel", name: "Fuel", color: "#5", icon: "fuel", aliases: [], parentId: "trans" };
const salary: Category = { id: "salary", name: "Salary", color: "#6", icon: "coins", aliases: [], kind: "income" };
const categories = [food, restaurants, groceries, transport, fuel, salary];

const accounts: Account[] = [
	{ id: "acc1", name: "Checking", type: "debit", currency: "EUR" },
	{ id: "acc2", name: "Credit card", type: "credit", currency: "EUR" },
];

let seq = 0;
function tx(date: string, amount: number, categoryId?: string, over: Partial<Transaction> = {}): Transaction {
	seq++;
	return {
		id: `t${seq}`,
		date,
		accountId: "acc1",
		description: "Row",
		amount,
		currency: "EUR",
		source: "manual",
		categoryId,
		...over,
	} as Transaction;
}

function source(transactions: Transaction[], fx?: ReportSource["fx"]): ReportSource {
	return { transactions, categories, accounts, fx };
}

describe("expandCategoryIds", () => {
	it("pulls a primary's secondaries in with it", () => {
		expect(expandCategoryIds(categories, ["food"])).toEqual(new Set(["food", "rest", "groc"]));
	});

	it("takes a secondary on its own", () => {
		expect(expandCategoryIds(categories, ["rest"])).toEqual(new Set(["rest"]));
	});

	it("keeps the uncategorized sentinel as-is", () => {
		expect(expandCategoryIds(categories, [UNCATEGORIZED])).toEqual(new Set([UNCATEGORIZED]));
	});

	it("returns undefined for an empty selection, meaning 'no category filter'", () => {
		expect(expandCategoryIds(categories, [])).toBeUndefined();
		expect(expandCategoryIds(categories, undefined)).toBeUndefined();
	});
});

describe("runReport — the headline question", () => {
	const rows = [
		tx("2025-02-14", -48.5, "rest"),
		tx("2025-07-02", -31.2, "rest"),
		tx("2024-11-30", -60, "rest"),
		tx("2025-03-01", -85, "groc"),
		tx("2025-05-20", -70, "fuel"),
		tx("2025-01-25", 2500, undefined, { description: "Salary" }),
	];

	it("answers 'all the restaurant visits in 2025'", () => {
		const result = runReport(source(rows), { from: "2025-01-01", to: "2025-12-31", categoryIds: ["rest"] });
		expect(result.count).toBe(2);
		expect(result.spent).toBeCloseTo(79.7);
		expect(result.received).toBe(0);
	});

	it("answers a combination of categories in one go", () => {
		const result = runReport(source(rows), { from: "2025-01-01", to: "2025-12-31", categoryIds: ["rest", "fuel"] });
		expect(result.count).toBe(3);
		expect(result.spent).toBeCloseTo(149.7);
	});

	it("includes a primary's secondaries when the primary is chosen", () => {
		const result = runReport(source(rows), { from: "2025-01-01", to: "2025-12-31", categoryIds: ["food"] });
		// Both restaurant rows plus the groceries row — asking for Food and getting no Food rows back
		// because everything is tagged one level down would under-report the question asked.
		expect(result.count).toBe(3);
		expect(result.spent).toBeCloseTo(164.7);
	});

	it("bounds the period inclusively at both ends", () => {
		expect(runReport(source(rows), { from: "2025-02-14", to: "2025-02-14" }).count).toBe(1);
	});

	it("reports net as received minus spent", () => {
		const result = runReport(source(rows), { from: "2025-01-01", to: "2025-12-31" });
		expect(result.net).toBeCloseTo(result.received - result.spent);
		expect(result.received).toBe(2500);
	});

	it("tracks the largest single expense", () => {
		expect(runReport(source(rows), { from: "2025-01-01", to: "2025-12-31" }).largest).toBe(85);
	});
});

describe("runReport — filters", () => {
	it("filters by direction", () => {
		const rows = [tx("2025-01-01", -10, "rest"), tx("2025-01-02", 20)];
		expect(runReport(source(rows), { direction: "out" }).count).toBe(1);
		expect(runReport(source(rows), { direction: "in" }).count).toBe(1);
		expect(runReport(source(rows), { direction: "all" }).count).toBe(2);
	});

	it("filters by account", () => {
		const rows = [tx("2025-01-01", -10), tx("2025-01-02", -20, undefined, { accountId: "acc2" })];
		expect(runReport(source(rows), { accountIds: ["acc2"] }).count).toBe(1);
		expect(runReport(source(rows), { accountIds: [] }).count).toBe(2);
	});

	it("searches description, counterparty and notes", () => {
		const rows = [
			tx("2025-01-01", -10, undefined, { description: "Dinner out" }),
			tx("2025-01-02", -10, undefined, { description: "Row", counterparty: "Dinner Club" }),
			tx("2025-01-03", -10, undefined, { description: "Row", notes: "the dinner one" }),
			tx("2025-01-04", -10, undefined, { description: "Petrol" }),
		];
		expect(runReport(source(rows), { search: "dinner" }).count).toBe(3);
	});

	it("selects rows with no category via the sentinel", () => {
		const rows = [tx("2025-01-01", -10, "rest"), tx("2025-01-02", -10)];
		const result = runReport(source(rows), { categoryIds: [UNCATEGORIZED] });
		expect(result.count).toBe(1);
		expect(result.rows[0].categoryId).toBeUndefined();
	});

	it("excludes transfers from the row set unless asked for — moved money is not spending", () => {
		const rows = [tx("2025-01-01", -500, undefined, { transferGroupId: "g1" }), tx("2025-01-02", -20, "rest")];
		expect(runReport(source(rows), {}).spent).toBe(20);
		expect(runReport(source(rows), {}).count).toBe(1);
		expect(runReport(source(rows), { includeTransfers: true }).count).toBe(2);
	});

	// v1.2.7 remediation Phase 2: economic mode's `spent` never counts a transfer, even when
	// includeTransfers makes the row visible in the list — a transfer isn't economic expense no matter
	// how you slice it, and `spent`/`received` are meant to answer "what did this cost", not "what's in
	// the row list". Cash-flow mode is the escape hatch for "how much cash actually moved".
	it("economic mode never counts a transfer's cash toward `spent`, even with includeTransfers — that's what cash-flow mode is for", () => {
		const rows = [tx("2025-01-01", -500, undefined, { transferGroupId: "g1" }), tx("2025-01-02", -20, "rest")];
		expect(runReport(source(rows), { includeTransfers: true }).spent).toBe(20);
		expect(runReport(source(rows), { measure: "cash-flow", includeTransfers: true }).spent).toBe(520);
	});
});

// ---------- economic vs cash-flow semantics (v1.2.7 remediation Phase 2) ----------

describe("runReport — economic measure (the default)", () => {
	it("Test A: nets a refund against the expense it returned", () => {
		const rows = [tx("2025-01-01", -300, "rest"), tx("2025-01-02", 50, "rest")];
		expect(runReport(source(rows), {}).spent).toBe(250);
		expect(runReport(source(rows), { direction: "out" }).spent).toBe(250);
	});

	it("Test B: a refund does not count as income", () => {
		const rows = [tx("2025-01-01", 2000, "salary"), tx("2025-01-02", 50, "rest")];
		const all = runReport(source(rows), {});
		expect(all.received).toBe(2000);
		// An income-direction report excludes the refund row entirely — it isn't income.
		const incomeOnly = runReport(source(rows), { direction: "in" });
		expect(incomeOnly.received).toBe(2000);
		expect(incomeOnly.count).toBe(1);
	});

	it("Test C: investment trades stay excluded from economic totals, dividends still count as income", () => {
		const rows = [
			tx("2025-01-01", -2000, undefined, { accountId: "acc-invest", action: "buy", ticker: "VWCE", shares: 10 }),
			tx("2025-01-02", 2500, undefined, { accountId: "acc-invest", action: "sell", ticker: "VWCE", shares: 10 }),
			tx("2025-01-03", 30, undefined, { accountId: "acc-invest", action: "dividend", ticker: "VWCE" }),
		];
		const investingAccounts: Account[] = [...accounts, { id: "acc-invest", name: "Investing", type: "investing", currency: "EUR" }];
		const result = runReport({ transactions: rows, categories, accounts: investingAccounts }, {});
		expect(result.received).toBe(30);
		expect(result.spent).toBe(0);
	});

	it("Test D: the same trade example only shows gross cash movement in cash-flow mode", () => {
		const rows = [
			tx("2025-01-01", -2000, undefined, { accountId: "acc-invest", action: "buy", ticker: "VWCE", shares: 10 }),
			tx("2025-01-02", 2500, undefined, { accountId: "acc-invest", action: "sell", ticker: "VWCE", shares: 10 }),
			tx("2025-01-03", 30, undefined, { accountId: "acc-invest", action: "dividend", ticker: "VWCE" }),
		];
		const investingAccounts: Account[] = [...accounts, { id: "acc-invest", name: "Investing", type: "investing", currency: "EUR" }];
		const result = runReport({ transactions: rows, categories, accounts: investingAccounts }, { measure: "cash-flow" });
		expect(result.spent).toBe(2000);
		expect(result.received).toBe(2530);
	});

	it("Test E: economic report totals agree with kpi.ts's totals on the identical fixture (cross-module consistency)", () => {
		// FIN-005's cross-module invariant: a report and the dashboard must never disagree about what
		// "spent"/"income" mean for the same rows.
		const rows = [tx("2025-01-01", -300, "rest"), tx("2025-01-02", 50, "rest"), tx("2025-01-03", 2000, "salary")];
		const result = runReport(source(rows), {});
		const [year] = summarizeByYear({ accounts, categories, transactions: rows });
		expect(result.spent).toBe(year.expenses);
		expect(result.received).toBe(year.income);
	});
});

describe("runReport — breakdowns", () => {
	const rows = [
		tx("2025-01-10", -20, "rest", { description: "Albert Heijn 1423" }),
		tx("2025-01-20", -30, "groc", { description: "CCV*ALBERT HEIJN 5566" }),
		tx("2025-03-05", -100, "fuel", { description: "Shell", accountId: "acc2" }),
	];

	it("ranks categories by size", () => {
		const result = runReport(source(rows), {});
		expect(result.byCategory.map((g) => g.label)).toEqual(["Transport › Fuel", "Food › Groceries", "Food › Restaurants"]);
		expect(result.byCategory[0].total).toBe(-100);
	});

	it("keeps months in chronological order, not size order", () => {
		const result = runReport(source(rows), {});
		expect(result.byMonth.map((g) => g.key)).toEqual(["2025-01", "2025-03"]);
	});

	it("counts distinct months for a monthly average", () => {
		expect(runReport(source(rows), {}).months).toBe(2);
	});

	it("collapses a merchant's every form into one line", () => {
		const result = runReport(source(rows), {});
		const ah = result.byMerchant.find((g) => g.label.toLowerCase().includes("albert"));
		expect(ah?.count).toBe(2);
		expect(ah?.total).toBe(-50);
	});

	it("breaks down by account", () => {
		const result = runReport(source(rows), {});
		expect(result.byAccount.map((g) => g.label)).toEqual(["Credit card", "Checking"]);
	});

	it("returns rows newest first", () => {
		expect(runReport(source(rows), {}).rows.map((r) => r.date)).toEqual(["2025-03-05", "2025-01-20", "2025-01-10"]);
	});
});

describe("runReport — currency", () => {
	const fx = { baseCurrency: "EUR", rates: { USD: 0.9 } };

	it("converts every total into the base currency", () => {
		const rows = [tx("2025-01-01", -10, "rest"), tx("2025-01-02", -100, "rest", { currency: "USD" })];
		// A report that added €10 and $100 to "110" would be quietly wrong.
		expect(runReport(source(rows, fx), {}).spent).toBeCloseTo(100);
	});

	it("names the currencies it could not convert", () => {
		const rows = [tx("2025-01-01", -10, "rest", { currency: "JPY" })];
		const result = runReport(source(rows, fx), {});
		expect(result.mixedCurrencies).toEqual(["JPY"]);
		expect(result.baseCurrency).toBe("EUR");
	});
});

describe("describePeriod", () => {
	it("names a whole year by its year", () => {
		expect(describePeriod("2025-01-01", "2025-12-31")).toBe("2025");
	});
	it("names a span of whole years", () => {
		expect(describePeriod("2024-01-01", "2025-12-31")).toBe("2024–2025");
	});
	it("names a single month", () => {
		expect(describePeriod("2025-03-01", "2025-03-31")).toBe("Mar 2025");
	});
	it("names a run of months within one year", () => {
		expect(describePeriod("2025-03-01", "2025-08-15")).toBe("Mar–Aug 2025");
	});
	it("names a span crossing a year boundary", () => {
		expect(describePeriod("2024-11-01", "2025-03-31")).toBe("Nov 2024 – Mar 2025");
	});
	it("handles open-ended and unbounded periods", () => {
		expect(describePeriod(undefined, undefined)).toBe("All time");
		expect(describePeriod("2025-03-01", undefined)).toBe("from 2025-03-01");
		expect(describePeriod(undefined, "2025-03-01")).toBe("up to 2025-03-01");
	});
});

describe("describeQuery", () => {
	const src = source([]);

	it("names the categories and the period", () => {
		expect(describeQuery(src, { categoryIds: ["rest"], from: "2025-01-01", to: "2025-12-31" })).toBe("Restaurants · 2025");
	});

	it("joins a combination of categories", () => {
		expect(describeQuery(src, { categoryIds: ["rest", "fuel"], from: "2025-01-01", to: "2025-12-31" })).toBe(
			"Restaurants, Fuel · 2025"
		);
	});

	it("falls back to a direction-aware label with no categories chosen", () => {
		expect(describeQuery(src, { direction: "out", from: "2025-01-01", to: "2025-12-31" })).toBe("All spending · 2025");
		expect(describeQuery(src, { direction: "in", from: "2025-01-01", to: "2025-12-31" })).toBe("All income · 2025");
		expect(describeQuery(src, { direction: "all", from: "2025-01-01", to: "2025-12-31" })).toBe("All transactions · 2025");
	});
});

describe("reportSlug", () => {
	it("strips the characters a filename can't hold", () => {
		expect(reportSlug("Restaurants · 2025")).toBe("Restaurants - 2025");
		expect(reportSlug("Food › Restaurants/2025")).toBe("Food - Restaurants 2025");
	});

	it("never returns an empty name", () => {
		expect(reportSlug("///")).toBe("Report");
	});
});
