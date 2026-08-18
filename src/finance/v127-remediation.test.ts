import { describe, expect, it } from "vitest";
import { oneOffBudgetStatus } from "../budgets";
import {
	categoryTotals,
	investingActivityByYear,
	investingRealizedPnLAsOf,
	netWorthAsOf,
	summarizeByYear,
	type KpiStore,
} from "../kpi";
import { runReport } from "../reports/query";
import type { Account, BalanceSnapshot, Category, OneOffBudget, Transaction } from "../types";

/**
 * Phase 6 (final regression validation) — one canonical ledger exercising every defect the v1.2.7
 * remediation pass fixed, checked against the audit doc's own required invariants. This is
 * deliberately broader than any single phase's own tests: those prove one fix works in isolation, this
 * proves the fixes hold together on one realistic, mixed ledger — salary and an expense with a partial
 * refund, a savings transfer, a pre-snapshot investment position partially sold post-snapshot alongside
 * a fresh post-snapshot position, a dividend, a foreign-currency investment fee, historically-backfilled
 * USD income, a transaction in a currency with no rate anywhere, an unsplit credit-card payment, and a
 * split mortgage payment.
 *
 * The one item from the doc's suggested ledger not exercised here — a genuine zero-spend month inside
 * the trailing observation window — is already covered by dedicated tests in kpi.test.ts
 * (`averageMonthlyExpenses`/`fiExpenseBase`'s own describe blocks), which need dates relative to the
 * real wall clock to land inside `lastCompleteMonthKey()`'s trailing-12-month window; this fixture uses
 * fixed historical dates instead, which suits every other invariant checked here better.
 */

const checking: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR" };
const savings: Account = { id: "acc-savings", name: "Savings", type: "saving", currency: "EUR" };
const investing: Account = { id: "acc-investing", name: "Investing", type: "investing", currency: "EUR" };
const creditCard: Account = { id: "acc-credit", name: "Credit card", type: "credit", currency: "EUR" };
const mortgage: Account = { id: "acc-mortgage", name: "Mortgage", type: "mortgage", currency: "EUR", openingBalance: 200000 };

const catSalary: Category = { id: "cat-salary", name: "Salary", color: "#000", icon: "coins", aliases: [], kind: "income" };
const catFood: Category = { id: "cat-food", name: "Food", color: "#000", icon: "utensils", aliases: [] };
const catUnknownFx: Category = { id: "cat-other", name: "Other", color: "#000", icon: "tag", aliases: [] };

let seq = 0;
function tx(partial: Partial<Transaction> & Pick<Transaction, "date" | "accountId" | "amount">): Transaction {
	seq++;
	return { id: `tx-${seq}`, description: "test", currency: "EUR", source: "manual", ...partial };
}

const snapshot: BalanceSnapshot = { id: "snap-1", accountId: investing.id, date: "2023-06-01", balance: 1500 };

