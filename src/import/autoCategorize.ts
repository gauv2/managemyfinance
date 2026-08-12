import type { Category, CategoryRule, Transaction } from "../types";
import { applyRules } from "./categorize";

/**
 * Keyword → category rules for common (mostly Dutch/EU) merchants and payment patterns, built from
 * real-world bank export text rather than generic guesses. Matched case-insensitively against
 * `description + counterparty`, same as any other CategoryRule. Kept deliberately free of anything
 * that identifies a specific person (names, employers) — this file ships with the plugin, so it's
 * public; personal categorization rules belong in the user's own local rules.json instead, not here.
 */
interface DefaultRulePattern {
	pattern: string;
	/**
	 * A primary category name, or "Primary > Secondary" to land on a leaf. A secondary that doesn't
	 * exist in the portfolio falls back to its primary rather than dropping the rule, so deleting a
	 * subcategory degrades the rule instead of silently disabling it.
	 */
	category: string;
	/**
	 * Match only as a whole word. Essential for short merchant names that are also fragments of
	 * ordinary Dutch: a plain substring rule for "ring" would claim every *verzeke***ring**,
	 * *parke***ring** and *financie***ring** in the ledger, which is far worse than leaving the row
	 * uncategorized. Emitted as an anchored regex rule instead.
	 */
	word?: boolean;
}

