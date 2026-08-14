import { describe, it, expect } from "vitest";
import {
	budgetOverruns,
	categoryDeltas,
	categoryOutliers,
	computeInsights,
	duplicateCharges,
	missingIncome,
	phantomSubscriptions,
	recurringPriceDrift,
	staleAccounts,
	staleSubscriptionCost,
	uncategorizedBacklog,
	zombieSubscriptions,
} from "./insights";
import { addDaysIso, recurringSeries } from "./recurring";
import type { KpiStore } from "./kpi";
import type { Account, Category, Subscription, Transaction } from "./types";

// ---------- fixtures ----------

/** Every test pins "today" so nothing depends on the day the suite runs. Local components, because
 *  `todayIso` reads the user's calendar day. 15 July 2024 → 15/31 of the month elapsed. */
const TODAY = new Date(2024, 6, 15);

const checking: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR", openingBalance: 0 };
const credit: Account = { id: "acc-credit", name: "Credit card", type: "credit", currency: "EUR", openingBalance: 0 };

const catFood: Category = { id: "cat-food", name: "Food", color: "#000", icon: "utensils", aliases: [] };
const catShopping: Category = { id: "cat-shopping", name: "Shopping", color: "#000", icon: "bag", aliases: [] };
const catTransfers: Category = { id: "cat-transfers", name: "Transfers", color: "#000", icon: "arrow", aliases: [] };

let nextId = 0;
function tx(partial: Partial<Transaction> & Pick<Transaction, "date" | "amount">): Transaction {
	nextId++;
	return {
		id: `tx-${nextId}`,
		accountId: checking.id,
		description: "test",
		currency: "EUR",
		source: "manual",
		...partial,
	};
}

function store(transactions: Transaction[], overrides: Partial<KpiStore> = {}): KpiStore {
	return { accounts: [checking, credit], categories: [catFood, catShopping, catTransfers], transactions, ...overrides };
}

const EMPTY: KpiStore = { accounts: [], categories: [], transactions: [] };

function charges(counterparty: string, startIso: string, gapDays: number, amounts: number[], extra: Partial<Transaction> = {}): Transaction[] {
	let date = startIso;
	return amounts.map((amount) => {
		const t = tx({ date, amount, counterparty, ...extra });
		date = addDaysIso(date, gapDays);
		return t;
	});
}

function sub(partial: Partial<Subscription> = {}): Subscription {
	return {
		id: "sub-1",
		name: "Netflix",
		category: "Streaming",
		cost: 9.99,
		billingCycle: "monthly",
		paidVia: "private",
		nextDueDate: "2024-07-05",
		...partial,
	};
}

// ---------- MUST: recurring price drift ----------

describe("recurringPriceDrift", () => {
	it("flags a price rise and annualizes the delta", () => {
		const s = recurringSeries(store(charges("NETFLIX", "2024-02-05", 30, [-9.99, -9.99, -9.99, -12.99])));
		const [insight] = recurringPriceDrift(s);
		expect(insight.kind).toBe("recurring-price-drift");
		expect(insight.impactEUR).toBeCloseTo(3 * 12, 6);
		expect(insight.title).toContain("went up");
		expect(insight.severity).toBe("medium");
	});

	it("flags a price cut too — the copy changes, the detection doesn't", () => {
		const s = recurringSeries(store(charges("NETFLIX", "2024-02-05", 30, [-12.99, -12.99, -12.99, -9.99])));
		expect(recurringPriceDrift(s)[0].title).toContain("went down");
	});

	it("holds a €0.50 move on a small subscription below the floor and flags a cent more", () => {
		const at = recurringSeries(store(charges("SERVICE", "2024-02-05", 30, [-10, -10, -10, -10.5])));
		expect(recurringPriceDrift(at)).toEqual([]);

		const over = recurringSeries(store(charges("SERVICE", "2024-02-05", 30, [-10, -10, -10, -10.51])));
		expect(recurringPriceDrift(over)).toHaveLength(1);
	});

	it("uses the 2% floor on a large charge, so ordinary variation is not a price rise", () => {
		const within = recurringSeries(store(charges("INSURANCE", "2024-02-05", 30, [-200, -200, -200, -203])));
		expect(recurringPriceDrift(within)).toEqual([]);

		const beyond = recurringSeries(store(charges("INSURANCE", "2024-02-05", 30, [-200, -200, -200, -205])));
		expect(recurringPriceDrift(beyond)).toHaveLength(1);
	});

	it("measures against the last three charges, not the all-time history", () => {
		// Rose from €5.99 to €10.99 long ago and has been steady since — that's not news any more.
		const s = recurringSeries(store(charges("SPOTIFY", "2023-10-05", 30, [-5.99, -5.99, -10.99, -10.99, -10.99, -10.99])));
		expect(recurringPriceDrift(s)).toEqual([]);
	});

	it("ignores incoming series, so a pay rise is not a warning card", () => {
		const s = recurringSeries(store(charges("EMPLOYER", "2024-02-25", 30, [2500, 2500, 2500, 2800])));
		expect(recurringPriceDrift(s)).toEqual([]);
	});

	it("returns nothing for an empty store", () => {
		expect(recurringPriceDrift(recurringSeries(EMPTY))).toEqual([]);
	});
});

