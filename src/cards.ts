import type { Card, CardNetwork, CardType } from "./types";

export const CARD_NETWORKS: CardNetwork[] = ["visa", "mastercard", "amex", "discover", "vpay", "other"];
export const CARD_NETWORK_LABEL: Record<CardNetwork, string> = {
	visa: "Visa",
	mastercard: "Mastercard",
	amex: "American Express",
	discover: "Discover",
	vpay: "V PAY",
	other: "Other",
};

export const CARD_TYPES: CardType[] = ["debit", "credit", "prepaid", "secured", "charge"];
export const CARD_TYPE_LABEL: Record<CardType, string> = {
	debit: "Debit",
	credit: "Credit",
	prepaid: "Prepaid",
	secured: "Secured credit",
	charge: "Charge",
};

export interface CardStyle {
	gradient: string;
	textColor: string;
	/** Loose "is this a light-faced card" flag, so callers can adapt chip/shine treatment too — derived from textColor, not hardcoded per rule. */
	isLight: boolean;
}

type StyleRule = { match: RegExp; gradient: string; text: string };

/**
 * Tier keywords (checked against the card's product/name/issuer) drive the visual, not an exact
 * issuer lookup table — so "Amex Platinum" and "Chase Sapphire Reserve" both read as recognizably
 * *their* tier without us reproducing any bank's actual trademarked card artwork. Ordered most-
 * specific first since the first match wins.
 */
const TIER_RULES: StyleRule[] = [
	{ match: /centurion|\bblack card\b|\bblack\b/i, gradient: "linear-gradient(135deg, #17181a, #3a3b3e 45%, #131314 80%)", text: "#f4f4f5" },
	{ match: /platinum/i, gradient: "linear-gradient(135deg, #8b95a1, #e8edf1 40%, #b6bfc7 65%, #737d87)", text: "#1c1c1e" },
	{ match: /venture ?x/i, gradient: "linear-gradient(135deg, #0b1520, #1f3a52 50%, #091018)", text: "#f4f4f5" },
	{ match: /reserve|infinite|world elite|prestige/i, gradient: "linear-gradient(135deg, #211a38, #4a2e6b 55%, #180f2b)", text: "#f4f4f5" },
	{ match: /signature/i, gradient: "linear-gradient(135deg, #1f2937, #3b4a63 55%, #171e2b)", text: "#f4f4f5" },
	{ match: /\bgold\b/i, gradient: "linear-gradient(135deg, #a8783a, #f3d999 42%, #dba956 68%, #8f6425)", text: "#241a05" },
	{ match: /\bgreen\b/i, gradient: "linear-gradient(135deg, #0e3b2e, #2f6e57 55%, #0a2a21)", text: "#f4f4f5" },
	{ match: /sapphire|\bpreferred\b/i, gradient: "linear-gradient(135deg, #123a6b, #2a6cc4 55%, #0f2e56)", text: "#f4f4f5" },
	{ match: /quicksilver/i, gradient: "linear-gradient(135deg, #8d8f92, #d7dadd 45%, #a3a6aa 70%, #6d6f72)", text: "#1c1c1e" },
	{ match: /venture/i, gradient: "linear-gradient(135deg, #14324a, #2f6690 55%, #0f2436)", text: "#f4f4f5" },
	{ match: /savor/i, gradient: "linear-gradient(135deg, #451a1f, #8a2f38 55%, #34141a)", text: "#f4f4f5" },
	{ match: /freedom|\bflex\b/i, gradient: "linear-gradient(135deg, #0e5fc0, #4fa3f7 55%, #0a4790)", text: "#f4f4f5" },
	{ match: /double cash/i, gradient: "linear-gradient(135deg, #1c4f8a, #6b93c2 55%, #14395f)", text: "#f4f4f5" },
	{ match: /blue cash|everyday/i, gradient: "linear-gradient(135deg, #0a4f7a, #1f8fc4 55%, #073a5a)", text: "#f4f4f5" },
	{ match: /business|corporate/i, gradient: "linear-gradient(135deg, #292b30, #52565e 55%, #1e1f22)", text: "#f4f4f5" },
	{ match: /secured/i, gradient: "linear-gradient(135deg, #4b5563, #7b8794)", text: "#f4f4f5" },
	{ match: /prepaid/i, gradient: "linear-gradient(135deg, #0f766e, #2dd4bf 60%, #0b5c56)", text: "#f4f4f5" },
];

/**
 * Issuer-recognizable palettes, checked only when no tier keyword matched — so e.g. a Chase or
 * Wells Fargo card that doesn't name a specific product tier still reads as *that bank's* card
 * rather than a generic network color.
 */
