import { classifyTransaction, isEconomicallyNeutral, type ClassifyStore } from "./finance/semantics";
import { resolveRuleMatch, ruleMatches } from "./import/categorize";
import type { CategoryRule, CategoryRuleMatch, RuleAmountCondition, Transaction } from "./types";

/**
 * What a rule would do to the ledger, grouped by where each matching row currently sits.
 *
 * Separate from the dialog that shows it so the count and the change cannot drift apart: the same
 * function produces the "42 will move" line and, moments later, the list of rows that actually move.
 * A preview computed by one code path and applied by another is a preview you cannot trust, and this
 * is a feature whose entire safety argument rests on the preview being right.
 */
export interface RulePreview {
	/** Matching rows already filed where the rule wants them — no change, but the rule now owns them. */
	alreadyCorrect: Transaction[];
	/** Matching rows with no category at all. The rule fills these in. */
	uncategorized: Transaction[];
	/** Matching rows filed elsewhere, which the rule will move, keyed by their current category id. */
	moving: Map<string, Transaction[]>;
	/**
	 * Matching rows the rule would turn from a money movement into spending — the "Apple Pay top-up"
	 * problem described on `previewRule`. Always reported, whether or not they are being written: the
	 * caller needs the count to offer the opt-in, and a group that vanished the moment you opted in
	 * would leave no way to opt back out. Check `neutralIncluded` for which it is.
	 */
	protectedNeutral: Transaction[];
	/** True when `protectedNeutral` is also being written, i.e. the caller passed `includeNeutral`. */
	neutralIncluded: boolean;
	/** Every matching row, however it is classified above. */
	total: number;
}

export interface RulePreviewStore extends ClassifyStore {
	transactions: Transaction[];
}

/** Rows the rule will write to: the blanks it fills plus the rows it moves. Not `alreadyCorrect`,
 *  and never `protectedNeutral` — opting those in moves them into the buckets above instead. */
export function changedByPreview(preview: RulePreview): Transaction[] {
	return [...preview.uncategorized, ...Array.from(preview.moving.values()).flat()];
}

export function movingCount(preview: RulePreview): number {
	return Array.from(preview.moving.values()).reduce((n, rows) => n + rows.length, 0);
}

/**
 * Unlike the import-time rule pass — which deliberately touches only uncategorized rows — this
 * reports on *every* match, including rows that already carry a different category. Filing the
 * stragglers consistently is the whole point of creating a rule from a transaction you are looking
 * at, and the caller is expected to show `moving` in full before writing anything.
 *
 * One class of row is held back regardless: a match the rule would flip from a money movement into
 * spending. A ledger of Apple purchases also contains "Apple Pay top-up by *1234" — money arriving
 * via a payment method that happens to share the merchant's name — and a pattern of "Apple" sweeps up
 * all 54 of them alongside the 204 real purchases. They are not mis-filed Apple charges to be
 * corrected; they are a different kind of row entirely.
 *
 * The test is deliberately "would this change flip it", not "is it a transfer": each match is
 * classified as it stands and again as it would stand under the new category, and it is protected
 * only when the first is economically neutral and the second is not. So a rule that files things
 * *into* Transfers or Savings moves them freely — nothing is being reclassified — and the rule needs
 * no list of category names of its own, deferring instead to the one classifier the whole plugin
 * shares. `includeNeutral` exists because it is a default, not a veto.
 *
 * An empty pattern or a missing target matches nothing rather than everything: `"".includes()` is
 * true for every string, so the guard is load-bearing, not defensive decoration.
 */