// ---------- MUST: stale subscription cost ----------

describe("staleSubscriptionCost", () => {
	it("flags the gap between what you track and what you are charged", () => {
		const s = recurringSeries(store(charges("NETFLIX", "2024-02-05", 30, [-12.99, -12.99, -12.99])));
		const [insight] = staleSubscriptionCost([sub({ cost: 9.99 })], s);
		expect(insight.kind).toBe("stale-subscription-cost");
		expect(insight.impactEUR).toBeCloseTo(3 * 12, 6);
		expect(insight.deepLink).toEqual({ type: "subscription", subscriptionId: "sub-1" });
	});

	it("stays quiet when the tracked cost is right", () => {
		const s = recurringSeries(store(charges("NETFLIX", "2024-02-05", 30, [-9.99, -9.99, -9.99])));
		expect(staleSubscriptionCost([sub({ cost: 9.99 })], s)).toEqual([]);
	});

	it("ignores archived subscriptions", () => {
		const s = recurringSeries(store(charges("NETFLIX", "2024-02-05", 30, [-12.99, -12.99, -12.99])));
		expect(staleSubscriptionCost([sub({ cost: 9.99, archived: true })], s)).toEqual([]);
	});
});

// ---------- MUST: phantom subscriptions ----------

describe("phantomSubscriptions", () => {
	it("flags a stable recurring charge that isn't tracked", () => {
		const s = recurringSeries(store(charges("SPOTIFY AB", "2024-02-08", 30, [-17.99, -17.99, -17.99])));
		const [insight] = phantomSubscriptions([], s);
		expect(insight.kind).toBe("phantom-subscription");
		expect(insight.impactEUR).toBeCloseTo(17.99 * 12, 6);
		expect(insight.deepLink).toEqual({ type: "detected-subscription", merchantKey: "spotify ab" });
	});

	it("stays quiet once the same charge is tracked", () => {
		const s = recurringSeries(store(charges("SPOTIFY AB", "2024-02-08", 30, [-17.99, -17.99, -17.99])));
		expect(phantomSubscriptions([sub({ name: "Spotify" })], s)).toEqual([]);
	});

	it("does not call the supermarket a subscription", () => {
		// Weekly like clockwork, nothing like a subscription in amount.
		const s = recurringSeries(store(charges("ALBERT HEIJN 1234", "2024-05-04", 7, [-42.18, -87.5, -19.99, -113.4, -61.2])));
		expect(phantomSubscriptions([], s)).toEqual([]);
	});
});

// ---------- MUST: zombie subscriptions ----------

