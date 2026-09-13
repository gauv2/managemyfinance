import { merchantKey } from "../import/merchantKey";
import { applyPendingSuggestions, remember, rememberSuggestion, unknownMerchants, type MerchantMap } from "../import/merchantMemory";
import type { Category, ReviewStatus, Transaction } from "../types";
import { classifyMerchants, DEFAULT_CONFIDENCE_THRESHOLD, type AiSettings } from "./provider";

/** Merchants per request. Small enough that one bad batch is cheap to lose, large enough that a
 *  typical import is one or two round trips rather than dozens. */
const BATCH_SIZE = 60;

export interface AiCategorizeResult {
	/** Distinct merchants sent for classification. */
	asked: number;
	/** Confident enough to apply on their own. */
	applied: number;
	/** Answered below the bar. Applied and marked flagged when applyLowConfidence is on (the default),
	 *  otherwise parked as a suggestion for the review queue. */
	flagged: number;
	/** Asked about but the model declined to guess. */
	unanswered: number;
	/** Answers thrown out by validation, with the reason. */
	rejected: { merchant: string; reason: string }[];
	/** Transaction id → the patch to write, for store.updateTransactions(). Carries `review` so a
	 *  low-confidence answer lands categorized *and* flagged, rather than silently trusted. */
	patches: Map<string, Partial<Transaction>>;
	/** The merchant memory after this pass, ready to persist. */
	memory: MerchantMap;
	model: string;
}

/**
 * Classifies the merchants nothing else could identify, then turns those answers into transaction
 * patches via merchant memory.
 *
 * Two things make this cheap and consistent rather than expensive and erratic:
 *
 * 1. It asks about *merchants*, not transactions. 300 uncategorized rows are usually 60-100 distinct
 *    shops, so the request is an order of magnitude smaller — and the same merchant cannot come back
 *    two different ways in two different batches, which is where transaction-level classification
 *    quietly loses its accuracy.
 * 2. Every answer is written into merchant memory, so a merchant is classified once, ever. The next
 *    import matches it for free with no request at all.
 *
 * Answers at or above the confidence threshold are applied; the rest are parked as suggestions so an
 * uncertain guess reaches the review queue instead of the ledger.
 */
export async function aiCategorize(
	transactions: Transaction[],
	categories: Category[],
	memory: MerchantMap,
	settings: AiSettings,
	onProgress?: (done: number, total: number) => void
): Promise<AiCategorizeResult> {
	const threshold = settings.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
	// Default on: leaving a row uncategorized to await approval is the worse outcome, because an
	// uncategorized row is invisible in every total while a flagged one is findable in Review.
	const applyLow = settings.applyLowConfidence !== false;

	// Answers already given but held back for approval cost nothing to apply and must not be re-asked.
	let working = memory;
	const lowConfidence = new Set<string>();
	if (applyLow) {
		const pending = applyPendingSuggestions(working);
		working = pending.map;
		pending.keys.forEach((k) => lowConfidence.add(k));
	}

	const targets = unknownMerchants(transactions, working).map((m) => ({ key: m.key, name: m.name }));

	const result: AiCategorizeResult = {
		asked: targets.length,
		applied: 0,
		flagged: 0,
		unanswered: 0,
		rejected: [],
		patches: new Map(),
		memory: working,
		model: settings.model ?? "",
	};
	// Even with nothing new to ask, the newly-applied suggestions still produce patches below.
	if (targets.length === 0) {
		applyPatches(result, transactions, working, lowConfidence);
		return result;
	}

	const answered = new Set<string>();
	let map = working;

	for (let i = 0; i < targets.length; i += BATCH_SIZE) {
		const batch = targets.slice(i, i + BATCH_SIZE);
		const response = await classifyMerchants(batch, categories, settings);
		result.model = response.model;
		result.rejected.push(...response.rejected);

		for (const assignment of response.assignments) {
			answered.add(assignment.merchant);
			if (assignment.confidence >= threshold) {
				map = remember(map, assignment.merchant, assignment.categoryId, "ai");
				result.applied++;
			} else if (applyLow) {
				// Applied now, flagged for review — the behaviour `applyLowConfidence` has always claimed
				// and never delivered for answers given in the same run. Parking them meant a merchant
				// left the "unrecognized" list (it now has a memory entry) while its rows stayed
				// uncategorized, because `applyPatches` needs a categoryId and a parked suggestion has
				// none. The answer only took effect on the *next* pass, so asking once looked like the
				// model had barely helped, and asking twice quietly did the rest.
				map = remember(map, assignment.merchant, assignment.categoryId, "ai");
				lowConfidence.add(assignment.merchant);
				result.flagged++;
			} else {
				map = rememberSuggestion(map, assignment.merchant, {
					categoryId: assignment.categoryId,
					confidence: assignment.confidence,
					model: response.model,
				});
				result.flagged++;
			}
		}
		onProgress?.(Math.min(i + BATCH_SIZE, targets.length), targets.length);
	}

	result.unanswered = targets.filter((t) => !answered.has(t.key)).length;
	result.memory = map;
	applyPatches(result, transactions, map, lowConfidence);
	return result;
}

/** Turns everything merchant memory now knows into per-transaction patches. */
function applyPatches(
	result: AiCategorizeResult,
	transactions: Transaction[],
	map: MerchantMap,
	lowConfidence: Set<string>
): void {
	for (const tx of transactions) {
		if (tx.categoryId) continue;
		const key = merchantKey(tx);
		if (!key) continue;
		const entry = map[key];
		if (!entry?.categoryId || entry.source !== "ai") continue;
		const review: ReviewStatus | undefined = lowConfidence.has(key) ? "flagged" : undefined;
		result.patches.set(tx.id, review ? { categoryId: entry.categoryId, review } : { categoryId: entry.categoryId });
	}
}

/** One-line summary for the Notice shown when a pass finishes. */
export function describeAiResult(r: AiCategorizeResult, taggedRows: number): string {
	if (r.asked === 0) return "Nothing left for the AI — every merchant is already known.";
	const parts = [`${r.applied + r.flagged} of ${r.asked} merchants categorized`];
	if (taggedRows > 0) parts.push(`${taggedRows} transaction${taggedRows === 1 ? "" : "s"} updated`);
	if (r.flagged > 0) parts.push(`${r.flagged} flagged as uncertain`);
	if (r.unanswered > 0) parts.push(`${r.unanswered} unrecognized`);
	if (r.rejected.length > 0) parts.push(`${r.rejected.length} invalid answer${r.rejected.length === 1 ? "" : "s"} discarded`);
	return parts.join(" · ");
}
