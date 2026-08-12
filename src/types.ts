/** A fully separate set of accounts/categories/transactions/subscriptions — one per person or entity managed. */
export interface Portfolio {
	id: string;
	name: string;
	/** Vault-relative folder this portfolio's data lives under (its own data/ and reports/ subfolders). */
	folder: string;
}

export type AccountType = "debit" | "credit" | "investing" | "saving" | "cash" | "crypto";

export interface Account {
	id: string;
	name: string;
	institution?: string;
	type: AccountType;
	currency: string;
	openingBalance?: number;
	openingDate?: string;
	/** IBAN (or other bank account identifier), used to auto-attribute rows from combined multi-account exports. */
	iban?: string;
}

export interface Category {
	id: string;
	name: string;
	color: string;
	icon: string;
	aliases: string[];
	/** Planned monthly budget, keyed by "YYYY-MM" — kept per month rather than overwritten, so past
	 *  plans survive for year-end budget-planning review (did you over- or under-budget, and where). */
	budgetHistory?: Record<string, number>;
	archived?: boolean;
	/** Id of the primary category this one is nested under. Unset means this is itself a primary category. */
	parentId?: string;
	/** Primary categories only. "breakdown" means the budget is the sum of this category's secondary
	 *  categories' own budgetHistory rather than a number set directly on this category. Defaults to "total". */
	budgetMode?: "total" | "breakdown";
	/** Primary categories only. Set once the default secondary categories have been seeded for this
	 *  category, so deleting them all doesn't cause them to reappear on the next load. */
	defaultSecondariesSeeded?: boolean;
}

export interface CategoryRule {
	id: string;
	pattern: string;
	isRegex?: boolean;
	categoryId: string;
}

export type SubscriptionBillingCycle = "weekly" | "monthly" | "quarterly" | "yearly";
export type SubscriptionPaidVia = "private" | "business";

export interface Subscription {
	id: string;
	name: string;
	plan?: string;
	website?: string;
	category: string;
	cost: number;
	/** ISO 4217 code, e.g. "EUR" / "USD" — missing on subscriptions saved before multi-currency support, treat as "EUR". */
	currency?: string;
	billingCycle: SubscriptionBillingCycle;
	paidVia: SubscriptionPaidVia;
	/** Free-text tag, e.g. "SaaS" / "Not SaaS" — not used for any calculation. */
	kind?: string;
	/** The Account this subscription is actually debited from (optional — unset means unknown/not tracked). */
	accountId?: string;
	nextDueDate: string;
	endDate?: string;
	cancelUrl?: string;
	notes?: string;
	archived?: boolean;
}

export type CardType = "debit" | "credit" | "prepaid" | "secured" | "charge";
export type CardNetwork = "visa" | "mastercard" | "amex" | "discover" | "other";

/**
 * A physical/digital payment card — always linked to exactly one Account, but counted and managed
 * completely separately: an account can have zero cards (a CD, a retirement account), one, or several
 * (a primary + a supplementary debit card on the same checking account).
 */
export interface Card {
	id: string;
	accountId: string;
	/** Your own label, e.g. "Amex Platinum" — also drives the stylized card art (tier/network lookup). */
	name: string;
	/** The name printed on the card — distinct from `name` above, which is just this app's own label for it. */
	cardholderName?: string;
	issuer?: string;
	/** Product tier, e.g. "Platinum", "Sapphire Reserve" — matched against known tiers for the card's look. */
	product?: string;
	network: CardNetwork;
	cardType: CardType;
	/** Full digits, no spaces — never the CVV, which this app never stores. Front face always shows only the last 4. */
	number?: string;
	/** Kept in sync with `number` (its last 4 digits) so cards entered before full-number support still render. */
	last4?: string;
	/** 1-12 */
	expiryMonth?: number;
	/** Full 4-digit year */
	expiryYear?: number;
	isPrimary?: boolean;
	notes?: string;
}

export type TransactionSource = "ing" | "trade-republic" | "generic" | "manual";

export interface Transaction {
	id: string;
	date: string;
	accountId: string;
	description: string;
	counterparty?: string;
	amount: number;
	currency: string;
	categoryId?: string;
	type?: string;
	/** Bank's own transaction code (e.g. ING's "IW", "BA", "GT"). */
	code?: string;
	source: TransactionSource;
	raw?: string;
	notes?: string;
	ticker?: string;
	assetClass?: string;
	shares?: number;
	price?: number;
	fee?: number;
	tax?: number;
	action?: string;
	/** Vault-relative path to a linked receipt/invoice file, e.g. "Finance/attachments/receipt.pdf". */
	attachmentPath?: string;
}