describe("zombieSubscriptions", () => {
	/** A ledger that is up to date and spans well over a year, with no Netflix charge in it. */
	function currentLedger(extra: Transaction[] = []): KpiStore {
		return store([
			...charges("SUPERMARKET", "2023-01-10", 30, new Array(19).fill(-50)),
			tx({ date: "2024-07-10", amount: -25, counterparty: "SUPERMARKET" }),
			...extra,
		]);
	}

	it("flags a tracked subscription with no matching charge in a current ledger", () => {
		const [insight] = zombieSubscriptions(currentLedger(), [sub({ nextDueDate: "2024-01-05" })], TODAY);
		expect(insight.kind).toBe("zombie-subscription");
		expect(insight.impactEUR).toBeCloseTo(9.99 * 12, 6);
		expect(insight.detail).toContain("untracked account");
	});

	it("stays quiet while the charges keep arriving", () => {
		const s = currentLedger(charges("NETFLIX", "2024-04-05", 30, [-9.99, -9.99, -9.99, -9.99]));
		expect(zombieSubscriptions(s, [sub({ nextDueDate: "2024-01-05" })], TODAY)).toEqual([]);
	});

	it("blames a stale import rather than the subscription when nothing at all is current", () => {
		const stale = store(charges("SUPERMARKET", "2023-01-10", 30, new Array(15).fill(-50))); // ends Feb 2024
		expect(zombieSubscriptions(stale, [sub({ nextDueDate: "2024-01-05" })], TODAY)).toEqual([]);
	});

	it("does not flag a subscription that has not come due yet", () => {
		expect(zombieSubscriptions(currentLedger(), [sub({ nextDueDate: "2024-12-05" })], TODAY)).toEqual([]);
	});

	it("does not flag when the ledger is too young to have missed a cycle", () => {
		const young = store([
			tx({ date: "2024-07-01", amount: -20, counterparty: "SUPERMARKET" }),
			tx({ date: "2024-07-10", amount: -20, counterparty: "SUPERMARKET" }),
		]);
		expect(zombieSubscriptions(young, [sub({ nextDueDate: "2024-07-05" })], TODAY)).toEqual([]);
	});

	it("ignores archived and lapsed subscriptions", () => {
		expect(zombieSubscriptions(currentLedger(), [sub({ nextDueDate: "2024-01-05", archived: true })], TODAY)).toEqual([]);
		expect(zombieSubscriptions(currentLedger(), [sub({ nextDueDate: "2024-01-05", endDate: "2024-02-01" })], TODAY)).toEqual([]);
	});
});

// ---------- MUST: month-over-month category delta ----------

describe("categoryDeltas", () => {
	it("compares this month's pace against the last three complete months", () => {
		// €100/month of Food in Apr/May/Jun, €200 already spent by 15 July → pace ≈ €413.
		const s = store([
			tx({ date: "2024-04-10", amount: -100, categoryId: catFood.id }),
			tx({ date: "2024-05-10", amount: -100, categoryId: catFood.id }),
			tx({ date: "2024-06-10", amount: -100, categoryId: catFood.id }),
			tx({ date: "2024-07-10", amount: -200, categoryId: catFood.id }),
		]);
		const [insight] = categoryDeltas(s, TODAY);
		expect(insight.kind).toBe("category-delta");
		expect(insight.title).toContain("above");
		expect(insight.impactEUR).toBeCloseTo(200 / (15 / 31) - 100, 4);
	});

	it("does not read an ordinary early-month month as a collapse", () => {
		// €100/month history and €48 by the 15th is the same pace — the elapsed-fraction correction is
		// the whole reason this doesn't fire.
		const s = store([
			tx({ date: "2024-04-10", amount: -100, categoryId: catFood.id }),
			tx({ date: "2024-05-10", amount: -100, categoryId: catFood.id }),
			tx({ date: "2024-06-10", amount: -100, categoryId: catFood.id }),
			tx({ date: "2024-07-10", amount: -48, categoryId: catFood.id }),
		]);
		expect(categoryDeltas(s, TODAY)).toEqual([]);
	});

	it("needs both €25 and 25% of the prior mean before it says anything", () => {
		const s = store([
			tx({ date: "2024-04-10", amount: -20, categoryId: catFood.id }),
			tx({ date: "2024-05-10", amount: -20, categoryId: catFood.id }),
			tx({ date: "2024-06-10", amount: -20, categoryId: catFood.id }),
			tx({ date: "2024-07-10", amount: -20, categoryId: catFood.id }), // pace ≈ €41, +€21 — under €25
		]);
		expect(categoryDeltas(s, TODAY)).toEqual([]);
	});

	it("returns at most the top three by absolute delta", () => {
		const s = store([
			tx({ date: "2024-07-10", amount: -500, categoryId: catFood.id }),
			tx({ date: "2024-07-10", amount: -400, categoryId: catShopping.id }),
			tx({ date: "2024-07-10", amount: -300, categoryId: "cat-x" }),
			tx({ date: "2024-07-10", amount: -200, categoryId: "cat-y" }),
		]);
		expect(categoryDeltas(s, TODAY)).toHaveLength(3);
	});

	it("leaves uncategorized spend to its own insight", () => {
		const s = store([tx({ date: "2024-07-10", amount: -900 })]);
		expect(categoryDeltas(s, TODAY)).toEqual([]);
	});

	it("says nothing in the first days of the month, where the pace figure is fiction (review MAJOR #6)", () => {
		// One €100 grocery run on the 1st against a €300 average read as "€3,100 this month at today's
		// pace, €2,800 above your average" — impactEUR 2,800, top of the five-card feed, every month.
		const s = store([
			tx({ date: "2024-04-10", amount: -300, categoryId: catFood.id }),
			tx({ date: "2024-05-10", amount: -300, categoryId: catFood.id }),
			tx({ date: "2024-06-10", amount: -300, categoryId: catFood.id }),
			tx({ date: "2024-07-01", amount: -100, categoryId: catFood.id }),
		]);
		expect(categoryDeltas(s, new Date(2024, 6, 1))).toEqual([]); // 1/31 of the month elapsed
		expect(categoryDeltas(s, new Date(2024, 6, 4))).toEqual([]); // 4/31 — still under the floor
		// Past the floor the same ledger is fair game again — and by then the honest reading of €100 by the
		// 15th against a €300 average is that Food is running *below* normal, not €2,800 above it.
		const later = categoryDeltas(s, TODAY);
		expect(later).toHaveLength(1);
		expect(later[0].title).toContain("below");
	});

	it("returns nothing for an empty store", () => {
		expect(categoryDeltas(EMPTY, TODAY)).toEqual([]);
	});
});

