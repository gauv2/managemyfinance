import { describe, expect, it, vi } from "vitest";
import type { Category, Transaction } from "../types";
import type { MerchantMap } from "../import/merchantMemory";

// `vi.hoisted` so the spy exists before `vi.mock` is lifted above the imports; that in turn lets
// `aiCategorize` be imported normally, without a top-level await this tsconfig's module target
// doesn't allow.
const { classifyMerchants } = vi.hoisted(() => ({ classifyMerchants: vi.fn() }));
vi.mock("./provider", () => ({
	classifyMerchants: (...args: unknown[]) => classifyMerchants(...args),
	DEFAULT_CONFIDENCE_THRESHOLD: 0.8,
}));

import { aiCategorize } from "./categorizer";

const CATEGORIES: Category[] = [{ id: "cat-shopping", name: "Shopping", color: "#000", icon: "tag", aliases: [] }];

function tx(description: string): Transaction {
	return { id: `t-${description}`, date: "2026-01-01", accountId: "acc", description, amount: -10, currency: "EUR", source: "manual" };
}

/** One unknown merchant, one scripted answer from the model. */
async function runWithAssignments(
	assignments: { merchant: string; categoryId: string; confidence: number }[],
	settings: { applyLowConfidence?: boolean; confidenceThreshold?: number }
) {
	classifyMerchants.mockReset();
	classifyMerchants.mockResolvedValue({ assignments, rejected: [], model: "test-model" });
	const memory: MerchantMap = {};
	return aiCategorize([tx("Snowcone B.V.")], CATEGORIES, memory, settings as never);
}

describe("low-confidence answers, applied in the run that produced them", () => {
	it("categorizes a below-threshold answer instead of parking it for next time", async () => {
		// The bug this covers: the answer was remembered as a suggestion with no categoryId, so the
		// merchant stopped counting as unrecognized while its rows stayed uncategorized. Asking once
		// looked like the model had barely helped; asking a second time quietly did the rest.
		const result = await runWithAssignments([{ merchant: "snowcone", categoryId: "cat-shopping", confidence: 0.2 }], {
			applyLowConfidence: true,
			confidenceThreshold: 0.8,
		});
		expect(result.flagged).toBe(1);
		expect(result.patches.size).toBe(1);
	});

	it("marks what it applied as flagged, so it is findable in Review", async () => {
		const result = await runWithAssignments([{ merchant: "snowcone", categoryId: "cat-shopping", confidence: 0.2 }], {
			applyLowConfidence: true,
			confidenceThreshold: 0.8,
		});
		expect([...result.patches.values()][0]).toMatchObject({ review: "flagged" });
	});

	it("still parks it when the setting is off", async () => {
		// Turning it off is a deliberate "I want to approve these first", and must keep working.
		const result = await runWithAssignments([{ merchant: "snowcone", categoryId: "cat-shopping", confidence: 0.2 }], {
			applyLowConfidence: false,
			confidenceThreshold: 0.8,
		});
		expect(result.flagged).toBe(1);
		expect(result.patches.size).toBe(0);
	});

	it("leaves a confident answer applied and unflagged", async () => {
		const result = await runWithAssignments([{ merchant: "snowcone", categoryId: "cat-shopping", confidence: 0.95 }], {
			applyLowConfidence: true,
			confidenceThreshold: 0.8,
		});
		expect(result.applied).toBe(1);
		expect([...result.patches.values()][0].review).toBeUndefined();
	});
});
