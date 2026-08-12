import { describe, expect, it } from "vitest";
import { findTransferMatches, transferGroupId, transferPatches, transferSiblings } from "./transfers";
import type { Transaction } from "./types";

function tx(overrides: Partial<Transaction> & { id: string; date: string; accountId: string; amount: number }): Transaction {
	return { description: "Transfer", currency: "EUR", source: "manual", ...overrides };
}

/**
 * A wrong match here removes two real transactions from income and expenses — a silent error nobody
 * ever notices — so the matcher's conservatism is the thing under test as much as its matching.
 */
describe("findTransferMatches", () => {
	it("pairs an outflow with the matching inflow in another account", () => {
		const pairs = findTransferMatches([
			tx({ id: "out", date: "2024-03-01", accountId: "checking", amount: -500 }),
			tx({ id: "in", date: "2024-03-01", accountId: "savings", amount: 500 }),
		]);

		expect(pairs).toHaveLength(1);
		expect(pairs[0].outflow.id).toBe("out");
		expect(pairs[0].inflow.id).toBe("in");
		expect(pairs[0].daysApart).toBe(0);
	});

	it("pairs legs posted a few days apart, as banks actually post them", () => {
		const pairs = findTransferMatches([
			tx({ id: "out", date: "2024-03-01", accountId: "checking", amount: -500 }),
			tx({ id: "in", date: "2024-03-03", accountId: "savings", amount: 500 }),
		]);
		expect(pairs).toHaveLength(1);
		expect(pairs[0].daysApart).toBe(2);
	});

	it("refuses a pair further apart than the window", () => {
		expect(
			findTransferMatches([
				tx({ id: "out", date: "2024-03-01", accountId: "checking", amount: -500 }),
				tx({ id: "in", date: "2024-03-20", accountId: "savings", amount: 500 }),
			])
		).toHaveLength(0);
	});

	it("never pairs two legs of the same account", () => {
		expect(
			findTransferMatches([
				tx({ id: "out", date: "2024-03-01", accountId: "checking", amount: -500 }),
				tx({ id: "in", date: "2024-03-01", accountId: "checking", amount: 500 }),
			])
		).toHaveLength(0);
	});

	it("refuses amounts that don't agree", () => {
		expect(
			findTransferMatches([
				tx({ id: "out", date: "2024-03-01", accountId: "checking", amount: -500 }),
				tx({ id: "in", date: "2024-03-01", accountId: "savings", amount: 499 }),
			])
		).toHaveLength(0);
	});

	it("takes the closest candidate when two would fit, leaving the other free", () => {
		const pairs = findTransferMatches([
			tx({ id: "out", date: "2024-03-03", accountId: "checking", amount: -500 }),
			tx({ id: "far", date: "2024-03-01", accountId: "savings", amount: 500 }),
			tx({ id: "near", date: "2024-03-03", accountId: "savings", amount: 500 }),
		]);

		expect(pairs).toHaveLength(1);
		expect(pairs[0].inflow.id).toBe("near");
	});

	it("uses each transaction at most once", () => {
		const pairs = findTransferMatches([
			tx({ id: "out1", date: "2024-03-01", accountId: "checking", amount: -100 }),
			tx({ id: "out2", date: "2024-03-01", accountId: "checking", amount: -100 }),
			tx({ id: "in1", date: "2024-03-01", accountId: "savings", amount: 100 }),
		]);

		expect(pairs).toHaveLength(1);
		const used = [pairs[0].outflow.id, pairs[0].inflow.id];
		expect(new Set(used).size).toBe(2);
	});

	it("leaves already-linked transactions completely alone, so re-running only ever adds", () => {
		const pairs = findTransferMatches([
			tx({ id: "out", date: "2024-03-01", accountId: "checking", amount: -500, transferGroupId: "xfer-existing" }),
			tx({ id: "in", date: "2024-03-01", accountId: "savings", amount: 500, transferGroupId: "xfer-existing" }),
		]);
		expect(pairs).toHaveLength(0);
	});

	it("pairs across currencies when rates make the amounts agree", () => {
		const pairs = findTransferMatches(
			[
				tx({ id: "out", date: "2024-03-01", accountId: "checking", amount: -100, currency: "EUR" }),
				tx({ id: "in", date: "2024-03-01", accountId: "usd", amount: 111.11, currency: "USD" }),
			],
			{ fx: { baseCurrency: "EUR", rates: { USD: 0.9 } }, amountTolerance: 0.05 }
		);
		expect(pairs).toHaveLength(1);
	});

	it("ignores zero-amount rows and unparseable dates", () => {
		expect(
			findTransferMatches([
				tx({ id: "zero-out", date: "2024-03-01", accountId: "checking", amount: 0 }),
				tx({ id: "zero-in", date: "2024-03-01", accountId: "savings", amount: 0 }),
				tx({ id: "bad-date", date: "not a date", accountId: "savings", amount: -50 }),
			])
		).toHaveLength(0);
	});
});

describe("transferGroupId", () => {
	it("is stable and independent of argument order, so re-matching doesn't churn ids", () => {
		expect(transferGroupId("a", "b")).toBe(transferGroupId("b", "a"));
		expect(transferGroupId("a", "b")).not.toBe(transferGroupId("a", "c"));
	});
});

describe("transferPatches / transferSiblings", () => {
	it("produces one patch per leg, both carrying the same group id", () => {
		const pairs = findTransferMatches([
			tx({ id: "out", date: "2024-03-01", accountId: "checking", amount: -500 }),
			tx({ id: "in", date: "2024-03-01", accountId: "savings", amount: 500 }),
		]);
		const patches = transferPatches(pairs);

		expect(patches.size).toBe(2);
		expect(patches.get("out")!.transferGroupId).toBe(patches.get("in")!.transferGroupId);
	});

	it("finds the other leg of a linked transfer", () => {
		const a = tx({ id: "out", date: "2024-03-01", accountId: "checking", amount: -500, transferGroupId: "g" });
		const b = tx({ id: "in", date: "2024-03-01", accountId: "savings", amount: 500, transferGroupId: "g" });

		expect(transferSiblings([a, b], a).map((t) => t.id)).toEqual(["in"]);
		expect(transferSiblings([a, b], tx({ id: "x", date: "2024-03-01", accountId: "c", amount: -1 }))).toEqual([]);
	});
});
