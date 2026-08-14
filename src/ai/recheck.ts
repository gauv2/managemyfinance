import { merchantDisplayName, merchantKey } from "../import/merchantKey";
import type { MerchantMap } from "../import/merchantMemory";
import type { Category, Transaction } from "../types";
import { classifyMerchants, type AiSettings } from "./provider";

/**
 * A second opinion on categories you already have.
 *
 * The categorization pass only ever touches rows with no category, which is right for an import but
 * leaves a blind spot that grows with the ledger: everything a keyword rule got wrong in 2023 is
 * still wrong, still filed under the wrong heading, and quietly bending every total that reads it.
 * Nothing in the app ever revisits those, because nothing had a reason to.
 *
 * The method is deliberately *not* "here is my category, is it right?". Showing the model the current
 * answer anchors it — it agrees with whatever it is shown, and a reviewer that agrees with everything
 * finds nothing. So the merchants are classified cold, exactly as the import pass classifies an
 * unknown one, and the disagreements are the output. Same prompt, same validation, same guardrails;
 * the only new thing here is the diff.
 *
 * Nothing is ever applied automatically. A recheck that silently rewrote your ledger would be the
 * single most destructive thing this plugin could do, and no confidence score justifies it.
 */

/** Merchants per pass. Same reasoning as the matcher's cap: a click shouldn't cost fourteen requests. */
export const MAX_RECHECK_MERCHANTS = 400;

/**
 * Confidence below which a disagreement isn't worth raising.
 *
 * Asymmetric on purpose, and the opposite way round from the import pass. There, a low-confidence
 * guess still beats leaving a row uncategorized, so the bar is low. Here, every proposal costs you
 * the attention of judging it against a category you already chose — so a weak proposal is worse
 * than a missed one, and the bar is high.
 */
export const PROPOSAL_FLOOR = 0.6;

export interface CategoryProposal {
	/** The merchant key — what the change is actually applied to. */
	key: string;
	name: string;
	currentCategoryId: string;
	proposedCategoryId: string;
	confidence: number;
	/** Every row that would change if this proposal is accepted. */
	transactions: Transaction[];
}

/** A merchant the model returned the existing category for — a genuine second opinion in favour. */
export interface AgreedMerchant {
	key: string;
	name: string;
	categoryId: string;
	transactions: Transaction[];
}

/**
 * A merchant the pass could not settle either way.
 *
 * Carried in full rather than counted, because "21 left alone" is not something anyone can act on
 * and "these 21, and here is what the model nearly said about each" is. The withheld suggestion is
 * the interesting part: seeing three near-misses at 55% is what tells you the confidence floor is
 * set wrong, or that a category is missing from your tree.
 */
export type UnsettledReason = "uncertain" | "unrecognized";

export interface UnsettledMerchant {
	key: string;
	name: string;
	currentCategoryId: string;
	transactions: Transaction[];
	reason: UnsettledReason;
	/** "uncertain" only: what it wanted to say, and how sure it was. */
	suggestedCategoryId?: string;
	confidence?: number;
}

export interface RecheckResult {
	/** Merchants actually sent for a second opinion. */
	checked: number;
	/** Merchants that existed to check, before the cap and before skips. */
	available: number;
	/**
	 * Merchants the model returned the already-assigned category for.
	 *
	 * Carried as keys rather than a count because these are the only merchants a pass has actually
	 * settled: the caller marks exactly these confirmed, and deliberately leaves the low-confidence
	 * and unanswered ones alone so a later run picks them up again.
	 */
	agreed: AgreedMerchant[];
	proposals: CategoryProposal[];
	/**
	 * Everything neither agreed nor proposed: near-misses below the confidence floor, and merchants
	 * the model declined to place at all. Deliberately left unconfirmed so a later run retries them.
	 */
	unsettled: UnsettledMerchant[];
	/** Merchants deliberately left out — see buildRecheckTargets. */
	skipped: { splitAcrossCategories: number; alreadyReviewed: number; noReadableName: number };
	/** Answers thrown out by validation, with the reason. */
	rejected: { merchant: string; reason: string }[];
	/** True when the cap bit, or a batch failed, so the pass covered only part of the ledger. */
	truncated: boolean;
	model: string;
}

export interface RecheckTarget {
	key: string;
	name: string;
	currentCategoryId: string;
	transactions: Transaction[];
}

export interface RecheckTargets {
	targets: RecheckTarget[];
	available: number;
	truncated: boolean;
	skipped: { splitAcrossCategories: number; alreadyReviewed: number; noReadableName: number };
}

