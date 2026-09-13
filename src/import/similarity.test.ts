import { describe, expect, it } from "vitest";
import { comparableText, findMatches, hasMatches, similarity } from "./similarity";
import type { Transaction } from "../types";

let counter = 0;
function tx(description: string, over: Partial<Transaction> = {}): Transaction {
	counter++;
	return {
		id: `t${counter}`,
		date: "2025-03-0" + ((counter % 9) + 1),
		accountId: "acc",
		description,
		amount: -10,
		currency: "EUR",
		source: "manual",
		...over,
	} as Transaction;
}

describe("similarity", () => {
	it("scores identical cleaned text as 1", () => {
		expect(similarity("albert heijn", "albert heijn")).toBe(1);
	});

	it("scores disjoint text at 0-ish", () => {
		expect(similarity("albert heijn", "zwembad")).toBeLessThan(0.3);
	});

	it("sees through punctuation differences the tokenizer splits on", () => {
		// Word overlap fails here (t-mobile is one token, "t mobile" is two); trigrams carry it.
		expect(similarity("t mobile nl", "t-mobile netherlands")).toBeGreaterThan(0.55);
	});

	it("sees a shared name behind a trailing branch or city", () => {
		// Trigram overlap is diluted by the tail; word overlap carries it.
		expect(similarity("albert heijn den haag centraal", "albert heijn")).toBeGreaterThan(0.55);
	});

	it("is symmetric", () => {
		expect(similarity("shell station", "shell")).toBe(similarity("shell", "shell station"));
	});

	it("treats empty text as matching nothing, including other empty text", () => {
		expect(similarity("", "")).toBe(0);
		expect(similarity("albert heijn", "")).toBe(0);
	});
});

describe("comparableText", () => {
	it("cleans bank noise off the description", () => {
		expect(comparableText({ description: "CCV*ALBERT HEIJN 1423 DEN HAAG" })).toContain("albert heijn");
	});

	it("falls back to the counterparty when there is no description", () => {
		expect(comparableText({ description: "", counterparty: "Jumbo Supermarkten" })).toBe("jumbo supermarkten");
	});
});

describe("findMatches — the exact tier", () => {
	it("groups every form of the same merchant under sameMerchant", () => {
		const subject = tx("CCV*ALBERT HEIJN 1423");
		const rows = [subject, tx("Albert Heijn 5566, Amsterdam"), tx("BEA, Betaalpas ALBERT HEIJN"), tx("Jumbo Utrecht")];
		const groups = findMatches(rows, subject);

		expect(groups.sameMerchant.map((t) => t.description).sort()).toEqual([
			"Albert Heijn 5566, Amsterdam",
			"BEA, Betaalpas ALBERT HEIJN",
		]);
	});

	it("leaves a branch-suffixed variant to the fuzzy tier rather than claiming it", () => {
		// merchantKey caps at five tokens, so a trailing city is part of the key: "albert heijn den
		// haag" is deliberately NOT "albert heijn". That conservatism is the point — the pair still
		// surfaces, but as a guess the user ticks, not as a fact acted on for them.
		const subject = tx("ALBERT HEIJN DEN HAAG");
		const groups = findMatches([subject, tx("Albert Heijn")], subject);
		expect(groups.sameMerchant).toHaveLength(0);
		expect(groups.similar.map((m) => m.tx.description)).toEqual(["Albert Heijn"]);
	});

	it("never returns the subject transaction itself", () => {
		const subject = tx("Albert Heijn");
		const groups = findMatches([subject, tx("Albert Heijn")], subject);
		expect(groups.sameMerchant.every((t) => t.id !== subject.id)).toBe(true);
		expect(groups.sameMerchant).toHaveLength(1);
	});

	it("puts a row in the exact tier or the fuzzy tier, never both", () => {
		const subject = tx("Albert Heijn");
		const groups = findMatches([subject, tx("Albert Heijn Den Haag")], subject);
		const exactIds = new Set(groups.sameMerchant.map((t) => t.id));
		expect(groups.similar.some((m) => exactIds.has(m.tx.id))).toBe(false);
	});
});

