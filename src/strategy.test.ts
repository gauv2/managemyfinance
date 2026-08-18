import { describe, it, expect } from "vitest";
import {
	debtByAccount,
	goalCurrentAmount,
	goalMonthlyRequired,
	goalStatus,
	nextReviewDate,
	orderDebtPayoff,
	reserveStatus,
	suggestReserveMonths,
	type GoalStatus,
} from "./strategy";
import type { Account, Category, FinancialGoal, Transaction } from "./types";
import type { KpiStore } from "./kpi";

// ---------- fixtures ----------

const checking: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR", openingBalance: 0 };
const savings: Account = { id: "acc-savings", name: "Savings", type: "saving", currency: "EUR", openingBalance: 0 };
const creditCard: Account = { id: "acc-credit", name: "Credit card", type: "credit", currency: "EUR", openingBalance: 0, apr: 0.2 };
const loan: Account = { id: "acc-loan", name: "Personal loan", type: "loan", currency: "EUR", openingBalance: 500, apr: 0.06 };

const catFood: Category = { id: "cat-food", name: "Food", color: "#000", icon: "utensils", aliases: [], essential: true };
const catFun: Category = { id: "cat-fun", name: "Entertainment", color: "#000", icon: "sparkles", aliases: [] };
const catSalary: Category = { id: "cat-salary", name: "Salary", color: "#000", icon: "coins", aliases: [], kind: "income" };

let nextId = 0;
function tx(partial: Partial<Transaction> & Pick<Transaction, "date" | "accountId" | "amount">): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, description: partial.description ?? "test", currency: "EUR", source: "manual", ...partial };
}

function store(overrides: Partial<KpiStore> = {}): KpiStore {
	return {
		accounts: [checking, savings, creditCard, loan],
		categories: [catFood, catFun],
		transactions: [],
		...overrides,
	};
}

let nextGoalId = 0;
function goal(partial: Partial<FinancialGoal> & Pick<FinancialGoal, "targetAmount" | "trackingMode" | "kind">): FinancialGoal {
	nextGoalId++;
	return { id: `goal-${nextGoalId}`, name: "test goal", priority: 1, createdAt: "2024-01-01", ...partial };
}

// ---------- suggestReserveMonths ----------

describe("suggestReserveMonths", () => {
	it("returns the book's stated three-to-six-month range regardless of data", () => {
		expect(suggestReserveMonths(store())).toEqual({ low: 3, high: 6 });
	});
});

// ---------- reserveStatus ----------

describe("reserveStatus", () => {
	it("sums only liquid accounts for bufferHave/incomeLossHave, and targets essential spend × months", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: 1000 }),
				tx({ date: "2024-01-01", accountId: savings.id, amount: 2000 }),
				tx({ date: "2024-01-05", accountId: checking.id, amount: -800, categoryId: catFood.id }),
				tx({ date: "2024-02-05", accountId: checking.id, amount: -800, categoryId: catFood.id }),
			],
		});
		const status = reserveStatus(s, { bufferTarget: 500, incomeLossMonths: 3 });
		// checking: 1000 - 800 - 800 = -600; savings: 2000 untouched -> liquid total 1400
		expect(status.bufferHave).toBe(1400);
		expect(status.incomeLossHave).toBe(1400);
		expect(status.incomeLossTarget).toBe(2400); // 800/mo essential average × 3
	});

	it("falls back to overall average expenses when no category is flagged essential", () => {
		const s = store({
			categories: [catFun],
			transactions: [tx({ date: "2024-01-05", accountId: checking.id, amount: -400, categoryId: catFun.id })],
		});
		const status = reserveStatus(s, { bufferTarget: 0, incomeLossMonths: 2 });
		expect(status.incomeLossTarget).toBe(800); // 400/mo overall average × 2
	});

	it("excludes a transfer into an essential-flagged category from the average", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-05", accountId: checking.id, amount: -600, categoryId: catFood.id }),
				// A transfer tagged (mistakenly, or via a linked pair) with the essential category — must
				// not count as essential spend.
				tx({ date: "2024-01-10", accountId: checking.id, amount: -400, categoryId: catFood.id, transferGroupId: "g1" }),
			],
		});
		const status = reserveStatus(s, { bufferTarget: 0, incomeLossMonths: 1 });
		expect(status.incomeLossTarget).toBeCloseTo(600, 6);
	});

	it("counts a zero-essential-spend month inside the tracked window in the average (FIN-010)", () => {
		// Essential spend in January and March, nothing in February — the divisor must be 3 months, not
		// the 2 months that happen to have an essential transaction.
		const s = store({
			transactions: [
				tx({ date: "2024-01-05", accountId: checking.id, amount: -600, categoryId: catFood.id }),
				tx({ date: "2024-03-05", accountId: checking.id, amount: -300, categoryId: catFood.id }),
			],
		});
		const status = reserveStatus(s, { bufferTarget: 0, incomeLossMonths: 1 });
		expect(status.incomeLossTarget).toBeCloseTo((600 + 300) / 3, 6);
	});

	it("nets a refund against essential spend instead of dropping it entirely (v1.2.7 Phase 5.2)", () => {
		const s = store({
			categories: [catFood, catSalary], // refunds are only distinguishable with an income-kind category on record
			transactions: [
				tx({ date: "2024-01-05", accountId: checking.id, amount: -600, categoryId: catFood.id }),
				tx({ date: "2024-01-10", accountId: checking.id, amount: 100, categoryId: catFood.id }), // partial refund
			],
		});
		const status = reserveStatus(s, { bufferTarget: 0, incomeLossMonths: 1 });
		// Net essential spend for the one tracked month is 600 - 100 = 500, not 600 (the refund ignored).
		expect(status.incomeLossTarget).toBeCloseTo(500, 6);
	});
});

