import { describe, expect, it } from "vitest";
import { amountGroups, changedByPreview, describeRuleScope, movingCount, previewRule, rulePatches, seedPatternFor, seedRuleFor, staleStampPatches } from "./rules";
import type { Category, CategoryRule, Transaction } from "./types";


/** previewRule classifies each match, so it needs the accounts and categories, not just the rows. */
function storeOf(transactions: Transaction[], categories: Category[] = []) {
	return { accounts: [], categories, transactions };
}

let n = 0;
function tx(description: string, categoryId?: string): Transaction {
	n++;
	return { id: `tx-${n}`, date: "2026-01-0" + ((n % 9) + 1), accountId: "acc", description, amount: -10, currency: "EUR", source: "manual", categoryId };
}

describe("previewRule", () => {
	it("splits matches into fill, move and already-correct", () => {
		const rows = [
			tx("ALBERT HEIJN 1423 DEN HAAG"),
			tx("Albert Heijn 5567", "cat-shopping"),
			tx("albert heijn to go", "cat-groceries"),
			tx("JUMBO 88", "cat-groceries"),
		];
		const p = previewRule(storeOf(rows), { pattern: "albert heijn" }, "cat-groceries");

		expect(p.total).toBe(3);
		expect(p.uncategorized).toHaveLength(1);
		expect(p.alreadyCorrect).toHaveLength(1);
		expect(movingCount(p)).toBe(1);
		expect(p.moving.get("cat-shopping")).toHaveLength(1);
		// The unrelated merchant is untouched.
		expect(changedByPreview(p).map((t) => t.description)).not.toContain("JUMBO 88");
	});

	it("groups movers by the category they are leaving", () => {
		const rows = [
			tx("Apple Store", "cat-shopping"),
			tx("Apple Store", "cat-shopping"),
			tx("APPLE.COM/BILL", "cat-subs"),
		];
		const p = previewRule(storeOf(rows), { pattern: "apple" }, "cat-electronics");

		expect(movingCount(p)).toBe(3);
		expect(p.moving.get("cat-shopping")).toHaveLength(2);
		expect(p.moving.get("cat-subs")).toHaveLength(1);
	});

	it("matches nothing on an empty pattern rather than everything", () => {
		// "".includes() is true for every string, so without the guard an empty box would propose
		// re-filing the entire ledger.
		const rows = [tx("A"), tx("B"), tx("C")];
		const p = previewRule(storeOf(rows), { pattern: "" }, "cat-x");
		expect(p.total).toBe(0);
		expect(changedByPreview(p)).toHaveLength(0);
	});

	it("matches nothing when no target category has been chosen yet", () => {
		const rows = [tx("Albert Heijn")];
		expect(previewRule(storeOf(rows), { pattern: "albert" }, undefined).total).toBe(0);
	});

	it("counts a row already in the target as no change", () => {
		const rows = [tx("Netflix", "cat-ent"), tx("Netflix", "cat-ent")];
		const p = previewRule(storeOf(rows), { pattern: "netflix" }, "cat-ent");
		expect(p.total).toBe(2);
		expect(changedByPreview(p)).toHaveLength(0);
		expect(p.alreadyCorrect).toHaveLength(2);
	});

	it("supports a regex pattern", () => {
		const rows = [tx("NS REIZIGERS"), tx("TRANSNS BV")];
		const p = previewRule(storeOf(rows), { pattern: "^ns\\s", isRegex: true }, "cat-transport");
		expect(p.total).toBe(1);
	});

	it("treats a broken regex as matching nothing, so a half-typed pattern proposes no damage", () => {
		const rows = [tx("anything"), tx("else")];
		expect(previewRule(storeOf(rows), { pattern: "([", isRegex: true }, "cat-x").total).toBe(0);
	});
});