// ---------- MUST: duplicate charges ----------

describe("duplicateCharges", () => {
	it("flags the same merchant charging the same amount twice within three days", () => {
		const s = store([
			tx({ date: "2024-07-01", amount: -49.95, counterparty: "MEDIA MARKT" }),
			tx({ date: "2024-07-02", amount: -49.95, counterparty: "MEDIA MARKT" }),
		]);
		const [insight] = duplicateCharges(s, [], TODAY);
		expect(insight.kind).toBe("duplicate-charge");
		expect(insight.impactEUR).toBeCloseTo(49.95, 6);
	});

	it("does NOT flag two consecutive charges of a weekly subscription", () => {
		// The disambiguation §2.7 calls for: a weekly service whose billing slipped produces a 2-day gap
		// at the same amount, which a naive amount+proximity rule reads as a double charge.
		const transactions = [
			tx({ date: "2024-06-03", amount: -20, counterparty: "WEEKLY BOX" }),
			tx({ date: "2024-06-10", amount: -20, counterparty: "WEEKLY BOX" }),
			tx({ date: "2024-06-12", amount: -20, counterparty: "WEEKLY BOX" }),
			tx({ date: "2024-06-19", amount: -20, counterparty: "WEEKLY BOX" }),
		];
		const s = store(transactions);
		const series = recurringSeries(s);
		expect(series[0].cycle).toBe("weekly");
		expect(duplicateCharges(s, series, TODAY)).toEqual([]);
		// Without the series context the same pair is indistinguishable from a duplicate — which is
		// exactly why the series has to be passed in.
		expect(duplicateCharges(s, [], TODAY)).toHaveLength(1);
	});

	it("requires the same account", () => {
		const s = store([
			tx({ date: "2024-07-01", amount: -49.95, counterparty: "MEDIA MARKT", accountId: checking.id }),
			tx({ date: "2024-07-02", amount: -49.95, counterparty: "MEDIA MARKT", accountId: credit.id }),
		]);
		expect(duplicateCharges(s, [], TODAY)).toEqual([]);
	});

	it("ignores small charges, wider date gaps and different amounts", () => {
		const s = store([
			tx({ date: "2024-07-01", amount: -4.5, counterparty: "COFFEE" }),
			tx({ date: "2024-07-02", amount: -4.5, counterparty: "COFFEE" }),
			tx({ date: "2024-07-01", amount: -30, counterparty: "SHOP" }),
			tx({ date: "2024-07-06", amount: -30, counterparty: "SHOP" }),
			tx({ date: "2024-07-01", amount: -30, counterparty: "OTHER" }),
			tx({ date: "2024-07-02", amount: -31, counterparty: "OTHER" }),
		]);
		expect(duplicateCharges(s, [], TODAY)).toEqual([]);
	});

	it("tolerates a one-cent rounding difference", () => {
		const s = store([
			tx({ date: "2024-07-01", amount: -49.95, counterparty: "MEDIA MARKT" }),
			tx({ date: "2024-07-02", amount: -49.96, counterparty: "MEDIA MARKT" }),
		]);
		expect(duplicateCharges(s, [], TODAY)).toHaveLength(1);
	});

	it("collapses a triple charge into one card instead of three (review MINOR #21)", () => {
		// Three identical rows produce the pairs (0,1), (0,2) and (1,2) — three cards, same merchant, same
		// amount, three of the five slots on the overview spent telling one fact three times.
		const s = store([
			tx({ date: "2024-07-01", amount: -60, counterparty: "MEDIA MARKT" }),
			tx({ date: "2024-07-02", amount: -60, counterparty: "MEDIA MARKT" }),
			tx({ date: "2024-07-03", amount: -60, counterparty: "MEDIA MARKT" }),
		]);
		const insights = duplicateCharges(s, [], TODAY);
		expect(insights).toHaveLength(1);
		expect(insights[0].title).toContain("charged 3 times");
		expect(insights[0].detail).toContain("2024-07-01, 2024-07-02 and 2024-07-03");
		expect(insights[0].impactEUR).toBeCloseTo(120, 6); // the two extra charges, not one and not three
	});

	it("still says 'twice' and books one charge of impact for a plain pair", () => {
		const s = store([
			tx({ date: "2024-07-01", amount: -60, counterparty: "MEDIA MARKT" }),
			tx({ date: "2024-07-02", amount: -60, counterparty: "MEDIA MARKT" }),
		]);
		const [insight] = duplicateCharges(s, [], TODAY);
		expect(insight.title).toContain("charged twice");
		expect(insight.detail).toContain("2024-07-01 and 2024-07-02");
		expect(insight.impactEUR).toBeCloseTo(60, 6);
	});

	it("looks back 90 days only, so a 2019 double charge doesn't outrank live insights", () => {
		const s = store([
			tx({ date: "2019-03-01", amount: -900, counterparty: "OLD SHOP" }),
			tx({ date: "2019-03-02", amount: -900, counterparty: "OLD SHOP" }),
		]);
		expect(duplicateCharges(s, [], TODAY)).toEqual([]);
	});

	it("returns nothing for an empty store", () => {
		expect(duplicateCharges(EMPTY, [], TODAY)).toEqual([]);
	});
});