const ISSUER_RULES: StyleRule[] = [
	{ match: /chase/i, gradient: "linear-gradient(135deg, #0a3d7a, #1f6fd6 55%, #072c58)", text: "#f4f4f5" },
	{ match: /capital ?one/i, gradient: "linear-gradient(135deg, #7a0d1c, #c4102b 55%, #4a0812)", text: "#f4f4f5" },
	{ match: /citi(?:bank)?\b/i, gradient: "linear-gradient(135deg, #0060a9, #4fa8dd 55%, #003f73)", text: "#f4f4f5" },
	{ match: /bank of america|\bbofa\b/i, gradient: "linear-gradient(135deg, #6e0f1f, #c41230 55%, #3f0a15)", text: "#f4f4f5" },
	{ match: /wells fargo/i, gradient: "linear-gradient(135deg, #7a1723, #b02a2a 45%, #a8781f 100%)", text: "#f4f4f5" },
	{ match: /hsbc/i, gradient: "linear-gradient(135deg, #6b1518, #a3181c 55%, #450e10)", text: "#f4f4f5" },
	{ match: /barclays/i, gradient: "linear-gradient(135deg, #00284d, #0060a3 55%, #001a33)", text: "#f4f4f5" },
	{ match: /u\.?s\.? ?bank/i, gradient: "linear-gradient(135deg, #0c2340, #1c4f8a 55%, #081729)", text: "#f4f4f5" },
	{ match: /\bpnc\b/i, gradient: "linear-gradient(135deg, #c05a15, #e8934a 55%, #8a3e0c)", text: "#241a05" },
	{ match: /\btd bank\b|\btd\b/i, gradient: "linear-gradient(135deg, #063b1e, #1a8a44 55%, #042a15)", text: "#f4f4f5" },
	{ match: /\bally\b/i, gradient: "linear-gradient(135deg, #3a1a6b, #6b3fb0 55%, #260f4a)", text: "#f4f4f5" },
	{ match: /schwab/i, gradient: "linear-gradient(135deg, #003057, #0064a4 55%, #001f3a)", text: "#f4f4f5" },
	{ match: /fidelity/i, gradient: "linear-gradient(135deg, #0a3d24, #1c8452 55%, #062a19)", text: "#f4f4f5" },
	// Dutch retail banks, plus a couple of international payment apps common enough alongside them.
	{ match: /\bing\b/i, gradient: "linear-gradient(135deg, #ff7a00, #ff6200 55%, #d94c00)", text: "#f4f4f5" },
	{ match: /abn|amro/i, gradient: "linear-gradient(135deg, #00645f, #00463f 62%, #002d2a)", text: "#f4f4f5" },
	{ match: /rabobank|\brabo\b/i, gradient: "linear-gradient(135deg, #123b83, #0b2a63 55%, #081c42)", text: "#f4f4f5" },
	{ match: /\bsns\b/i, gradient: "linear-gradient(135deg, #7b3fa1, #5e2b82 55%, #3d1d59)", text: "#f4f4f5" },
	{ match: /\bbunq\b/i, gradient: "linear-gradient(135deg, #1a1a1a, #080808)", text: "#f4f4f5" },
	{ match: /\basn\b/i, gradient: "linear-gradient(135deg, #254f45, #173b34 65%, #102a25)", text: "#f4f4f5" },
	{ match: /\bknab\b/i, gradient: "linear-gradient(135deg, #0a7a80, #075d65 58%, #043f46)", text: "#f4f4f5" },
	{ match: /regiobank|regio bank/i, gradient: "linear-gradient(135deg, #d82218, #b40f0b 58%, #7b0806)", text: "#f4f4f5" },
	{ match: /triodos/i, gradient: "linear-gradient(135deg, #175b4a, #0c4437 60%, #072e26)", text: "#f4f4f5" },
	{ match: /american express|\bamex\b/i, gradient: "linear-gradient(135deg, #4f7c8f, #315f72 58%, #183d4d)", text: "#f4f4f5" },
	{ match: /revolut/i, gradient: "linear-gradient(135deg, #23262b, #111316 60%, #050607)", text: "#f4f4f5" },
	{ match: /skrill/i, gradient: "linear-gradient(135deg, #79226f, #5c1755 58%, #391035)", text: "#f4f4f5" },
];

/**
 * Card-type fallbacks, checked when neither tier nor issuer keywords matched — gives debit/prepaid/
 * secured/charge cards a look distinct from a generic revolving-credit card even with no other hint.
 */
