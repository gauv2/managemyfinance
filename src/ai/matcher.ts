import { merchantDisplayName, merchantKey } from "../import/merchantKey";
import type { Transaction } from "../types";
import { buildMatchPrompt, matchResponseSchema, MATCH_SYSTEM_PROMPT, validateMatches, type MatchCandidate, type MatchVerdict } from "./matchPrompt";
import { extractJson } from "./prompt";
import { callModel, type AiSettings } from "./provider";

/**
 * Asks Claude which other merchants in the ledger are the same payee as one you're reviewing.
 *
 * The cost model is the same as the categorization pass, and for the same reason: it asks about
 * *merchants*, not transactions. A ledger of 4,000 rows is usually 300-600 distinct shops, so one
 * question covers the whole ledger in a handful of round trips instead of thousands.
 *
 * What is sent is exactly what the categorization pass sends, minus the category tree: merchant names
 * and nothing else. No amounts, no dates, no account names, no IBANs, no balances.
 */

/** Names per request. Each item is a short string, so this can be far larger than the 60 the
 *  categorization pass uses — fewer round trips for the same tokens. */
const BATCH_SIZE = 150;

/**
 * Ceiling on how many distinct merchants one question covers.
 *
 * A ledger with 2,000 merchants would otherwise be 14 requests for a single click, which is not a
 * cost anyone agreed to by pressing a button labelled "Ask Claude". Candidates are ranked by how many
 * transactions sit behind them, so the cap keeps the merchants that actually matter — and when it
 * bites, the result says so rather than quietly reporting on a slice.
 */
export const MAX_CANDIDATES = 400;

export interface AiMatch extends MatchVerdict {
	/** The transactions behind that merchant — what a bulk action would actually touch. */
	transactions: Transaction[];
	/** The readable name the model was shown and judged. */
	name: string;
}

export interface AiMatchResult {
	matches: AiMatch[];
	/** Distinct merchants actually sent. */
	asked: number;
	/** Distinct merchants that existed to ask about, before the cap. */
	available: number;
	/** True when `available` exceeded the cap, so the answer covers only the busiest merchants. */
	truncated: boolean;
	/** Answers thrown out by validation, with the reason. */
	rejected: { merchant: string; reason: string }[];
	model: string;
}

export interface CandidatePool {
	subjectName: string;
	subjectKey?: string;
	candidates: MatchCandidate[];
	available: number;
	truncated: boolean;
	/** Every candidate's transactions, keyed by merchant key, for turning verdicts back into rows. */
	byKey: Map<string, Transaction[]>;
}

/**
 * Builds the list of merchants worth asking about.
 *
 * Deliberately *not* pre-filtered by string similarity. Filtering candidates by how much they already
 * look like the subject would remove exactly the answers this pass exists to find — "AH TO GO" scores
 * near zero against "Albert Heijn", which is the whole reason a metric couldn't find it.
 */
export function buildCandidatePool(
	transactions: Transaction[],
	subject: Transaction,
	opts: { exclude?: Set<string>; eligible?: (tx: Transaction) => boolean; limit?: number } = {}
): CandidatePool {
	const limit = opts.limit ?? MAX_CANDIDATES;
	const eligible = opts.eligible ?? ((): boolean => true);
	const subjectKey = merchantKey(subject);

	const byKey = new Map<string, Transaction[]>();
	const names = new Map<string, string>();

	for (const tx of transactions) {
		if (tx.id === subject.id || !eligible(tx)) continue;
		const key = merchantKey(tx);
		if (!key || key === subjectKey) continue;
		if (opts.exclude?.has(key)) continue;

		const bucket = byKey.get(key);
		if (bucket) bucket.push(tx);
		else byKey.set(key, [tx]);

		// Keep the longest cleaned description, same as the categorization pass: "Koninklijke PostNL
		// B.V." carries more for a judgement than "PostNL", and the extra words cost nothing here.
		const candidate = merchantDisplayName(tx.description || tx.counterparty || "");
		if (candidate && candidate.length > (names.get(key) ?? "").length) names.set(key, candidate);
	}

	const all: MatchCandidate[] = Array.from(byKey.entries())
		.map(([key, txs]) => ({ key, name: names.get(key) || key, count: txs.length }))
		.sort((a, b) => b.count - a.count);

	return {
		// No fallback to the raw description. merchantDisplayName only comes back empty when the text
		// genuinely holds no name — a bare reference number — and falling back would send exactly that
		// to the model, which cannot judge it and would be billed for saying so.
		subjectName: merchantDisplayName(subject.description || subject.counterparty || ""),
		subjectKey,
		candidates: all.slice(0, limit),
		available: all.length,
		truncated: all.length > limit,
		byKey,
	};
}