export function previewRule(
	store: RulePreviewStore,
	rule: Pick<CategoryRule, "pattern" | "isRegex" | "match" | "amount">,
	targetCategoryId: string | undefined,
	opts: { includeNeutral?: boolean } = {}
): RulePreview {
	const includeNeutral = !!opts.includeNeutral;
	const preview: RulePreview = {
		alreadyCorrect: [],
		uncategorized: [],
		moving: new Map(),
		protectedNeutral: [],
		neutralIncluded: includeNeutral,
		total: 0,
	};
	if (!rule.pattern.trim() || !targetCategoryId) return preview;

	for (const tx of store.transactions) {
		if (!ruleMatches(tx, rule)) continue;
		preview.total++;

		if (tx.categoryId === targetCategoryId) {
			preview.alreadyCorrect.push(tx);
			continue;
		}

		if (wouldFlipToSpending(store, tx, targetCategoryId)) {
			preview.protectedNeutral.push(tx);
			if (!includeNeutral) continue;
		}

		if (!tx.categoryId) preview.uncategorized.push(tx);
		else {
			const bucket = preview.moving.get(tx.categoryId) ?? [];
			bucket.push(tx);
			preview.moving.set(tx.categoryId, bucket);
		}
	}
	return preview;
}

/** Neutral as it stands, not neutral under the proposed category — i.e. the rule would recast a
 *  movement between your own accounts as money you spent. */
function wouldFlipToSpending(store: ClassifyStore, tx: Transaction, targetCategoryId: string): boolean {
	if (!isEconomicallyNeutral(classifyTransaction(store, tx))) return false;
	return !isEconomicallyNeutral(classifyTransaction(store, { ...tx, categoryId: targetCategoryId }));
}

/**
 * The pattern to offer when creating a rule from one transaction.
 *
 * A branch number is what stops a merchant's rows looking alike — "ALBERT HEIJN 1423 DEN HAAG" and
 * "ALBERT HEIJN 0891 UTRECHT" are the same shop — so the seed is the description up to its first
 * numeric token: "ALBERT HEIJN". Everything after it is branch, city, date or reference.
 *
 * Deliberately *not* `merchantKey`, despite that being the plugin's own idea of a merchant's
 * identity. That key exists for grouping, where both sides are normalised before they meet, so it is
 * free to rewrite the text — it lowercases, folds punctuation to spaces and drops short tokens. A
 * non-regex rule is a raw substring test against the original description, and a rewritten key is not
 * generally a substring of what it came from: "ONLY&SONS" keys to "only sons", which never appears in
 * "only&sons", and "H&M 0123 AMSTERDAM" keys to "amsterdam", which would file every Amsterdam
 * transaction in the ledger under H&M. Cutting a prefix on whitespace can do neither, because the
 * result is a substring of the original by construction.
 *
 * The trailing trim keeps a dangling separator out of the pattern ("TICKETS - 4412" → "TICKETS", not
 * "TICKETS -"), and a description that opens with a number is kept whole rather than reduced to "".
 */
export function seedPatternFor(tx: Pick<Transaction, "description" | "counterparty">): string {
	const raw = tx.counterparty?.trim() || tx.description.trim();
	const words = raw.split(/\s+/);
	const firstNumeric = words.findIndex((w) => /\d/.test(w));
	const head = (firstNumeric > 0 ? words.slice(0, firstNumeric) : words).join(" ");
	return head.replace(/[\s\-\u2013\u2014,;:.]+$/, "").trim() || raw;
}

/**
 * The exact ledger writes a confirmed rule should make.
 *
 * Pure and exported so the destructive step can be tested without a vault: getting this wrong writes
 * to someone's ledger, and "it looked right in the dialog" is not evidence about what gets written.
 *
 * Three decisions live here. Only ticked rows are written — an unticked row keeps its category *and*
 * gets no stamp, because the badge means "this rule filed this row" and a row the rule was told to
 * skip would be lying about its own provenance. Rows already sitting in the target are stamped even
 * though their category doesn't move, so the badge describes every row the rule now governs rather
 * than only those that happened to change today. And a row already stamped by this same rule is left
 * out entirely, so re-confirming an unchanged rule is a no-op rather than a rewrite of every file it
 * touches.
 */
