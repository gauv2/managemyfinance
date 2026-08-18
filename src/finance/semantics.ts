import { resolvePrimaryId } from "../categories";
import { isLiabilityType, type Account, type Category, type Transaction } from "../types";

/**
 * The one place that decides what a transaction *means*, economically — as opposed to what a bank or
 * broker happened to call it. Provider fields (`action`, `type`, category names) are evidence this
 * module interprets; they are not the financial definition. Every consumer that currently answers "is
 * this income/expense/a transfer" with its own local logic (kpi.ts, reports/query.ts, recurring.ts,
 * insights.ts) is migrated to read `classifyTransaction()` instead, so the same row can never be a
 * transfer on one screen and spending on another.
 *
 * See ManageMyFinance_Financial_Correctness_Audit_and_Remediation_Spec.pdf, FIN-002/004/005 and the
 * "Target financial model" section — this module is exactly the classifier that spec asks for.
 */

export type EconomicKind =
	| "income"
	| "expense"
	| "refund"
	| "internal-transfer"
	| "investment-buy"
	| "investment-sell"
	| "dividend"
	| "interest-income"
	| "investment-fee"
	| "tax"
	| "loan-proceeds"
	| "debt-principal"
	| "debt-interest"
	| "asset-purchase"
	| "asset-sale"
	| "unknown";

export interface ClassifiedTransaction {
	tx: Transaction;
	kind: EconomicKind;
	/** Converted amount in the base currency, when a caller supplies one — this module itself is
	 *  currency-agnostic (classification doesn't depend on FX), so callers that need it convert
	 *  `cashMovement` themselves and may stash the result here for convenience. Left undefined by
	 *  `classifyTransaction`. */
	amountBase?: number;
	/** Positive contribution to economic income. A refund contributes here as 0 — see `affectsExpense`. */
	affectsIncome: number;
	/** Net contribution to economic expense — negative for a refund, so summing this field across a
	 *  set of classified transactions is already the correct net-of-refunds expense total. */
	affectsExpense: number;
	/** True only for a genuine transfer between the user's own accounts (linked or inferred). A trade
	 *  or a debt-principal movement also doesn't affect income/expense, but isn't "a transfer" in this
	 *  narrower sense — check `affectsIncome === 0 && affectsExpense === 0` for the general case. */
	isInternalTransfer: boolean;
	/** The raw signed amount, in the transaction's own currency — cash movement is cash movement
	 *  regardless of economic kind, and this is what a future "all cash flows" view would sum. */
	cashMovement: number;
	/** "explicit": a linked transferGroupId — the only signal that's actually known rather than
	 *  inferred. "derived": classified from category/action/type/account-type evidence. "ambiguous":
	 *  fell through to the raw-sign fallback with no corroborating evidence at all (no category, no
	 *  recognized action/type, no account-type context) — a positive/negative amount that could
	 *  plausibly be several different things. */
	confidence: "explicit" | "derived" | "ambiguous";
}

export interface ClassifyStore {
	accounts: Account[];
	categories: Category[];
}

const TRANSFER_CATEGORY_NAMES = new Set(["transfers", "savings", "savings & transfers"]);
const TRANSFER_ACCOUNT_MARKERS = new Set(["deposit", "withdraw", "withdrawal"]);
const TRADE_ACTION_MARKERS = new Set(["buy", "sell"]);
/** Account types a trade action can occur in — anywhere a security or coin is actually held. */
const TRADE_ACCOUNT_TYPES = new Set(["investing", "crypto"]);

function normalizedAction(tx: Transaction): string {
	return (tx.action ?? "").trim().toLowerCase();
}
function normalizedType(tx: Transaction): string {
	return (tx.type ?? "").trim().toLowerCase();
}

function accountOf(store: ClassifyStore, tx: Transaction): Account | undefined {
	return store.accounts.find((a) => a.id === tx.accountId);
}

function categoryOf(store: ClassifyStore, categoryId: string | undefined): Category | undefined {
	if (!categoryId) return undefined;
	return store.categories.find((c) => c.id === categoryId);
}

/** Whether this store can tell income apart from a refund at all — ported unchanged from kpi.ts's
 *  original refundsDistinguishable(). A vault where nothing is flagged as income keeps the old
 *  sign-only reading rather than quietly reclassifying a salary as a negative expense. */
function refundsDistinguishable(store: ClassifyStore): boolean {
	return store.categories.some((c) => c.kind === "income");
}

/** Dividends and interest payouts, identified from the broker action/type text. */
function passiveIncomeWord(text: string): "dividend" | "interest" | undefined {
	if (/dividend/.test(text)) return "dividend";
	if (/interest/.test(text)) return "interest";
	return undefined;
}

function result(
	tx: Transaction,
	kind: EconomicKind,
	confidence: ClassifiedTransaction["confidence"],
	opts: { affectsIncome?: number; affectsExpense?: number; isInternalTransfer?: boolean } = {}
): ClassifiedTransaction {
	return {
		tx,
		kind,
		affectsIncome: opts.affectsIncome ?? 0,
		affectsExpense: opts.affectsExpense ?? 0,
		isInternalTransfer: opts.isInternalTransfer ?? false,
		cashMovement: tx.amount,
		confidence,
	};
}

