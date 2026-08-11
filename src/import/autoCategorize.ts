import type { Category, CategoryRule, Transaction } from "../types";
import { applyRules } from "./categorize";

/**
 * Keyword → category rules for common (mostly Dutch/EU) merchants and payment patterns, built from
 * real-world bank export text rather than generic guesses. Matched case-insensitively against
 * `description + counterparty`, same as any other CategoryRule. Kept deliberately free of anything
 * that identifies a specific person (names, employers) — this file ships with the plugin, so it's
 * public; personal categorization rules belong in the user's own local rules.json instead, not here.
 */
const DEFAULT_RULE_PATTERNS: { pattern: string; category: string }[] = [
	// Auto & Transport
	{ pattern: "shell", category: "Auto & Transport" },
	{ pattern: "esso", category: "Auto & Transport" },
	{ pattern: "bp leyweg", category: "Auto & Transport" },
	{ pattern: "q-park", category: "Auto & Transport" },
	{ pattern: "q park", category: "Auto & Transport" },
	{ pattern: "tmc*", category: "Auto & Transport" },
	{ pattern: "autoradam", category: "Auto & Transport" },

	// Food
	{ pattern: "albert heijn", category: "Food" },
	{ pattern: "ah to go", category: "Food" },
	{ pattern: "jumbo", category: "Food" },
	{ pattern: "lidl", category: "Food" },
	{ pattern: "mcdonald", category: "Food" },
	{ pattern: "burger king", category: "Food" },
	{ pattern: "ccv*kfc", category: "Food" },
	{ pattern: "taco bell", category: "Food" },
	{ pattern: "iss catering", category: "Food" },
	{ pattern: "sumup", category: "Food" },
	{ pattern: "rasoi", category: "Food" },
	{ pattern: "tango eindhoven", category: "Food" },
	{ pattern: "baya cuba", category: "Food" },
	{ pattern: "natraj", category: "Food" },
	{ pattern: "harput grillroom", category: "Food" },
	{ pattern: "asml", category: "Food" }, // on-site canteen vendors (Il Gusto, Your Choice, Typical Dutch, Sharing Dishes)

	// Entertainment
	{ pattern: "pathe", category: "Entertainment" },
	{ pattern: "nyx*palaceofgames", category: "Entertainment" },

	// Shopping
	{ pattern: "amazon", category: "Shopping" },
	{ pattern: "kruidvat", category: "Shopping" }, // confirmed with user
	{ pattern: "dell products", category: "Shopping" },
	{ pattern: "riverty", category: "Shopping" }, // confirmed with user (BNPL, treated as the underlying purchase)
	{ pattern: "klarna", category: "Shopping" }, // confirmed with user

	// Fees & Charges
	{ pattern: "kosten ing", category: "Fees & Charges" },
	{ pattern: "kosten oranjepakket", category: "Fees & Charges" },
	{ pattern: "ing punten", category: "Fees & Charges" },

	// Transfers (own accounts, credit card bill, personal/Tikkie payments)
	{ pattern: "american express europe", category: "Transfers" },
	{ pattern: "oranje spaarrekening", category: "Transfers" },
	{ pattern: "transfer to current account", category: "Transfers" },
	{ pattern: "transfer from current account", category: "Transfers" },
	{ pattern: "via tikkie", category: "Transfers" },
	{ pattern: "via ing betaalverzoek", category: "Transfers" },

	// Loan
	{ pattern: "duo hoofdrekening", category: "Loan" }, // Dutch student finance (DUO)

	// Taxes
	{ pattern: "belastingdienst", category: "Taxes" },
	{ pattern: "belastingen", category: "Taxes" },

	// Legal
	{ pattern: "ministerie van justitie", category: "Legal" },

	// Education
	{ pattern: "hbo haaglanden", category: "Education" },

	// Bills & Utilities
	{ pattern: "strato gmbh", category: "Bills & Utilities" },

	// Travel & Vacation
	{ pattern: "holafly", category: "Travel & Vacation" }, // international eSIM/travel data

	// More Transfers (same own-account-movement pattern as Oranje Spaarrekening)
	{ pattern: "trade republic bank gmbh", category: "Transfers" },
	{ pattern: "spaarrekening", category: "Transfers" },
	{ pattern: "savings", category: "Transfers" },
	{ pattern: "ing deposit", category: "Transfers" },
	{ pattern: "transfer from savings account", category: "Transfers" },
	{ pattern: "investering", category: "Transfers" },

	// More Auto & Transport
	{ pattern: "ov-chipkaart", category: "Auto & Transport" },
	{ pattern: "yellowbrick", category: "Auto & Transport" },
	{ pattern: "greenwheels", category: "Auto & Transport" },
	{ pattern: "gulf ", category: "Auto & Transport" },
	{ pattern: "mcwash", category: "Auto & Transport" },
	{ pattern: "flitsmeister", category: "Auto & Transport" },

	// More Food
	{ pattern: "domino", category: "Food" },
	{ pattern: "new york pizza", category: "Food" },
	{ pattern: "nypd ", category: "Food" },
	{ pattern: "thuisbezorgd", category: "Food" },
	{ pattern: "shabu shabu", category: "Food" },
	{ pattern: "nieuw peking", category: "Food" },
	{ pattern: "momiji sushi", category: "Food" },
	{ pattern: "koi utrecht", category: "Food" },
	{ pattern: "holi indian", category: "Food" },
	{ pattern: "marmaris", category: "Food" },
	{ pattern: "cafe de sport", category: "Food" },
	{ pattern: "o learys", category: "Food" },
	{ pattern: "eethuis djojo", category: "Food" },
	{ pattern: "arabblend", category: "Food" },
	{ pattern: "bck*chinees indisch", category: "Food" },
	{ pattern: "bck*miami fried chicke", category: "Food" },
	{ pattern: "hmshost", category: "Food" },
	{ pattern: "supermarkt houtwijk", category: "Food" },
	{ pattern: "dhol and soul", category: "Food" },
	{ pattern: "mcvlamingstraat", category: "Food" },
	{ pattern: "mcgrotemarkt", category: "Food" },
	{ pattern: "mcbuitenhof", category: "Food" },

	// More Shopping
	{ pattern: "h&m", category: "Shopping" },
	{ pattern: "hennes", category: "Shopping" },
	{ pattern: "h?m online", category: "Shopping" },
	{ pattern: "zara", category: "Shopping" },
	{ pattern: "c&a ", category: "Shopping" },
	{ pattern: "we fashion", category: "Shopping" },
	{ pattern: "wefashion", category: "Shopping" },
	{ pattern: "wehkamp", category: "Shopping" },
	{ pattern: "mango", category: "Shopping" },
	{ pattern: "about you", category: "Shopping" },
	{ pattern: "peek & cloppenburg", category: "Shopping" },
	{ pattern: "peek-cloppenburg", category: "Shopping" },
	{ pattern: "snipes", category: "Shopping" },
	{ pattern: "pandora", category: "Shopping" },
	{ pattern: "adidas", category: "Shopping" },
	{ pattern: "media markt", category: "Shopping" },
	{ pattern: "hema ", category: "Shopping" },
	{ pattern: "bol.com", category: "Shopping" },
	{ pattern: "coolblue", category: "Shopping" },
	{ pattern: "belsimpel", category: "Shopping" },
	{ pattern: "bax-shop", category: "Shopping" },
	{ pattern: "bijenkorf", category: "Shopping" },
	{ pattern: "studystore", category: "Shopping" },
	{ pattern: "daily paper", category: "Shopping" },
	{ pattern: "the sting", category: "Shopping" },
	{ pattern: "manfield", category: "Shopping" },
	{ pattern: "charles tyrwhitt", category: "Shopping" },
	{ pattern: "wolff vuurwerk", category: "Shopping" },
	{ pattern: "philips-hue", category: "Shopping" },
	{ pattern: "gymshark", category: "Shopping" },
	{ pattern: "sports supplements", category: "Shopping" },
	{ pattern: "edel-optics", category: "Shopping" },
	{ pattern: "pluto sport", category: "Shopping" },
	{ pattern: "123adapter", category: "Shopping" },
	{ pattern: "minisou", category: "Shopping" },
	{ pattern: "excelsior sport", category: "Shopping" },
	{ pattern: "tinka", category: "Shopping" }, // Dutch BNPL, same treatment as Riverty/Klarna
	{ pattern: "zalando", category: "Shopping" },
	{ pattern: "thesting", category: "Shopping" },

	// Gifts
	{ pattern: "greetz", category: "Gifts" },
	{ pattern: "topgeschenken", category: "Gifts" },

	// More Entertainment
	{ pattern: "gamestate", category: "Entertainment" },
	{ pattern: "walibi holland", category: "Entertainment" },
	{ pattern: "getyourguide", category: "Entertainment" },
	{ pattern: "afc ajax", category: "Entertainment" },
	{ pattern: "glowgolf", category: "Entertainment" },
	{ pattern: "i-ticketz", category: "Entertainment" },
	{ pattern: "gamecity gokarting", category: "Entertainment" },
	{ pattern: "steampowered", category: "Entertainment" },

	// Travel & Vacation
	{ pattern: "booking", category: "Travel & Vacation" },
	{ pattern: "nh eindhoven", category: "Travel & Vacation" },
	{ pattern: "hotel amsterdam zuidas", category: "Travel & Vacation" },
];

