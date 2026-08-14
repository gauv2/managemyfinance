import type { Account, Category } from "./types";

export const VIEW_TYPE_FINANCE = "finance-workspace-view";

export const DEFAULT_DATA_FOLDER = "Manage My Finance";

export const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "INR"];

/**
 * Every account type, with the blurb shown wherever one is chosen. The last four don't have money
 * flowing through them in any export — they're the balances that make net worth true rather than
 * merely bank-shaped, and they're kept up to date with hand-recorded balance snapshots instead.
 */
export const ACCOUNT_TYPE_META: Record<AccountType, { label: string; icon: string; desc: string }> = {
	debit: { label: "Debit", icon: "landmark", desc: "An everyday current/checking account." },
	credit: { label: "Credit", icon: "credit-card", desc: "A credit card — utilization, statement and due dates." },
	investing: { label: "Investing", icon: "trending-up", desc: "A brokerage or fund account holding positions." },
	saving: { label: "Saving", icon: "piggy-bank", desc: "A savings or deposit account." },
	cash: { label: "Cash", icon: "banknote", desc: "Physical cash in your pocket or a jar." },
	crypto: { label: "Crypto", icon: "bitcoin", desc: "A crypto wallet or exchange balance." },
	loan: { label: "Loan", icon: "hand-coins", desc: "Money you owe — the balance counts against net worth." },
	mortgage: { label: "Mortgage", icon: "key", desc: "A home loan — the balance counts against net worth." },
	property: { label: "Property", icon: "home", desc: "A house, a car, anything you own that holds value." },
	pension: { label: "Pension", icon: "umbrella", desc: "A retirement pot you can't spend yet but do own." },
};

/** The order account types are offered in, grouped by what they are rather than alphabetically. */
export const ACCOUNT_TYPE_ORDER: AccountType[] = [
	"debit",
	"credit",
	"saving",
	"investing",
	"crypto",
	"cash",
	"property",
	"pension",
	"loan",
	"mortgage",
];

type AccountType = Account["type"];

/**
 * The plugin's standard "Spending & Budget Categories" set — the same broad taxonomy used by most
 * bank/PFM dashboards, nested into primary categories with subcategories underneath. This app's
 * Category model is flat, so subcategory names live on as aliases/rule keywords instead of separate
 * categories. "Excluded" and "Unclassified" meta-labels for hidden/unsorted transactions are left out
 * since they're not real budget categories here — anything unmatched is simply "Uncategorized".
 */
