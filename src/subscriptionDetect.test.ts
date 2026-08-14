import { describe, it, expect } from "vitest";
import { detectRecurring, type TrackedSubscription } from "./subscriptionDetect";
import { addDaysIso } from "./recurring";
import type { KpiStore } from "./kpi";
import type { Account, Category, Subscription, Transaction } from "./types";

// ---------- fixtures ----------

const checking: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR", openingBalance: 0 };
const credit: Account = { id: "acc-credit", name: "Credit", type: "credit", currency: "EUR", openingBalance: 0 };

const catFood: Category = { id: "cat-food", name: "Food", color: "#000", icon: "utensils", aliases: [] };
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

function store(transactions: Transaction[]): KpiStore {
	return { accounts: [checking, credit], categories: [catFood, catTransfers], transactions };
}

/** A merchant charged `amounts.length` times, `gapDays` apart, at the given amounts (negative = charge). */
function charges(counterparty: string, startIso: string, gapDays: number, amounts: number[], extra: Partial<Transaction> = {}): Transaction[] {
	let date = startIso;
	return amounts.map((amount) => {
		const t = tx({ date, amount, counterparty, ...extra });
		date = addDaysIso(date, gapDays);
		return t;
	});
}

function sub(partial: Partial<TrackedSubscription> = {}): TrackedSubscription {
	return {
		id: "sub-1",
		name: "Netflix",
		category: "Streaming",
		cost: 10,
		billingCycle: "monthly",
		paidVia: "private",
		nextDueDate: "2024-07-05",
		...partial,
	};
}

// ---------- detection ----------