describe("seedPatternFor", () => {
	/** The invariant: whatever we seed must match the row it was seeded from. */
	function seedMatchesItsOwnRow(description: string, counterparty?: string): boolean {
		const row = { description, counterparty };
		const seed = seedPatternFor(row);
		return previewRule(storeOf([{ ...tx(description), description, counterparty }]), { pattern: seed }, "cat-x").total === 1;
	}

	it("cuts at the branch number so the rule catches every branch", () => {
		expect(seedPatternFor({ description: "ALBERT HEIJN 1423 DEN HAAG" })).toBe("ALBERT HEIJN");
		expect(seedPatternFor({ description: "Bck Barbershop 040" })).toBe("Bck Barbershop");
	});

	it("never reduces a merchant to a bare city", () => {
		// merchantKey turns "H&M 0123 AMSTERDAM" into "amsterdam" — a rule that would file every
		// Amsterdam transaction in the ledger under H&M.
		expect(seedPatternFor({ description: "H&M 0123 AMSTERDAM" })).toBe("H&M");
	});

	it("keeps punctuation, since the rule is a raw substring test", () => {
		expect(seedPatternFor({ description: "ONLY&SONS" })).toBe("ONLY&SONS");
		expect(seedPatternFor({ description: "APPLE.COM/BILL" })).toBe("APPLE.COM/BILL");
	});

	it("leaves no dangling separator on the end of the pattern", () => {
		expect(seedPatternFor({ description: "TICKETS - 4412" })).toBe("TICKETS");
	});

	it("keeps a description that opens with a number whole rather than emptying it", () => {
		expect(seedPatternFor({ description: "998877665544 SOME SHOP" })).toBe("998877665544 SOME SHOP");
	});

	it("prefers the counterparty when there is one", () => {
		expect(seedPatternFor({ description: "Card payment", counterparty: "Bck Barbershop 040" })).toBe("Bck Barbershop");
	});

	it("still matches the row it came from when the merchant contains punctuation", () => {
		// merchantKey turns "ONLY&SONS" into "only sons", which is not a substring of "only&sons" —
		// seeding it would propose a rule that matches nothing, including the row you right-clicked.
		expect(seedMatchesItsOwnRow("ONLY&SONS")).toBe(true);
		expect(seedMatchesItsOwnRow("APPLE.COM/BILL")).toBe(true);
		expect(seedMatchesItsOwnRow("H&M 0123 AMSTERDAM")).toBe(true);
	});

	it("holds the invariant for plain merchant names too", () => {
		expect(seedMatchesItsOwnRow("ALBERT HEIJN 1423 DEN HAAG")).toBe(true);
		expect(seedMatchesItsOwnRow("Netflix")).toBe(true);
		expect(seedMatchesItsOwnRow("Card payment", "Bck Barbershop 040")).toBe(true);
	});

	it("falls back to the raw text when there is no usable merchant key", () => {
		expect(seedPatternFor({ description: "  Some Shop  " })).toBeTruthy();
		expect(seedMatchesItsOwnRow("998877665544")).toBe(true);
	});
});

