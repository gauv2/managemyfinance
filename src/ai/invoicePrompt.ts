import type { ExtractedFields } from "../invoiceExtract";
import type { InvoiceDocument } from "../invoiceMatch";

/**
 * Everything the model is asked about a receipt, and everything it is trusted with.
 *
 * Same arrangement as matchPrompt.ts and for the same reason: these are pure functions, so what leaves
 * the vault is a value a test can assert on and the dialog can print in full before anything is sent.
 * That matters more here than anywhere else in the plugin, because this is the one pass where the thing
 * being sent is a *document* — a real invoice with a real address on it — rather than a merchant name.
 *
 * Two separate questions, deliberately kept separate:
 *
 * 1. Reading a document. Sent when local parsing came up short, which for a photographed till receipt
 *    is always. The model sees the file and nothing else — no ledger, no amounts, no account names.
 * 2. Ranking a shortlist. Sent with the handful of transactions the deterministic pass already found
 *    plausible, never the period and never the ledger. The answer is a re-ordering suggestion; the
 *    safeguards in invoiceMatch.ts are applied afterwards and are not the model's to override.
 */

export const INVOICE_EXTRACT_SYSTEM_PROMPT = [
	"You read invoices and receipts and report the few facts needed to reconcile one against a bank statement.",
	"",
	"Rules:",
	"- Report only what the document actually shows. Leave a field out rather than inferring it.",
	"- vendor is the business that was paid, not the customer and not the payment processor.",
	"- date is the invoice or receipt date in YYYY-MM-DD form, never the due date and never today's date.",
	"- total is the amount actually payable — the gross including tax, after any discount. A plain positive number, no currency symbol, no thousands separators, a dot for the decimal point.",
	"- currency is the ISO code (EUR, USD, GBP…).",
	"- invoiceNumber is the document's own reference. reference is a separate payment reference, order number or the last digits of the card, when one is shown.",
	"- Set credit to true only when the document is a credit note, refund or reversal — money going back to the customer.",
	"- If the document is unreadable, return an empty object. Do not guess.",
].join("\n");

/**
 * The user turn for a reading request.
 *
 * The filename is included because people name receipts usefully and the model should be allowed to use
 * that; whatever local text extraction managed is included for the same reason, since a scrambled
 * column of PDF text that defeated the label parser is still perfectly legible to a reader.
 */
export function buildInvoiceExtractPrompt(filename: string, text?: string): string {
	const lines = [`Filename: ${filename}`];
	if (text?.trim()) {
		lines.push(
			"",
			"Text extracted from the document (layout is lost, so fields may be out of order):",
			text.trim().slice(0, 6000)
		);
	} else {
		lines.push("", "No text could be extracted locally; read the attached document itself.");
	}
	lines.push(
		"",
		'Reply with JSON only: {"vendor":"…","date":"YYYY-MM-DD","total":0,"currency":"EUR","invoiceNumber":"…","reference":"…","credit":false}',
		"Omit any field the document does not show."
	);
	return lines.join("\n");
}

export function invoiceExtractSchema(): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			vendor: { type: "string" },
			date: { type: "string" },
			total: { type: "number" },
			currency: { type: "string" },
			invoiceNumber: { type: "string" },
			reference: { type: "string" },
			credit: { type: "boolean" },
		},
		additionalProperties: false,
	};
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Keeps only fields that are the shape they claim to be.
 *
 * Every one of these has a downstream consumer that would misbehave quietly rather than loudly on bad
 * input: a total of "49,99" as a string sails through `Math.abs` as NaN and matches nothing, a date of
 * "12 April" makes every day-gap undefined, and a currency of "euros" conflicts with "EUR" on every row
 * in the period and zeroes the whole batch. So each is checked here rather than at the point it breaks.
 */
export function validateInvoiceExtract(parsed: unknown): ExtractedFields {
	const row = (parsed ?? {}) as Record<string, unknown>;
	const fields: ExtractedFields = {};

	if (typeof row.vendor === "string" && row.vendor.trim()) fields.vendor = row.vendor.trim().slice(0, 80);
	if (typeof row.date === "string" && ISO_DATE.test(row.date.trim())) fields.date = row.date.trim();
	if (typeof row.total === "number" && isFinite(row.total)) fields.total = Math.abs(row.total);
	if (typeof row.currency === "string" && /^[A-Za-z]{3}$/.test(row.currency.trim())) {
		fields.currency = row.currency.trim().toUpperCase();
	}
	if (typeof row.invoiceNumber === "string" && row.invoiceNumber.trim()) {
		fields.invoiceNumber = row.invoiceNumber.trim().slice(0, 40);
	}
	if (typeof row.reference === "string" && row.reference.trim()) fields.reference = row.reference.trim().slice(0, 40);
	if (row.credit === true) fields.credit = true;

	return fields;
}

// ─── Ranking ──────────────────────────────────────────────────────────────────────────────────────

/** One shortlisted transaction as the model sees it. `ref` is a per-request label, not an id from the vault. */
export interface AiRankCandidate {
	ref: string;
	date: string;
	merchant: string;
	amount: number;
	currency: string;
}

export interface AiRankVerdict {
	ref: string;
	confidence: number;
	reason: string;
}

