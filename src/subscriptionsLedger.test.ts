import { describe, expect, it } from "vitest";
import {
	detectRecurring,
	latestPriceIncrease,
	looksLikePaymentFor,
	paymentsFor,
	priceChanges,
	spendOn,
	suggestPaymentsFor,
} from "./subscriptions";
import type { Subscription, Transaction } from "./types";

function sub(overrides: Partial<Subscription> = {}): Subscription {
	return {
		id: "sub-netflix",
		name: "Netflix",
		category: "Streaming",
		cost: 11.99,
		currency: "EUR",
		billingCycle: "monthly",
		paidVia: "private",
		nextDueDate: "2024-04-01",
		...overrides,
	};
}

let nextId = 0;
function tx(date: string, amount: number, description: string, overrides: Partial<Transaction> = {}): Transaction {
	nextId++;
	return {
		id: `tx-${nextId}`,
		date,
		accountId: "acc",
		description,
		amount,
		currency: "EUR",
		source: "manual",
		...overrides,
	};
}

describe("matching payments to a subscription", () => {
	it("matches on the subscription's own name when no pattern is set", () => {
		expect(looksLikePaymentFor(tx("2024-01-01", -11.99, "NETFLIX.COM 4356"), sub())).toBe(true);
		expect(looksLikePaymentFor(tx("2024-01-01", -11.99, "SPOTIFY"), sub())).toBe(false);
	});

	it("prefers an explicit match pattern over the name", () => {
		const s = sub({ name: "Streaming box", matchPattern: "NFLX" });
		expect(looksLikePaymentFor(tx("2024-01-01", -11.99, "NFLX DIGITAL"), s)).toBe(true);
		expect(looksLikePaymentFor(tx("2024-01-01", -11.99, "Streaming box"), s)).toBe(false);
	});

	it("never treats income as a subscription payment", () => {
		expect(looksLikePaymentFor(tx("2024-01-01", 11.99, "NETFLIX REFUND"), sub())).toBe(false);
	});

	it("counts only explicitly linked rows as payments, not text matches", () => {
		const transactions = [
			tx("2024-01-01", -11.99, "NETFLIX.COM", { subscriptionId: "sub-netflix" }),
			tx("2024-02-01", -11.99, "NETFLIX.COM"),
		];
		// What a subscription has cost is a claim; it shouldn't rest on a substring.
		expect(paymentsFor(transactions, sub())).toHaveLength(1);
		expect(suggestPaymentsFor(transactions, sub())).toHaveLength(1);
	});

	it("returns payments newest first", () => {
		const transactions = [
			tx("2024-01-01", -11.99, "NETFLIX", { subscriptionId: "sub-netflix" }),
			tx("2024-03-01", -11.99, "NETFLIX", { subscriptionId: "sub-netflix" }),
		];
		expect(paymentsFor(transactions, sub()).map((p) => p.date)).toEqual(["2024-03-01", "2024-01-01"]);
	});
});

describe("what a subscription has actually cost", () => {
	it("totals the linked payments and reports the latest", () => {
		const transactions = [
			tx("2024-01-01", -11.99, "NETFLIX", { subscriptionId: "sub-netflix" }),
			tx("2024-02-01", -13.99, "NETFLIX", { subscriptionId: "sub-netflix" }),
		];
		const spend = spendOn(transactions, sub());
		expect(spend.count).toBe(2);
		expect(spend.total).toBeCloseTo(25.98, 6);
		expect(spend.lastAmount).toBe(13.99);
		expect(spend.firstDate).toBe("2024-01-01");
		expect(spend.average).toBeCloseTo(12.99, 6);
	});

	it("converts payments in another currency into the base currency", () => {
		const transactions = [tx("2024-01-01", -10, "NETFLIX", { subscriptionId: "sub-netflix", currency: "USD" })];
		expect(spendOn(transactions, sub(), { USD: 0.9 }).total).toBeCloseTo(9, 6);
	});

	it("reports nothing rather than zero-ing out when nothing is linked", () => {
		expect(spendOn([], sub())).toMatchObject({ count: 0, total: 0 });
	});
});