describe("previewRule — money movements are not merchant spending", () => {
	const TRANSFERS = "cat-transfers";
	const ELECTRONICS = "cat-electronics";
	const CATS: Category[] = [
		{ id: TRANSFERS, name: "Transfers", color: "#000", icon: "repeat", aliases: [] },
		{ id: ELECTRONICS, name: "Electronics", color: "#000", icon: "tag", aliases: [] },
	];

	/** The real shape: Apple purchases plus Apple Pay top-ups, which share the word and nothing else. */
	function appleLedger(): Transaction[] {
		const purchases = [tx("Apple", ELECTRONICS), tx("APPLE.COM/BILL", ELECTRONICS)];
		const topUps = [tx("Apple Pay top-up by *1234", TRANSFERS), tx("Apple Pay top-up by *0942", TRANSFERS)];
		for (const t of topUps) t.amount = 50;
		return [...purchases, ...topUps];
	}

	it("holds back a transfer a merchant rule would recast as spending", () => {
		const p = previewRule(storeOf(appleLedger(), CATS), { pattern: "Apple" }, ELECTRONICS);

		expect(p.total).toBe(4);
		expect(p.protectedNeutral).toHaveLength(2);
		expect(p.protectedNeutral.every((t) => t.description.includes("top-up"))).toBe(true);
		// And nothing protected leaks into the rows that actually get written.
		expect(changedByPreview(p)).toHaveLength(0);
		expect(movingCount(p)).toBe(0);
	});

	it("still moves the real purchases", () => {
		const rows = appleLedger();
		rows[0].categoryId = "cat-shopping";
		const p = previewRule(storeOf(rows, [...CATS, { id: "cat-shopping", name: "Shopping", color: "#000", icon: "tag", aliases: [] }]), { pattern: "Apple" }, ELECTRONICS);

		expect(movingCount(p)).toBe(1);
		expect(changedByPreview(p)[0].description).toBe("Apple");
		expect(p.protectedNeutral).toHaveLength(2);
	});

	it("lets the user opt the transfers in", () => {
		const p = previewRule(storeOf(appleLedger(), CATS), { pattern: "Apple" }, ELECTRONICS, { includeNeutral: true });

		expect(movingCount(p)).toBe(2);
		expect(p.neutralIncluded).toBe(true);
	});

	it("keeps reporting the neutral rows once opted in, so the choice can be reversed", () => {
		// They were previously dropped from `protectedNeutral` when included, which removed the
		// checkbox that had just been ticked — a one-way door with no way back.
		const p = previewRule(storeOf(appleLedger(), CATS), { pattern: "Apple" }, ELECTRONICS, { includeNeutral: true });

		expect(p.protectedNeutral).toHaveLength(2);
		expect(p.protectedNeutral.every((t) => t.description.includes("top-up"))).toBe(true);
	});

	it("does not double-count an included neutral row", () => {
		const p = previewRule(storeOf(appleLedger(), CATS), { pattern: "Apple" }, ELECTRONICS, { includeNeutral: true });

		const written = changedByPreview(p).map((t) => t.id);
		expect(new Set(written).size).toBe(written.length);
		expect(p.total).toBe(4);
	});

	it("does not hold anything back when the rule files INTO a transfer category", () => {
		// Nothing is being reclassified — the rows stay money movements — so the protection must not
		// fire, or filing transfers by rule would be impossible.
		const p = previewRule(storeOf(appleLedger(), CATS), { pattern: "Apple Pay top-up" }, TRANSFERS);

		expect(p.protectedNeutral).toHaveLength(0);
		expect(p.neutralIncluded).toBe(false);
		expect(p.alreadyCorrect).toHaveLength(2);
	});

	it("leaves ordinary spending rows entirely alone", () => {
		const rows = [tx("Albert Heijn", "cat-shopping"), tx("Albert Heijn 22", "cat-shopping")];
		const cats: Category[] = [
			{ id: "cat-shopping", name: "Shopping", color: "#000", icon: "tag", aliases: [] },
			{ id: "cat-groceries", name: "Groceries", color: "#000", icon: "tag", aliases: [] },
		];
		const p = previewRule(storeOf(rows, cats), { pattern: "Albert Heijn" }, "cat-groceries");

		expect(p.protectedNeutral).toHaveLength(0);
		expect(movingCount(p)).toBe(2);
	});
});

