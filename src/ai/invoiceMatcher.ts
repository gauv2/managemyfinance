import type { ExtractedFields } from "../invoiceExtract";
import type { AiRanking, InvoiceDocument, InvoiceMatchPlan } from "../invoiceMatch";
import { merchantDisplayName } from "../import/merchantKey";
import {
	buildInvoiceExtractPrompt,
	buildInvoiceRankPrompt,
	INVOICE_EXTRACT_SYSTEM_PROMPT,
	INVOICE_RANK_SYSTEM_PROMPT,
	invoiceExtractSchema,
	invoiceRankSchema,
	validateInvoiceExtract,
	validateInvoiceRanking,
	type AiRankCandidate,
} from "./invoicePrompt";
import { extractJson } from "./prompt";
import { callModel, type AiSettings, type ModelAttachment } from "./provider";

/**
 * The two optional round trips, and everything that happens when they don't come back.
 *
 * Both passes are enhancements to a result that already exists. Reading a document improves the fields
 * the deterministic scorer works from; ranking improves the order of a shortlist that scorer produced.
 * Neither is load-bearing, which is why every failure path here ends in "carry on with what we have"
 * rather than an exception — a rate limit on the seventh receipt must not throw away the six matches
 * already found, and a vault with AI switched off must reach the same results screen, only emptier.
 */

export interface InvoiceAiOutcome {
	/** Documents Claude read that local parsing couldn't. */
	read: number;
	/** Documents whose shortlist Claude re-ranked. */
	ranked: number;
	/** Requests that failed outright. The batch continues; the count is shown. */
	failures: number;
	/** The last failure's message, for the non-blocking notice. */
	lastError?: string;
	model: string;
	/** Answers thrown out by validation, surfaced rather than silently dropped. */
	rejected: { ref: string; reason: string }[];
}

export function emptyAiOutcome(): InvoiceAiOutcome {
	return { read: 0, ranked: 0, failures: 0, model: "", rejected: [] };
}

/**
 * Asks Claude to read one document.
 *
 * `attachment` is the file itself, and it is present precisely when nothing local could read it — a
 * photographed receipt, or a PDF that turned out to be a scan. When local extraction did produce text
 * but the label parser couldn't make sense of the layout, the text goes instead and the file stays
 * where it is: it answers the same question for a fraction of the payload and without uploading a
 * document that has the user's home address on it.
 */
export async function aiReadDocument(
	doc: InvoiceDocument,
	localText: string | undefined,
	attachment: ModelAttachment | undefined,
	settings: AiSettings
): Promise<{ fields: ExtractedFields; model: string }> {
	const { raw, model } = await callModel(
		{
			system: INVOICE_EXTRACT_SYSTEM_PROMPT,
			user: buildInvoiceExtractPrompt(doc.filename, localText),
			schema: invoiceExtractSchema(),
			attachments: attachment ? [attachment] : undefined,
		},
		settings
	);
	return { fields: validateInvoiceExtract(extractJson(raw)), model };
}

/**
 * The shortlist as the model sees it: a per-request label, the date, the cleaned merchant name, and the
 * amount.
 *
 * The label is an index, not a transaction id. Ids are internal and mean nothing to a reader, and
 * sending them would put a vault identifier in a request for no benefit — the mapping back lives here,
 * in a Map that never leaves the function that built it.
 */
function shortlistFor(plan: InvoiceMatchPlan, docId: string): { candidates: AiRankCandidate[]; txByRef: Map<string, string> } {
	const proposal = plan.proposals.find((p) => p.doc.id === docId);
	const candidates: AiRankCandidate[] = [];
	const txByRef = new Map<string, string>();

	proposal?.candidates.forEach((candidate, index) => {
		const ref = `t${index + 1}`;
		txByRef.set(ref, candidate.tx.id);
		candidates.push({
			ref,
			date: candidate.tx.date,
			merchant: merchantDisplayName(candidate.tx.description || candidate.tx.counterparty || "") || candidate.tx.description,
			amount: candidate.tx.amount,
			currency: candidate.tx.currency,
		});
	});

	return { candidates, txByRef };
}

/**
 * Runs the ranking pass over a whole plan, one request per document that has something to rank.
 *
 * A document with a single candidate is skipped: there is no ordering to improve, and the one thing a
 * model could add — "actually none of these" — is not something the safeguards would act on anyway,
 * since a lone candidate that already scored well is judged on its own evidence. A document with no
 * candidates is skipped for the same reason, and both keep the bill down on a batch of ten.
 */
export async function aiRankPlan(
	plan: InvoiceMatchPlan,
	settings: AiSettings,
	onProgress?: (done: number, total: number) => void
): Promise<{ rankings: AiRanking[]; outcome: InvoiceAiOutcome }> {
	const outcome = emptyAiOutcome();
	outcome.model = settings.model ?? "";

	const rankable = plan.proposals.filter((p) => p.candidates.length > 1);
	const rankings: AiRanking[] = [];

	for (let i = 0; i < rankable.length; i++) {
		const proposal = rankable[i];
		const { candidates, txByRef } = shortlistFor(plan, proposal.doc.id);
		try {
			const { raw, model } = await callModel(
				{
					system: INVOICE_RANK_SYSTEM_PROMPT,
					user: buildInvoiceRankPrompt(proposal.doc, candidates),
					schema: invoiceRankSchema(),
				},
				settings
			);
			outcome.model = model;
			const validated = validateInvoiceRanking(extractJson(raw), candidates);
			outcome.rejected.push(...validated.rejected);
			rankings.push({
				docId: proposal.doc.id,
				verdicts: validated.verdicts
					.map((verdict) => ({
						txId: txByRef.get(verdict.ref) ?? "",
						confidence: verdict.confidence,
						reason: verdict.reason,
					}))
					.filter((verdict) => !!verdict.txId),
			});
			outcome.ranked++;
		} catch (e) {
			outcome.failures++;
			outcome.lastError = e instanceof Error ? e.message : String(e);
		}
		onProgress?.(i + 1, rankable.length);
	}

	return { rankings, outcome };
}

/** The non-blocking notice shown when the AI pass did something, or failed to. */
export function describeAiOutcome(outcome: InvoiceAiOutcome): string | undefined {
	const parts: string[] = [];
	if (outcome.read > 0) parts.push(`Claude read ${outcome.read} document${outcome.read === 1 ? "" : "s"}`);
	if (outcome.ranked > 0) parts.push(`re-ranked ${outcome.ranked} shortlist${outcome.ranked === 1 ? "" : "s"}`);
	if (outcome.failures > 0) {
		parts.push(
			`${outcome.failures} request${outcome.failures === 1 ? "" : "s"} failed${outcome.lastError ? ` (${outcome.lastError})` : ""} — the matches below are the deterministic ones`
		);
	}
	if (outcome.rejected.length > 0) {
		parts.push(`${outcome.rejected.length} invalid answer${outcome.rejected.length === 1 ? "" : "s"} discarded`);
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}