/**
 * The single economic classification of one transaction. Every other module's "is this a
 * transfer/income/expense" question should be answered by reading this result, not by re-deriving it.
 *
 * Priority order (per the spec): explicit transferGroupId first, then normalized provider action/type
 * evidence, then account context, then category-based fallback. A category name/kind is real evidence
 * but never overrides a trade action — a sell proceeds row mis-categorized under "Income" still
 * classifies as investment-sell, not income, because the account+action evidence is stronger than a
 * category someone may have picked without thinking about it.
 */
export function classifyTransaction(store: ClassifyStore, tx: Transaction): ClassifiedTransaction {
	const amount = tx.amount;

	// 1. Linked transfer — the one signal that's actually known, not inferred.
	if (tx.transferGroupId) {
		return result(tx, "internal-transfer", "explicit", { isInternalTransfer: true });
	}

	const account = accountOf(store, tx);
	const action = normalizedAction(tx);
	const type = normalizedType(tx);

	// 2. Trade inside any account that actually holds positions — investing or crypto alike (FIN-004:
	//    this used to be gated to account.type === "investing" only). Checked ahead of category
	//    evidence on purpose: a sale mis-categorized under an income-kind category must still read as
	//    investment-sell, per the spec's FIN-006 acceptance test.
	if (account && TRADE_ACCOUNT_TYPES.has(account.type) && TRADE_ACTION_MARKERS.has(action)) {
		return result(tx, action === "buy" ? "investment-buy" : "investment-sell", "derived");
	}

	// 3. Cash moving into/out of a savings/investing/crypto account under its own action/type text.
	if (account && (account.type === "saving" || TRADE_ACCOUNT_TYPES.has(account.type))) {
		if (TRANSFER_ACCOUNT_MARKERS.has(action) || TRANSFER_ACCOUNT_MARKERS.has(type)) {
			return result(tx, "internal-transfer", "derived", { isInternalTransfer: true });
		}
	}

	// 4. Passive income — dividend/interest/staking-style rewards, wherever the account holding them.
	const passiveWord = passiveIncomeWord(`${action} ${type}`);
	if (passiveWord && amount >= 0) {
		return result(tx, passiveWord === "dividend" ? "dividend" : "interest-income", "derived", { affectsIncome: amount });
	}
	// TR-style cashback-into-investing reward: real income, not trade principal.
	if ((action === "saveback" || type === "saveback") && amount >= 0) {
		return result(tx, "income", "derived", { affectsIncome: amount });
	}

	// 5. Category-declared transfer (older "Savings & Transfers" vocabulary, kept for back-compat).
	const primaryId = resolvePrimaryId(store.categories, tx.categoryId);
	const primaryCategory = categoryOf(store, primaryId);
	if (primaryCategory && TRANSFER_CATEGORY_NAMES.has(primaryCategory.name.trim().toLowerCase())) {
		return result(tx, "internal-transfer", "derived", { isInternalTransfer: true });
	}

	// 6. Refund into an expense category — money returning against a purchase, not new income. Checked
	//    ahead of the debt-principal rule below on purpose: a merchant refund credited back onto a
	//    credit card is still a refund against that category's spend, and a categorized positive row is
	//    much stronger evidence of "refund" than the bare fact that the account happens to carry debt.
	//    Getting this order backwards silently folded ordinary card refunds into debt-principal, which
	//    understated the refunded category's spend instead of netting against it.
	const refunds = refundsDistinguishable(store);
	if (amount >= 0 && refunds && primaryCategory && primaryCategory.kind !== "income") {
		return result(tx, "refund", "derived", { affectsExpense: -amount });
	}

	// 7. Debt-carrying account (credit card, loan, mortgage): a credit reduces what's owed — a payment
	//    or principal repayment, a balance-sheet movement, not income to that account. Charges (debits)
	//    fall through to the ordinary expense case below, which is already correct for card purchases.
	//    Only reached once rule 6 above has ruled out a categorized refund. Principal-vs-interest
	//    splitting proper arrives once Transaction carries the fields for it (FIN-012); until then, a
	//    bare uncategorized (or non-refund-categorized) credit here is presumptively principal.
	if (account && (isLiabilityType(account.type) || account.type === "credit") && amount >= 0) {
		return result(tx, "debt-principal", "derived");
	}

	// 8. Fallback: plain sign-based income/expense, using whatever category evidence exists to set
	//    confidence rather than kind.
	const hasEvidence = !!tx.categoryId || !!action || !!type;
	const confidence: ClassifiedTransaction["confidence"] = hasEvidence ? "derived" : "ambiguous";
	if (amount >= 0) return result(tx, "income", confidence, { affectsIncome: amount });
	return result(tx, "expense", confidence, { affectsExpense: -amount });
}

/** Convenience: whether a transaction should be excluded from every income/expense figure — the
 *  general case (`affectsIncome === 0 && affectsExpense === 0`), broader than `isInternalTransfer`
 *  since it also covers trades and debt-principal movements. */
export function isEconomicallyNeutral(classified: ClassifiedTransaction): boolean {
	return classified.affectsIncome === 0 && classified.affectsExpense === 0;
}