// ---------- SHOULD: category outlier ----------

describe("categoryOutliers", () => {
	/** Twelve months of Shopping: ten ordinary €20 charges and two genuine big months. The big two are
	 *  what break a stdev-based threshold and leave a MAD-based one untouched. */
	function shoppingHistory(): Transaction[] {
		const months = ["2023-08", "2023-09", "2023-10", "2023-11", "2023-12", "2024-01", "2024-02", "2024-03", "2024-04", "2024-05"];
		const rows = months.map((m) => tx({ date: `${m}-10`, amount: -20, categoryId: catShopping.id }));
		rows.push(tx({ date: "2023-12-20", amount: -300, categoryId: catShopping.id }));
		rows.push(tx({ date: "2024-06-20", amount: -400, categoryId: catShopping.id }));
		return rows;
	}

	it("flags a charge above median + 3·MAD that a stdev threshold would miss", () => {
		const s = store([...shoppingHistory(), tx({ date: "2024-07-08", amount: -250, categoryId: catShopping.id, counterparty: "MEDIA MARKT" })]);
		const [insight] = categoryOutliers(s, TODAY);
		expect(insight.kind).toBe("category-outlier");
		expect(insight.impactEUR).toBeCloseTo(230, 6); // 250 − median 20

		// The stdev route would not have caught it: median + 3·stdev sits well above €250.
		const amounts = shoppingHistory().map((t) => -t.amount);
		const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
		const stdev = Math.sqrt(amounts.reduce((sum, a) => sum + (a - mean) ** 2, 0) / amounts.length);
		expect(20 + 3 * stdev).toBeGreaterThan(250);
	});

	it("ignores anything under €50 however unusual", () => {
		const s = store([...shoppingHistory(), tx({ date: "2024-07-08", amount: -45, categoryId: catShopping.id })]);
		expect(categoryOutliers(s, TODAY)).toEqual([]);
	});

	it("waits for enough history before calling anything unusual", () => {
		const s = store([
			tx({ date: "2024-06-10", amount: -20, categoryId: catShopping.id }),
			tx({ date: "2024-05-10", amount: -20, categoryId: catShopping.id }),
			tx({ date: "2024-07-08", amount: -250, categoryId: catShopping.id }),
		]);
		expect(categoryOutliers(s, TODAY)).toEqual([]);
	});

	it("skips a category whose charges are all identical, rather than treating zero MAD as infinite sensitivity", () => {
		const rows = ["2023-08", "2023-09", "2023-10", "2023-11", "2023-12", "2024-01", "2024-02", "2024-03"].map((m) =>
			tx({ date: `${m}-10`, amount: -100, categoryId: catShopping.id })
		);
		const s = store([...rows, tx({ date: "2024-07-08", amount: -101, categoryId: catShopping.id })]);
		expect(categoryOutliers(s, TODAY)).toEqual([]);
	});

	it("returns nothing for an empty store", () => {
		expect(categoryOutliers(EMPTY, TODAY)).toEqual([]);
	});
});