/**
 * The merchants worth a second opinion, and the two kinds this deliberately leaves alone.
 *
 * A merchant whose rows are genuinely split across categories is skipped, because the split is
 * usually a decision rather than a mistake — a supermarket you buy both groceries and petrol from,
 * an electronics shop that sold you both a gift and a work tool. There is no single "current
 * category" to disagree with, and proposing one would flatten a distinction you drew on purpose.
 * (This is the same clear-majority test learnFromHistory uses to decide what it can infer.)
 *
 * A merchant already confirmed by a person is skipped too, unless asked for explicitly. Raising the
 * same merchant on every pass after you have twice said it's fine is how a review tool trains you to
 * stop reading it.
 */
export function buildRecheckTargets(
	transactions: Transaction[],
	memory: MerchantMap,
	opts: { includeReviewed?: boolean; limit?: number } = {}
): RecheckTargets {
	const limit = opts.limit ?? MAX_RECHECK_MERCHANTS;

	const rows = new Map<string, Transaction[]>();
	const votes = new Map<string, Map<string, number>>();
	const names = new Map<string, string>();

	for (const tx of transactions) {
		if (!tx.categoryId) continue;
		const key = merchantKey(tx);
		if (!key) continue;

		const bucket = rows.get(key);
		if (bucket) bucket.push(tx);
		else rows.set(key, [tx]);

		if (!votes.has(key)) votes.set(key, new Map());
		const byCategory = votes.get(key)!;
		byCategory.set(tx.categoryId, (byCategory.get(tx.categoryId) ?? 0) + 1);

		const candidate = merchantDisplayName(tx.description || tx.counterparty || "");
		if (candidate && candidate.length > (names.get(key) ?? "").length) names.set(key, candidate);
	}

	const skipped = { splitAcrossCategories: 0, alreadyReviewed: 0, noReadableName: 0 };
	const all: RecheckTarget[] = [];

	for (const [key, byCategory] of votes) {
		if (!opts.includeReviewed && memory[key]?.reviewedAt) {
			skipped.alreadyReviewed++;
			continue;
		}

		const ranked = Array.from(byCategory.entries()).sort((a, b) => b[1] - a[1]);
		const [topCategory, topCount] = ranked[0];
		const total = ranked.reduce((sum, [, n]) => sum + n, 0);
		if (ranked.length > 1 && topCount * 2 <= total) {
			skipped.splitAcrossCategories++;
			continue;
		}

		const name = names.get(key);
		// No readable name means nothing a model could judge — the same reason the matcher refuses.
		// Counted rather than dropped in silence: these used to vanish from every total, so the tallies
		// on screen added up to fewer merchants than the vault holds and the difference was unexplained.
		if (!name) {
			skipped.noReadableName++;
			continue;
		}

		all.push({
			key,
			name,
			currentCategoryId: topCategory,
			// Only the rows actually sitting in the current category change if a proposal is accepted;
			// a stray row already filed elsewhere isn't part of what was proposed.
			transactions: (rows.get(key) ?? []).filter((t) => t.categoryId === topCategory),
		});
	}

	// Busiest merchants first: when the cap bites, a wrong category on 200 rows matters more than one
	// on a single row, and this is the only ordering that makes the cap land on the cheap end.
	all.sort((a, b) => b.transactions.length - a.transactions.length);

	return {
		targets: all.slice(0, limit),
		available: all.length,
		truncated: all.length > limit,
		skipped,
	};
}

/**
 * Runs the pass and returns the disagreements.
 *
 * A batch that fails takes only itself down, exactly as in the matcher: a partial second opinion the
 * user can see the size of beats losing the whole pass to one transient rate limit.
 */
