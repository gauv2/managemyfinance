import { describe, expect, it } from "vitest";
import { forecastFixedCommitment } from "./fixedCommitment";
import type { ForecastStore } from "../types";
import type { Account, Category, Transaction } from "../../types";

const CHECKING: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR" };
const RENT = "cat-rent";

const CATEGORIES: Category[] = [{ id: RENT, name: "Rent", color: "#000", icon: "tag", aliases: [] }];

let nextId = 0;
function tx(date: string, amount: number, categoryId: string, counterparty: string): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, date, accountId: CHECKING.id, description: counterparty, counterparty, amount, currency: "EUR", categoryId, source: "manual" };
}

/** 36 months of an identical €1,250 rent charge, same landlord, same day every month — the spec's own
 *  "a truly fixed category" example (§31). */
function rentHistory(): Transaction[] {
	const out: Transaction[] = [];
	for (let year = 2022; year <= 2024; year++) {
		for (let month = 1; month <= 12; month++) {
			out.push(tx(`${year}-${String(month).padStart(2, "0")}-01`, -1250, RENT, "Landlord Holdings BV"));
		}
	}
	return out;
}

function store(transactions: Transaction[]): ForecastStore {
	return { accounts: [CHECKING], categories: CATEGORIES, transactions };
}

const TARGET = { from: "2025-01-01", to: "2025-01-31", label: "January 2025" };

describe("forecastFixedCommitment — Rent", () => {
	const result = forecastFixedCommitment(store(rentHistory()), { categoryId: RENT, target: TARGET, scope: "leaf" });

	it("returns the exact same amount for Lean, Typical and Buffered — no manufactured spread (§31)", () => {
		expect(result.p25?.amount).toBe(1250);
		expect(result.p50?.amount).toBe(1250);
		expect(result.p75?.amount).toBe(1250);
	});

	it("gives every scenario the same confidence too — there's no tail to be less sure about", () => {
		expect(result.p25?.confidenceScore).toBe(result.p50?.confidenceScore);
		expect(result.p75?.confidenceScore).toBe(result.p50?.confidenceScore);
	});

	it("reads high confidence off three years of a perfectly stable stable recurring series", () => {
		expect(result.p50?.confidenceLabel).toBe("high");
		expect(result.diagnostics.relativeIqr).toBe(0);
		expect(result.diagnostics.volatility).toBe("low");
	});

	it("sources the amount from a known projected commitment, not a fallback reading", () => {
		expect(result.diagnostics.knownCommitments).toBe(1250);
		expect(result.diagnostics.explanation[0]).toContain("known");
	});
});

describe("forecastFixedCommitment — fallback rungs", () => {
	it("falls back to the latest tracked payment when nothing projects into the target", () => {
		// Two payments only — not enough occurrences to form a detected recurring series (needs 3) or a
		// projectable commitment, so this exercises the "latest stable amount" rung directly.
		const s = store([tx("2024-06-01", -900, RENT, "New Landlord"), tx("2024-07-01", -900, RENT, "New Landlord")]);
		const result = forecastFixedCommitment(s, { categoryId: RENT, target: { from: "2025-01-01", to: "2025-01-31", label: "January 2025" }, scope: "leaf" });
		expect(result.p50?.amount).toBe(900);
		expect(result.diagnostics.knownCommitments).toBe(0);
		expect(result.diagnostics.explanation[0]).toContain("most recent payment");
	});

	it("is not forecastable when the ledger has tracked months but this category was never charged", () => {
		// The ledger is tracked (via an unrelated category's own transactions), but Rent itself was
		// never actually charged in any of those months. Averaging an all-zero series answered €0 and
		// then cited the empty month buckets as if they were payments; a fixed cost nobody has ever
		// paid is missing evidence, not a €0 budget.
		const OTHER = "cat-other";
		const s: ForecastStore = {
			accounts: [CHECKING],
			categories: [...CATEGORIES, { id: OTHER, name: "Other", color: "#000", icon: "tag", aliases: [] }],
			transactions: [tx("2024-06-15", -10, OTHER, "Shop"), tx("2024-07-15", -10, OTHER, "Shop")],
		};
		const result = forecastFixedCommitment(s, { categoryId: RENT, target: { from: "2025-01-01", to: "2025-01-31", label: "January 2025" }, scope: "leaf" });
		expect(result.forecastable).toBe(false);
		expect(result.p50).toBeUndefined();
		expect(result.reason).toMatch(/no payments recorded/i);
	});

	it("never reports empty month buckets as historical payments", () => {
		// The regression this guards: 79 tracked-but-empty months were counted as "79 historical
		// payments back this estimate" for a category with none of them.
		const OTHER = "cat-other";
		const transactions = Array.from({ length: 79 }, (_, i) => {
			const month = String((i % 12) + 1).padStart(2, "0");
			const year = 2018 + Math.floor(i / 12);
			return tx(`${year}-${month}-15`, -10, OTHER, "Shop");
		});
		const s: ForecastStore = {
			accounts: [CHECKING],
			categories: [...CATEGORIES, { id: OTHER, name: "Other", color: "#000", icon: "tag", aliases: [] }],
			transactions,
		};
		const result = forecastFixedCommitment(s, { categoryId: RENT, target: { from: "2025-01-01", to: "2025-01-31", label: "January 2025" }, scope: "leaf" });
		expect(result.forecastable).toBe(false);
		expect(result.diagnostics.explanation.join(" ")).not.toMatch(/historical payment/i);
	});

	it("is not forecastable at all with no history whatsoever", () => {
		const result = forecastFixedCommitment(store([]), { categoryId: RENT, target: TARGET, scope: "leaf" });
		expect(result.forecastable).toBe(false);
		expect(result.reason).toMatch(/no spending history/i);
	});

	it("projects a recent price rise forward, not the multi-year historical median (§59)", () => {
		// Nine years at the old €1,250 rent, then a genuine rise to €1,300 for the three months right
		// before the target — the historical median is still €1,250 (it's the overwhelming majority of
		// the series), but the *next* payment is €1,300, and that's what a future-rent forecast needs.
		const raisedMonths = new Set([10, 11, 12]);
		const transactions: Transaction[] = [];
		for (let year = 2016; year <= 2024; year++) {
			for (let month = 1; month <= 12; month++) {
				const raised = year === 2024 && raisedMonths.has(month);
				transactions.push(tx(`${year}-${String(month).padStart(2, "0")}-01`, raised ? -1300 : -1250, RENT, "Landlord Holdings BV"));
			}
		}
		const result = forecastFixedCommitment(store(transactions), { categoryId: RENT, target: TARGET, scope: "leaf" });
		expect(result.p50?.amount).toBe(1300);
	});
});
