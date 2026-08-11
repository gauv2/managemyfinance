import type { Account, Category } from "./types";

export const VIEW_TYPE_FINANCE = "finance-workspace-view";

export const DEFAULT_DATA_FOLDER = "Manage My Finance";

export const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "INR"];

export const ACCOUNT_TYPE_META: Record<AccountType, { label: string; icon: string }> = {
	debit: { label: "Debit", icon: "landmark" },
	credit: { label: "Credit", icon: "credit-card" },
	investing: { label: "Investing", icon: "trending-up" },
	saving: { label: "Saving", icon: "piggy-bank" },
	cash: { label: "Cash", icon: "banknote" },
	crypto: { label: "Crypto", icon: "bitcoin" },
};

type AccountType = Account["type"];

/**
 * Based on eMoney Advisor's standard "Spending & Budget Categories" list (the same taxonomy used by
 * many bank/PFM dashboards). eMoney nests subcategories under each bold category; this app's Category
 * model is flat, so subcategory names live on as aliases/rule keywords instead of separate categories.
 * "Excluded" and "Unclassified" (eMoney's own meta-labels for hidden/unsorted transactions) are left
 * out since they're not real budget categories here — anything unmatched is simply "Uncategorized".
 */
export function defaultCategories(): Category[] {
	const seed: [string, string, string][] = [
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
		["Income", "#16a34a", "wallet"],
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
	return seed.map(([name, color, icon], i) => ({
		id: `cat-${i}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
		name,
		color,
		icon,
		aliases: [],
	}));
}

/**
 * Maps historical/external category labels onto the canonical eMoney-based set above: both this
 * app's old default names (pre-eMoney) and eMoney's own subcategory names (so a bank/spreadsheet
 * export that already tags rows with e.g. "Gas & Fuel" or "Groceries" lands on the right parent).
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

	// eMoney's own subcategories, mapped up to their parent category.
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