export function defaultCategories(): Category[] {
	/** name, colour, icon, and the `kind` for the one category that isn't an expense. */
	const seed: [string, string, string, Category["kind"]?][] = [
		["Auto & Transport", "#3b82f6", "car"],
		["Health & Fitness", "#ef4444", "heart-pulse"],
		["Bills & Utilities", "#64748b", "receipt"],
		["Home", "#92400e", "home"],
		["Business", "#0f766e", "briefcase"],
		["Cash/ATM", "#059669", "banknote"],
		["Charity", "#db2777", "heart-handshake"],
		["Education", "#4338ca", "graduation-cap"],
		["Entertainment", "#a855f7", "clapperboard"],
		["Fees & Charges", "#b91c1c", "alert-circle"],
		["Food", "#f97316", "utensils"],
		["Gifts", "#ec4899", "gift"],
		// The only non-expense default. Without this its budget reads as a ceiling to stay under, so
		// hitting an income target lights up red — see budgetTone, which flips on exactly this flag.
		["Income", "#16a34a", "wallet", "income"],
		["Insurance", "#0ea5e9", "shield"],
		["Kids", "#eab308", "baby"],
		["Legal", "#52525b", "scale"],
		["Loan", "#b45309", "landmark"],
		["Medical", "#dc2626", "stethoscope"],
		["Mortgage & Rent", "#78350f", "key"],
		["Pets", "#ca8a04", "paw-print"],
		["Savings", "#2563eb", "piggy-bank"],
		["Shipping & Handling", "#6b7280", "package"],
		["Shopping", "#ec4899", "shopping-bag"],
		["Taxes", "#57534e", "percent"],
		["Transfers", "#2563eb", "repeat"],
		["Travel & Vacation", "#0d9488", "plane"],
	];
	return seed.map(([name, color, icon, kind], i) => ({
		id: `cat-${i}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
		name,
		color,
		icon,
		aliases: [],
		// Left absent rather than set to undefined, so a category serialises exactly as it always has.
		...(kind ? { kind } : {}),
	}));
}

/**
 * Curated secondary categories per primary category, for the primaries where a second level is
 * actually useful for spend insight (e.g. "how much did I spend on car washes this year"). Not every
 * primary gets subcategories — Income, Transfers, Taxes, etc. stay flat since splitting them further
 * wouldn't help anyone's budgeting. Colors are inherited from the parent; only name/icon differ.
 */
const DEFAULT_SECONDARY_SEED: Record<string, [string, string][]> = {
	"Auto & Transport": [
		["Fuel", "fuel"],
		["Parking", "map-pin"],
		["Maintenance & Repairs", "wrench"],
		["Car Wash", "sparkles"],
		["Public Transport", "bus"],
		["Auto Insurance", "shield"],
	],
	Food: [
		["Groceries", "shopping-cart"],
		["Restaurants & Dining", "utensils"],
		["Coffee & Snacks", "coffee"],
		["Fast Food", "pizza"],
		["Alcohol & Bars", "wine"],
	],
	Shopping: [
		["Clothing", "shirt"],
		["Electronics", "laptop"],
		["Books", "book-open"],
		["Sports & Hobbies", "dumbbell"],
		["Home & Decor", "sofa"],
	],
	Home: [
		["Furniture & Decor", "sofa"],
		["Home Improvement", "hammer"],
		["Home Supplies", "spray-can"],
		["Household Services", "brush"],
	],
	"Bills & Utilities": [
		["Electricity & Gas", "zap"],
		["Water", "droplet"],
		["Internet & Phone", "wifi"],
		["Garbage & Recycling", "trash-2"],
	],
	"Health & Fitness": [
		["Gym", "dumbbell"],
		["Hair & Nails", "scissors"],
		["Spa & Massage", "sparkles"],
	],
	Medical: [
		["Doctor", "stethoscope"],
		["Dentist", "smile"],
		["Pharmacy", "pill"],
	],
	Entertainment: [
		["Movies & Streaming", "film"],
		["Concerts & Events", "ticket"],
		["Music", "music"],
		["Subscriptions", "tv"],
	],
	Insurance: [
		["Health Insurance", "heart-pulse"],
		["Home Insurance", "home"],
		["Life Insurance", "shield"],
	],
	Pets: [
		["Pet Food", "dog"],
		["Veterinary", "stethoscope"],
		["Grooming", "scissors"],
	],
	Kids: [
		["Childcare & Daycare", "baby"],
		["Kids Clothing", "shirt"],
		["Toys", "gamepad-2"],
	],
	"Travel & Vacation": [
		["Flights", "plane"],
		["Hotels", "building-2"],
		["Rental Car", "car"],
	],
	"Mortgage & Rent": [
		["Mortgage Interest", "percent"],
		["Mortgage Principal", "landmark"],
	],
};

/**
 * Builds the default secondary categories for a given set of primary categories, e.g. Car ->
 * Fuel/Parking/Maintenance/Car Wash/Public Transport/Auto Insurance. Only primaries present in
 * `DEFAULT_SECONDARY_SEED` (by name) get any — the rest stay flat. Called against whatever the
 * user's actual primary category ids are, so it's safe to call again later for primaries that were
 * added after the initial seed (it's purely additive — callers should skip any name already present).
 */
export function defaultSecondaryCategories(primaries: Category[]): Category[] {
	const out: Category[] = [];
	for (const primary of primaries) {
		const subs = DEFAULT_SECONDARY_SEED[primary.name];
		if (!subs) continue;
		for (const [name, icon] of subs) {
			out.push({
				id: `${primary.id}-sub-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
				name,
				color: primary.color,
				icon,
				aliases: [],
				parentId: primary.id,
			});
		}
	}
	return out;
}