describe("price changes", () => {
	it("finds a rise between consecutive payments", () => {
		const transactions = [
			tx("2024-01-01", -11.99, "NETFLIX", { subscriptionId: "sub-netflix" }),
			tx("2024-02-01", -13.99, "NETFLIX", { subscriptionId: "sub-netflix" }),
		];
		const change = latestPriceIncrease(transactions, sub())!;
		expect(change.from).toBe(11.99);
		expect(change.to).toBe(13.99);
		expect(change.delta).toBeCloseTo(0.1668, 3);
		expect(change.date).toBe("2024-02-01");
	});

	it("ignores wobble below the tolerance — FX drift and VAT rounding aren't price rises", () => {
		const transactions = [
			tx("2024-01-01", -11.99, "NETFLIX", { subscriptionId: "sub-netflix" }),
			tx("2024-02-01", -12.0, "NETFLIX", { subscriptionId: "sub-netflix" }),
		];
		expect(priceChanges(transactions, sub())).toEqual([]);
	});

	it("reports a price cut as a change but not as an increase", () => {
		const transactions = [
			tx("2024-01-01", -13.99, "NETFLIX", { subscriptionId: "sub-netflix" }),
			tx("2024-02-01", -11.99, "NETFLIX", { subscriptionId: "sub-netflix" }),
		];
		expect(priceChanges(transactions, sub())).toHaveLength(1);
		expect(latestPriceIncrease(transactions, sub())).toBeUndefined();
	});
});

describe("detectRecurring", () => {
	function monthlyCharges(label: string, amount: number, months: number, day = "01"): Transaction[] {
		return Array.from({ length: months }, (_, i) =>
			tx(`2024-${String(i + 1).padStart(2, "0")}-${day}`, -amount, label, { counterparty: label })
		);
	}

	it("finds a monthly charge of a stable amount", () => {
		const found = detectRecurring(monthlyCharges("SPOTIFY AB", 10.99, 4), []);
		expect(found).toHaveLength(1);
		expect(found[0].billingCycle).toBe("monthly");
		expect(found[0].amount).toBeCloseTo(10.99, 2);
		expect(found[0].occurrences).toBe(4);
	});

	it("ignores a merchant you simply visit often — repetition isn't recurrence", () => {
		// Three supermarket trips in one week, varying amounts: repetitive, not a subscription.
		const trips = [
			tx("2024-01-02", -23.4, "ALBERT HEIJN", { counterparty: "ALBERT HEIJN" }),
			tx("2024-01-04", -8.1, "ALBERT HEIJN", { counterparty: "ALBERT HEIJN" }),
			tx("2024-01-06", -55.0, "ALBERT HEIJN", { counterparty: "ALBERT HEIJN" }),
		];
		expect(detectRecurring(trips, [])).toEqual([]);
	});

	it("ignores a regular charge whose amount swings wildly — that's a bill, not a subscription", () => {
		const bills = [
			tx("2024-01-01", -40, "ENERGY CO", { counterparty: "ENERGY CO" }),
			tx("2024-02-01", -180, "ENERGY CO", { counterparty: "ENERGY CO" }),
			tx("2024-03-01", -25, "ENERGY CO", { counterparty: "ENERGY CO" }),
		];
		expect(detectRecurring(bills, [])).toEqual([]);
	});

	it("needs at least three occurrences before calling something recurring", () => {
		expect(detectRecurring(monthlyCharges("SPOTIFY AB", 10.99, 2), [])).toEqual([]);
	});

	it("skips merchants already tracked as a subscription", () => {
		const charges = monthlyCharges("NETFLIX", 11.99, 4);
		expect(detectRecurring(charges, [sub({ matchPattern: "netflix" })])).toEqual([]);
	});

	it("skips transactions already mapped to a subscription", () => {
		const charges = monthlyCharges("SPOTIFY AB", 10.99, 4).map((t) => ({ ...t, subscriptionId: "sub-x" }));
		expect(detectRecurring(charges, [])).toEqual([]);
	});

	it("recognizes a yearly cycle", () => {
		const yearly = [
			tx("2022-06-01", -95, "DOMAIN RENEWAL", { counterparty: "DOMAIN RENEWAL" }),
			tx("2023-06-02", -95, "DOMAIN RENEWAL", { counterparty: "DOMAIN RENEWAL" }),
			tx("2024-06-01", -99, "DOMAIN RENEWAL", { counterparty: "DOMAIN RENEWAL" }),
		];
		const found = detectRecurring(yearly, []);
		expect(found).toHaveLength(1);
		expect(found[0].billingCycle).toBe("yearly");
	});

	it("returns the transactions behind a candidate, so tracking it maps its history", () => {
		const found = detectRecurring(monthlyCharges("SPOTIFY AB", 10.99, 4), []);
		expect(found[0].transactionIds).toHaveLength(4);
	});

	it("groups a merchant whose reference number changes every month", () => {
		const charges = [
			tx("2024-01-01", -9.99, "ICLOUD 4451", { counterparty: "ICLOUD 4451" }),
			tx("2024-02-01", -9.99, "ICLOUD 8823", { counterparty: "ICLOUD 8823" }),
			tx("2024-03-01", -9.99, "ICLOUD 1290", { counterparty: "ICLOUD 1290" }),
		];
		expect(detectRecurring(charges, [])).toHaveLength(1);
	});
});
