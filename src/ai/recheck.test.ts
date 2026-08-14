import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	aiRecheckCategories,
	buildRecheckTargets,
	countUncertain,
	countUnrecognized,
	describeRecheck,
	PROPOSAL_FLOOR,
	type RecheckResult,
} from "./recheck";
import type { MerchantMap } from "../import/merchantMemory";
import type { Category, Transaction } from "../types";

const classifyMerchants = vi.fn();
vi.mock("./provider", () => ({
	classifyMerchants: (...args: unknown[]) => classifyMerchants(...args),
}));

const food: Category = { id: "food", name: "Food", color: "#1", icon: "u", aliases: [] };
const groceries: Category = { id: "groc", name: "Groceries", color: "#2", icon: "u", aliases: [], parentId: "food" };
const fuel: Category = { id: "fuel", name: "Fuel", color: "#3", icon: "u", aliases: [] };
const gone: Category = { id: "gone", name: "Retired", color: "#4", icon: "u", aliases: [], archived: true };
const categories = [food, groceries, fuel, gone];

let seq = 0;
function tx(description: string, categoryId?: string): Transaction {
	seq++;
	return {
		id: `t${seq}`,
		date: "2025-03-01",
		accountId: "acc",
		description,
		amount: -10,
		currency: "EUR",
		source: "manual",
		categoryId,
	} as Transaction;
}

/** A reply assigning every named merchant to a category. Names must be what the pass sent. */
function reply(pairs: [string, string, number][]) {
	return {
		assignments: pairs.map(([merchant, categoryId, confidence]) => ({ merchant, categoryId, confidence })),
		rejected: [],
		model: "claude-opus-5",
		provider: "api" as const,
	};
}

beforeEach(() => {
	classifyMerchants.mockReset();
});

describe("buildRecheckTargets", () => {
	it("collects one target per categorized merchant with its current category", () => {
		const rows = [tx("Albert Heijn 1423", "groc"), tx("CCV*ALBERT HEIJN 5566", "groc"), tx("Shell", "fuel")];
		const { targets } = buildRecheckTargets(rows, {});

		expect(targets).toHaveLength(2);
		const ah = targets.find((t) => t.name.toLowerCase().includes("albert"));
		expect(ah?.currentCategoryId).toBe("groc");
		expect(ah?.transactions).toHaveLength(2);
	});

	it("ignores uncategorized rows — those are the other pass's job", () => {
		const { targets } = buildRecheckTargets([tx("Albert Heijn"), tx("Shell", "fuel")], {});
		expect(targets.map((t) => t.currentCategoryId)).toEqual(["fuel"]);
	});

	// A supermarket you buy both groceries and petrol from has no single category to disagree with.
	it("skips a merchant deliberately split across categories", () => {
		const rows = [tx("Shell 1", "fuel"), tx("Shell 2", "groc")];
		const { targets, skipped } = buildRecheckTargets(rows, {});
		expect(targets).toHaveLength(0);
		expect(skipped.splitAcrossCategories).toBe(1);
	});

	it("still checks a merchant with a clear majority despite one stray row", () => {
		const rows = [tx("Shell 1", "fuel"), tx("Shell 2", "fuel"), tx("Shell 3", "fuel"), tx("Shell 4", "groc")];
		const { targets, skipped } = buildRecheckTargets(rows, {});
		expect(targets[0].currentCategoryId).toBe("fuel");
		expect(skipped.splitAcrossCategories).toBe(0);
	});

	it("proposes against only the rows in the majority category", () => {
		const rows = [tx("Shell 1", "fuel"), tx("Shell 2", "fuel"), tx("Shell 3", "fuel"), tx("Shell 4", "groc")];
		const { targets } = buildRecheckTargets(rows, {});
		// The stray groceries row was never part of what a proposal claims about.
		expect(targets[0].transactions).toHaveLength(3);
	});

	it("skips merchants a person has already confirmed", () => {
		const memory: MerchantMap = { "albert heijn": { key: "albert heijn", source: "user", at: "2025-01-01", reviewedAt: "2025-01-01" } };
		const rows = [tx("Albert Heijn", "groc"), tx("Shell", "fuel")];
		const { targets, skipped } = buildRecheckTargets(rows, memory);
		expect(targets.map((t) => t.currentCategoryId)).toEqual(["fuel"]);
		expect(skipped.alreadyReviewed).toBe(1);
	});

	it("can be asked to include confirmed merchants anyway", () => {
		const memory: MerchantMap = { "albert heijn": { key: "albert heijn", source: "user", at: "2025-01-01", reviewedAt: "2025-01-01" } };
		const { targets } = buildRecheckTargets([tx("Albert Heijn", "groc")], memory, { includeReviewed: true });
		expect(targets).toHaveLength(1);
	});

	it("puts the busiest merchants first, so a cap lands on the cheap end", () => {
		const rows = [tx("Shell", "fuel"), tx("Albert Heijn 1", "groc"), tx("Albert Heijn 2", "groc"), tx("Albert Heijn 3", "groc")];
		const { targets } = buildRecheckTargets(rows, {});
		expect(targets[0].name.toLowerCase()).toContain("albert");
	});

	it("caps the pass and reports that it did", () => {
		const rows = Array.from({ length: 8 }, (_, i) => tx(`Merchant Alpha${i} Store`, "groc"));
		const { targets, available, truncated } = buildRecheckTargets(rows, {}, { limit: 3 });
		expect(targets).toHaveLength(3);
		expect(available).toBe(8);
		expect(truncated).toBe(true);
	});

	it("skips rows with no recognizable merchant name", () => {
		const { targets } = buildRecheckTargets([tx("4738291047", "groc"), tx("Shell", "fuel")], {});
		expect(targets).toHaveLength(1);
	});
});

