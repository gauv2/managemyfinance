import type { Category, Transaction } from "../types";
import { merchantDisplayName, merchantKey, merchantSourceText } from "./merchantKey";

/**
 * What the app has learned about one merchant. Stored per portfolio in data/merchants.json — plain,
 * inspectable, and editable outside the plugin like everything else it writes.
 */
export interface MerchantEntry {
	/** The normalized key from merchantKey(). */
	key: string;
	/** The category every transaction from this merchant should get. */
	categoryId?: string;
	/** Where the decision came from — a category you set yourself always outranks a guess. */
	source: "user" | "rule" | "ai";
	/** ISO date the decision was last changed. */
	at: string;
	/** Set when a suggestion was rejected without choosing a category. Keeps the merchant out of the
	 *  next AI batch — "that guess is wrong" is worth remembering even though it names no answer. */
	dismissedAt?: string;
	/** Set when a person has looked at this merchant's category and said it is right — either by
	 *  accepting a proposed change or by explicitly keeping the existing one. Distinct from having a
	 *  category at all, which merely means something once assigned one. A recheck skips these by
	 *  default, so confirming a merchant is what stops it being raised again every single pass. */
	reviewedAt?: string;
	/** An AI answer that wasn't confident enough to apply on its own. Sits here until you accept or
	 *  reject it, so an uncertain guess never quietly becomes a category. */
	suggestion?: {
		categoryId: string;
		confidence: number;
		model: string;
		at: string;
	};
}

export type MerchantMap = Record<string, MerchantEntry>;

/** Precedence: your own decisions beat AI answers, which beat keyword-rule matches. */
const SOURCE_RANK: Record<MerchantEntry["source"], number> = { user: 3, ai: 2, rule: 1 };