const CARD_TYPE_RULES: Partial<Record<CardType, StyleRule>> = {
	debit: { match: /./, gradient: "linear-gradient(135deg, #0c4a6e, #38bdf8 55%, #0a3a56)", text: "#f4f4f5" },
	prepaid: { match: /./, gradient: "linear-gradient(135deg, #0f766e, #2dd4bf 60%, #0b5c56)", text: "#f4f4f5" },
	secured: { match: /./, gradient: "linear-gradient(135deg, #4b5563, #7b8794)", text: "#f4f4f5" },
	charge: { match: /./, gradient: "linear-gradient(135deg, #27272a, #55555c 55%, #1a1a1c)", text: "#f4f4f5" },
};

const NETWORK_FALLBACK_GRADIENT: Record<CardNetwork, string> = {
	visa: "linear-gradient(135deg, #1a1f71, #3b4bce 60%, #12173f)",
	mastercard: "linear-gradient(135deg, #2b2320, #4a3b32)",
	amex: "linear-gradient(135deg, #006fcf, #00a8e8 60%, #004a8f)",
	discover: "linear-gradient(135deg, #b3500f, #ff8c1a 60%, #8a3d0b)",
	// V PAY is Visa's European debit-only brand — related blue, kept visually distinct from Visa itself.
	vpay: "linear-gradient(135deg, #0f3d91, #1f6fd6 60%, #0a2a63)",
	other: "linear-gradient(135deg, #3f3f46, #6b7280)",
};

function isLightText(hex: string): boolean {
	// The rule tables always pick a *dark* text color for light-gradient cards and vice versa, so
	// "is this face light" is just the inverse of "is the chosen text color dark".
	const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return false;
	const n = parseInt(m[1], 16);
	const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luminance < 0.5; // dark text => light-faced card
}

/**
 * Not a lookup of real bank card art — a tier → issuer → card-type → network cascade so each card
 * still reads as recognizably its own kind, without reproducing any bank's actual trademarked design.
 */
export function cardStyle(card: Pick<Card, "product" | "name" | "network" | "issuer" | "cardType">): CardStyle {
	const haystack = `${card.issuer ?? ""} ${card.product ?? ""} ${card.name}`.toLowerCase();

	for (const rule of TIER_RULES) {
		if (rule.match.test(haystack)) return { gradient: rule.gradient, textColor: rule.text, isLight: isLightText(rule.text) };
	}
	for (const rule of ISSUER_RULES) {
		if (rule.match.test(haystack)) return { gradient: rule.gradient, textColor: rule.text, isLight: isLightText(rule.text) };
	}
	const typeRule = CARD_TYPE_RULES[card.cardType];
	if (typeRule) return { gradient: typeRule.gradient, textColor: typeRule.text, isLight: isLightText(typeRule.text) };

	return { gradient: NETWORK_FALLBACK_GRADIENT[card.network], textColor: "#f4f4f5", isLight: false };
}

export function cardsForAccount(cards: Card[], accountId: string): Card[] {
	return cards.filter((c) => c.accountId === accountId);
}

/** Midnight on the last day of the printed expiry month — a card is good for the whole month shown. */
export function cardExpiryDate(card: Pick<Card, "expiryMonth" | "expiryYear">): Date | undefined {
	if (!card.expiryMonth || !card.expiryYear) return undefined;
	return new Date(card.expiryYear, card.expiryMonth, 0);
}

/**
 * A card is expired only once its printed month has fully passed.
 *
 * Compared per calendar month, not per instant: `cardExpiryDate` returns *midnight* on the last day
 * of the month, so a `Date.now()` comparison declared a card expired for the whole of its final day —
 * a card printed 08/26 read as dead from 00:00 on 31 August, while it is in fact still good.
 */
export function cardIsExpired(card: Pick<Card, "expiryMonth" | "expiryYear">): boolean {
	if (!card.expiryMonth || !card.expiryYear) return false;
	const now = new Date();
	// `expiryMonth` is 1-based as printed on the card; `getMonth()` is 0-based.
	return card.expiryYear * 12 + (card.expiryMonth - 1) < now.getFullYear() * 12 + now.getMonth();
}

/** Whole calendar months from now to `date`, rounded down — 0 means "this month". */
export function monthsUntil(date: Date): number {
	const now = new Date();
	return (date.getFullYear() - now.getFullYear()) * 12 + (date.getMonth() - now.getMonth());
}

export function cardExpiresWithinMonths(card: Pick<Card, "expiryMonth" | "expiryYear">, months: number): boolean {
	const d = cardExpiryDate(card);
	if (!d) return false;
	const remaining = monthsUntil(d);
	return remaining >= 0 && remaining <= months;
}