const transactions: Transaction[] = [
	// 1. Salary
	tx({ date: "2023-01-05", accountId: checking.id, amount: 3000, categoryId: catSalary.id }),
	// 2. Expense
	tx({ date: "2023-01-10", accountId: checking.id, amount: -200, categoryId: catFood.id }),
	// 3. Refund (partial, against the expense above)
	tx({ date: "2023-01-15", accountId: checking.id, amount: 50, categoryId: catFood.id }),
	// 4. Savings transfer
	tx({ date: "2023-01-20", accountId: checking.id, amount: -500, transferGroupId: "g1" }),
	// Deposit into investing, establishing cash=0 after the buy below, so the snapshot's reset math
	// isn't muddied by leftover cash — see kpi.test.ts's Phase 1 tests for the isolated version of this.
	tx({ date: "2023-01-25", accountId: investing.id, amount: 1000, action: "deposit" }),
	// 5. Investment buy before snapshot
	tx({ date: "2023-02-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
	// 6. Investment market-value snapshot — see `snapshot` above (2023-06-01, balance 1500: the position
	//    appreciated from €1,000 cost to €1,500 market value).
	// 7. Partial sell after snapshot, at exactly the snapshot-implied price (€150/share) — net-worth
	//    neutral; the historical-cost gain (relative to the original €100/share) is still real and
	//    tracked separately.
	tx({ date: "2023-07-01", accountId: investing.id, amount: 600, action: "sell", ticker: "VWCE", shares: 4 }),
	// 8. Investment buy after snapshot (a fresh position, untouched by the snapshot reset)
	tx({ date: "2023-08-01", accountId: investing.id, amount: -500, action: "buy", ticker: "BTC", shares: 0.02 }),
	// 9. Investment sell after snapshot (the same fresh position, at a genuine post-snapshot gain)
	tx({ date: "2023-09-01", accountId: investing.id, amount: 550, action: "sell", ticker: "BTC", shares: 0.02 }),
	// 10. Dividend
	tx({ date: "2023-09-15", accountId: investing.id, amount: 30, action: "dividend", ticker: "VWCE" }),
	// 11. Investment fee in a foreign currency
	tx({ date: "2023-10-01", accountId: investing.id, amount: -100, currency: "USD", fee: 5, action: "buy", ticker: "GBPX", shares: 1 }),
	// 12. USD historical income — a historical rate for this exact date is backfilled below.
	tx({ date: "2023-11-01", accountId: checking.id, amount: 1000, currency: "USD", categoryId: catSalary.id }),
	// 13. Missing-FX transaction — SEK has no rate anywhere, current or historical.
	tx({ date: "2023-12-01", accountId: checking.id, amount: -50, currency: "SEK", categoryId: catUnknownFx.id }),
	// 14. Credit-card payment, unsplit — pure principal, economically neutral.
	tx({ date: "2024-01-05", accountId: creditCard.id, amount: 500 }),
	// 15. Mortgage payment with principal + interest.
	tx({ date: "2024-02-05", accountId: mortgage.id, amount: 1000, principalAmount: 700, interestAmount: 300 }),
];

function buildStore(overrides: Partial<KpiStore> = {}): KpiStore {
	return {
		accounts: [checking, savings, investing, creditCard, mortgage],
		categories: [catSalary, catFood, catUnknownFx],
		transactions,
		snapshots: [snapshot],
		fx: {
			baseCurrency: "EUR",
			rates: { USD: 0.9 }, // today's rate — deliberately different from the historical one below
			history: { "2023-11-01": { USD: 0.85 } },
		},
		...overrides,
	};
}

describe("v1.2.7 remediation — canonical fixture (Phase 6)", () => {
	it("investment snapshot invariant: disposing of a pre-snapshot position at its snapshot-implied value doesn't move net worth", () => {
		const store = buildStore();
		// Before the partial sell: investing account is worth exactly the snapshot, €1,500 (no other
		// cash flows between the snapshot date and the sell).
		expect(netWorthAsOf(store, "2023-06-15", investing.id)).toBeCloseTo(1500, 6);
		// After selling 4 of 10 shares at exactly the snapshot-implied €150/share (€600): still €1,500 —
		// shares converted to cash at the value the snapshot already assigned them, nothing gained or lost.
		expect(netWorthAsOf(store, "2023-07-15", investing.id)).toBeCloseTo(1500, 6);
		// The historical-cost realized gain from that same sale is a real, separately-tracked number:
		// proceeds (600) minus original cost removed (100/share * 4 = 400) = 200.
		expect(investingRealizedPnLAsOf(store, investing.id, "2023-07-15")).toBeCloseTo(200, 6);
	});

	it("investment snapshot invariant: a fresh post-snapshot position's genuine gain still shows up", () => {
		const store = buildStore();
		// BTC bought for €500 and sold for €550 entirely after the snapshot — that €50 is new, real
		// appreciation the snapshot never saw, so it must show up on top of the €1,500 anchor (plus the
		// unrelated €30 dividend booked the same window).
		expect(netWorthAsOf(store, "2023-09-20", investing.id)).toBeCloseTo(1500 + 50 + 30, 6);
	});

	it("report invariant: report economic totals agree with KPI economic totals on the identical fixture", () => {
		const store = buildStore();
		const [year] = summarizeByYear(store, checking.id, { from: "2023-01-01", to: "2023-01-31" });
		const report = runReport(store, { from: "2023-01-01", to: "2023-01-31", accountIds: [checking.id] });
		expect(report.spent).toBeCloseTo(year.expenses, 6);
		expect(report.received).toBeCloseTo(year.income, 6);
	});

	it("refund invariant: the €50 refund reduces KPI expenses, report spend, and a one-off budget's spend identically", () => {
		const store = buildStore();
		const [year] = summarizeByYear(store, checking.id, { from: "2023-01-01", to: "2023-01-31" });
		expect(year.expenses).toBeCloseTo(150, 6); // 200 - 50

		const report = runReport(store, { from: "2023-01-01", to: "2023-01-31", accountIds: [checking.id] });
		expect(report.spent).toBeCloseTo(150, 6);
		expect(categoryTotals(store, "2023", checking.id).get(catFood.id)).toBeCloseTo(150, 6);

		const budget: OneOffBudget = { id: "b1", name: "January", amount: 1000, startDate: "2023-01-01", endDate: "2023-01-31", categoryIds: [catFood.id] };
		expect(oneOffBudgetStatus(store, budget, new Date("2023-02-01T00:00:00Z")).spent).toBeCloseTo(150, 6);
	});

	it("FX invariant: historical USD income is stable against a later change to today's rate", () => {
		const store = buildStore();
		const [year] = summarizeByYear(store, checking.id, { from: "2023-11-01", to: "2023-11-30" });
		// $1,000 at the backfilled 2023-11-01 rate (0.85), not today's configured rate (0.9).
		expect(year.income).toBeCloseTo(850, 6);

		const changedTodayRate = buildStore({ fx: { baseCurrency: "EUR", rates: { USD: 0.5 }, history: { "2023-11-01": { USD: 0.85 } } } });
		const [yearAfterRateChange] = summarizeByYear(changedTodayRate, checking.id, { from: "2023-11-01", to: "2023-11-30" });
		expect(yearAfterRateChange.income).toBeCloseTo(850, 6); // unchanged
	});

	it("FX invariant: a currency with no rate anywhere reads as incomplete (NaN), never a plausible number", () => {
		const store = buildStore();
		const [year] = summarizeByYear(store, checking.id, { from: "2023-12-01", to: "2023-12-31" });
		expect(year.expenses).toBeNaN();
	});

	it("FX invariant: an investment fee in a foreign currency converts into the base currency (Phase 5.3)", () => {
		const store = buildStore();
		const activity = investingActivityByYear(store, investing.id).find((y) => y.year === "2023")!;
		// $5 fee at today's 0.9 EUR/USD rate (no historical rate backfilled for 2023-10-01, so this falls
		// back to the current table per convert()'s documented compromise) = €4.50, not the raw $5 figure.
		expect(activity.fees).toBeCloseTo(4.5, 6);
	});

	it("debt invariant: an unsplit credit-card payment is fully principal — no income, no expense", () => {
		const store = buildStore();
		const [year] = summarizeByYear(store, creditCard.id, { from: "2024-01-01", to: "2024-01-31" });
		expect(year.income).toBe(0);
		expect(year.expenses).toBe(0);
		expect(year.debtPrincipal).toBeCloseTo(500, 6);
	});

	it("debt invariant: a split mortgage payment separates principal (balance-sheet) from interest (real expense)", () => {
		const store = buildStore();
		const [year] = summarizeByYear(store, mortgage.id, { from: "2024-02-01", to: "2024-02-29" });
		expect(year.expenses).toBeCloseTo(300, 6); // interest only
		expect(year.debtPrincipal).toBeCloseTo(700, 6); // principal only
		expect(year.income).toBe(0);
	});
});