// ---------- SHOULD: projected budget overrun ----------

describe("budgetOverruns", () => {
	const budgets = { categories: [{ id: catFood.id, name: "Food", budget: 100 }] };

	it("projects the month from the elapsed fraction, not from spend alone", () => {
		// €60 by the 15th of a 31-day month projects to €124 against a €100 limit.
		const s = store([tx({ date: "2024-07-10", amount: -60, categoryId: catFood.id })]);
		const [insight] = budgetOverruns(s, budgets, TODAY);
		expect(insight.kind).toBe("budget-overrun");
		expect(insight.impactEUR).toBeCloseTo(60 / (15 / 31) - 100, 4);
	});

	it("leaves a 10% cushion so a category landing a hair over doesn't card every month", () => {
		const s = store([tx({ date: "2024-07-10", amount: -53, categoryId: catFood.id })]); // projects to ≈ €110
		expect(budgetOverruns(s, budgets, TODAY)).toEqual([]);
	});

	it("says nothing in the first days of a month, when the projection is pure noise", () => {
		const s = store([tx({ date: "2024-07-02", amount: -60, categoryId: catFood.id })]);
		expect(budgetOverruns(s, budgets, new Date(2024, 6, 2))).toEqual([]);
	});

	it("ignores categories with no budget", () => {
		const s = store([tx({ date: "2024-07-10", amount: -600, categoryId: catShopping.id })]);
		expect(budgetOverruns(s, budgets, TODAY)).toEqual([]);
	});

	it("returns nothing for an empty store", () => {
		expect(budgetOverruns(EMPTY, budgets, TODAY)).toEqual([]);
	});
});

// ---------- SHOULD: missing income ----------

describe("missingIncome", () => {
	it("flags the biggest monthly incoming series once it is more than five days late", () => {
		const s = recurringSeries(store(charges("EMPLOYER BV", "2024-02-25", 30, [2500, 2500, 2500])));
		const [insight] = missingIncome(s, TODAY);
		expect(insight.kind).toBe("missing-income");
		expect(insight.impactEUR).toBe(2500);
		expect(insight.severity).toBe("high");
	});

	it("stays quiet while the salary is on time or only a few days late", () => {
		const s = recurringSeries(store(charges("EMPLOYER BV", "2024-04-25", 30, [2500, 2500, 2500])));
		expect(missingIncome(s, TODAY)).toEqual([]);
	});

	it("picks the salary, not a small recurring refund", () => {
		const s = recurringSeries(
			store([
				...charges("EMPLOYER BV", "2024-02-25", 30, [2500, 2500, 2500]),
				...charges("SMALL REFUND", "2024-02-10", 30, [12, 12, 12]),
			])
		);
		expect(missingIncome(s, TODAY)[0].title).toContain("Employer");
	});

	it("returns nothing for an empty store", () => {
		expect(missingIncome(recurringSeries(EMPTY), TODAY)).toEqual([]);
	});

	it("blames a stale import rather than the employer when the whole ledger is months behind (review MINOR #19)", () => {
		// Last import ended 25 April, "today" is 15 July. Without the guard this pinned a permanent
		// high-severity "your salary hasn't arrived" to the top of the feed — the same false alarm
		// zombieSubscriptions already refuses to raise.
		const s = store(charges("EMPLOYER BV", "2024-02-25", 30, [2500, 2500, 2500]));
		expect(missingIncome(recurringSeries(s), TODAY, s)).toEqual([]);
		// A current ledger with the same late salary still speaks up.
		const current = store([...charges("EMPLOYER BV", "2024-02-25", 30, [2500, 2500, 2500]), tx({ date: "2024-07-12", amount: -30 })]);
		expect(missingIncome(recurringSeries(current), TODAY, current)).toHaveLength(1);
	});
});

// ---------- SHOULD: uncategorized backlog ----------