describe("detectRecurring", () => {
	it("returns nothing for an empty store", () => {
		expect(detectRecurring({ accounts: [], categories: [], transactions: [] })).toEqual([]);
		expect(detectRecurring(store([]), [], [])).toEqual([]);
	});

	it("detects a clean monthly subscription with every field the wizard needs", () => {
		const s = store(charges("NETFLIX.COM", "2024-01-05", 30, [-10.99, -10.99, -10.99, -10.99]));
		const [candidate] = detectRecurring(s);
		expect(candidate).toMatchObject({
			merchantKey: "netflix com",
			displayName: "Netflix.com",
			accountId: checking.id,
			cost: 10.99,
			billingCycle: "monthly",
			occurrences: 4,
			firstSeen: "2024-01-05",
			lastSeen: "2024-04-04",
			nextDueDate: "2024-05-04",
			confidence: "high",
		});
		expect(candidate.monthlyCost).toBeCloseTo(10.99, 6);
	});

	it("normalizes cost to a monthly figure for every cycle", () => {
		const weekly = detectRecurring(store(charges("GYM", "2024-01-01", 7, [-5, -5, -5, -5, -5, -5])))[0];
		expect(weekly.billingCycle).toBe("weekly");
		expect(weekly.monthlyCost).toBeCloseTo((5 * 52) / 12, 6);

		const yearly = detectRecurring(store(charges("DOMAIN", "2020-01-01", 365, [-12, -12, -12])))[0];
		expect(yearly.billingCycle).toBe("yearly");
		expect(yearly.monthlyCost).toBeCloseTo(1, 6);
	});

	// ---------- the precision filters ----------

	it("rejects the supermarket: regular in time, wildly variable in amount", () => {
		// A weekly grocery run passes every timing test Netflix passes. Amount stability is the only thing
		// separating them, and it is the single most important filter in this module.
		const supermarket = store(charges("ALBERT HEIJN 1234", "2024-01-06", 7, [-42.18, -87.5, -19.99, -113.4, -61.2, -38.75]));
		expect(detectRecurring(supermarket)).toEqual([]);
	});

	it("accepts a subscription whose amount moves inside ±15% and rejects one that moves outside it", () => {
		const inside = store(charges("SERVICE", "2024-01-05", 30, [-10, -10, -10, -11.5])); // last three: 10, 10, 11.5 → +15%
		expect(detectRecurring(inside)).toHaveLength(1);

		const outside = store(charges("SERVICE", "2024-01-05", 30, [-10, -10, -10, -11.6])); // → +16%
		expect(detectRecurring(outside)).toEqual([]);
	});

	it("only looks at the three most recent amounts, so an old price rise doesn't disqualify a subscription", () => {
		const s = store(charges("SPOTIFY", "2024-01-05", 30, [-5.99, -5.99, -10.99, -10.99, -10.99]));
		const [candidate] = detectRecurring(s);
		expect(candidate.cost).toBe(10.99);
	});

	it("rejects a series whose timing wanders", () => {
		const s = store(charges("HABIT", "2024-01-05", 0, []).concat([
			tx({ date: "2024-01-05", amount: -10, counterparty: "HABIT" }),
			tx({ date: "2024-02-04", amount: -10, counterparty: "HABIT" }),
			tx({ date: "2024-03-05", amount: -10, counterparty: "HABIT" }),
			tx({ date: "2024-05-04", amount: -10, counterparty: "HABIT" }), // 60-day gap
		]));
		expect(detectRecurring(s)).toEqual([]);
	});

	it("requires at least 3 charges", () => {
		expect(detectRecurring(store(charges("NETFLIX", "2024-01-05", 30, [-10, -10])))).toEqual([]);
		expect(detectRecurring(store(charges("NETFLIX", "2024-01-05", 30, [-10, -10, -10])))).toHaveLength(1);
	});

	it("requires the charges to span at least 2 distinct months", () => {
		// Three weekly charges inside one month is a billing quirk or a retry storm, not a commitment.
		const oneMonth = store(charges("SOMETHING", "2024-01-01", 7, [-10, -10, -10]));
		expect(detectRecurring(oneMonth)).toEqual([]);
	});

	it("ignores incoming money — a salary is not a subscription", () => {
		expect(detectRecurring(store(charges("EMPLOYER BV", "2024-01-25", 30, [2500, 2500, 2500, 2500])))).toEqual([]);
	});

	it("ignores transfers between your own accounts", () => {
		const s = store(charges("OWN SAVINGS", "2024-01-05", 30, [-500, -500, -500, -500], { categoryId: catTransfers.id }));
		expect(detectRecurring(s)).toEqual([]);
	});

	it("ignores sub-€1 charges", () => {
		expect(detectRecurring(store(charges("VERIFY", "2024-01-05", 30, [-0.01, -0.01, -0.01, -0.01])))).toEqual([]);
	});

	// ---------- suppression ----------

	it("suppresses a series already tracked under a matching name", () => {
		const s = store(charges("NETFLIX.COM", "2024-01-05", 30, [-10.99, -10.99, -10.99]));
		expect(detectRecurring(s, [sub({ name: "Netflix" })])).toEqual([]);
		expect(detectRecurring(s, [sub({ name: "Netflix Premium" })])).toEqual([]);
	});

	it("suppresses a series tracked on the same account at within 5% of the cost, even under a different name", () => {
		const s = store(charges("PAYMENT REF 88231", "2024-01-05", 30, [-10.99, -10.99, -10.99]));
		expect(detectRecurring(s, [sub({ name: "Some Service", accountId: checking.id, cost: 10.6 })])).toEqual([]);
		// 20% off is a different subscription that happens to be nearby, not the same one.
		expect(detectRecurring(s, [sub({ name: "Some Service", accountId: checking.id, cost: 8.8 })])).toHaveLength(1);
	});

	it("does not let a short subscription name swallow an unrelated merchant", () => {
		const s = store(charges("BOLT.EU", "2024-01-05", 30, [-12, -12, -12]));
		expect(detectRecurring(s, [sub({ name: "Bol" })])).toHaveLength(1);
	});

	it("honours the optional merchantKey link ahead of the name", () => {
		const s = store(charges("PAYMENT REF 88231", "2024-01-05", 30, [-10.99, -10.99, -10.99]));
		expect(detectRecurring(s, [sub({ name: "Nothing Alike", merchantKey: "payment ref" })])).toEqual([]);
	});

	it("still suggests a series whose only tracking record is archived", () => {
		const s = store(charges("NETFLIX.COM", "2024-01-05", 30, [-10.99, -10.99, -10.99]));
		expect(detectRecurring(s, [sub({ name: "Netflix", archived: true })])).toHaveLength(1);
	});

	it("never suggests a dismissed merchant key again", () => {
		const s = store(charges("NETFLIX.COM", "2024-01-05", 30, [-10.99, -10.99, -10.99]));
		expect(detectRecurring(s, [], ["netflix com"])).toEqual([]);
		// A dismissal recorded from raw merchant text still matches, since it goes through the same normalizer.
		expect(detectRecurring(s, [], ["NETFLIX.COM"])).toEqual([]);
		expect(detectRecurring(s, [], ["something else"])).toHaveLength(1);
	});

	// ---------- confidence and ordering ----------

	it("grades confidence on occurrences × timing regularity × amount stability", () => {
		const strong = detectRecurring(store(charges("NETFLIX", "2024-01-05", 30, [-10, -10, -10, -10, -10, -10])))[0];
		expect(strong.confidence).toBe("high");

		const thin = detectRecurring(store(charges("NETFLIX", "2024-01-05", 30, [-10, -10, -10])))[0];
		expect(thin.confidence).toBe("medium");

		const shaky = detectRecurring(
			store([
				tx({ date: "2024-01-01", amount: -10, counterparty: "SHAKY" }),
				tx({ date: "2024-01-31", amount: -10, counterparty: "SHAKY" }),
				tx({ date: "2024-03-07", amount: -10, counterparty: "SHAKY" }),
				tx({ date: "2024-03-31", amount: -11, counterparty: "SHAKY" }),
			])
		)[0];
		expect(shaky.confidence).toBe("low");
	});

	it("ranks by monthly cost so the biggest commitment leads", () => {
		const s = store([
			...charges("SMALL", "2024-01-05", 30, [-3, -3, -3]),
			...charges("BIG", "2024-01-05", 30, [-40, -40, -40]),
		]);
		expect(detectRecurring(s).map((c) => c.merchantKey)).toEqual(["big", "small"]);
	});

	it("samples the most recent transaction ids, newest first, capped at five", () => {
		const s = store(charges("NETFLIX", "2024-01-05", 30, [-10, -10, -10, -10, -10, -10, -10]));
		const [candidate] = detectRecurring(s);
		expect(candidate.sampleTransactionIds).toHaveLength(5);
		expect(candidate.sampleTransactionIds[0]).toBe(s.transactions[6].id);
		expect(candidate.sampleTransactionIds[4]).toBe(s.transactions[2].id);
	});

	it("attributes a series to the account most of its charges landed on", () => {
		const s = store([
			tx({ date: "2024-01-05", amount: -10, counterparty: "NETFLIX", accountId: checking.id }),
			tx({ date: "2024-02-04", amount: -10, counterparty: "NETFLIX", accountId: credit.id }),
			tx({ date: "2024-03-05", amount: -10, counterparty: "NETFLIX", accountId: credit.id }),
			tx({ date: "2024-04-04", amount: -10, counterparty: "NETFLIX", accountId: credit.id }),
		]);
		expect(detectRecurring(s)[0].accountId).toBe(credit.id);
	});

	it("accepts caller-tuned thresholds", () => {
		const s = store(charges("SERVICE", "2024-01-05", 30, [-10, -10, -10, -14]));
		expect(detectRecurring(s)).toEqual([]);
		expect(detectRecurring(s, [], [], { maxAmountSpread: 0.5 })).toHaveLength(1);
	});
});