export const INVOICE_RANK_SYSTEM_PROMPT = [
	"You decide which bank transaction paid a given invoice or receipt.",
	"",
	"You are given the details of one document and a short list of candidate transactions that already look plausible on amount and date. Rank them.",
	"",
	"Rules:",
	"- The amount is the strongest signal. A candidate whose amount differs from the document total needs a good reason to be preferred.",
	"- The merchant name on a bank statement is often a trading name, a parent company, or a payment processor. Recognising that 'CCV*AH TO GO 1423' paid an Albert Heijn receipt is exactly what you are here for.",
	"- A card payment usually settles within a few days of the receipt, so a small date difference is normal and a large one is suspicious.",
	"- Set confidence to how sure you are: 1.0 when it is unmistakable, around 0.5 when it is a reasonable read you would want confirmed, below 0.3 when you are guessing.",
	"- Give a reason of at most twelve words, naming the evidence.",
	"- Return only candidates you actually believe in. An empty list is a valid and useful answer — say nothing rather than ranking a list of wrong answers.",
	"- Judge only from what you are shown. You have no access to the rest of the ledger and should not ask for it.",
].join("\n");

/** The exact text sent as the user turn for a ranking request. */
export function buildInvoiceRankPrompt(doc: InvoiceDocument, candidates: AiRankCandidate[]): string {
	const facts: string[] = [];
	if (doc.vendor) facts.push(`vendor: ${doc.vendor}`);
	if (doc.date) facts.push(`date: ${doc.date}`);
	if (doc.total !== undefined) facts.push(`total: ${doc.total}${doc.currency ? ` ${doc.currency}` : ""}`);
	if (doc.invoiceNumber) facts.push(`invoice number: ${doc.invoiceNumber}`);
	if (doc.reference) facts.push(`reference: ${doc.reference}`);
	if (doc.credit) facts.push("this is a credit note or refund");
	if (facts.length === 0) facts.push("nothing could be read from this document");

	return [
		"Document:",
		...facts.map((fact) => `- ${fact}`),
		"",
		"Candidate transactions:",
		...candidates.map((c) => `- ${c.ref}: ${c.date} | ${c.merchant} | ${c.amount} ${c.currency}`),
		"",
		'Reply with JSON only: {"matches":[{"ref":"<exact candidate ref>","confidence":<0-1>,"reason":"<max 12 words>"}]}',
	].join("\n");
}

export function invoiceRankSchema(): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			matches: {
				type: "array",
				items: {
					type: "object",
					properties: {
						ref: { type: "string" },
						confidence: { type: "number" },
						reason: { type: "string" },
					},
					required: ["ref", "confidence", "reason"],
					additionalProperties: false,
				},
			},
		},
		required: ["matches"],
		additionalProperties: false,
	};
}

export interface RankValidation {
	verdicts: AiRankVerdict[];
	rejected: { ref: string; reason: string }[];
}

/**
 * Keeps only verdicts about candidates that were actually offered, once each.
 *
 * The guardrail that earns its keep is the "did we ask about this?" check, exactly as in validateMatches.
 * A hallucinated ref has no transaction behind it, and letting one through would mean a result row
 * proposing a transaction that isn't in the period — or worse, resolving to whichever row happened to
 * sit at that index and attaching a receipt to a stranger.
 */
export function validateInvoiceRanking(parsed: unknown, askedFor: AiRankCandidate[]): RankValidation {
	const verdicts: AiRankVerdict[] = [];
	const rejected: { ref: string; reason: string }[] = [];

	const known = new Set(askedFor.map((c) => c.ref.toLowerCase()));
	const seen = new Set<string>();

	const root = parsed as { matches?: unknown };
	const list = Array.isArray(root?.matches) ? root.matches : undefined;
	if (!list) throw new Error('The model\'s reply had no "matches" list.');

	for (const item of list) {
		const row = item as Partial<AiRankVerdict>;
		const ref = typeof row?.ref === "string" ? row.ref.trim().toLowerCase() : "";

		if (!ref) {
			rejected.push({ ref: String(row?.ref ?? "?"), reason: "no candidate reference" });
			continue;
		}
		if (!known.has(ref)) {
			rejected.push({ ref, reason: "not a candidate we asked about" });
			continue;
		}
		if (seen.has(ref)) {
			rejected.push({ ref, reason: "duplicate answer" });
			continue;
		}

		const confidence =
			typeof row.confidence === "number" && isFinite(row.confidence) ? Math.max(0, Math.min(1, row.confidence)) : 0;
		seen.add(ref);
		verdicts.push({ ref, confidence, reason: typeof row.reason === "string" ? row.reason.trim().slice(0, 120) : "" });
	}

	verdicts.sort((a, b) => b.confidence - a.confidence);
	return { verdicts, rejected };
}

/**
 * The sentence shown before any of this runs.
 *
 * Spelled out per document rather than as a general warning, because "receipt data will be sent" and
 * "the file itself will be uploaded" are materially different disclosures, and which one applies
 * depends on whether the PDF gave up its text.
 */
export function describeAiDisclosure(uploads: number, reads: number, candidates: number): string {
	const parts: string[] = [];
	if (uploads > 0) parts.push(`${uploads} document${uploads === 1 ? "" : "s"} will be uploaded in full`);
	if (reads > 0) parts.push(`text from ${reads} document${reads === 1 ? "" : "s"} will be sent`);
	if (parts.length === 0) parts.push("the vendor, date and total read from each document will be sent");
	return `Sent to your configured Claude provider: ${parts.join(", ")}, together with the date, description and amount of up to ${candidates} shortlisted transactions per document. Nothing else from the ledger leaves the vault.`;
}