describe("rulePatches — what actually gets written", () => {
	const GROCERIES = "cat-groceries";
	const SHOPPING = "cat-shopping";
	const CATS: Category[] = [
		{ id: GROCERIES, name: "Groceries", color: "#000", icon: "tag", aliases: [] },
		{ id: SHOPPING, name: "Shopping", color: "#000", icon: "tag", aliases: [] },
	];
	const RULE = { id: "rule-1", categoryId: GROCERIES };

	function ledger(): Transaction[] {
		return [
			tx("Albert Heijn 1", SHOPPING), // moves
			tx("Albert Heijn 2", SHOPPING), // moves
			tx("Albert Heijn 3"), //           fills a blank
			tx("Albert Heijn 4", GROCERIES), // already correct
		];
	}

	it("writes every ticked row and stamps it with the rule", () => {
		const rows = ledger();
		const p = previewRule(storeOf(rows, CATS), { pattern: "Albert Heijn" }, GROCERIES);
		const patches = rulePatches(p, new Set(), RULE);

		expect(patches.size).toBe(4);
		for (const patch of patches.values()) {
			expect(patch).toEqual({ categoryId: GROCERIES, categoryRuleId: "rule-1" });
		}
	});

	it("writes nothing for an unticked row — not the category, and not the stamp", () => {
		// A row the rule was told to skip must not end up wearing the rule's badge.
		const rows = ledger();
		const p = previewRule(storeOf(rows, CATS), { pattern: "Albert Heijn" }, GROCERIES);
		const skipped = changedByPreview(p)[0];
		const patches = rulePatches(p, new Set([skipped.id]), RULE);

		expect(patches.has(skipped.id)).toBe(false);
		expect(patches.size).toBe(3);
	});

	it("still stamps rows that were already filed correctly", () => {
		const rows = ledger();
		const p = previewRule(storeOf(rows, CATS), { pattern: "Albert Heijn" }, GROCERIES);
		const patches = rulePatches(p, new Set(), RULE);

		const already = p.alreadyCorrect[0];
		expect(patches.get(already.id)).toEqual({ categoryId: GROCERIES, categoryRuleId: "rule-1" });
	});

	it("is a no-op for a row this same rule already stamped", () => {
		// Re-confirming an unchanged rule shouldn't rewrite every ledger file it touches.
		const rows = ledger();
		rows[3].categoryRuleId = "rule-1";
		const p = previewRule(storeOf(rows, CATS), { pattern: "Albert Heijn" }, GROCERIES);
		const patches = rulePatches(p, new Set(), RULE);

		expect(patches.has(rows[3].id)).toBe(false);
	});

	it("writes nothing at all when every row is unticked", () => {
		const rows = [tx("Albert Heijn 1", SHOPPING), tx("Albert Heijn 2", SHOPPING)];
		const p = previewRule(storeOf(rows, CATS), { pattern: "Albert Heijn" }, GROCERIES);
		const patches = rulePatches(p, new Set(rows.map((t) => t.id)), RULE);

		expect(patches.size).toBe(0);
	});

	it("never writes a protected transfer unless it was opted in", () => {
		const TRANSFERS = "cat-transfers";
		const cats: Category[] = [...CATS, { id: TRANSFERS, name: "Transfers", color: "#000", icon: "repeat", aliases: [] }];
		const topUp = tx("Albert Heijn Pay top-up", TRANSFERS);
		topUp.amount = 50;
		const rows = [tx("Albert Heijn 1", SHOPPING), topUp];

		const held = previewRule(storeOf(rows, cats), { pattern: "Albert Heijn" }, GROCERIES);
		expect(rulePatches(held, new Set(), RULE).has(topUp.id)).toBe(false);

		const optedIn = previewRule(storeOf(rows, cats), { pattern: "Albert Heijn" }, GROCERIES, { includeNeutral: true });
		expect(rulePatches(optedIn, new Set(), RULE).has(topUp.id)).toBe(true);
	});
});

