/** A fully separate set of accounts/categories/transactions/subscriptions — one per person or entity managed. */
export interface Portfolio {
	id: string;
	name: string;
	/** Vault-relative folder this portfolio's data lives under (its own data/ and reports/ subfolders). */
	folder: string;
}

/**
 * How this portfolio's owner wants to budget: against the calendar, or against their own pay
 * cycle (see payCycle.ts) for anyone paid on a day other than the 1st. Per portfolio rather than
 * a plugin-wide setting, since two portfolios can genuinely belong to two different people with
 * two different paydays — stored alongside the portfolio's own data (budgeting.json), not in the
 * global plugin settings, matching every other piece of data that's specific to one portfolio.
 */
export interface PortfolioBudgetingSettings {
	/** Defaults to "calendar" — a portfolio with no budgeting.json yet behaves exactly as before. */
	periodMode: "calendar" | "payCycle";
	/** Which category's incoming money marks a payday. Required to derive any cycle at all. */
	salaryCategoryId?: string;
	/** Below this many days apart, a second income row in that category is treated as a bonus
	 *  riding along with the same payday rather than a new cycle boundary — see payCycle.ts. */
	minCycleGapDays?: number;
	/**
	 * Whether — and how — what a period didn't spend (or overspent) carries into the next one's
	 * available budget, for every category at once. Defaults to `"off"`: budgets stay simple fixed
	 * limits, resetting every period.
	 *
	 * One dial for the whole portfolio rather than a per-category setting — twenty categories each
	 * with an independent switch means the overall philosophy is never actually stated anywhere, just
	 * whatever accumulated from individual clicks, and it's easy to end up with an inconsistency
	 * (debt discipline on one category, free rollover on another) nobody consciously chose.
	 *
	 * `"full"`: both directions carry — an envelope you underspend is genuinely bigger next period,
	 * and an overspend eats into it. `"debt"`: only overspend carries, as a debt against yourself —
	 * underspending is never banked as a bonus, so a category never grows past its own plan; it can
	 * only be brought back to plan by staying under it. See `rolloverInto` in budgets.ts, which is
	 * the one place this is computed — the clamp that makes `"debt"` one-directional lives there.
	 */
	rolloverMode?: "off" | "full" | "debt";
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

/** Account types spendable within days, with no risk of loss between "decide to use it" and "have it"
 *  — the pool a runway or emergency-reserve figure should draw from. Excludes investing/crypto: those
 *  may need to be sold at a loss exactly when the money is needed most. */
export const LIQUID_TYPES: readonly AccountType[] = ["debit", "saving", "cash"];

export function isLiquidType(type: AccountType): boolean {
	return LIQUID_TYPES.includes(type);
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
	/**
	 * A closed/cancelled account whose history you still want. Presentation only, deliberately: every
	 * transaction, balance, snapshot, report and net-worth figure counts exactly as before, so ticking
	 * this can never move a number. It moves the account into the sidebar's "Closed" group and takes
	 * it out of the pickers that file *new* activity, which is the whole point — an account you can no
	 * longer spend from shouldn't be offered as a destination, but the eight years it was open are
	 * still real. Mirrors `Category.archived` and `Subscription.archived`.
	 */
	archived?: boolean;
	/**
	 * `false` means this account keeps no running balance: a register of what happened, not a
	 * reconciled book.
	 *
	 * Plenty of real use is like that — years of a closed account imported for the history, a cash
	 * wallet nobody counts, a shared account you only record your own side of. For those a balance is
	 * not merely unknown, it is meaningless, and a tool that insists on one turns every import into an
	 * exercise in making a number come out right.
	 *
	 * Untracked accounts are left out of every net-worth total rather than counted as zero: an unknown
	 * balance and a zero balance are different claims and only one of them is true here. Their
	 * transactions still count everywhere else — spending, budgets, categories and reports are about
	 * what happened, which is exactly what a register knows. Absent means tracked, so nothing that
	 * exists today changes.
	 */
	trackBalance?: boolean;
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
	/** A whole-year envelope, keyed by "YYYY" — for the costs that don't divide sensibly into months
	 *  (annual insurance, road tax, a yearly software renewal). Tracked independently of budgetHistory. */
	annualBudgets?: Record<string, number>;
	/** Marks this as a non-negotiable living expense (rent, groceries, utilities) rather than
	 *  discretionary spending. Used only to suggest an income-loss reserve target in the Strategy
	 *  feature — unset means "not flagged either way", not "not essential". */
	essential?: boolean;
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

/**
 * How a rule's pattern is compared against a transaction.
 *
 * "contains" is the original behaviour and stays the fallback for every rule written before this
 * existed. The other two non-regex modes exist because a substring can't express "this merchant and
 * not the one whose name starts the same way": a ledger holding both "Apple" and "Apple Store" — two
 * merchants, two categories — has no substring that catches the first without the second.
 */
export type CategoryRuleMatch = "contains" | "exact" | "starts-with" | "regex";

export type RuleAmountOp = "exactly" | "any-of" | "between" | "at-most" | "at-least";

/**
 * An optional amount test on top of a rule's text match.
 *
 * Some merchants bill everything under one description. 201 rows described only "Apple" hold a
 * €9.99/month subscription, a €5.99/month one that ended, and a long tail of one-off app purchases —
 * no text can tell them apart, because there is no text. The amount is the only thing left.
 *
 * Compared on the *absolute* amount, in the transaction's own currency: people think in "the €9.99
 * charge", not "-9.99", and a refund of a subscription belongs with the subscription rather than
 * outside it. No FX conversion — a rule about €9.99 should not start matching a different sum because
 * a rate moved.
 */
export interface RuleAmountCondition {
	op: RuleAmountOp;
	value: number;
	/** Upper bound, "between" only. */
	value2?: number;
	/**
	 * "any-of" only: the set of amounts to accept. A merchant that bills one description at several
	 * price points needs several of them in one rule — the €9.99 and €2.99 and €6.99 subscriptions
	 * belong in one category, and three separate rules over the same pattern would be three things to
	 * keep in step, in an order where the first match wins.
	 */
	values?: number[];
}

export interface CategoryRule {
	id: string;
	pattern: string;
	/** Narrows the text match further; unset means "any amount". */
	amount?: RuleAmountCondition;
	/** Superseded by `match`, kept so rules written before it keep working (and so does anything else
	 *  still reading this flag). `match: "regex"` is written alongside it, never instead of it. */
	isRegex?: boolean;
	/** Unset means "contains", or "regex" when `isRegex` is set — see `resolveRuleMatch`. */
	match?: CategoryRuleMatch;
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
/** Which way a debt points. "owe" is money you owe someone; "owed" is money owed to you. */
export type DebtDirection = "owe" | "owed";

export type DebtCounterpartyKind = "person" | "company" | "bank" | "other";

/**
 * One debt between you and someone else — a bank, a company, or a person.
 *
 * Deliberately a register and nothing more. It records who, how much, since when, when it is due and
 * whether it is settled, and it touches no other figure in the plugin: net worth, budgets and every
 * report are exactly as they were with or without it. That is the whole point. A forgotten €20 to a
 * friend has no business quietly reshaping a headline number, and the alternative — asking every debt
 * to be reconciled before it can be written down — is how a note-to-self becomes bookkeeping.
 *
 * Distinct from the debt-carrying *accounts* the Strategy page plans a payoff for. Those are real
 * accounts with balances and APRs. These are the ones that live on a scrap of paper.
 */
export interface Debt {
	id: string;
	/** Who the debt is with. Free text: a bank, a shop, a person. */
	counterparty: string;
	kind?: DebtCounterpartyKind;
	direction: DebtDirection;
	/** The original amount, always positive — `direction` carries which way it points. */
	amount: number;
	currency: string;
	/** Repaid so far, positive. Absent means nothing yet. */
	paid?: number;
	/** When the debt started, ISO. */
	date: string;
	dueDate?: string;
	settledDate?: string;
	notes?: string;
	/** Optionally the account it relates to — a reference only, never a balance adjustment. */
	accountId?: string;
}

export type TransactionSource =
	| "ing"
	| "trade-republic"
	| "generic"
	| "manual"
	| "revolut"
	| "bunq"
	| "n26"
	| "knab"
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
	/**
	 * The `CategoryRule` that decided this row's category, when one did. Provenance, not a second
	 * source of truth: `categoryId` above is still the only thing anything reads to know the category.
	 * This exists so the ledger can say *why* a row is filed where it is — a rule you wrote once and
	 * forgot is otherwise indistinguishable from a category you chose deliberately. Cleared the moment
	 * the category is set by any other means (by hand, by merchant memory, by a later rule).
	 */
	categoryRuleId?: string;
	/** The subscription this payment is an instance of, once linked. Drives "what have I actually paid
	 *  for Netflix" and price-increase detection. */
	subscriptionId?: string;
	/**
	 * A debt payment's split into what actually reduces the balance versus what it truly cost — a
	 * mortgage or loan installment is rarely 100% principal (v1.2.7 remediation Phase 4, FIN-012).
	 * All three are in the transaction's own currency; when set, `principalAmount + interestAmount +
	 * feeAmount` should sum to (approximately) `amount`. Optional and independent — a plain credit-card
	 * payoff with no split set is still read as pure principal, exactly as before these fields existed;
	 * the classifier (src/finance/semantics.ts) only changes its reading of a debt-carrying account's
	 * payment when at least one of `interestAmount`/`feeAmount` is actually present.
	 */
	principalAmount?: number;
	/** Real cost of carrying the debt — an economic expense, unlike the principal portion. */
	interestAmount?: number;
	/** A fee bundled into the same debt payment (e.g. a loan servicing fee) — also an economic expense. */
	feeAmount?: number;
}

export type GoalKind = "reserve-buffer" | "reserve-income-loss" | "debt-payoff" | "custom";

/**
 * One entry in the goal register: something being saved toward, distinct from OneOffBudget (which
 * caps spending in a window rather than accumulating savings toward a target).
 */
export interface FinancialGoal {
	id: string;
	name: string;
	targetAmount: number;
	/** "YYYY-MM-DD" — optional, not every goal has a deadline. */
	deadline?: string;
	/** Lower number = higher priority. Drives the register's default sort. */
	priority: number;
	/**
	 * How the current amount is known. "manual" is typed and updated by hand — the fallback for a goal
	 * with no single account behind it. "account" mirrors one Account's live balance. "computed" is for
	 * the auto-populated starter goals (reserve, debt-to-zero), whose current amount is an aggregate
	 * this app already knows how to calculate — storing it again as a manual number would only drift
	 * from the accounts it's supposed to reflect.
	 */
	trackingMode: "manual" | "account" | "computed";
	/** trackingMode "manual" only. */
	manualCurrentAmount?: number;
	/** trackingMode "account" only. */
	linkedAccountId?: string;
	kind: GoalKind;
	notes?: string;
	archived?: boolean;
	createdAt: string;
}

export interface ReservePlan {
	/** Buffer for one unexpected expense — a free-entry target, not derived from a formula. */
	bufferTarget: number;
	/** Income-loss reserve, expressed in months of essential spending. */
	incomeLossMonths: number;
}

export type DebtPayoffStrategy = "avalanche" | "snowball";

export interface DebtPayoffPlan {
	strategy: DebtPayoffStrategy;
	/** Debt-carrying accounts included in the plan — the order/progress itself is always recomputed
	 *  live from current balances/APR; this only records which accounts count and which method. */
	includedAccountIds: string[];
}

export interface SavingsPolicy {
	targetSavingsRatePct: number;
	horizonNotes?: string;
	riskNotes?: string;
}

export type ReviewCadence = "monthly" | "quarterly" | "annual";

export interface StrategyReview {
	cadence: ReviewCadence;
	lastReviewedAt?: string;
	nextReviewDate?: string;
}

/**
 * One living financial plan — the output of the wizard's six-step cycle (situation, goals,
 * alternatives, evaluation, action, review), checked against real data on the Strategy page.
 * A singleton per portfolio, not a collection — see FinanceStore.strategy.
 */
export interface Strategy {
	/** Unset until the wizard has been finished once. */
	completedAt?: string;
	reserve: ReservePlan;
	debtPlan: DebtPayoffPlan;
	goals: FinancialGoal[];
	savingsPolicy: SavingsPolicy;
	rules: string[];
	review: StrategyReview;
}