describe("findMatches — the fuzzy tier", () => {
	it("finds a payee the key logic deliberately keeps apart", () => {
		const subject = tx("T-Mobile NL");
		const groups = findMatches([subject, tx("T-Mobile Netherlands")], subject);
		expect(groups.sameMerchant).toHaveLength(0);
		expect(groups.similar.map((m) => m.tx.description)).toEqual(["T-Mobile Netherlands"]);
	});

	it("matches a name against itself plus a long branch suffix, which Dice alone under-scores", () => {
		const subject = tx("Albert Heijn");
		const groups = findMatches([subject, tx("Albert Heijn Den Haag Centraal Station")], subject);
		expect(groups.similar).toHaveLength(1);
	});

	it("does not let two short shared words merge different people", () => {
		// "Vo Ty" is four characters over two tokens — not distinctive enough to claim identity, which
		// is the whole reason containment is gated. These are different payees.
		const subject = tx("To Vo Ty Nguyen");
		const groups = findMatches([subject, tx("To Vo Ty Tran"), tx("To Vo Ty Le")], subject);
		expect(groups.similar.every((m) => m.score < 1)).toBe(true);
	});

	it("ranks the closest match first", () => {
		const subject = tx("Shell");
		const groups = findMatches([subject, tx("Shell Station Rotterdam Zuid"), tx("Shell Station")], subject, {
			threshold: 0.3,
		});
		expect(groups.similar[0].tx.description).toBe("Shell Station");
		expect(groups.similar[0].score).toBeGreaterThan(groups.similar[1].score);
	});

	it("respects the threshold", () => {
		// Two branches of one chain: they share only "shell", which is too short to be distinctive, so
		// containment stays out of it and the score is a partial one the threshold can actually move.
		const subject = tx("Shell Rotterdam");
		const rows = [subject, tx("Shell Amsterdam")];
		expect(findMatches(rows, subject, { threshold: 0.99 }).similar).toHaveLength(0);
		expect(findMatches(rows, subject, { threshold: 0.4 }).similar).toHaveLength(1);
	});

	it("never offers a genuinely different merchant, however low the threshold", () => {
		const subject = tx("Albert Heijn");
		expect(findMatches([subject, tx("Jumbo")], subject).similar).toHaveLength(0);
	});

	it("caps the fuzzy tier at the limit", () => {
		const subject = tx("Albert Heijn");
		const rows = [subject, ...Array.from({ length: 20 }, (_, i) => tx(`Albert Heijn Filiaal ${i} Locatie`))];
		expect(findMatches(rows, subject, { threshold: 0.3, limit: 5 }).similar).toHaveLength(5);
	});

	it("does not drag in unnameable rows when the subject has no name either", () => {
		// Both reduce to nothing. Grouping every unreadable row together is exactly the failure
		// merchantKey() returns undefined to avoid, and the fuzzy tier must not reintroduce it.
		const subject = tx("4738291047");
		const groups = findMatches([subject, tx("9182736450"), tx("00000")], subject, { threshold: 0.01 });
		expect(groups.key).toBeUndefined();
		expect(groups.similar).toHaveLength(0);
	});
});

describe("findMatches — filtering and reporting", () => {
	it("honours the eligibility filter", () => {
		const subject = tx("Albert Heijn");
		const rows = [subject, tx("Albert Heijn", { review: "approved" }), tx("Albert Heijn")];
		const groups = findMatches(rows, subject, { filter: (t) => (t.review ?? "new") !== "approved" });
		expect(groups.sameMerchant).toHaveLength(1);
	});

	it("hasMatches is false only when both tiers are empty", () => {
		const subject = tx("Albert Heijn");
		expect(hasMatches(findMatches([subject], subject))).toBe(false);
		expect(hasMatches(findMatches([subject, tx("Albert Heijn")], subject))).toBe(true);
	});
});

describe("a card payment is compared by shop, not by where the terminal stood", () => {
	function card(counterparty: string, description: string, amount: number): Transaction {
		return {
			id: `t-${counterparty}-${amount}`,
			date: "2019-07-18",
			accountId: "acc",
			description,
			counterparty,
			amount,
			currency: "EUR",
			source: "manual",
		};
	}

	it("does not call two different shops in one town the same", () => {
		// The descriptions differ only by timestamp, so comparing them scored every card payment made
		// in one town on one card as "100% alike" — 60 unrelated shops arrived pre-ticked under a fuel
		// transaction, and approving them would have filed the lot as Fuel.
		const fuel = card("Tango Capelle/IJ", "CAPELLE AAN D 18-07-2019 07:30 Pas: 4333", -76.39);
		const bakery = card("Bakkerij Vreugdenhil", "CAPELLE AAN D 14-04-2019 17:41 Pas: 4333", -3.5);
		expect(similarity(comparableText(fuel), comparableText(bakery))).toBeLessThan(0.5);
	});

	it("still calls the same shop the same", () => {
		const a = card("Tango Capelle/IJ", "CAPELLE AAN D 18-07-2019 07:30 Pas: 4333", -76.39);
		const b = card("Tango Capelle/IJ", "CAPELLE AAN D 11-07-2019 18:06 Pas: 4333", -78.04);
		expect(similarity(comparableText(a), comparableText(b))).toBe(1);
	});

	it("still reads the description where that is the merchant", () => {
		// The banks this was written for put the shop in the description and nothing beside it.
		const a = card("", "ALBERT HEIJN 1423 DEN HAAG", -12);
		const b = card("", "ALBERT HEIJN 0891 UTRECHT", -18);
		expect(similarity(comparableText(a), comparableText(b))).toBeGreaterThan(0.5);
	});
});