describe("seedRuleFor — the mode the dialog opens on", () => {
	it("starts exact when the description IS the merchant", () => {
		// The Apple case: 201 rows described "Apple", 2 described "Apple Store", in the same category
		// today but not necessarily tomorrow. Exact is the only mode that can tell them apart.
		expect(seedRuleFor({ description: "Apple" })).toEqual({ pattern: "Apple", match: "exact" });
		expect(seedRuleFor({ description: "Apple Store" })).toEqual({ pattern: "Apple Store", match: "exact" });
		expect(seedRuleFor({ description: "apple.com/bill" })).toEqual({ pattern: "apple.com/bill", match: "exact" });
		expect(seedRuleFor({ description: "ONLY&SONS" })).toEqual({ pattern: "ONLY&SONS", match: "exact" });
	});

	it("starts with starts-with when the seed was cut back from a longer description", () => {
		// Exact would match nothing here, and one rule has to cover every branch.
		expect(seedRuleFor({ description: "ALBERT HEIJN 1423 DEN HAAG" })).toEqual({ pattern: "ALBERT HEIJN", match: "starts-with" });
		expect(seedRuleFor({ description: "Bck Barbershop 040" })).toEqual({ pattern: "Bck Barbershop", match: "starts-with" });
	});

	it("reads the counterparty when that is where the merchant lives", () => {
		expect(seedRuleFor({ description: "Card payment", counterparty: "Bck Barbershop 040" })).toEqual({
			pattern: "Bck Barbershop",
			match: "starts-with",
		});
	});

	it("always produces a rule that matches the row it came from", () => {
		for (const row of [
			{ description: "Apple" },
			{ description: "Apple Store" },
			{ description: "ALBERT HEIJN 1423 DEN HAAG" },
			{ description: "H&M 0123 AMSTERDAM" },
			{ description: "APPLE.COM/BILL" },
			{ description: "998877665544" },
			{ description: "Card payment", counterparty: "Bck Barbershop 040" },
		]) {
			const seeded = seedRuleFor(row);
			expect(previewRule(storeOf([{ ...tx(row.description), ...row }]), seeded, "cat-x").total).toBe(1);
		}
	});
});

describe("previewRule — telling Apple from Apple Store", () => {
	const ELECTRONICS = "cat-electronics";
	const SUBS = "cat-subs";
	const CATS: Category[] = [
		{ id: ELECTRONICS, name: "Electronics", color: "#000", icon: "tag", aliases: [] },
		{ id: SUBS, name: "Subscriptions", color: "#000", icon: "tag", aliases: [] },
	];

	/** The real shape of the ledger, scaled down. */
	function appleLedger(): Transaction[] {
		return [
			tx("Apple", ELECTRONICS),
			tx("Apple", ELECTRONICS),
			tx("Apple Store", ELECTRONICS),
			tx("apple.com/bill", SUBS),
		];
	}

	it("exact reaches the plain Apple rows and nothing else", () => {
		const p = previewRule(storeOf(appleLedger(), CATS), { pattern: "Apple", match: "exact" }, ELECTRONICS);
		expect(p.total).toBe(2);
		expect(p.alreadyCorrect).toHaveLength(2);
	});

	it("exact lets Apple Store be filed somewhere else entirely", () => {
		const rows = appleLedger();
		const p = previewRule(storeOf(rows, CATS), { pattern: "Apple Store", match: "exact" }, SUBS);
		expect(p.total).toBe(1);
		expect(changedByPreview(p)[0].description).toBe("Apple Store");
	});

	it("contains still sweeps up all four, which is why it is no longer the default", () => {
		const p = previewRule(storeOf(appleLedger(), CATS), { pattern: "Apple", match: "contains" }, ELECTRONICS);
		expect(p.total).toBe(4);
	});
});