/**
 * Maps historical/external category labels onto the canonical set above: both this app's older
 * default names and common external subcategory names (so a bank/spreadsheet export that already
 * tags rows with e.g. "Gas & Fuel" or "Groceries" lands on the right parent).
 */
export const CATEGORY_ALIAS_SEED: Record<string, string> = {
	// This app's previous default category names.
	groceries: "Food",
	"restaurants & take-out": "Food",
	car: "Auto & Transport",
	"car & travelling": "Auto & Transport",
	travelling: "Auto & Transport",
	shopping: "Shopping",
	"shopping & clothing": "Shopping",
	"entertainment & recreation": "Entertainment",
	subscriptions: "Entertainment",
	housing: "Home",
	"salary / income": "Income",
	"other inc.": "Income",
	otherinc: "Income",
	salary: "Income",
	"salary/financing": "Income",
	"allowances/financing": "Income",
	"savings & transfers": "Transfers",
	"savings & asset transfers": "Transfers",
	investments: "Savings",
	"payment requests sent": "Transfers",
	"payment requests paid": "Transfers",
	reimbursable: "Transfers",

	// Common external subcategory names, mapped up to their parent category.
	"auto payment": "Auto & Transport",
	"auto registration": "Auto & Transport",
	"auto service": "Auto & Transport",
	"gas & fuel": "Auto & Transport",
	"public transport": "Auto & Transport",
	gym: "Health & Fitness",
	"hair & nails": "Health & Fitness",
	"spa & massage": "Health & Fitness",
	"energy, gas & electric": "Bills & Utilities",
	"garbage & recycling": "Bills & Utilities",
	"phone, internet & cable": "Bills & Utilities",
	sewer: "Bills & Utilities",
	water: "Bills & Utilities",
	"furniture & home decor": "Home",
	"home improvement/maintenance": "Home",
	"home supplies": "Home",
	"household services": "Home",
	"concerts & events": "Entertainment",
	"movies, dvds & music": "Entertainment",
	"bank fee": "Fees & Charges",
	"finance charge": "Fees & Charges",
	"service fee": "Fees & Charges",
	"alcohol & bars": "Food",
	"fast food & convenience": "Food",
	"restaurants/dining": "Food",
	bonus: "Income",
	dividend: "Income",
	"interest income": "Income",
	"investment income": "Income",
	"net salary": "Income",
	"other income": "Income",
	"paycheck/salary": "Income",
	"tax refund": "Income",
	"auto insurance": "Insurance",
	"disability insurance": "Insurance",
	"health insurance": "Insurance",
	"homeowner insurance": "Insurance",
	"life insurance": "Insurance",
	"ltc insurance": "Insurance",
	"umbrella insurance": "Insurance",
	"whole life insurance": "Insurance",
	"baby supplies": "Kids",
	"childcare & daycare": "Kids",
	"kids clothing": "Kids",
	toys: "Kids",
	dentist: "Medical",
	doctor: "Medical",
	pharmacy: "Medical",
	"mortgage escrow": "Mortgage & Rent",
	"mortgage interest": "Mortgage & Rent",
	"mortgage principal": "Mortgage & Rent",
	"pet food": "Pets",
	"pet grooming": "Pets",
	veterinary: "Pets",
	"federal tax": "Taxes",
	"local tax": "Taxes",
	"medicare tax": "Taxes",
	"other tax": "Taxes",
	"property tax": "Taxes",
	"sdi tax": "Taxes",
	"social security tax": "Taxes",
	"state tax": "Taxes",
	"credit card payment": "Transfers",
	"air travel": "Travel & Vacation",
	hotel: "Travel & Vacation",
	"rental car": "Travel & Vacation",
	"investment savings": "Savings",
	"retirement savings": "Savings",
	books: "Shopping",
	clothing: "Shopping",
	"electronics & software": "Shopping",
	"merchandise/misc.": "Shopping",
	"sports & hobbies": "Shopping",
};