describe("aiRecheckCategories", () => {
	const rows = [tx("Albert Heijn 1", "fuel"), tx("Albert Heijn 2", "fuel"), tx("Shell Station", "fuel")];

	it("proposes only where the model disagrees", async () => {
		const prepared = buildRecheckTargets(rows, {});
		const names = prepared.targets.map((t) => t.name);
		classifyMerchants.mockResolvedValue(
			reply([
				// Disagrees about Albert Heijn, agrees about Shell.
				[prepared.targets[0].key, "groc", 0.95],
				[prepared.targets[1].key, "fuel", 0.95],
			])
		);
		void names;

		const result = await aiRecheckCategories(prepared, categories, {});

		expect(result.proposals).toHaveLength(1);
		expect(result.proposals[0].currentCategoryId).toBe("fuel");
		expect(result.proposals[0].proposedCategoryId).toBe("groc");
		expect(result.agreed).toHaveLength(1);
		// Carries the key and category so only these get marked confirmed, plus the name and rows so
		// the dialog can list exactly which merchants a click is about to settle.
		expect(result.agreed[0]).toMatchObject({ key: prepared.targets[1].key, categoryId: "fuel", name: "Shell Station" });
		expect(result.agreed[0].transactions).toHaveLength(1);
	});

	// The point of classifying cold rather than asking "is this right?" — the request must not carry
	// the answer, or the model simply agrees with whatever it is shown.
	it("never tells the model what the current category is", async () => {
		const prepared = buildRecheckTargets(rows, {});
		classifyMerchants.mockResolvedValue(reply([]));

		await aiRecheckCategories(prepared, categories, {});

		const sent = classifyMerchants.mock.calls[0][0] as { key: string; name: string }[];
		for (const item of sent) {
			expect(Object.keys(item).sort()).toEqual(["key", "name"]);
		}
	});

	it("drops a disagreement below the confidence floor and counts it", async () => {
		const prepared = buildRecheckTargets(rows, {});
		classifyMerchants.mockResolvedValue(reply([[prepared.targets[0].key, "groc", PROPOSAL_FLOOR - 0.01]]));

		const result = await aiRecheckCategories(prepared, categories, {});

		expect(result.proposals).toHaveLength(0);
		expect(countUncertain(result)).toBe(1);
		// The withheld answer is carried, not just counted — the dialog shows what it nearly said.
		expect(result.unsettled[0]).toMatchObject({ reason: "uncertain", suggestedCategoryId: "groc" });
	});

	it("never proposes moving anything into an archived category", async () => {
		const prepared = buildRecheckTargets(rows, {});
		classifyMerchants.mockResolvedValue(reply([[prepared.targets[0].key, "gone", 1]]));

		const result = await aiRecheckCategories(prepared, categories, {});
		expect(result.proposals).toHaveLength(0);
	});

	it("carries the affected transactions on the proposal", async () => {
		const prepared = buildRecheckTargets(rows, {});
		classifyMerchants.mockResolvedValue(reply([[prepared.targets[0].key, "groc", 0.9]]));

		const result = await aiRecheckCategories(prepared, categories, {});
		expect(result.proposals[0].transactions).toHaveLength(2);
	});

	// The two groups nobody settled must stay out of `agreed`, because the caller marks exactly that
	// list confirmed — and stamping "a human confirmed this" on a merchant the model shrugged at
	// would hide it from every future pass on the strength of a non-answer.
	it("does not count a low-confidence disagreement as agreement", async () => {
		const prepared = buildRecheckTargets(rows, {});
		classifyMerchants.mockResolvedValue(reply([[prepared.targets[0].key, "groc", PROPOSAL_FLOOR - 0.01]]));

		const result = await aiRecheckCategories(prepared, categories, {});
		expect(result.agreed).toHaveLength(0);
		expect(countUncertain(result)).toBe(1);
	});

	it("does not count an unanswered merchant as agreement", async () => {
		const prepared = buildRecheckTargets(rows, {});
		classifyMerchants.mockResolvedValue(reply([]));

		const result = await aiRecheckCategories(prepared, categories, {});
		expect(result.agreed).toHaveLength(0);
		expect(countUnrecognized(result)).toBe(prepared.targets.length);
	});

	it("counts merchants the model declined to place", async () => {
		const prepared = buildRecheckTargets(rows, {});
		classifyMerchants.mockResolvedValue(reply([]));

		const result = await aiRecheckCategories(prepared, categories, {});
		expect(countUnrecognized(result)).toBe(prepared.targets.length);
		// Named, so the dialog can list which ones it gave up on.
		expect(result.unsettled.every((u) => u.name.length > 0)).toBe(true);
	});

	it("ranks proposals by confidence, then by how many rows move", async () => {
		const many = [
			tx("Alpha One", "fuel"),
			tx("Alpha Two", "fuel"),
			...Array.from({ length: 5 }, () => tx("Beta Shop", "fuel")),
		];
		const prepared = buildRecheckTargets(many, {});
		classifyMerchants.mockResolvedValue(
			reply(prepared.targets.map((t) => [t.key, "groc", 0.9] as [string, string, number]))
		);

		const result = await aiRecheckCategories(prepared, categories, {});
		expect(result.proposals[0].transactions.length).toBeGreaterThanOrEqual(result.proposals[1].transactions.length);
	});

	it("throws when every batch fails rather than reporting a clean bill of health", async () => {
		const prepared = buildRecheckTargets(rows, {});
		classifyMerchants.mockRejectedValue(new Error("Rate limited by the Claude API"));

		await expect(aiRecheckCategories(prepared, categories, {})).rejects.toThrow("Rate limited");
	});

	it("does not call the model when there is nothing to check", async () => {
		const prepared = buildRecheckTargets([tx("Uncategorized row")], {});
		const result = await aiRecheckCategories(prepared, categories, {});
		expect(classifyMerchants).not.toHaveBeenCalled();
		expect(result.checked).toBe(0);
	});
});