export function rulePatches(
	preview: RulePreview,
	excludedIds: ReadonlySet<string>,
	rule: Pick<CategoryRule, "id" | "categoryId">
): Map<string, Partial<Transaction>> {
	const patches = new Map<string, Partial<Transaction>>();
	for (const tx of changedByPreview(preview)) {
		if (excludedIds.has(tx.id)) continue;
		patches.set(tx.id, { categoryId: rule.categoryId, categoryRuleId: rule.id });
	}
	for (const tx of preview.alreadyCorrect) {
		if (tx.categoryRuleId === rule.id) continue;
		patches.set(tx.id, { categoryId: rule.categoryId, categoryRuleId: rule.id });
	}
	return patches;
}

/**
 * The pattern *and* the match mode to open the dialog with — the narrowest of the two whole-field
 * modes that still matches the row you right-clicked.
 *
 * A ledger holding "Apple" (201 rows, Electronics), "Apple Store" (2 rows), "Apple Pay top-up by
 * *4606" (54 rows, Transfers) and "apple.com/bill" (1 row, Subscriptions) has four merchants sharing
 * one word, and under a substring rule there is no pattern that reaches the first without dragging in
 * the rest. Right-clicking a row whose description *is* the merchant therefore starts at "exact", and
 * the 201 Apple charges can be filed without touching the other 57.
 *
 * Where the seed was cut back from a longer description — "ALBERT HEIJN" out of "ALBERT HEIJN 1423
 * DEN HAAG" — exact would match nothing at all, so those start at "starts with", which is what makes
 * one rule cover every branch. Narrow first either way: widening is one dropdown away and the preview
 * shows the consequence immediately, whereas a rule that quietly swept up a neighbouring merchant is
 * only discovered later, in a total that looks wrong.
 */
export function seedRuleFor(tx: Pick<Transaction, "description" | "counterparty">): { pattern: string; match: CategoryRuleMatch } {
	const pattern = seedPatternFor(tx);
	if (ruleMatches(tx, { pattern, match: "exact" })) return { pattern, match: "exact" };
	if (ruleMatches(tx, { pattern, match: "starts-with" })) return { pattern, match: "starts-with" };
	return { pattern, match: "contains" };
}

export interface AmountGroup {
	/** Absolute amount, rounded to the cent — the value an "is exactly" condition would carry. */
	value: number;
	currency: string;
	count: number;
	/** How many distinct calendar months it appears in, and the median gap in days between charges.
	 *  A monthly subscription shows a gap near 30 across many months; a one-off shows neither. */
	months: number;
	medianGapDays?: number;
}

/**
 * The distinct amounts among a set of matches, commonest first.
 *
 * The answer to "how do I catch these" when every row carries the same description. 201 rows called
 * only "Apple" are a €9.99/month subscription, a €5.99/month one that ran for a year, a €3.49 and a
 * €0.99 both currently active, and a long tail of one-off app purchases — and none of that is visible
 * in the text, because there is no text to read. It is entirely visible in the amounts.
 *
 * The cadence figures are reported, never acted on: "35 charges across 33 months, 30 days apart" is
 * enough for a person to recognise a subscription, and guessing on their behalf would only be right
 * until the first annual plan or the first merchant who bills monthly for something that isn't one.
 *
 * Returns every distinct amount by default. Deciding how many to *show* belongs to the caller, which
 * is the only place that knows which ones the user has already picked — and a picked amount that fell
 * off the end of a truncated list would be one the user could no longer un-pick.
 */