describe("uncategorizedBacklog", () => {
	it("fires above 15% of trailing-3-month spend", () => {
		const s = store([
			tx({ date: "2024-05-10", amount: -700, categoryId: catFood.id }),
			tx({ date: "2024-06-10", amount: -100 }), // uncategorized
			tx({ date: "2024-06-11", amount: -200 }), // uncategorized
		]);
		const [insight] = uncategorizedBacklog(s, TODAY);
		expect(insight.kind).toBe("uncategorized-backlog");
		expect(insight.impactEUR).toBe(300);
		expect(insight.deepLink).toMatchObject({ type: "ledger", uncategorizedOnly: true, dateFrom: "2024-04-01", dateTo: "2024-06-30" });
	});

	it("stays quiet below the threshold", () => {
		const s = store([
			tx({ date: "2024-05-10", amount: -900, categoryId: catFood.id }),
			tx({ date: "2024-06-10", amount: -100 }),
		]);
		expect(uncategorizedBacklog(s, TODAY)).toEqual([]);
	});

	it("ignores the partial current month, so a mid-import spike doesn't trigger it", () => {
		const s = store([
			tx({ date: "2024-05-10", amount: -900, categoryId: catFood.id }),
			tx({ date: "2024-07-10", amount: -900 }),
		]);
		expect(uncategorizedBacklog(s, TODAY)).toEqual([]);
	});

	it("returns nothing for an empty store", () => {
		expect(uncategorizedBacklog(EMPTY, TODAY)).toEqual([]);
	});
});

// ---------- SHOULD: stale account ----------

describe("staleAccounts", () => {
	it("flags an account that went quiet while the others kept moving", () => {
		const s = store([
			tx({ date: "2024-07-10", amount: -20, accountId: checking.id }),
			tx({ date: "2024-03-01", amount: -60, accountId: credit.id }),
			tx({ date: "2024-02-01", amount: -60, accountId: credit.id }),
		]);
		const [insight] = staleAccounts(s, TODAY);
		expect(insight.kind).toBe("stale-account");
		expect(insight.title).toContain("Credit card");
		expect(insight.impactEUR).toBe(60); // its own monthly expense average
	});

	it("says nothing when the whole ledger is behind — that is one message, not one per account", () => {
		const s = store([
			tx({ date: "2024-03-01", amount: -20, accountId: checking.id }),
			tx({ date: "2024-02-01", amount: -60, accountId: credit.id }),
		]);
		expect(staleAccounts(s, TODAY)).toEqual([]);
	});

	it("does not call a never-imported account stale", () => {
		const s = store([tx({ date: "2024-07-10", amount: -20, accountId: checking.id })]);
		expect(staleAccounts(s, TODAY)).toEqual([]);
	});

	it("returns nothing for an empty store", () => {
		expect(staleAccounts(EMPTY, TODAY)).toEqual([]);
	});
});

// ---------- computeInsights ----------

