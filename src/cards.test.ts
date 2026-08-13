import { describe, expect, it } from "vitest";
import { cardsForAccount, cardStyle } from "./cards";
import type { Card } from "./types";

function card(overrides: Partial<Card> = {}): Card {
	return { id: "c1", accountId: "acc-1", name: "Card", network: "visa", cardType: "credit", ...overrides };
}

/**
 * Card art is derived, never fetched — no logos, no network. These pin down that every card gets a
 * usable look, including the ones the tier lookup has never heard of.
 */
describe("cardStyle", () => {
	it("returns a complete style for a card it recognizes nothing about", () => {
		const style = cardStyle(card({ name: "Some card", product: undefined, issuer: undefined }));
		expect(style).toBeDefined();
		expect(Object.values(style).every((v) => v !== undefined && v !== "")).toBe(true);
	});

	it("gives two different tiers of the same network different looks", () => {
		const platinum = cardStyle(card({ name: "Amex Platinum", product: "Platinum", network: "amex" }));
		const green = cardStyle(card({ name: "Amex Green", product: "Green", network: "amex" }));
		expect(platinum).not.toEqual(green);
	});

	it("reads the tier out of the card's own name when no product is set", () => {
		const fromName = cardStyle(card({ name: "My Platinum card", network: "amex" }));
		const fromProduct = cardStyle(card({ name: "Whatever", product: "Platinum", network: "amex" }));
		expect(fromName).toEqual(fromProduct);
	});

	it("is stable — the same card always renders the same way", () => {
		const c = card({ name: "Sapphire Reserve", network: "visa" });
		expect(cardStyle(c)).toEqual(cardStyle({ ...c }));
	});
});

describe("cardsForAccount", () => {
	it("returns only that account's cards", () => {
		const cards = [card({ id: "a", accountId: "acc-1" }), card({ id: "b", accountId: "acc-2" }), card({ id: "c", accountId: "acc-1" })];
		expect(cardsForAccount(cards, "acc-1").map((c) => c.id)).toEqual(["a", "c"]);
	});

	it("returns nothing for an account with no cards — a CD or a pension has none", () => {
		expect(cardsForAccount([card({ accountId: "acc-1" })], "acc-9")).toEqual([]);
	});
});