const DEFAULT_RULE_PATTERNS: DefaultRulePattern[] = [
	// Auto & Transport
	{ pattern: "shell", category: "Auto & Transport > Fuel" },
	{ pattern: "esso", category: "Auto & Transport > Fuel" },
	{ pattern: "bp leyweg", category: "Auto & Transport" },
	{ pattern: "q-park", category: "Auto & Transport > Parking" },
	{ pattern: "q park", category: "Auto & Transport > Parking" },
	{ pattern: "tmc*", category: "Auto & Transport" },
	{ pattern: "autoradam", category: "Auto & Transport" },

	// Food
	{ pattern: "albert heijn", category: "Food > Groceries" },
	{ pattern: "ah to go", category: "Food" },
	{ pattern: "jumbo", category: "Food > Groceries" },
	{ pattern: "lidl", category: "Food > Groceries" },
	{ pattern: "mcdonald", category: "Food > Fast Food" },
	{ pattern: "burger king", category: "Food > Fast Food" },
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
	{ pattern: "ov-chipkaart", category: "Auto & Transport > Public Transport" },
	{ pattern: "yellowbrick", category: "Auto & Transport" },
	{ pattern: "greenwheels", category: "Auto & Transport" },
	{ pattern: "gulf ", category: "Auto & Transport" },
	{ pattern: "mcwash", category: "Auto & Transport > Car Wash" },
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
	{ pattern: "zara", category: "Shopping > Clothing" },
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
	{ pattern: "media markt", category: "Shopping > Electronics" },
	{ pattern: "hema ", category: "Shopping" },
	{ pattern: "bol.com", category: "Shopping" },
	{ pattern: "coolblue", category: "Shopping > Electronics" },
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

	// ---------------------------------------------------------------------------------------------
	// Recurring international merchants. The list above is mostly Dutch high-street names matched from
	// one person's export; almost everything anyone actually pays every month — streaming, SaaS, cloud,
	// telecom, energy — was missing, which is why a typical import matched close to nothing.
	// ---------------------------------------------------------------------------------------------

	// Streaming, media and gaming → Entertainment
	{ pattern: "netflix", category: "Entertainment > Movies & Streaming" },
	{ pattern: "spotify", category: "Entertainment > Music" },
	{ pattern: "disney", category: "Entertainment > Movies & Streaming" },
	{ pattern: "videoland", category: "Entertainment > Movies & Streaming" },
	{ pattern: "viaplay", category: "Entertainment" },
	{ pattern: "hbo max", category: "Entertainment" },
	{ pattern: "prime video", category: "Entertainment" },
	{ pattern: "youtube", category: "Entertainment" },
	{ pattern: "audible", category: "Entertainment" },
	{ pattern: "storytel", category: "Entertainment" },
	{ pattern: "patreon", category: "Entertainment" },
	{ pattern: "twitch", category: "Entertainment" },
	{ pattern: "steampowered", category: "Entertainment" },
	{ pattern: "playstation", category: "Entertainment" },
	{ pattern: "nintendo", category: "Entertainment" },
	{ pattern: "xbox", category: "Entertainment" },
	{ pattern: "epic games", category: "Entertainment" },
	{ pattern: "blizzard", category: "Entertainment" },
	{ pattern: "ticketmaster", category: "Entertainment" },
	{ pattern: "pathé", category: "Entertainment" },

	// Software, cloud and connectivity → Bills & Utilities.
	// A judgement call: these are recurring service costs rather than goods, and this category is where
	// the "Internet & Phone" secondary already lives. Re-map any of them from the Review page.
	{ pattern: "google one", category: "Bills & Utilities" },
	{ pattern: "google storage", category: "Bills & Utilities" },
	{ pattern: "dropbox", category: "Bills & Utilities" },
	{ pattern: "icloud", category: "Bills & Utilities" },
	{ pattern: "microsoft", category: "Bills & Utilities" },
	{ pattern: "office 365", category: "Bills & Utilities" },
	{ pattern: "adobe", category: "Bills & Utilities" },
	{ pattern: "github", category: "Bills & Utilities" },
	{ pattern: "openai", category: "Bills & Utilities" },
	{ pattern: "anthropic", category: "Bills & Utilities" },
	{ pattern: "claude.ai", category: "Bills & Utilities" },
	{ pattern: "perplexity", category: "Bills & Utilities" },
	{ pattern: "midjourney", category: "Bills & Utilities" },
	{ pattern: "elevenlabs", category: "Bills & Utilities" },
	{ pattern: "notion", category: "Bills & Utilities" },
	{ pattern: "figma", category: "Bills & Utilities" },
	{ pattern: "canva", category: "Bills & Utilities" },
	{ pattern: "atlassian", category: "Bills & Utilities" },
	{ pattern: "jetbrains", category: "Bills & Utilities" },
	{ pattern: "1password", category: "Bills & Utilities" },
	{ pattern: "nordvpn", category: "Bills & Utilities" },
	{ pattern: "expressvpn", category: "Bills & Utilities" },
	{ pattern: "proton", category: "Bills & Utilities" },
	{ pattern: "cloudflare", category: "Bills & Utilities" },
	{ pattern: "digitalocean", category: "Bills & Utilities" },
	{ pattern: "hetzner", category: "Bills & Utilities" },
	{ pattern: "namecheap", category: "Bills & Utilities" },
	{ pattern: "godaddy", category: "Bills & Utilities" },
	{ pattern: "vercel", category: "Bills & Utilities" },
	{ pattern: "netlify", category: "Bills & Utilities" },
	{ pattern: "sharesub", category: "Bills & Utilities" },
	{ pattern: "setapp", category: "Bills & Utilities" },
	{ pattern: "grammarly", category: "Bills & Utilities" },
	{ pattern: "linkedin", category: "Bills & Utilities" },

	// Telecom and energy → Bills & Utilities
	{ pattern: "vodafone", category: "Bills & Utilities > Internet & Phone" },
	{ pattern: "odido", category: "Bills & Utilities > Internet & Phone" },
	{ pattern: "t-mobile", category: "Bills & Utilities" },
	{ pattern: "ziggo", category: "Bills & Utilities > Internet & Phone" },
	{ pattern: "tele2", category: "Bills & Utilities" },
	{ pattern: "simyo", category: "Bills & Utilities" },
	{ pattern: "lebara", category: "Bills & Utilities" },
	{ pattern: "hollandsnieuwe", category: "Bills & Utilities" },
	{ pattern: "kpn", category: "Bills & Utilities", word: true },
	{ pattern: "eneco", category: "Bills & Utilities > Electricity & Gas" },
	{ pattern: "vattenfall", category: "Bills & Utilities > Electricity & Gas" },
	{ pattern: "essent", category: "Bills & Utilities > Electricity & Gas" },
	{ pattern: "greenchoice", category: "Bills & Utilities" },
	{ pattern: "budget energie", category: "Bills & Utilities" },
	{ pattern: "dunea", category: "Bills & Utilities > Water" },
	{ pattern: "evides", category: "Bills & Utilities > Water" },
	{ pattern: "vitens", category: "Bills & Utilities > Water" },
	{ pattern: "waternet", category: "Bills & Utilities" },

	// Hardware and general retail → Shopping
	{ pattern: "bambu lab", category: "Shopping" },
	{ pattern: "bambulab", category: "Shopping" },
	{ pattern: "prusa", category: "Shopping" },
	{ pattern: "ring", category: "Shopping", word: true },
	{ pattern: "ikea", category: "Shopping > Home & Decor" },
	{ pattern: "action", category: "Shopping", word: true },
	{ pattern: "blokker", category: "Shopping" },
	{ pattern: "gamma", category: "Shopping", word: true },
	{ pattern: "praxis", category: "Shopping" },
	{ pattern: "hornbach", category: "Shopping" },
	{ pattern: "karwei", category: "Shopping" },
	{ pattern: "alternate", category: "Shopping" },
	{ pattern: "azerty", category: "Shopping" },
	{ pattern: "megekko", category: "Shopping" },
	{ pattern: "aliexpress", category: "Shopping" },
	{ pattern: "temu", category: "Shopping", word: true },
	{ pattern: "shein", category: "Shopping" },
	{ pattern: "etsy", category: "Shopping" },
	{ pattern: "ebay", category: "Shopping" },
	{ pattern: "decathlon", category: "Shopping" },

	// Gyms and wellbeing → Health & Fitness
	{ pattern: "basic-fit", category: "Health & Fitness > Gym" },
	{ pattern: "basicfit", category: "Health & Fitness > Gym" },
	{ pattern: "fit for free", category: "Health & Fitness" },
	{ pattern: "sportcity", category: "Health & Fitness" },
	{ pattern: "trainmore", category: "Health & Fitness" },
	{ pattern: "anytime fitness", category: "Health & Fitness" },

	// Insurers → Insurance
	{ pattern: "zilveren kruis", category: "Insurance" },
	{ pattern: "menzis", category: "Insurance" },
	{ pattern: "univé", category: "Insurance" },
	{ pattern: "unive", category: "Insurance" },
	{ pattern: "centraal beheer", category: "Insurance" },
	{ pattern: "nationale nederlanden", category: "Insurance" },
	{ pattern: "interpolis", category: "Insurance" },
	{ pattern: "ditzo", category: "Insurance" },
	{ pattern: "aegon", category: "Insurance" },
	{ pattern: "achmea", category: "Insurance" },
	{ pattern: "verzekering", category: "Insurance" },

	// Getting around → Auto & Transport
	{ pattern: "ns groep", category: "Auto & Transport > Public Transport" },
	{ pattern: "ns-", category: "Auto & Transport" },
	{ pattern: "nsinternational", category: "Auto & Transport" },
	{ pattern: "uber", category: "Auto & Transport" },
	{ pattern: "bolt.eu", category: "Auto & Transport" },
	{ pattern: "swapfiets", category: "Auto & Transport" },
	{ pattern: "felyx", category: "Auto & Transport" },
	{ pattern: "donkey republic", category: "Auto & Transport" },
	{ pattern: "fastned", category: "Auto & Transport" },
	{ pattern: "allego", category: "Auto & Transport" },
	{ pattern: "shell recharge", category: "Auto & Transport" },
	{ pattern: "anwb", category: "Auto & Transport" },

	// Groceries and delivery → Food
	{ pattern: "picnic", category: "Food > Groceries" },
	{ pattern: "crisp", category: "Food" },
	{ pattern: "hellofresh", category: "Food" },
	{ pattern: "marley spoon", category: "Food" },
	{ pattern: "uber eats", category: "Food" },
	{ pattern: "ubereats", category: "Food" },
	{ pattern: "deliveroo", category: "Food" },
	{ pattern: "flink", category: "Food", word: true },
	{ pattern: "getir", category: "Food" },
	{ pattern: "starbucks", category: "Food > Coffee & Snacks" },
	{ pattern: "coop", category: "Food", word: true },
	{ pattern: "plus supermarkt", category: "Food" },
	{ pattern: "dirk van den broek", category: "Food" },
	{ pattern: "aldi", category: "Food", word: true },
	{ pattern: "spar", category: "Food", word: true },

	// Cash
	{ pattern: "geldmaat", category: "Cash/ATM" },
];