describe("amountGroups — the structure inside one merchant", () => {
	function charge(amount: number, date: string): Transaction {
		n++;
		return { id: `t-${n}`, date, accountId: "acc", description: "Apple", amount, currency: "EUR", source: "manual" };
	}

	/** A monthly 9.99 subscription plus a handful of one-off purchases, all described "Apple". */
	function ledger(): Transaction[] {
		const subs = ["2026-01-24", "2026-02-24", "2026-03-24", "2026-04-24"].map((d) => charge(-9.99, d));
		return [...subs, charge(-29.99, "2026-02-14"), charge(-3.49, "2026-03-19"), charge(-9.99, "2026-05-24")];
	}

	it("groups by amount, commonest first", () => {
		const groups = amountGroups(ledger());
		expect(groups[0].value).toBe(9.99);
		expect(groups[0].count).toBe(5);
		expect(groups.map((g) => g.value)).toEqual([9.99, 29.99, 3.49]);
	});

	it("reports the cadence that makes a subscription recognisable", () => {
		const groups = amountGroups(ledger());
		expect(groups[0].months).toBe(5);
		expect(groups[0].medianGapDays).toBeGreaterThanOrEqual(28);
		expect(groups[0].medianGapDays).toBeLessThanOrEqual(32);
	});

	it("reports no cadence below three charges — two points are a gap, not a rhythm", () => {
		const groups = amountGroups(ledger());
		expect(groups.find((g) => g.value === 29.99)?.medianGapDays).toBeUndefined();
	});

	it("treats a refund as the same amount as the charge", () => {
		const groups = amountGroups([charge(-9.99, "2026-01-01"), charge(9.99, "2026-02-01")]);
		expect(groups).toHaveLength(1);
		expect(groups[0].count).toBe(2);
	});

	it("keeps different currencies apart", () => {
		const eur = charge(-9.99, "2026-01-01");
		const usd = { ...charge(-9.99, "2026-02-01"), currency: "USD" };
		expect(amountGroups([eur, usd])).toHaveLength(2);
	});

	it("survives rows with no date", () => {
		const undated = { ...charge(-9.99, "2026-01-01"), date: "" };
		expect(() => amountGroups([undated])).not.toThrow();
		expect(amountGroups([undated])[0].count).toBe(1);
	});

	it("honours an explicit limit", () => {
		const many = Array.from({ length: 20 }, (_, i) => charge(-(i + 1), "2026-01-01"));
		expect(amountGroups(many, 5)).toHaveLength(5);
	});

	it("returns every distinct amount by default", () => {
		// The caller decides how many to show, because only it knows which are already picked — and a
		// picked amount truncated out of the list is one the user can no longer un-pick.
		const many = Array.from({ length: 20 }, (_, i) => charge(-(i + 1), "2026-01-01"));
		expect(amountGroups(many)).toHaveLength(20);
	});
});

describe("previewRule with an amount condition", () => {
	const DIGITAL = "cat-digital";
	const ELEC = "cat-elec";
	const CATS: Category[] = [
		{ id: DIGITAL, name: "Digital & IT", color: "#000", icon: "tag", aliases: [] },
		{ id: ELEC, name: "Electronics", color: "#000", icon: "tag", aliases: [] },
	];

	function appleRows(): Transaction[] {
		const rows = [tx("Apple", ELEC), tx("Apple", ELEC), tx("Apple", ELEC), tx("Apple", ELEC)];
		rows[0].amount = -9.99;
		rows[1].amount = -9.99;
		rows[2].amount = -29.99;
		rows[3].amount = -3.49;
		return rows;
	}

	it("narrows an identical-description merchant down to one price point", () => {
		const p = previewRule(
			storeOf(appleRows(), CATS),
			{ pattern: "Apple", match: "exact", amount: { op: "exactly", value: 9.99 } },
			DIGITAL
		);
		expect(p.total).toBe(2);
		expect(changedByPreview(p)).toHaveLength(2);
	});

	it("without the condition it takes the whole merchant", () => {
		const p = previewRule(storeOf(appleRows(), CATS), { pattern: "Apple", match: "exact" }, DIGITAL);
		expect(p.total).toBe(4);
	});

	it("a range catches the small purchases and leaves the big one", () => {
		const p = previewRule(
			storeOf(appleRows(), CATS),
			{ pattern: "Apple", match: "exact", amount: { op: "at-most", value: 10 } },
			DIGITAL
		);
		expect(p.total).toBe(3);
	});
});