/**
 * Runs the pass: batches the candidate names, validates every reply, and turns surviving verdicts
 * back into the transactions a bulk action would touch.
 *
 * A batch that fails takes only itself down — the merchants in the batches that did answer are still
 * returned, because losing a whole pass to one transient 429 would be a worse outcome than a partial
 * answer the user can see the size of.
 */
export async function aiFindMatches(
	pool: CandidatePool,
	settings: AiSettings,
	onProgress?: (done: number, total: number) => void
): Promise<AiMatchResult> {
	const result: AiMatchResult = {
		matches: [],
		asked: pool.candidates.length,
		available: pool.available,
		truncated: pool.truncated,
		rejected: [],
		model: settings.model ?? "",
	};

	if (!pool.subjectName.trim()) {
		throw new Error("This transaction's description has no merchant name in it to match against.");
	}
	if (pool.candidates.length === 0) return result;

	const verdicts: MatchVerdict[] = [];
	let failures = 0;
	let lastError: unknown;

	for (let i = 0; i < pool.candidates.length; i += BATCH_SIZE) {
		const batch = pool.candidates.slice(i, i + BATCH_SIZE);
		try {
			const { raw, model } = await callModel(
				{
					system: MATCH_SYSTEM_PROMPT,
					user: buildMatchPrompt(pool.subjectName, batch),
					schema: matchResponseSchema(),
				},
				settings
			);
			result.model = model;
			const validated = validateMatches(extractJson(raw), batch, pool.subjectKey);
			verdicts.push(...validated.verdicts);
			result.rejected.push(...validated.rejected);
		} catch (e) {
			failures++;
			lastError = e;
		}
		onProgress?.(Math.min(i + BATCH_SIZE, pool.candidates.length), pool.candidates.length);
	}

	// Only a total wipeout is an error worth stopping for; anything else is a partial answer, and the
	// caller reports how much of the ledger it actually covered.
	if (failures > 0 && verdicts.length === 0 && result.rejected.length === 0) {
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}
	if (failures > 0) result.truncated = true;

	result.matches = verdicts
		.map((verdict) => {
			const transactions = pool.byKey.get(verdict.merchant) ?? [];
			const candidate = pool.candidates.find((c) => c.key === verdict.merchant);
			return { ...verdict, transactions, name: candidate?.name ?? verdict.merchant };
		})
		.filter((m) => m.transactions.length > 0);

	return result;
}

/** One-line summary for the notice shown when a pass finishes. */
export function describeMatchResult(result: AiMatchResult): string {
	if (result.asked === 0) return "Nothing else in the ledger to compare this against.";
	const rows = result.matches.reduce((sum, m) => sum + m.transactions.length, 0);
	if (result.matches.length === 0) {
		return `Claude found no other merchant matching this one, out of ${result.asked} checked.`;
	}
	const parts = [
		`${result.matches.length} merchant${result.matches.length === 1 ? "" : "s"} matched (${rows} transaction${rows === 1 ? "" : "s"})`,
		`${result.asked} checked`,
	];
	if (result.truncated) parts.push(`of ${result.available} — busiest merchants only`);
	if (result.rejected.length > 0) parts.push(`${result.rejected.length} invalid answer${result.rejected.length === 1 ? "" : "s"} discarded`);
	return parts.join(" · ");
}