/** n stand-in agreed merchants, since describeRecheck only ever reads the length. */
function agreedList(n: number): RecheckResult["agreed"] {
	return Array.from({ length: n }, (_, i) => ({ key: `m${i}`, name: `M${i}`, categoryId: "food", transactions: [] }));
}

/** n stand-in unsettled merchants of one kind, for the summary-line tests. */
function unsettledList(n: number, reason: "uncertain" | "unrecognized"): RecheckResult["unsettled"] {
	return Array.from({ length: n }, (_, i) => ({
		key: `u${reason}${i}`,
		name: `U${i}`,
		currentCategoryId: "food",
		transactions: [],
		reason,
	}));
}

describe("describeRecheck", () => {
	function result(over: Partial<RecheckResult> = {}): RecheckResult {
		return {
			checked: 100,
			available: 100,
			agreed: [],
			proposals: [],
			unsettled: [],
			skipped: { splitAcrossCategories: 0, alreadyReviewed: 0, noReadableName: 0 },
			rejected: [],
			truncated: false,
			model: "claude-opus-5",
			...over,
		};
	}

	it("says what was confirmed as well as what was proposed", () => {
		const line = describeRecheck(result({ agreed: agreedList(89), proposals: [{} as never] }));
		expect(line).toContain("1 change proposed across 100 merchants");
		expect(line).toContain("89 confirmed as-is");
	});

	// Coverage attached to the number is the difference between a report and a claim.
	it("names everything it deliberately left out", () => {
		const line = describeRecheck(
			result({
				agreed: agreedList(50),
				skipped: { splitAcrossCategories: 12, alreadyReviewed: 30, noReadableName: 0 },
				unsettled: [...unsettledList(4, "uncertain"), ...unsettledList(2, "unrecognized")],
			})
		);
		expect(line).toContain("12 skipped as deliberately split");
		expect(line).toContain("30 already confirmed");
		expect(line).toContain("4 too uncertain to raise");
		expect(line).toContain("2 unrecognized");
	});

	it("admits a partial sweep", () => {
		expect(describeRecheck(result({ checked: 400, available: 1200, truncated: true }))).toContain("busiest 400 of 1200 only");
	});

	it("explains an empty run caused by everything already being confirmed", () => {
		const line = describeRecheck(result({ checked: 0, skipped: { splitAcrossCategories: 0, alreadyReviewed: 55, noReadableName: 0 } }));
		expect(line).toContain("all 55 categorized merchants have already been confirmed");
	});
});