/** Type-column shortcuts that don't need a description match — the bank's own transaction type already says enough. */
const TYPE_CATEGORY_RULES: { type: string; category: string }[] = [
	{ type: "withdrawal", category: "Cash/ATM" },
	{ type: "interest", category: "Income" },
];

function categoryIdByName(categories: Category[], name: string): string | undefined {
	return categories.find((c) => c.name === name)?.id;
}

/** Converts the keyword list above into real CategoryRule objects — skipped for any category name not present in `categories`. */
export function buildDefaultRules(categories: Category[]): CategoryRule[] {
	const rules: CategoryRule[] = [];
	for (const { pattern, category } of DEFAULT_RULE_PATTERNS) {
		const categoryId = categoryIdByName(categories, category);
		if (!categoryId) continue;
		rules.push({ id: `rule-default-${pattern.replace(/[^a-z0-9]+/gi, "-")}`, pattern, categoryId });
	}
	return rules;
}

export interface AutoCategorizeResult {
	rulesAdded: number;
	categorized: number;
}

/**
 * Categorizes every currently-uncategorized transaction it can, using (in order) the bank's own
 * type column for unambiguous cases (ATM withdrawals, interest), then the keyword rules above.
 * Anything neither matches is left alone — same "Uncategorized" state as today, not a wrong guess.
 */
export function autoCategorize(transactions: Transaction[], categories: Category[], rules: CategoryRule[]): { patches: Map<string, string>; categorized: number } {
	const patches = new Map<string, string>();
	const typeRules = TYPE_CATEGORY_RULES.map((r) => ({ type: r.type, categoryId: categoryIdByName(categories, r.category) })).filter(
		(r): r is { type: string; categoryId: string } => !!r.categoryId
	);

	for (const tx of transactions) {
		if (tx.categoryId) continue;

		const byType = typeRules.find((r) => (tx.type ?? "").toLowerCase() === r.type);
		if (byType) {
			patches.set(tx.id, byType.categoryId);
			continue;
		}

		const categoryId = applyRules(tx, rules);
		if (categoryId) patches.set(tx.id, categoryId);
	}

	return { patches, categorized: patches.size };
}
