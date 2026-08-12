import { describe, it, expect } from "vitest";
import {
	applyMemory,
	dismissSuggestion,
	learnFromHistory,
	pruneMemory,
	remember,
	rememberSuggestion,
	siblingsOf,
	unknownMerchants,
	type MerchantMap,
} from "./merchantMemory";
import type { Category, Transaction } from "../types";

const FOOD: Category = { id: "cat-food", name: "Food", color: "#000", icon: "utensils", aliases: [] };
const FUEL: Category = { id: "cat-fuel", name: "Fuel", color: "#000", icon: "fuel", aliases: [], parentId: "cat-car" };
const CAR: Category = { id: "cat-car", name: "Auto & Transport", color: "#000", icon: "car", aliases: [] };
const categories = [FOOD, CAR, FUEL];

let n = 0;
function tx(description: string, categoryId?: string): Transaction {
	n++;
	return {
		id: `tx-${n}`,
		date: "2026-01-08",
		accountId: "acc-1",
		description,
		amount: -10,
		currency: "EUR",
		source: "ing",
		categoryId,
	};
}

describe("learnFromHistory", () => {
	it("learns a merchant from transactions already categorized", () => {
		const map = learnFromHistory([tx("Albert Heijn 1423", FOOD.id), tx("CCV*ALBERT HEIJN 5566", FOOD.id)]);
		expect(map["albert heijn"]?.categoryId).toBe(FOOD.id);
	});

	it("takes a clear majority when a merchant's history disagrees", () => {
		const map = learnFromHistory([
			tx("Shell Rotterdam", FUEL.id),
			tx("Shell Rotterdam", FUEL.id),
			tx("Shell Rotterdam", FOOD.id),
		]);
		expect(map["shell rotterdam"]?.categoryId).toBe(FUEL.id);
	});

	it("refuses to decide a merchant split evenly between two categories", () => {
		// A supermarket you buy both groceries and petrol from is genuinely ambiguous; guessing here
		// would silently rewrite real history.
		const map = learnFromHistory([tx("Esso Shop", FUEL.id), tx("Esso Shop", FOOD.id)]);
		expect(map["esso shop"]).toBeUndefined();
	});

	it("ignores uncategorized transactions", () => {
		expect(learnFromHistory([tx("Bambu Lab")])["bambu lab"]).toBeUndefined();
	});

	it("never overrides a category the user set explicitly", () => {
		const seeded = remember({}, "albert heijn", CAR.id, "user");
		const map = learnFromHistory([tx("Albert Heijn", FOOD.id), tx("Albert Heijn", FOOD.id)], seeded);
		expect(map["albert heijn"]?.categoryId).toBe(CAR.id);
	});
});

describe("remember — precedence", () => {
	it("lets a user decision replace a rule match", () => {
		let map = remember({}, "netflix", CAR.id, "rule");
		map = remember(map, "netflix", FOOD.id, "user");
		expect(map["netflix"].categoryId).toBe(FOOD.id);
	});

	it("does not let a rule match overwrite a user decision", () => {
		// Re-running auto-categorization must never undo a correction.
		let map = remember({}, "netflix", FOOD.id, "user");
		map = remember(map, "netflix", CAR.id, "rule");
		expect(map["netflix"].categoryId).toBe(FOOD.id);
	});

	it("lets an AI answer replace a rule match but not a user decision", () => {
		let fromRule = remember({}, "sharesub", CAR.id, "rule");
		fromRule = remember(fromRule, "sharesub", FOOD.id, "ai");
		expect(fromRule["sharesub"].categoryId).toBe(FOOD.id);

		let fromUser = remember({}, "sharesub", CAR.id, "user");
		fromUser = remember(fromUser, "sharesub", FOOD.id, "ai");
		expect(fromUser["sharesub"].categoryId).toBe(CAR.id);
	});

	it("clears a parked suggestion once the merchant is settled", () => {
		let map = rememberSuggestion({}, "vats prague", { categoryId: FOOD.id, confidence: 0.5, model: "m" });
		map = remember(map, "vats prague", CAR.id, "user");
		expect(map["vats prague"].suggestion).toBeUndefined();
	});
});

describe("rememberSuggestion", () => {
	it("parks a low-confidence answer without applying it", () => {
		const map = rememberSuggestion({}, "innoboonint in", { categoryId: FOOD.id, confidence: 0.55, model: "m" });
		expect(map["innoboonint in"].categoryId).toBeUndefined();
		expect(map["innoboonint in"].suggestion?.confidence).toBe(0.55);
	});

	it("never overwrites a merchant that already has a category", () => {
		const settled = remember({}, "netflix", FOOD.id, "user");
		const map = rememberSuggestion(settled, "netflix", { categoryId: CAR.id, confidence: 0.9, model: "m" });
		expect(map["netflix"].suggestion).toBeUndefined();
		expect(map["netflix"].categoryId).toBe(FOOD.id);
	});
});

