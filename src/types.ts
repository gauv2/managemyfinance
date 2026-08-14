/** A fully separate set of accounts/categories/transactions/subscriptions — one per person or entity managed. */
export interface Portfolio {
	id: string;
	name: string;
	/** Vault-relative folder this portfolio's data lives under (its own data/ and reports/ subfolders). */
	folder: string;
}

/**
 * Everything you own or owe that carries a balance. The first six are the accounts money actually
 * moves through and gets imported into; the last four are the ones that make net worth true rather
 * than merely bank-shaped — a mortgage you owe, a house you own, a pension you can't spend yet.
 *
 * `loan` and `mortgage` are liabilities: their balances count *against* net worth. See LIABILITY_TYPES.
 */
export type AccountType =
	| "debit"
	| "credit"
	| "investing"
	| "saving"
	| "cash"
	| "crypto"
	| "loan"
	| "mortgage"
	| "property"
	| "pension";

/** Account types whose balance is money owed, not money held — netted out rather than added up. */
export const LIABILITY_TYPES: readonly AccountType[] = ["loan", "mortgage"];

export function isLiabilityType(type: AccountType): boolean {
	return LIABILITY_TYPES.includes(type);
}

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
	/** Credit accounts: the agreed limit, so utilization (balance ÷ limit) can be shown. */
	creditLimit?: number;
	/** Credit accounts: day of the month the statement closes (1-31). */
	statementDay?: number;
	/** Credit accounts: day of the month payment is due (1-31). */
	paymentDueDay?: number;
	/** Annual interest rate as a fraction (0.1999 = 19.99% APR) — credit cards and loans. */
	apr?: number;
	/** Credit accounts: minimum payment as a fraction of the statement balance (0.02 = 2%). */
	minPaymentPct?: number;
}

/**
 * A balance you recorded by hand at a point in time — the fix for every account whose real worth
 * isn't derivable from imported transactions: a house, a pension, a savings account you never export,
 * a brokerage whose market value has drifted far from what you paid for it.
 *
 * Net worth uses the latest snapshot on or before the date being asked about, falling back to
 * opening balance + transactions when there is none. Balances are in the account's own currency.
 */
export interface BalanceSnapshot {
	id: string;
	accountId: string;
	/** "YYYY-MM-DD" — the date this balance was true. */
	date: string;
	/** The account's balance in its own currency. For a liability, the positive amount still owed. */
	balance: number;
	note?: string;
}

/**
 * One run of the import wizard. Every transaction it created carries the batch's id, which is what
 * makes an import undoable — without it, "I just imported the wrong file" has no clean answer.
 */
export interface ImportBatch {
	id: string;
	/** ISO timestamp of when the import ran. */
	importedAt: string;
	source: TransactionSource;
	/** The file the rows came from, purely so the batch is recognizable in a list weeks later. */
	fileName?: string;
	format?: string;
	count: number;
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
	/** "income" flips every budget reading for this category: the number is a target to reach rather
	 *  than a ceiling to stay under, so 120% of an income budget is good news and 120% of an expense
	 *  budget is bad. Unset means "expense", which is what almost every category is. */
	kind?: "expense" | "income";
	/** Carries whatever a month didn't spend (or overspent) into the next month's available budget,
	 *  so an envelope you underspend in January is genuinely bigger in February. Off by default —
	 *  budgets stay simple monthly limits unless you ask for this. */
	rollover?: boolean;
	/** A whole-year envelope, keyed by "YYYY" — for the costs that don't divide sensibly into months
	 *  (annual insurance, road tax, a yearly software renewal). Tracked independently of budgetHistory. */
	annualBudgets?: Record<string, number>;
}

/**
 * A budget that isn't monthly and isn't annual: a named pot for one specific thing over one specific
 * window — a holiday, a kitchen, a wedding. Kept as its own collection rather than as fields on
 * Category because a one-off can span categories and must not disturb the monthly envelope it
 * borrows from.
 */
export interface OneOffBudget {
	id: string;
	name: string;
	amount: number;
	/** "YYYY-MM-DD" bounds, inclusive on both ends. */
	startDate: string;
	endDate: string;
	/** Restricts what counts toward it. Empty/absent means any spending in the window counts. */
	categoryIds?: string[];
	notes?: string;
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
	/** How this one subscription prefers to be quoted, independent of how often it's actually billed —
	 *  a yearly-billed domain renewal you think of as "€15/yr", a monthly SaaS you think of as "€20/mo".
	 *  Unset follows the Subscriptions page's own toggle. Never affects any total, only the wording. */
	displayCycle?: "monthly" | "yearly";
	/** Case-insensitive text matched against a transaction's description + counterparty to suggest
	 *  which ledger rows are payments for this subscription. Set automatically when you link a
	 *  transaction to a subscription (from that transaction's own merchant text), editable after. */
	matchPattern?: string;
}

export type CardType = "debit" | "credit" | "prepaid" | "secured" | "charge";
export type CardNetwork = "visa" | "mastercard" | "amex" | "discover" | "vpay" | "other";

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

/**
 * Where a transaction came from. Also the ledger's own filing system: one folder per source, one CSV
 * per year inside it, so a source is a durable partition of the data rather than a label.
 * "manual" is the one that isn't an importer — it's a row you typed yourself.
 */
export type TransactionSource =
	| "ing"
	| "trade-republic"
	| "generic"
	| "manual"
	| "revolut"
	| "bunq"
	| "n26"
	| "camt"
	| "mt940"
	| "ofx"
	| "qif";

/**
 * How far a transaction has got through your own review pass. "new" is the implicit state of anything
 * that arrived from an import and hasn't been looked at — it's stored as an absent value rather than
 * the literal string, so an existing ledger doesn't need rewriting to gain the concept.
 *
 * "flagged" is deliberately not a failure state: it's the parking space for a row you can't decide
 * about yet, so the review queue can be driven to empty without forcing a wrong category on anything.
 */
export type ReviewStatus = "new" | "approved" | "flagged";

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
	/** Absent means "new" (never reviewed) — see ReviewStatus. */
	review?: ReviewStatus;
	/** Free-text note left while reviewing, e.g. why a row was flagged. Separate from `notes`, which
	 *  describes the transaction itself rather than your handling of it. */
	reviewNote?: string;
	/**
	 * Shared by the two sides of one movement between your own accounts. This is the field that makes
	 * a transfer *knowable* rather than guessable: with both legs tagged, neither counts as income or
	 * expense, and net worth stops moving when money merely changes pockets. Set by the transfer
	 * matcher (src/transfers.ts) or by hand from the transaction detail modal.
	 */
	transferGroupId?: string;
	/** The import run that created this row — see ImportBatch. Absent on manually entered transactions. */
	importBatchId?: string;
	/** The subscription this payment is an instance of, once linked. Drives "what have I actually paid
	 *  for Netflix" and price-increase detection. */
	subscriptionId?: string;
}