describe("staleStampPatches — editing a rule narrower", () => {
	const SOFTWARE = "cat-software";
	const RULE: CategoryRule = {
		id: "rule-1",
		pattern: "Apple",
		match: "exact",
		categoryId: SOFTWARE,
		amount: { op: "any-of", value: 2.99, values: [2.99, 5.99] },
	};

	function stamped(amount: number, ruleId?: string): Transaction {
		const t = tx("Apple", SOFTWARE);
		t.amount = amount;
		t.categoryRuleId = ruleId;
		return t;
	}

	it("unstamps a row the narrowed rule no longer reaches", () => {
		// The €5.99 charges were dropped from the rule's set; their badge would otherwise keep claiming
		// a rule governs them when it no longer does.
		const rows = [stamped(-2.99, "rule-1"), stamped(-5.99, "rule-1")];
		const narrowed: CategoryRule = { ...RULE, amount: { op: "any-of", value: 2.99, values: [2.99] } };
		const patches = staleStampPatches(rows, narrowed);

		expect(patches.size).toBe(1);
		expect(patches.get(rows[1].id)).toEqual({ categoryRuleId: undefined });
	});

	it("never touches the category, only the stamp", () => {
		const rows = [stamped(-5.99, "rule-1")];
		const narrowed: CategoryRule = { ...RULE, amount: { op: "any-of", value: 2.99, values: [2.99] } };
		const patch = staleStampPatches(rows, narrowed).get(rows[0].id)!;

		expect("categoryId" in patch).toBe(false);
		expect(Object.keys(patch)).toEqual(["categoryRuleId"]);
	});

	it("leaves rows the rule still matches alone", () => {
		const rows = [stamped(-2.99, "rule-1"), stamped(-5.99, "rule-1")];
		expect(staleStampPatches(rows, RULE).size).toBe(0);
	});

	it("ignores rows stamped by a different rule", () => {
		const rows = [stamped(-29.99, "rule-other"), stamped(-29.99, undefined)];
		expect(staleStampPatches(rows, RULE).size).toBe(0);
	});

	it("unstamps when the pattern itself stops matching", () => {
		const rows = [stamped(-2.99, "rule-1")];
		const renamed: CategoryRule = { ...RULE, pattern: "Spotify" };
		expect(staleStampPatches(rows, renamed).size).toBe(1);
	});

	it("unstamps when the mode is tightened from contains to exact", () => {
		const row = tx("Apple Store", SOFTWARE);
		row.amount = -2.99;
		row.categoryRuleId = "rule-1";
		const tightened: CategoryRule = { ...RULE, match: "exact" };
		expect(staleStampPatches([row], tightened).size).toBe(1);
		expect(staleStampPatches([row], { ...RULE, match: "contains" }).size).toBe(0);
	});
});

describe("describeRuleScope", () => {
	const money = (v: number): string => `\u20ac${v.toFixed(2)}`;

	it("names a single amount rather than counting it", () => {
		// "exact match, 1 amount" told you how many there were and not which.
		expect(describeRuleScope({ match: "exact", amount: { op: "any-of", value: 0.99, values: [0.99] } }, money)).toBe(
			"exact match, \u20ac0.99"
		);
		expect(describeRuleScope({ match: "exact", amount: { op: "exactly", value: 9.99 } }, money)).toBe("exact match, \u20ac9.99");
	});

	it("lists a small set", () => {
		expect(describeRuleScope({ match: "exact", amount: { op: "any-of", value: 2.99, values: [2.99, 5.99] } }, money)).toBe(
			"exact match, \u20ac2.99 / \u20ac5.99"
		);
	});

	it("describes ranges and bounds", () => {
		expect(describeRuleScope({ match: "contains", amount: { op: "at-most", value: 5 } }, money)).toBe("contains, \u2264 \u20ac5.00");
		expect(describeRuleScope({ match: "contains", amount: { op: "at-least", value: 5 } }, money)).toBe("contains, \u2265 \u20ac5.00");
		expect(describeRuleScope({ match: "contains", amount: { op: "between", value: 10, value2: 1 } }, money)).toBe(
			"contains, \u20ac1.00\u2013\u20ac10.00"
		);
	});

	it("says only the mode when there is no amount filter", () => {
		expect(describeRuleScope({ match: "starts-with" }, money)).toBe("starts with");
		expect(describeRuleScope({}, money)).toBe("contains");
		expect(describeRuleScope({ isRegex: true }, money)).toBe("regex");
	});
});