// ---------- debtByAccount / orderDebtPayoff ----------

describe("debtByAccount", () => {
	it("includes only credit/loan/mortgage accounts with a positive balance owed, carrying apr through", () => {
		const s = store({ transactions: [tx({ date: "2024-01-01", accountId: creditCard.id, amount: -300 })] });
		const debts = debtByAccount(s);
		expect(debts).toHaveLength(2);
		const byId = new Map(debts.map((d) => [d.account.id, d]));
		expect(byId.get(creditCard.id)?.balanceOwed).toBe(300);
		expect(byId.get(creditCard.id)?.account.apr).toBe(0.2);
		expect(byId.get(loan.id)?.balanceOwed).toBe(500);
		expect(byId.has(checking.id)).toBe(false);
	});

	it("excludes debt accounts with nothing owed", () => {
		const s = store({ accounts: [checking, creditCard] });
		expect(debtByAccount(s)).toHaveLength(0);
	});
});

describe("orderDebtPayoff", () => {
	const debts = [
		{ account: creditCard, balanceOwed: 3000 }, // apr 0.20
		{ account: loan, balanceOwed: 500 }, // apr 0.06
	];
	const includedAccountIds = [creditCard.id, loan.id];

	it("avalanche orders by descending APR", () => {
		const order = orderDebtPayoff(debts, "avalanche", includedAccountIds);
		expect(order.map((d) => d.account.id)).toEqual([creditCard.id, loan.id]);
	});

	it("snowball orders by ascending balance", () => {
		const order = orderDebtPayoff(debts, "snowball", includedAccountIds);
		expect(order.map((d) => d.account.id)).toEqual([loan.id, creditCard.id]);
	});

	it("drops accounts not in includedAccountIds", () => {
		const order = orderDebtPayoff(debts, "avalanche", [loan.id]);
		expect(order.map((d) => d.account.id)).toEqual([loan.id]);
	});

	it("keeps equal-APR debts in their original relative order", () => {
		const tiedA = { account: { ...creditCard, id: "tied-a" }, balanceOwed: 100 };
		const tiedB = { account: { ...loan, id: "tied-b", apr: 0.2 }, balanceOwed: 200 };
		const order = orderDebtPayoff([tiedA, tiedB], "avalanche", ["tied-a", "tied-b"]);
		expect(order.map((d) => d.account.id)).toEqual(["tied-a", "tied-b"]);
	});
});

// ---------- goalCurrentAmount ----------