describe("computeInsights", () => {
	/** A ledger carrying a €96/year price rise and a €400 duplicate, so ranking has something to rank. */
	function mixedStore(): KpiStore {
		return store([
			...charges("NETFLIX", "2024-02-05", 30, [-9.99, -9.99, -9.99, -17.99]),
			tx({ date: "2024-07-01", amount: -400, counterparty: "MEDIA MARKT" }),
			tx({ date: "2024-07-02", amount: -400, counterparty: "MEDIA MARKT" }),
		]);
	}

	it("returns an empty feed for an empty store without crashing", () => {
		expect(computeInsights(EMPTY)).toEqual([]);
		expect(computeInsights(EMPTY, [], null, { today: TODAY })).toEqual([]);
		expect(computeInsights(store([]), [], null, { today: TODAY })).toEqual([]);
	});

	it("ranks by € impact, not by detector order", () => {
		const feed = computeInsights(mixedStore(), [], null, { today: TODAY });
		expect(feed.length).toBeGreaterThan(1);
		expect(feed[0].impactEUR).toBe(400);
		for (let i = 1; i < feed.length; i++) expect(feed[i - 1].impactEUR).toBeGreaterThanOrEqual(feed[i].impactEUR);
	});

	it("produces the same ids across recomputes, so a dismissal sticks", () => {
		const s = mixedStore();
		const first = computeInsights(s, [], null, { today: TODAY });
		const second = computeInsights(s, [], null, { today: TODAY });
		expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));

		const dismissed = computeInsights(s, [], null, { today: TODAY, dismissed: [first[0].id] });
		expect(dismissed.map((i) => i.id)).not.toContain(first[0].id);
		expect(dismissed).toHaveLength(first.length - 1);
	});

	it("gives a price rise a different id once the price changes again", () => {
		const before = recurringPriceDrift(recurringSeries(store(charges("NETFLIX", "2024-02-05", 30, [-9.99, -9.99, -9.99, -12.99]))));
		const after = recurringPriceDrift(recurringSeries(store(charges("NETFLIX", "2024-02-05", 30, [-9.99, -9.99, -9.99, -15.99]))));
		expect(after[0].id).not.toBe(before[0].id);
	});

	it("caps the feed when a limit is given", () => {
		expect(computeInsights(mixedStore(), [], null, { today: TODAY, limit: 1 })).toHaveLength(1);
		expect(computeInsights(mixedStore(), [], null, { today: TODAY, limit: 0 })).toEqual([]);
	});

	it("falls back to the store's own categories for budgets", () => {
		const s = store([tx({ date: "2024-07-10", amount: -600, categoryId: catFood.id })], {
			categories: [{ ...catFood, budgetHistory: { "2024-07": 100 } }, catShopping, catTransfers],
		});
		const feed = computeInsights(s, [], null, { today: TODAY });
		expect(feed.some((i) => i.kind === "budget-overrun")).toBe(true);
	});

	it("reads the budget set for the month being judged, not one set for another month", () => {
		const s = store([tx({ date: "2024-07-10", amount: -600, categoryId: catFood.id })], {
			// A generous June budget must not excuse a July overrun — budgetHistory is per month.
			categories: [{ ...catFood, budgetHistory: { "2024-06": 5000 } }, catShopping, catTransfers],
		});
		const feed = computeInsights(s, [], null, { today: TODAY });
		expect(feed.some((i) => i.kind === "budget-overrun")).toBe(false);
	});

	it("reuses caller-supplied series rather than regrouping the ledger", () => {
		const s = mixedStore();
		const series = recurringSeries(s);
		expect(computeInsights(s, [], null, { today: TODAY, series })).toEqual(computeInsights(s, [], null, { today: TODAY }));
	});

	it("carries every insight shape the feed needs", () => {
		for (const insight of computeInsights(mixedStore(), [], null, { today: TODAY })) {
			expect(insight.id).toMatch(/^ins-/);
			expect(["high", "medium", "low"]).toContain(insight.severity);
			expect(insight.title.length).toBeGreaterThan(0);
			expect(insight.detail.length).toBeGreaterThan(0);
			expect(insight.impactEUR).toBeGreaterThanOrEqual(0);
			expect(insight.deepLink.type).toBeTruthy();
		}
	});

	// ---------- structured copy (privacy contract) ----------

	it("gives every insight parts that join back to its own title and detail", () => {
		// The view renders parts so privacy mode can redact figures and merchant names; the flat strings
		// stay the fallback, so the two must never disagree by so much as a space.
		const s = store([
			...charges("NETFLIX", "2024-02-05", 30, [-9.99, -9.99, -9.99, -17.99]),
			...charges("EMPLOYER BV", "2024-02-25", 30, [2500, 2500, 2500]),
			tx({ date: "2024-07-01", amount: -400, counterparty: "MEDIA MARKT" }),
			tx({ date: "2024-07-02", amount: -400, counterparty: "MEDIA MARKT" }),
			tx({ date: "2024-07-10", amount: -900, categoryId: catFood.id }),
			tx({ date: "2024-06-10", amount: -100 }),
			tx({ date: "2024-05-10", amount: -100 }),
		]);
		const feed = computeInsights(s, [sub({ cost: 4.99 })], null, { today: TODAY });
		expect(feed.length).toBeGreaterThan(3);
		const kinds = new Set(feed.map((i) => i.kind));
		expect(kinds.size).toBeGreaterThan(2);

		for (const insight of feed) {
			expect(insight.titleParts?.map((p) => p.text).join("")).toBe(insight.title);
			expect(insight.detailParts?.map((p) => p.text).join("")).toBe(insight.detail);
			// Nothing carries both flags — a part is either a figure or a name, never a mixed run.
			for (const part of [...(insight.titleParts ?? []), ...(insight.detailParts ?? [])]) {
				expect(part.money && part.sensitive).toBeFalsy();
			}
		}
	});

	it("marks the amounts as money and the merchant as sensitive", () => {
		const s = store([
			tx({ date: "2024-07-01", amount: -400, counterparty: "MEDIA MARKT" }),
			tx({ date: "2024-07-02", amount: -400, counterparty: "MEDIA MARKT" }),
		]);
		const [insight] = duplicateCharges(s, [], TODAY);
		expect(insight.titleParts).toEqual([
			{ text: "€400.00", money: true },
			{ text: " charged twice by " },
			{ text: "MEDIA MARKT", sensitive: true },
		]);
	});
});
