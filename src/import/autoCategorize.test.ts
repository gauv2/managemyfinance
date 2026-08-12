import { describe, it, expect } from "vitest";
import { defaultCategories, defaultSecondaryCategories } from "../constants";
import { autoCategorize, buildDefaultRules, effectiveRules } from "./autoCategorize";
import type { Category, CategoryRule, Transaction } from "../types";

const categories = defaultCategories();

function nameOf(categoryId: string | undefined): string | undefined {
	return categories.find((c) => c.id === categoryId)?.name;
}

let nextId = 0;
function tx(description: string, extra: Partial<Transaction> = {}): Transaction {
	nextId++;
	return {
		id: `tx-${nextId}`,
		date: "2026-01-08",
		accountId: "acc-1",
		description,
		amount: -10,
		currency: "EUR",
		source: "ing",
		...extra,
	};
}

/** Runs the shipped rules the way the import wizard now does, and returns the resulting category name. */
function categorize(description: string, extra: Partial<Transaction> = {}): string | undefined {
	const t = tx(description, extra);
	const { patches } = autoCategorize([t], categories, effectiveRules(categories, []));
	return nameOf(patches.get(t.id));
}

describe("the merchants a real import actually contains", () => {
	// Every one of these came back "Uncategorized" before, because the import wizard only ever
	// consulted the user's own (empty) rules.json and never the shipped list.
	const cases: [string, string][] = [
		["Ring", "Shopping"],
		["Bambu Lab", "Shopping"],
		["Sharesub", "Bills & Utilities"],
		["Google One", "Bills & Utilities"],
		["Patreon", "Entertainment"],
		["NETFLIX.COM", "Entertainment"],
		["Spotify AB", "Entertainment"],
		["Adobe Systems Software", "Bills & Utilities"],
		["OpenAI *ChatGPT Subscr", "Bills & Utilities"],
		["Basic-Fit Nederland BV", "Health & Fitness"],
		["Vodafone Libertel", "Bills & Utilities"],
		["Eneco Services", "Bills & Utilities"],
		["Uber BV", "Auto & Transport"],
		["Picnic Online Supermarkt", "Food"],
		["Geldmaat Den Haag", "Cash/ATM"],
	];

	for (const [description, expected] of cases) {
		it(`categorizes "${description}" as ${expected}`, () => {
			expect(categorize(description)).toBe(expected);
		});
	}
});

describe("word-boundary rules", () => {
	// The reason `word: true` exists: a plain substring rule for "ring" claims a third of any Dutch
	// ledger. Mis-categorizing is worse than leaving a row for the review queue.
	it("does not let short merchant names match inside ordinary Dutch words", () => {
		expect(categorize("Autoverzekering premie")).not.toBe("Shopping");
		expect(categorize("Parkering centrum")).not.toBe("Shopping");
		expect(categorize("Financiering aanvraag")).not.toBe("Shopping");
	});

	it("still matches the merchant itself, in any casing and with surrounding text", () => {
		expect(categorize("Ring")).toBe("Shopping");
		expect(categorize("RING PROTECT PLUS")).toBe("Shopping");
		expect(categorize("Betaalautomaat Ring.com")).toBe("Shopping");
	});

	it("routes an insurance description to Insurance rather than to a short-name rule", () => {
		expect(categorize("Autoverzekering premie")).toBe("Insurance");
	});
});

describe("effectiveRules", () => {
	it("puts the user's own rules ahead of the shipped ones, so they win on the same merchant", () => {
		const business = categories.find((c) => c.name === "Business")!;
		const mine: CategoryRule[] = [{ id: "mine", pattern: "adobe", categoryId: business.id }];
		const t = tx("Adobe Systems Software");
		const { patches } = autoCategorize([t], categories, effectiveRules(categories, mine));
		expect(nameOf(patches.get(t.id))).toBe("Business");
	});

	it("falls back to the shipped rule when the user has none for that merchant", () => {
		const mine: CategoryRule[] = [{ id: "mine", pattern: "something else", categoryId: "cat-0" }];
		const t = tx("Spotify AB");
		const { patches } = autoCategorize([t], categories, effectiveRules(categories, mine));
		expect(nameOf(patches.get(t.id))).toBe("Entertainment");
	});
});

describe("autoCategorize", () => {
	it("uses the bank's own type column for the unambiguous cases", () => {
		expect(categorize("Some ATM somewhere", { type: "Withdrawal" })).toBe("Cash/ATM");
		expect(categorize("Rente", { type: "Interest" })).toBe("Income");
	});

	it("leaves an unrecognized merchant alone rather than guessing", () => {
		expect(categorize("Innoboonint In")).toBeUndefined();
		expect(categorize("Vats Prague Group")).toBeUndefined();
	});

	it("never overwrites a category a transaction already has", () => {
		const food = categories.find((c) => c.name === "Food")!;
		const t = tx("NETFLIX.COM", { categoryId: food.id });
		const { patches } = autoCategorize([t], categories, effectiveRules(categories, []));
		expect(patches.has(t.id)).toBe(false);
	});

	it("matches against the counterparty as well as the description", () => {
		expect(categorize("Card payment", { counterparty: "SPOTIFY AB" })).toBe("Entertainment");
	});
});

describe("buildDefaultRules", () => {
	it("skips rules whose category the portfolio doesn't have", () => {
		const onlyFood: Category[] = [{ id: "c-food", name: "Food", color: "#000", icon: "utensils", aliases: [] }];
		const rules = buildDefaultRules(onlyFood);
		expect(rules.length).toBeGreaterThan(0);
		expect(rules.every((r) => r.categoryId === "c-food")).toBe(true);
	});

	it("emits every word-boundary rule as a valid, compilable regex", () => {
		for (const rule of buildDefaultRules(categories).filter((r) => r.isRegex)) {
			expect(() => new RegExp(rule.pattern, "i")).not.toThrow();
		}
	});
});

describe("subcategory rule targets", () => {
	// A real portfolio has the seeded secondaries too; `categories` above deliberately doesn't, which
	// is what the fallback test below exercises.
	const withSubs = [...defaultCategories(), ...defaultSecondaryCategories(defaultCategories())];
	const leaf = (description: string): string | undefined => {
		const t = tx(description);
		const { patches } = autoCategorize([t], withSubs, effectiveRules(withSubs, []));
		return withSubs.find((c) => c.id === patches.get(t.id))?.name;
	};

	it("lands on the leaf when a rule names one", () => {
		expect(leaf("Albert Heijn 1423")).toBe("Groceries");
		expect(leaf("Shell Rotterdam")).toBe("Fuel");
		expect(leaf("NETFLIX.COM")).toBe("Movies & Streaming");
		expect(leaf("Basic-Fit Nederland BV")).toBe("Gym");
		expect(leaf("Vodafone Libertel")).toBe("Internet & Phone");
	});

	it("falls back to the primary when the portfolio has no such subcategory", () => {
		// Deleting a subcategory should degrade the rule, never silently disable it.
		expect(categorize("Albert Heijn 1423")).toBe("Food");
		expect(categorize("Shell Rotterdam")).toBe("Auto & Transport");
	});
});