describe("applyMemory", () => {
	it("fills in every uncategorized transaction from the same merchant", () => {
		const map = remember({}, "albert heijn", FOOD.id, "user");
		const txs = [tx("Albert Heijn 1423"), tx("CCV*ALBERT HEIJN 5566"), tx("Jumbo")];
		const { patches, merchants } = applyMemory(txs, map, categories);
		expect(patches.size).toBe(2);
		expect(merchants).toBe(1);
		expect(patches.get(txs[0].id)).toBe(FOOD.id);
		expect(patches.has(txs[2].id)).toBe(false);
	});

	it("never touches a transaction that already has a category", () => {
		const map = remember({}, "albert heijn", FOOD.id, "user");
		const already = tx("Albert Heijn", CAR.id);
		expect(applyMemory([already], map, categories).patches.size).toBe(0);
	});

	it("ignores memory pointing at a category that has since been deleted", () => {
		const map = remember({}, "albert heijn", "cat-deleted", "user");
		expect(applyMemory([tx("Albert Heijn")], map, categories).patches.size).toBe(0);
	});

	it("can target a secondary category, not just a primary", () => {
		const map = remember({}, "shell rotterdam", FUEL.id, "user");
		const t = tx("Shell Rotterdam");
		expect(applyMemory([t], map, categories).patches.get(t.id)).toBe(FUEL.id);
	});
});

describe("unknownMerchants", () => {
	it("returns distinct merchants, commonest first — one entry per shop, not per row", () => {
		const txs = [tx("Bambu Lab"), tx("Bambu Lab"), tx("Bambu Lab"), tx("Sharesub"), tx("Sharesub"), tx("Patreon")];
		expect(unknownMerchants(txs, {})).toEqual([
			{ key: "bambu lab", count: 3, name: "Bambu Lab" },
			{ key: "sharesub", count: 2, name: "Sharesub" },
			{ key: "patreon", count: 1, name: "Patreon" },
		]);
	});

	it("skips merchants that are already known or already have a parked suggestion", () => {
		let map = remember({}, "bambu lab", FOOD.id, "user");
		map = rememberSuggestion(map, "sharesub", { categoryId: FOOD.id, confidence: 0.4, model: "m" });
		const txs = [tx("Bambu Lab"), tx("Sharesub"), tx("Patreon")];
		expect(unknownMerchants(txs, map).map((m) => m.key)).toEqual(["patreon"]);
	});

	it("skips rows with no recognizable merchant at all", () => {
		expect(unknownMerchants([tx("000123456789")], {})).toEqual([]);
	});

	it("carries the full readable name, not the two-word grouping key", () => {
		// The bug this exists for: the model was being asked to classify "to koninklijke" and declined
		// 28 of 29 merchants. It now sees the name a person would recognise.
		const [m] = unknownMerchants([tx("To Koninklijke PostNL B.V.")], {});
		expect(m.key).toBe("koninklijke postnl");
		expect(m.name).toBe("Koninklijke PostNL B.V.");
	});

	it("keeps the most informative description when a merchant appears several ways", () => {
		// Same key, different amounts of detail — the fullest form is what a classifier should see.
		const txs = [tx("Koninklijke PostNL"), tx("Koninklijke PostNL B.V."), tx("Koninklijke PostNL")];
		expect(unknownMerchants(txs, {})[0].name).toBe("Koninklijke PostNL B.V.");
	});
});

describe("siblingsOf", () => {
	it("finds the other transactions from the same shop", () => {
		const a = tx("Albert Heijn 1423");
		const b = tx("CCV*ALBERT HEIJN 5566");
		const c = tx("Jumbo");
		expect(siblingsOf([a, b, c], a).map((t) => t.id)).toEqual([b.id]);
	});
});

describe("pruneMemory", () => {
	it("drops entries whose category no longer exists", () => {
		const map: MerchantMap = {
			gone: { key: "gone", categoryId: "cat-deleted", source: "user", at: "2026-01-01" },
			kept: { key: "kept", categoryId: FOOD.id, source: "user", at: "2026-01-01" },
		};
		const pruned = pruneMemory(map, categories);
		expect(pruned.gone).toBeUndefined();
		expect(pruned.kept.categoryId).toBe(FOOD.id);
	});

	it("drops a suggestion pointing at a deleted category", () => {
		const map = rememberSuggestion({}, "x", { categoryId: "cat-deleted", confidence: 0.9, model: "m" });
		expect(pruneMemory(map, categories).x).toBeUndefined();
	});
});

describe("dismissSuggestion", () => {
	it("drops the suggestion without inventing a category", () => {
		let map = rememberSuggestion({}, "vats prague", { categoryId: FOOD.id, confidence: 0.5, model: "m" });
		map = dismissSuggestion(map, "vats prague");
		expect(map["vats prague"].suggestion).toBeUndefined();
		expect(map["vats prague"].categoryId).toBeUndefined();
	});

	it("keeps the merchant out of the next AI batch", () => {
		// Without this, rejecting a guess would just get you the same guess again next pass.
		let map = rememberSuggestion({}, "vats prague group", { categoryId: FOOD.id, confidence: 0.5, model: "m" });
		map = dismissSuggestion(map, "vats prague group");
		expect(unknownMerchants([tx("Vats Prague Group")], map)).toEqual([]);
	});

	it("survives pruning even though it names no category", () => {
		let map = rememberSuggestion({}, "vats prague", { categoryId: FOOD.id, confidence: 0.5, model: "m" });
		map = dismissSuggestion(map, "vats prague");
		expect(pruneMemory(map, categories)["vats prague"]).toBeDefined();
	});

	it("is cleared once the merchant is given a category", () => {
		let map = dismissSuggestion({}, "vats prague");
		map = remember(map, "vats prague", FOOD.id, "user");
		expect(map["vats prague"].dismissedAt).toBeUndefined();
		expect(map["vats prague"].categoryId).toBe(FOOD.id);
	});
});