export async function aiRecheckCategories(
	prepared: RecheckTargets,
	categories: Category[],
	settings: AiSettings,
	onProgress?: (done: number, total: number) => void
): Promise<RecheckResult> {
	const result: RecheckResult = {
		checked: prepared.targets.length,
		available: prepared.available,
		agreed: [],
		proposals: [],
		unsettled: [],
		skipped: prepared.skipped,
		rejected: [],
		truncated: prepared.truncated,
		model: settings.model ?? "",
	};
	if (prepared.targets.length === 0) return result;

	const validIds = new Set(categories.filter((c) => !c.archived).map((c) => c.id));
	const byKey = new Map(prepared.targets.map((t) => [t.key, t]));
	const answered = new Set<string>();

	let failures = 0;
	let lastError: unknown;

	// Smaller than the matcher's batches: each item here carries the whole category tree's worth of
	// context in the reply, and this is the same request shape the import pass already tunes at 60.
	const BATCH_SIZE = 60;
	for (let i = 0; i < prepared.targets.length; i += BATCH_SIZE) {
		const batch = prepared.targets.slice(i, i + BATCH_SIZE);
		try {
			const response = await classifyMerchants(
				batch.map((t) => ({ key: t.key, name: t.name })),
				categories,
				settings
			);
			result.model = response.model;
			result.rejected.push(...response.rejected);

			for (const assignment of response.assignments) {
				const target = byKey.get(assignment.merchant);
				if (!target) continue;
				answered.add(assignment.merchant);

				if (assignment.categoryId === target.currentCategoryId) {
					result.agreed.push({
						key: target.key,
						name: target.name,
						categoryId: target.currentCategoryId,
						transactions: target.transactions,
					});
					continue;
				}
				// A category that has since been deleted must never be proposed as a destination.
				if (!validIds.has(assignment.categoryId)) continue;
				if (assignment.confidence < PROPOSAL_FLOOR) {
					result.unsettled.push({
						key: target.key,
						name: target.name,
						currentCategoryId: target.currentCategoryId,
						transactions: target.transactions,
						reason: "uncertain",
						suggestedCategoryId: assignment.categoryId,
						confidence: assignment.confidence,
					});
					continue;
				}

				result.proposals.push({
					key: target.key,
					name: target.name,
					currentCategoryId: target.currentCategoryId,
					proposedCategoryId: assignment.categoryId,
					confidence: assignment.confidence,
					transactions: target.transactions,
				});
			}
		} catch (e) {
			failures++;
			lastError = e;
		}
		onProgress?.(Math.min(i + BATCH_SIZE, prepared.targets.length), prepared.targets.length);
	}

	if (failures > 0 && answered.size === 0 && result.rejected.length === 0) {
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}
	if (failures > 0) result.truncated = true;

	for (const target of prepared.targets) {
		if (answered.has(target.key)) continue;
		result.unsettled.push({
			key: target.key,
			name: target.name,
			currentCategoryId: target.currentCategoryId,
			transactions: target.transactions,
			reason: "unrecognized",
		});
	}
	// Most confident first, then by blast radius: the proposals worth reading are the ones the model
	// is sure about and that move the most money.
	result.proposals.sort((a, b) => b.confidence - a.confidence || b.transactions.length - a.transactions.length);
	return result;
}

/** Near-misses: the model disagreed, but not confidently enough to be worth raising. */
export function countUncertain(result: RecheckResult): number {
	return result.unsettled.filter((u) => u.reason === "uncertain").length;
}

/** Merchants the model declined to place at all. */
export function countUnrecognized(result: RecheckResult): number {
	return result.unsettled.filter((u) => u.reason === "unrecognized").length;
}

/**
 * The status line for a finished pass — what was looked at, what was left alone, and why.
 *
 * Deliberately says what it *didn't* do as loudly as what it did. "23 proposals" alone reads as a
 * complete audit; "23 proposals · 289 agreed · 41 skipped as deliberately split" is the same number
 * with its coverage attached, which is the difference between a report and a claim.
 */
export function describeRecheck(result: RecheckResult): string {
	if (result.checked === 0) {
		if (result.skipped.alreadyReviewed > 0) {
			return `Nothing to recheck — all ${result.skipped.alreadyReviewed} categorized merchants have already been confirmed.`;
		}
		return "Nothing to recheck — no categorized merchants in this portfolio yet.";
	}

	const parts = [
		result.proposals.length === 0
			? `No changes proposed across ${result.checked} merchants`
			: `${result.proposals.length} change${result.proposals.length === 1 ? "" : "s"} proposed across ${result.checked} merchants`,
	];
	if (result.agreed.length > 0) parts.push(`${result.agreed.length} confirmed as-is`);
	if (countUncertain(result) > 0) parts.push(`${countUncertain(result)} too uncertain to raise`);
	if (countUnrecognized(result) > 0) parts.push(`${countUnrecognized(result)} unrecognized`);
	if (result.skipped.splitAcrossCategories > 0) parts.push(`${result.skipped.splitAcrossCategories} skipped as deliberately split`);
	if (result.skipped.alreadyReviewed > 0) parts.push(`${result.skipped.alreadyReviewed} already confirmed`);
	if (result.truncated) parts.push(`busiest ${result.checked} of ${result.available} only`);
	if (result.rejected.length > 0) parts.push(`${result.rejected.length} invalid answer${result.rejected.length === 1 ? "" : "s"} discarded`);
	return parts.join(" · ");
}
