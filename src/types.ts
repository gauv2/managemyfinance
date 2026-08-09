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
	budget?: number;
	archived?: boolean;
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
	issuer?: string;
	/** Product tier, e.g. "Platinum", "Sapphire Reserve" — matched against known tiers for the card's look. */
	product?: string;
	network: CardNetwork;
	cardType: CardType;
	last4?: string;
	/** MM/YY */
	expiry?: string;
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
