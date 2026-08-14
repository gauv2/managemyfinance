import { describe, expect, it } from "vitest";
import { checkConsistency } from "./consistency";
import type { MerchantMap } from "./import/merchantMemory";
import type { Category, Transaction } from "./types";

let seq = 0;
const tx = (description: string, categoryId?: string): Transaction =>
	({ id: `t${seq++}`, date: "2026-01-01", amount: -10, description, categoryId, accountId: "a", source: "s" }) as unknown as Transaction;

const cats: Category[] = [
	{ id: "food", name: "Food", color: "#f00", icon: "x", aliases: [] },
	{ id: "travel", name: "Travel", color: "#0f0", icon: "x", aliases: [] },
] as unknown as Category[];

const mem = (entries: Record<string, string | undefined>): MerchantMap =>
	Object.fromEntries(
		// "rule" is the realistic default: memory learned automatically. Entries a person made are given
		// source "user" explicitly, because that is exactly what the protection keys off.
		Object.entries(entries).map(([k, categoryId]) => [k, { key: k, categoryId, source: "rule", at: "2026-01-01" }])
	) as MerchantMap;

// Merchant key is the lowercased description here; display name is the description as written.
const keyOf = (t: Transaction): string | undefined => (t.description || "").toLowerCase() || undefined;
const nameOf = (t: Transaction): string | undefined => t.description || undefined;

const run = (txs: Transaction[], memory: MerchantMap, categories = cats) =>
	checkConsistency(txs, memory, categories, keyOf, nameOf);

const kinds = (r: ReturnType<typeof run>) => r.issues.map((i) => i.kind);

describe("dangling categories", () => {
	it("flags transactions filed under a category that no longer exists", () => {
		const r = run([tx("AH", "deleted-id")], mem({}));
		expect(kinds(r)).toContain("dangling-category");
		expect(r.issues[0].transactions).toHaveLength(1);
	});

	it("says nothing when every category resolves", () => {
		const r = run([tx("AH", "food")], mem({ ah: "food" }));
		expect(kinds(r)).not.toContain("dangling-category");
	});

	it("ignores uncategorized rows, which are not an inconsistency", () => {
		const r = run([tx("AH")], mem({}));
		expect(kinds(r)).not.toContain("dangling-category");
	});
});

describe("memory against the ledger", () => {
	it("flags memory that disagrees with how the rows are actually filed", () => {
		const r = run([tx("AH", "food"), tx("AH", "food")], mem({ ah: "travel" }));
		const issue = r.issues.find((i) => i.kind === "memory-disagrees");
		expect(issue).toBeDefined();
		expect(issue?.resolveTo).toBe("food");
		expect(issue?.transactions).toHaveLength(2);
	});

	it("stays quiet when they agree", () => {
		const r = run([tx("AH", "food")], mem({ ah: "food" }));
		expect(kinds(r)).not.toContain("memory-disagrees");
	});

	it("stays quiet when the ledger has no clear majority — that is a split, not a mistake", () => {
		const r = run([tx("AH", "food"), tx("AH", "travel")], mem({ ah: "travel" }));
		expect(kinds(r)).not.toContain("memory-disagrees");
	});

	it("flags memory pointing at a deleted category, and does not also call it a disagreement", () => {
		const r = run([tx("AH", "food")], mem({ ah: "gone" }));
		expect(kinds(r)).toContain("memory-missing-category");
		expect(kinds(r)).not.toContain("memory-disagrees");
	});
});


describe("variants of the same shop", () => {
	it("flags two keys reading as the same name but filed differently", () => {
		// Same display name, different keys, different categories.
		const a = tx("Albert Heijn", "food");
		const b = tx("albert heijn", "travel");
		const r = checkConsistency([a, b], mem({}), cats, (t) => t.id, nameOf);
		const split = r.issues.find((i) => i.kind === "same-name-split");
		expect(split).toBeDefined();
		expect(split?.variantKeys).toHaveLength(2);
	});

	it("stays quiet when the variants agree", () => {
		const a = tx("Albert Heijn", "food");
		const b = tx("albert heijn", "food");
		const r = checkConsistency([a, b], mem({}), cats, (t) => t.id, nameOf);
		expect(kinds(r)).not.toContain("same-name-split");
	});
});

describe("the report itself", () => {
	it("says what it looked at", () => {
		const r = run([tx("AH", "food")], mem({ ah: "food" }));
		expect(r.checked).toEqual({ transactions: 1, merchants: 1, categories: 2 });
	});

	it("finds nothing in a consistent vault", () => {
		const r = run([tx("AH", "food"), tx("Shell", "travel")], mem({ ah: "food", shell: "travel" }));
		expect(r.issues).toHaveLength(0);
	});
});

describe("a merchant split across categories", () => {
	// The inconsistency Iwan actually meant: one shop whose rows sit under several categories. No page
	// in the plugin groups a merchant across categories, so it is invisible without asking.
	it("flags it, worst-first, with the majority as the default answer", () => {
		const r = run(
			[tx("AH", "food"), tx("AH", "food"), tx("AH", "travel")],
			mem({})
		);
		const split = r.issues.find((i) => i.kind === "merchant-split");
		expect(split).toBeDefined();
		expect(split?.resolveTo).toBe("food");
		expect(split?.spread).toEqual([
			{ categoryId: "food", count: 2 },
			{ categoryId: "travel", count: 1 },
		]);
		// The fix moves every row, not just the minority, so the result is one category not a smaller split.
		expect(split?.transactions).toHaveLength(3);
	});

	it("says nothing about a merchant filed consistently", () => {
		const r = run([tx("AH", "food"), tx("AH", "food")], mem({}));
		expect(kinds(r)).not.toContain("merchant-split");
	});

	it("is reported alongside other disagreements", () => {
		const r = run([tx("AH", "food"), tx("AH", "travel"), tx("X", "gone-id")], mem({}));
		expect(kinds(r)).toContain("merchant-split");
		expect(kinds(r)).toContain("dangling-category");
	});
});

describe("merchants the ledger seems to have lost", () => {
	/**
	 * There is deliberately no check for these, and this test exists to stop one being added back.
	 *
	 * A lookup miss is not evidence of absence. In Iwan's vault the previous version reported 66
	 * merchants as gone whose transactions were sitting right there — memory keyed "barbershop
	 * rotterdam" against a row reading "Barbershop Rotterdam Alexander" — and offered to delete all of
	 * them under "clearing them costs nothing". Merchant memory is the only place a decision survives
	 * once the rows that taught it change.
	 */
	it("are never reported, however stale they look", () => {
		const r = run([tx("AH", "food")], mem({ ah: "food", "looks-gone": "food", "also-gone": "travel" }));
		expect(r.issues).toHaveLength(0);
	});

	it("does not report them even when nothing in the ledger matches at all", () => {
		const r = run([], mem({ "nothing-matches": "food" }));
		expect(r.issues).toHaveLength(0);
	});
});