function outranks(next: MerchantEntry["source"], current: MerchantEntry["source"]): boolean {
	return SOURCE_RANK[next] >= SOURCE_RANK[current];
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

/**
 * Records that a merchant belongs to a category. Refuses to downgrade: a rule match never overwrites
 * a category you chose yourself, so re-running auto-categorization can't undo your corrections.
 */
export function remember(map: MerchantMap, key: string, categoryId: string, source: MerchantEntry["source"]): MerchantMap {
	const existing = map[key];
	if (existing?.categoryId && !outranks(source, existing.source)) return map;
	// Choosing a category clears any dismissal — the merchant is settled now.
	//
	// `reviewedAt` is carried across rather than dropped. It records that a person has ruled on this
	// merchant, which remains true after the category is written again by an import, an auto-categorize
	// pass or a fan-out from a sibling row. Rebuilding the entry without it silently un-confirmed
	// merchants, so the count of "already confirmed" moved on its own depending on which code path had
	// run last — and the recheck dialog kept re-offering work that had already been done by hand.
	return {
		...map,
		[key]: {
			key,
			categoryId,
			source,
			at: today(),
			reviewedAt: existing?.reviewedAt,
			suggestion: undefined,
			dismissedAt: undefined,
		},
	};
}

/**
 * Records that a person has confirmed this merchant's category — whether by accepting a proposed
 * change or by looking at one and keeping what was already there.
 *
 * Both are the same statement to the recheck pass ("a human has ruled on this"), which is why
 * rejecting a proposal is stored rather than discarded: a recheck that keeps raising the same
 * merchant you have already dismissed twice stops being something anyone runs.
 */
export function markReviewed(map: MerchantMap, key: string, categoryId: string | undefined): MerchantMap {
	const existing = map[key];
	return {
		...map,
		[key]: {
			key,
			categoryId: categoryId ?? existing?.categoryId,
			source: "user",
			at: today(),
			reviewedAt: today(),
			suggestion: undefined,
			dismissedAt: existing?.dismissedAt,
		},
	};
}

/** Parks an AI answer that fell below the confidence bar. Never touches a settled category. */
export function rememberSuggestion(
	map: MerchantMap,
	key: string,
	suggestion: { categoryId: string; confidence: number; model: string }
): MerchantMap {
	const existing = map[key];
	if (existing?.categoryId) return map;
	return {
		...map,
		[key]: {
			key,
			source: existing?.source ?? "ai",
			at: existing?.at ?? today(),
			categoryId: existing?.categoryId,
			suggestion: { ...suggestion, at: today() },
		},
	};
}

/**
 * Drops a parked suggestion without categorizing the merchant, and remembers that it was dismissed so
 * the same guess isn't offered again on the next pass. The merchant stays uncategorized on purpose —
 * "this suggestion is wrong" is not the same statement as "here is the right answer".
 */
export function dismissSuggestion(map: MerchantMap, key: string): MerchantMap {
	const existing = map[key];
	return {
		...map,
		[key]: {
			key,
			source: "user",
			at: today(),
			categoryId: existing?.categoryId,
			dismissedAt: today(),
			suggestion: undefined,
		},
	};
}

/**
 * Turns parked suggestions into real categories.
 *
 * A suggestion is an answer the model already gave that was held back for approval. That design had a
 * hole: unknownMerchants() skips a merchant that has a suggestion (so it is never re-asked), but the
 * suggestion itself was never applied — so 147 merchants sat with an answer in the vault, their rows
 * permanently uncategorized, and the AI panel reported almost nothing left to ask about.
 *
 * Called whenever low-confidence answers are being applied, which is the default. Costs no requests:
 * the answers are already here.
 */
export function applyPendingSuggestions(map: MerchantMap): { map: MerchantMap; keys: Set<string> } {
	const keys = new Set<string>();
	let next = map;
	for (const [key, entry] of Object.entries(map)) {
		if (entry.categoryId || !entry.suggestion || entry.dismissedAt) continue;
		next = {
			...next,
			[key]: { ...entry, categoryId: entry.suggestion.categoryId, source: "ai", suggestion: undefined },
		};
		keys.add(key);
	}
	return { map: next, keys };
}

/**
 * Builds merchant knowledge out of transactions you've already categorized.
 *
 * This is what makes the feature work on day one rather than only on transactions you touch from now
 * on: 391 already-categorized rows are 391 decisions you've made, and every one of them tells the app
 * something about a merchant it can apply to the rows you haven't reached yet.
 *
 * Where a merchant's history disagrees with itself, the majority wins — but only a clear majority. A
 * merchant split near-evenly between two categories is genuinely ambiguous (a supermarket you buy both
 * groceries and petrol from), and guessing there would silently rewrite real history.
 */
export function learnFromHistory(transactions: Transaction[], existing: MerchantMap = {}): MerchantMap {
	const votes = new Map<string, Map<string, number>>();
	for (const tx of transactions) {
		if (!tx.categoryId) continue;
		const key = merchantKey(tx);
		if (!key) continue;
		if (!votes.has(key)) votes.set(key, new Map());
		const byCategory = votes.get(key)!;
		byCategory.set(tx.categoryId, (byCategory.get(tx.categoryId) ?? 0) + 1);
	}

	let map = existing;
	for (const [key, byCategory] of votes) {
		// A category you set explicitly is never overridden by inference from history.
		if (map[key]?.source === "user") continue;

		const ranked = Array.from(byCategory.entries()).sort((a, b) => b[1] - a[1]);
		const [topCategory, topCount] = ranked[0];
		const total = ranked.reduce((sum, [, n]) => sum + n, 0);
		// Needs a clear majority — a 50/50 merchant is ambiguous, not decided.
		if (topCount * 2 <= total && ranked.length > 1) continue;

		map = remember(map, key, topCategory, "user");
	}
	return map;
}

export interface MemoryApplyResult {
	/** Transaction id → category id, ready for store.updateTransactions(). */
	patches: Map<string, string>;
	/** How many distinct merchants contributed. */
	merchants: number;
}

/**
 * Applies everything known about merchants to transactions that don't have a category yet. Never
 * touches a categorized row — this fills gaps, it doesn't re-file your ledger.
 */
export function applyMemory(transactions: Transaction[], map: MerchantMap, categories: Category[]): MemoryApplyResult {
	const valid = new Set(categories.map((c) => c.id));
	const patches = new Map<string, string>();
	const merchants = new Set<string>();

	for (const tx of transactions) {
		if (tx.categoryId) continue;
		const key = merchantKey(tx);
		if (!key) continue;
		const entry = map[key];
		// A category that has since been deleted must not be re-applied to anything.
		if (!entry?.categoryId || !valid.has(entry.categoryId)) continue;
		patches.set(tx.id, entry.categoryId);
		merchants.add(key);
	}

	return { patches, merchants: merchants.size };
}

/** Every transaction sharing a merchant with `tx` — what "apply to the other N from this shop" acts on. */
export function siblingsOf(transactions: Transaction[], tx: Transaction): Transaction[] {
	const key = merchantKey(tx);
	if (!key) return [];
	return transactions.filter((t) => t.id !== tx.id && merchantKey(t) === key);
}

/**
 * Distinct merchants with no category yet and no parked suggestion — exactly the list worth sending
 * to a model, and the reason an AI pass costs one classification per merchant rather than per row.
 */
export interface UnknownMerchant {
	key: string;
	count: number;
	/** The most informative original description seen for this merchant — what a person, or a model,
	 *  is actually shown. The key is a two-word grouping token and is far too lossy to classify from. */
	name: string;
}

export function unknownMerchants(transactions: Transaction[], map: MerchantMap): UnknownMerchant[] {
	const counts = new Map<string, number>();
	const names = new Map<string, string>();
	for (const tx of transactions) {
		if (tx.categoryId) continue;
		const key = merchantKey(tx);
		if (!key) continue;
		const entry = map[key];
		if (entry?.categoryId || entry?.suggestion || entry?.dismissedAt) continue;
		counts.set(key, (counts.get(key) ?? 0) + 1);
		// From the same field the key came from. Preferring the description here regardless meant a card
		// payment was grouped correctly under its shop and then labelled — and sent to the model — as
		// the terminal line, "CAPELLE AAN Pas: 4333". The classifier was still being asked what category
		// a city belongs to, long after the grouping had been fixed.
		//
		// Longest wins among candidates: "Koninklijke PostNL B.V." carries more for a classifier than
		// "PostNL", and the extra words cost nothing at this scale.
		const candidate = merchantDisplayName(merchantSourceText(tx));
		if (candidate && candidate.length > (names.get(key) ?? "").length) names.set(key, candidate);
	}
	return Array.from(counts.entries())
		.map(([key, count]) => ({ key, count, name: names.get(key) || key }))
		.sort((a, b) => b.count - a.count);
}

/** Drops entries whose category no longer exists, so a deleted category can't linger as memory. */
export function pruneMemory(map: MerchantMap, categories: Category[]): MerchantMap {
	const valid = new Set(categories.map((c) => c.id));
	const out: MerchantMap = {};
	for (const [key, entry] of Object.entries(map)) {
		const categoryId = entry.categoryId && valid.has(entry.categoryId) ? entry.categoryId : undefined;
		const suggestion = entry.suggestion && valid.has(entry.suggestion.categoryId) ? entry.suggestion : undefined;
		// A dismissal names no category but is still a decision, so it survives pruning — otherwise a
		// rejected suggestion would be offered again on the very next pass.
		if (!categoryId && !suggestion && !entry.dismissedAt) continue;
		out[key] = { ...entry, categoryId, suggestion };
	}
	return out;
}