/** Type-column shortcuts that don't need a description match — the bank's own transaction type already says enough. */
const TYPE_CATEGORY_RULES: { type: string; category: string }[] = [
	{ type: "withdrawal", category: "Cash/ATM" },
	{ type: "interest", category: "Income" },
];

function categoryIdByName(categories: Category[], name: string): string | undefined {
	return categories.find((c) => c.name === name)?.id;
}

/** Resolves "Food > Groceries" to the secondary's id, falling back to "Food" when it doesn't exist. */
function resolveTarget(categories: Category[], target: string): string | undefined {
	const [primaryName, secondaryName] = target.split(">").map((part) => part.trim());
	const primaryId = categoryIdByName(categories, primaryName);
	if (!primaryId || !secondaryName) return primaryId;
	const secondary = categories.find((c) => c.parentId === primaryId && c.name === secondaryName);
	return secondary?.id ?? primaryId;
}

/** Escapes a literal so it can be embedded in the anchored regex a `word: true` pattern compiles to. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Converts the keyword list above into real CategoryRule objects — skipped for any category name not present in `categories`. */
export function buildDefaultRules(categories: Category[]): CategoryRule[] {
	const rules: CategoryRule[] = [];
	for (const { pattern, category, word } of DEFAULT_RULE_PATTERNS) {
		const categoryId = resolveTarget(categories, category);
		if (!categoryId) continue;
		const id = `rule-default-${pattern.replace(/[^a-z0-9]+/gi, "-")}`;
		if (word) {
			rules.push({ id, pattern: `\\b${escapeRegex(pattern)}\\b`, isRegex: true, categoryId });
		} else {
			rules.push({ id, pattern, categoryId });
		}
	}
	return rules;
}

/**
 * The rules actually used to categorize an import: the user's own first, the shipped defaults behind
 * them. applyRules returns the first match, so anything you've defined yourself always beats a
 * built-in guess about the same merchant.
 *
 * This exists because the import wizard used to run against `store.rules` alone. On a fresh portfolio
 * that list is empty, so every import reported "0 auto-categorized" no matter how recognizable the
 * merchants were — the built-in list was only reachable through a command-palette command most people
 * never ran.
 */
export function effectiveRules(categories: Category[], userRules: CategoryRule[]): CategoryRule[] {
	return [...userRules, ...buildDefaultRules(categories)];
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