describe("goalCurrentAmount", () => {
	it("reads manualCurrentAmount for trackingMode 'manual'", () => {
		const g = goal({ targetAmount: 1000, trackingMode: "manual", kind: "custom", manualCurrentAmount: 750 });
		expect(goalCurrentAmount(store(), g)).toBe(750);
	});

	it("defaults manual current to 0 when unset", () => {
		const g = goal({ targetAmount: 1000, trackingMode: "manual", kind: "custom" });
		expect(goalCurrentAmount(store(), g)).toBe(0);
	});

	it("reads the linked account's balance for trackingMode 'account'", () => {
		const s = store({ transactions: [tx({ date: "2024-01-01", accountId: savings.id, amount: 1200 })] });
		const g = goal({ targetAmount: 5000, trackingMode: "account", kind: "custom", linkedAccountId: savings.id });
		expect(goalCurrentAmount(s, g)).toBe(1200);
	});

	it("reads liquid balance for a computed reserve goal", () => {
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: checking.id, amount: 400 }), tx({ date: "2024-01-01", accountId: savings.id, amount: 600 })],
		});
		const g = goal({ targetAmount: 3000, trackingMode: "computed", kind: "reserve-buffer" });
		expect(goalCurrentAmount(s, g)).toBe(1000);
	});

	it("reads paid-down progress (target minus remaining) for a computed debt-payoff goal", () => {
		const s = store({ transactions: [tx({ date: "2024-01-01", accountId: creditCard.id, amount: -2500 })] });
		// original total debt (the goal's target) was 3500; 2500 credit card + 500 loan = 3000 remains,
		// so 500 has been paid off
		const g = goal({ targetAmount: 3500, trackingMode: "computed", kind: "debt-payoff" });
		expect(goalCurrentAmount(s, g)).toBe(500);
	});
});

// ---------- goalMonthlyRequired ----------

describe("goalMonthlyRequired", () => {
	it("divides the remaining amount by the whole months until the deadline", () => {
		expect(goalMonthlyRequired(1000, 4000, "2024-04-01", "2024-01-01")).toBe(750); // 3000 / 4 months
	});

	it("returns undefined with no deadline", () => {
		expect(goalMonthlyRequired(1000, 4000, undefined, "2024-01-01")).toBeUndefined();
	});

	it("returns undefined once the deadline has passed without the target being met", () => {
		expect(goalMonthlyRequired(1000, 4000, "2024-01-01", "2024-06-01")).toBeUndefined();
	});

	it("returns 0 once current already meets or exceeds target", () => {
		expect(goalMonthlyRequired(5000, 4000, "2024-04-01", "2024-01-01")).toBe(0);
	});
});

// ---------- goalStatus ----------

describe("goalStatus", () => {
	it("reads 'no-deadline' for a goal with none", () => {
		const g = goal({ targetAmount: 1000, trackingMode: "manual", kind: "custom" });
		expect(goalStatus(store(), g, 100)).toBe<GoalStatus>("no-deadline");
	});

	it("reads 'ahead' once the target is already met", () => {
		// Deadline fixed far in the future so this stays true regardless of when the suite runs —
		// goalStatus always compares against the real current date, not an injectable one.
		const g = goal({ targetAmount: 1000, trackingMode: "manual", kind: "custom", manualCurrentAmount: 1200, deadline: "2099-01-01" });
		expect(goalStatus(store(), g, 0)).toBe<GoalStatus>("ahead");
	});

	it("reads 'behind' once the deadline has passed without the target met", () => {
		const g = goal({ targetAmount: 1000, trackingMode: "manual", kind: "custom", manualCurrentAmount: 200, deadline: "2020-01-01" });
		expect(goalStatus(store(), g, 100)).toBe<GoalStatus>("behind");
	});

	it("compares actual monthly pace against what the deadline requires", () => {
		// A deadline decades out keeps the required-per-month figure tiny regardless of run date, so
		// these extreme monthlyNet values are unambiguously ahead/behind without pinning an exact date.
		const g = goal({ targetAmount: 4000, trackingMode: "manual", kind: "custom", manualCurrentAmount: 1000, deadline: "2099-01-01" });
		expect(goalStatus(store(), g, 10000)).toBe<GoalStatus>("ahead");
		expect(goalStatus(store(), g, 1)).toBe<GoalStatus>("behind");
	});
});

// ---------- nextReviewDate ----------

describe("nextReviewDate", () => {
	it("adds one month for a monthly cadence", () => {
		expect(nextReviewDate("monthly", "2024-01-15")).toBe("2024-02-15");
	});

	it("adds three months for a quarterly cadence", () => {
		expect(nextReviewDate("quarterly", "2024-01-15")).toBe("2024-04-15");
	});

	it("adds twelve months for an annual cadence", () => {
		expect(nextReviewDate("annual", "2024-01-15")).toBe("2025-01-15");
	});

	it("rolls over the year for a monthly cadence in December", () => {
		expect(nextReviewDate("monthly", "2024-12-20")).toBe("2025-01-20");
	});
});
