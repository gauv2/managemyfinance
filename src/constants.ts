import type { Account, Category } from "./types";

export const VIEW_TYPE_FINANCE = "finance-workspace-view";
export const VIEW_TYPE_SETUP = "finance-setup-view";

export const DEFAULT_DATA_FOLDER = "Finance";

export const ACCOUNT_TYPE_META: Record<AccountType, { label: string; icon: string }> = {
	checking: { label: "Checking", icon: "landmark" },
	savings: { label: "Savings", icon: "piggy-bank" },
	broker: { label: "Broker / Investments", icon: "trending-up" },
	cash: { label: "Cash", icon: "banknote" },
};

type AccountType = Account["type"];

export function defaultCategories(): Category[] {
	const seed: [string, string, string][] = [
		["Groceries", "#22c55e", "shopping-cart"],
		["Restaurants & Take-Out", "#f97316", "utensils"],
		["Car & Travelling", "#3b82f6", "car"],
		["Shopping & Clothing", "#ec4899", "shirt"],
		["Entertainment & Recreation", "#a855f7", "clapperboard"],
		["Subscriptions", "#06b6d4", "repeat"],
		["Housing", "#78716c", "home"],
		["Insurance", "#0ea5e9", "shield"],
		["Salary / Income", "#16a34a", "wallet"],
		["Savings & Transfers", "#2563eb", "piggy-bank"],
		["Investments", "#7c3aed", "trending-up"],
		["Gifts", "#db2777", "gift"],
		["Other", "#6b7280", "more-horizontal"],
	];
	return seed.map(([name, color, icon], i) => ({
		id: `cat-${i}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
		name,
		color,
		icon,
		aliases: [],
	}));
}

/** Historical spreadsheet category names, mapped onto the canonical set above. */
export const CATEGORY_ALIAS_SEED: Record<string, string> = {
	food: "Groceries",
	groceries: "Groceries",
	"restaurants & take-out": "Restaurants & Take-Out",
	car: "Car & Travelling",
	"car & travelling": "Car & Travelling",
	travelling: "Car & Travelling",
	shopping: "Shopping & Clothing",
	"shopping & clothing": "Shopping & Clothing",
	"entertainment & recreation": "Entertainment & Recreation",
	other: "Other",
	"other exp.": "Other",
	otherexp: "Other",
	"other inc.": "Salary / Income",
	otherinc: "Salary / Income",
	salary: "Salary / Income",
	"salary/financing": "Salary / Income",
	"allowances/financing": "Salary / Income",
	gift: "Gifts",
	gifts: "Gifts",
	savings: "Savings & Transfers",
	"savings & asset transfers": "Savings & Transfers",
	transfers: "Savings & Transfers",
	investments: "Investments",
	subscriptions: "Subscriptions",
	"payment requests sent": "Other",
	"payment requests paid": "Other",
	reimbursable: "Other",
};