export function amountGroups(transactions: Transaction[], limit = Number.POSITIVE_INFINITY): AmountGroup[] {
	const buckets = new Map<string, { value: number; currency: string; dates: string[]; count: number }>();
	for (const tx of transactions) {
		if (typeof tx.amount !== "number" || !Number.isFinite(tx.amount)) continue;
		const value = Math.round(Math.abs(tx.amount) * 100) / 100;
		const currency = tx.currency || "EUR";
		const key = `${currency}:${value.toFixed(2)}`;
		const bucket = buckets.get(key) ?? { value, currency, dates: [], count: 0 };
		if (tx.date) bucket.dates.push(tx.date);
		bucket.count++;
		buckets.set(key, bucket);
	}
	return Array.from(buckets.values())
		.map((b) => ({
			value: b.value,
			currency: b.currency,
			count: b.count,
			months: new Set(b.dates.map((d) => d.slice(0, 7))).size,
			medianGapDays: medianGapDays(b.dates),
		}))
		.sort((a, b) => b.count - a.count || b.value - a.value)
		.slice(0, limit);
}

/** Median days between consecutive charges, or undefined below three of them — two points are a gap,
 *  not a cadence. */
function medianGapDays(dates: string[]): number | undefined {
	const days = dates
		.map((d) => Date.parse(d))
		.filter((t) => Number.isFinite(t))
		.sort((a, b) => a - b);
	if (days.length < 3) return undefined;
	const gaps: number[] = [];
	for (let i = 1; i < days.length; i++) gaps.push((days[i] - days[i - 1]) / 86_400_000);
	gaps.sort((a, b) => a - b);
	const mid = Math.floor(gaps.length / 2);
	return Math.round(gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2);
}

/**
 * Rows still carrying an edited rule's stamp that the rule no longer matches.
 *
 * Narrowing a rule — dropping an amount from its set, tightening "contains" to "exact" — leaves the
 * rows it used to govern still wearing its badge. They keep their category, because re-filing them to
 * nothing would be a second edit nobody asked for, but they stop claiming this rule put them there,
 * since it no longer would. The patch touches `categoryRuleId` alone and never `categoryId`, which
 * also keeps it clear of the store's own stale-provenance rule (that one fires on patches that *set*
 * a category).
 */
export function staleStampPatches(transactions: Transaction[], rule: CategoryRule): Map<string, Partial<Transaction>> {
	const patches = new Map<string, Partial<Transaction>>();
	for (const tx of transactions) {
		if (tx.categoryRuleId !== rule.id) continue;
		if (ruleMatches(tx, rule)) continue;
		patches.set(tx.id, { categoryRuleId: undefined });
	}
	return patches;
}

/** "€9.99", "€9.99 / €2.99 / €6.99", "≤ €5.00", "€1.00–€10.00" — the condition in as few characters
 *  as stay true. Amounts are formatted by the caller so this stays currency-agnostic. */
export function describeAmountCondition(c: RuleAmountCondition, money: (v: number) => string): string {
	switch (c.op) {
		case "exactly":
			return money(c.value);
		case "any-of": {
			const values = c.values?.length ? c.values : [c.value];
			return values.map(money).join(" / ");
		}
		case "at-most":
			return `\u2264 ${money(c.value)}`;
		case "at-least":
			return `\u2265 ${money(c.value)}`;
		case "between": {
			const lo = Math.min(c.value, c.value2 ?? c.value);
			const hi = Math.max(c.value, c.value2 ?? c.value);
			return `${money(lo)}\u2013${money(hi)}`;
		}
	}
}

const RULE_MATCH_TEXT: Record<CategoryRuleMatch, string> = {
	contains: "contains",
	exact: "exact match",
	"starts-with": "starts with",
	regex: "regex",
};

/**
 * How a rule reaches its rows, in one phrase — "exact match, €9.99" or "contains, ≤ €5.00".
 *
 * One definition shared by the ledger's marker, the rules list and the transaction detail, because
 * three hand-written versions of the same sentence is three chances for one of them to describe a
 * rule the plugin no longer has.
 */
export function describeRuleScope(rule: Pick<CategoryRule, "match" | "isRegex" | "amount">, money: (v: number) => string): string {
	const mode = RULE_MATCH_TEXT[resolveRuleMatch(rule)];
	return rule.amount ? `${mode}, ${describeAmountCondition(rule.amount, money)}` : mode;
}
