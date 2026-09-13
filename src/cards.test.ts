import { afterEach, describe, expect, it, vi } from "vitest";
import { cardExpiresWithinMonths, cardExpiryDate, cardIsExpired, cardsForAccount, cardStyle, monthsUntil } from "./cards";
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

	it("recognizes Dutch retail banks by issuer name", () => {
		const ing = cardStyle(card({ name: "Betaalpas", issuer: "ING", network: "mastercard" }));
		const generic = cardStyle(card({ name: "Betaalpas", issuer: undefined, network: "mastercard" }));
		expect(ing).not.toEqual(generic);
	});

	it("doesn't false-match a bank keyword found inside an unrelated word", () => {
		// "ing" is only meant to catch ING as its own word — a naive substring match would also catch
		// it inside "Morning" (or "Checking", "Savings", ...), matching an issuer nobody named.
		const morning = cardStyle(card({ name: "Morning Card", issuer: undefined, network: "visa" }));
		const generic = cardStyle(card({ name: "Something else", issuer: undefined, network: "visa" }));
		expect(morning).toEqual(generic);
	});
});

describe("card expiry", () => {
	it("has no expiry date without both a month and a year", () => {
		expect(cardExpiryDate(card({ expiryMonth: 6, expiryYear: undefined }))).toBeUndefined();
	});

	it("treats a card as expired once its month has fully passed", () => {
		const lastMonth = new Date();
		lastMonth.setMonth(lastMonth.getMonth() - 2);
		const past = card({ expiryMonth: lastMonth.getMonth() + 1, expiryYear: lastMonth.getFullYear() });
		expect(cardIsExpired(past)).toBe(true);
	});

	// The instant-comparison bug this guards only ever showed itself on the last day of a month, so
	// the relative-date tests above sailed past it on 30 days out of 31. Pin the clock instead.
	describe("on the last day of the printed expiry month", () => {
		afterEach(() => vi.useRealTimers());

		it("is still valid at one second past midnight", () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date(2026, 7, 31, 0, 0, 1));
			expect(cardIsExpired(card({ expiryMonth: 8, expiryYear: 2026 }))).toBe(false);
		});

		it("is still valid at the last second of that day", () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date(2026, 7, 31, 23, 59, 59));
			expect(cardIsExpired(card({ expiryMonth: 8, expiryYear: 2026 }))).toBe(false);
		});

		it("is expired once the next month starts", () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date(2026, 8, 1, 0, 0, 0));
			expect(cardIsExpired(card({ expiryMonth: 8, expiryYear: 2026 }))).toBe(true);
		});

		it("treats a December expiry as valid through 31 December", () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date(2026, 11, 31, 12, 0, 0));
			expect(cardIsExpired(card({ expiryMonth: 12, expiryYear: 2026 }))).toBe(false);
			vi.setSystemTime(new Date(2027, 0, 1, 0, 0, 0));
			expect(cardIsExpired(card({ expiryMonth: 12, expiryYear: 2026 }))).toBe(true);
		});
	});

	it("is not expired for the current or a future month", () => {
		const now = new Date();
		const current = card({ expiryMonth: now.getMonth() + 1, expiryYear: now.getFullYear() });
		expect(cardIsExpired(current)).toBe(false);
	});

	it("flags a card expiring within the given window, but not one further out", () => {
		const soon = new Date();
		soon.setMonth(soon.getMonth() + 2);
		const far = new Date();
		far.setMonth(far.getMonth() + 8);

		expect(cardExpiresWithinMonths(card({ expiryMonth: soon.getMonth() + 1, expiryYear: soon.getFullYear() }), 3)).toBe(true);
		expect(cardExpiresWithinMonths(card({ expiryMonth: far.getMonth() + 1, expiryYear: far.getFullYear() }), 3)).toBe(false);
	});

	it("doesn't call an already-expired card 'expiring soon'", () => {
		const lastMonth = new Date();
		lastMonth.setMonth(lastMonth.getMonth() - 2);
		const past = card({ expiryMonth: lastMonth.getMonth() + 1, expiryYear: lastMonth.getFullYear() });
		expect(cardExpiresWithinMonths(past, 3)).toBe(false);
	});

	it("counts whole months from now to a future date", () => {
		const now = new Date();
		const inThreeMonths = new Date(now.getFullYear(), now.getMonth() + 3, 1);
		expect(monthsUntil(inThreeMonths)).toBe(3);
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
