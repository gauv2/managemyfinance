import { comparableText, similarity } from "./import/similarity";
import { merchantDisplayName } from "./import/merchantKey";
import type { DateRange } from "./period";
import { MONTH_NAMES } from "./period";
import type { Transaction } from "./types";

/**
 * Deciding which transaction a receipt belongs to, with no Obsidian anywhere in sight.
 *
 * The interesting part of this feature is not the dropzone — it is the judgement, and a judgement you
 * cannot test against plain object literals is a judgement nobody can check. So the whole of it lives
 * here as pure functions over a structural transaction, the same arrangement kpi.ts and matcher.ts use,
 * and the wizard on top is left with nothing to do but paint the answer.
 *
 * The deterministic pass runs first and is the one that is allowed to be confident. An invoice carries
 * the amount that was charged, and a bank row carries the amount that was charged; when those agree to
 * the cent and the shop name agrees too, no model is needed and none is asked. Claude's later pass
 * exists for the cases the arithmetic cannot settle — a vendor trading under a different name, two
 * lunches on the same day for the same money — and it arrives as a re-ranking of a shortlist this
 * module already vetted, never as permission to attach something the rules below rejected.
 */

export type InvoicePeriodKind = "month" | "quarter" | "year";

/** A reporting period, as chosen rather than as resolved — the from/to pair is derived, never stored. */
export interface InvoicePeriod {
	kind: InvoicePeriodKind;
	year: number;
	/** 1-12, for kind "month". */
	month?: number;
	/** 1-4, for kind "quarter". */
	quarter?: number;
}

/**
 * What a document turned out to say, however that was found out: parsed out of the PDF's own text,
 * read off the filename, or identified by Claude from the picture. Every field is optional because a
 * blurry photo of a till receipt genuinely yields none of them, and a match on amount alone is still
 * worth offering.
 */
export interface InvoiceDocument {
	/** Stable within one batch — the file's position in it. Used to keep results and files paired. */
	id: string;
	filename: string;
	vendor?: string;
	/** "YYYY-MM-DD". The date on the document, which is not always the date the bank moved the money. */
	date?: string;
	/** The document total as a positive magnitude. Direction is carried by `credit`, not by the sign. */
	total?: number;
	currency?: string;
	invoiceNumber?: string;
	/** A payment reference, order number or card suffix — anything that might also appear in the bank text. */
	reference?: string;
	/** A credit note or refund: money coming back, so it belongs against an incoming row rather than a payment. */
	credit?: boolean;
	/** Where the fields above came from, so the UI can be honest about how much it actually knows. */
	source?: "text" | "filename" | "ai" | "none";
}

/**
 * The slice of a transaction a match is decided on.
 *
 * Structural rather than the real `Transaction` so a test can state a case in six fields instead of
 * fifteen, and so nothing in here can quietly start depending on the store.
 */
export type InvoiceCandidateTx = Pick<
	Transaction,
	"id" | "date" | "description" | "counterparty" | "amount" | "currency" | "accountId" | "attachmentPath"
>;

export type MatchConfidence = "high" | "medium" | "low";

/** One transaction weighed against one document, with the working shown. */
export interface ScoredCandidate {
	tx: InvoiceCandidateTx;
	/** 0-1. Comparable between candidates for the same document; not meaningful across documents. */
	score: number;
	confidence: MatchConfidence;
	/** Short prose naming the signals that fired, e.g. "Exact amount and merchant; date difference 1 day". */
	reason: string;
	signals: MatchSignals;
	/** True when this transaction already carries a file. Never written to, only reported. */
	alreadyAttached: boolean;
	/** What Claude made of this pairing, when it was asked. Absent when the AI pass didn't run. */
	aiConfidence?: number;
	/** Claude's own one-line justification, shown beside the deterministic one rather than instead of it. */
	aiReason?: string;
}

export interface MatchSignals {
	/** Amounts agree within the rounding tolerance. */
	amountExact: boolean;
	/** Amounts are close but outside the tolerance — a tip, a conversion, a partial payment. */
	amountClose: boolean;
	/** Currencies are known and disagree. */
	currencyConflict: boolean;
	/** 0-1 merchant-name similarity, or undefined when the document named no vendor. */
	vendorSimilarity?: number;
	/** Whole days between the document's date and the transaction's, or undefined when undated. */
	dayGap?: number;
	/** An invoice number, reference or card suffix from the document was found in the bank text. */
	referenceHit: boolean;
}

export interface InvoiceMatchOptions {
	/** How far two amounts may differ and still count as the same payment. Cents, not a percentage —
	 *  it exists for rounding, not for haggling. */
	amountTolerance?: number;
	/** Beyond this many days a date is treated as conflicting rather than merely distant. A card
	 *  payment usually settles within a few days of the receipt; a fortnight apart is a different bill. */
	dateWindowDays?: number;
	/** How many candidates a document keeps for display and for the AI shortlist. */
	candidateLimit?: number;
}

export const DEFAULT_AMOUNT_TOLERANCE = 0.01;
export const DEFAULT_DATE_WINDOW_DAYS = 14;
export const DEFAULT_CANDIDATE_LIMIT = 5;

/** Ten is not a technical limit — it is the number of result rows a person can actually rule on in one sitting. */
export const MAX_INVOICE_FILES = 10;

/**
 * What can be dropped. PDF plus the raster formats Obsidian will happily store and preview; there is
 * no point accepting a file the vault can hold but the attachment preview then refuses to show.
 */
export const SUPPORTED_INVOICE_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "heic"] as const;

export function invoiceFileExtension(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

export function isSupportedInvoiceFile(filename: string): boolean {
	return (SUPPORTED_INVOICE_EXTENSIONS as readonly string[]).includes(invoiceFileExtension(filename));
}

export interface FileSelectionCheck {
	accepted: string[];
	/** Names rejected for their type, so the message can say which rather than just "some". */
	unsupported: string[];
	/** Set when the batch is over the cap. The whole selection is refused rather than silently trimmed:
	 *  quietly dropping the eleventh receipt is how one goes missing without anyone noticing. */
	tooMany?: string;
}

/**
 * Vets a dropped or picked batch before anything else happens.
 *
 * The cap is checked against the accepted files, not the raw drop, so dragging a folder containing
 * eleven files of which three are `.txt` is not refused for being too big when it isn't.
 */
export function checkFileSelection(filenames: string[], max = MAX_INVOICE_FILES): FileSelectionCheck {
	const accepted: string[] = [];
	const unsupported: string[] = [];
	for (const name of filenames) {
		if (isSupportedInvoiceFile(name)) accepted.push(name);
		else unsupported.push(name);
	}
	const check: FileSelectionCheck = { accepted, unsupported };
	if (accepted.length > max) {
		check.tooMany = `That's ${accepted.length} files — ${max} at a time is the limit. Drop fewer and run it again for the rest.`;
	}
	return check;
}

// ─── Periods ──────────────────────────────────────────────────────────────────────────────────────

/** The last day of a month, leap years included — day 0 of the next month is the previous month's last. */
function lastDayOf(year: number, month: number): number {
	return new Date(year, month, 0).getDate();
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * The inclusive from/to a chosen period stands for.
 *
 * Deliberately its own function rather than a reuse of `periodRange`: the ledger's period filter is
 * built around presets relative to today ("this month", "last month"), and a reporting period is the
 * opposite — an absolute window someone names because that is the quarter they are doing the books for.
 */
export function invoicePeriodRange(period: InvoicePeriod): DateRange {
	if (period.kind === "year") {
		return { from: `${period.year}-01-01`, to: `${period.year}-12-31` };
	}
	if (period.kind === "quarter") {
		const quarter = Math.min(4, Math.max(1, period.quarter ?? 1));
		const firstMonth = (quarter - 1) * 3 + 1;
		const lastMonth = firstMonth + 2;
		return {
			from: `${period.year}-${pad(firstMonth)}-01`,
			to: `${period.year}-${pad(lastMonth)}-${pad(lastDayOf(period.year, lastMonth))}`,
		};
	}
	const month = Math.min(12, Math.max(1, period.month ?? 1));
	return {
		from: `${period.year}-${pad(month)}-01`,
		to: `${period.year}-${pad(month)}-${pad(lastDayOf(period.year, month))}`,
	};
}

/** "April 2026", "Q2 2026", "2026" — how the period is named back to the person who chose it. */
export function describeInvoicePeriod(period: InvoicePeriod): string {
	if (period.kind === "year") return String(period.year);
	if (period.kind === "quarter") return `Q${Math.min(4, Math.max(1, period.quarter ?? 1))} ${period.year}`;
	return `${MONTH_NAMES[Math.min(12, Math.max(1, period.month ?? 1)) - 1]} ${period.year}`;
}

/**
 * The transactions a period actually covers.
 *
 * Inclusive at both ends and compared as ISO strings, which is the same comparison the ledger's own
 * filter makes — a receipt from the 30th of June must not fall down the gap between Q2 and Q3.
 */
export function transactionsInPeriod<T extends { date: string }>(transactions: T[], period: InvoicePeriod): T[] {
	const range = invoicePeriodRange(period);
	return transactions.filter((tx) => !!tx.date && tx.date >= range.from && tx.date <= range.to);
}

/** "Searching 82 transactions from 2026-04-01 through 2026-06-30" — the sentence shown before analysis. */
export function describeSearchScope(count: number, period: InvoicePeriod): string {
	const range = invoicePeriodRange(period);
	return `Searching ${count} transaction${count === 1 ? "" : "s"} from ${range.from} through ${range.to}`;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────────────────────────

/** Whole days between two ISO dates, or undefined when either is missing or unreadable. */
export function dayGap(a?: string, b?: string): number | undefined {
	if (!a || !b) return undefined;
	const left = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
	const right = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
	if (!isFinite(left) || !isFinite(right)) return undefined;
	return Math.round(Math.abs(left - right) / 86_400_000);
}

/** The merchant text a document's vendor name is compared against. */
function merchantTextOf(tx: InvoiceCandidateTx): string {
	return comparableText({ description: tx.description, counterparty: tx.counterparty });
}

/**
 * Every character-and-digit run in the bank text, lowercased, for reference hunting.
 *
 * Comparing loosely matters here: a bank writes "Factuur 2026-00417" where the PDF says "INV2026/00417",
 * and the only part that survives both is the digits. So references are compared with their punctuation
 * stripped, and only when what is left is long enough to be an identifier rather than a coincidence.
 */
function referenceHaystack(tx: InvoiceCandidateTx): string {
	return `${tx.description ?? ""} ${tx.counterparty ?? ""}`.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function referenceMatches(needle: string | undefined, haystack: string): boolean {
	if (!needle) return false;
	const cleaned = needle.toLowerCase().replace(/[^a-z0-9]/g, "");
	// Four characters is the shortest thing worth calling an identifier. Below that, "12" appears in
	// half the ledger and would hand a bonus to a coincidence.
	if (cleaned.length < 4) return false;
	return haystack.includes(cleaned);
}

/**
 * Which way the money should be going for this document.
 *
 * An invoice is something you paid, so it belongs against a debit. A credit note is money coming back,
 * so it belongs against a credit. Matching one to the other is never a near-miss worth offering — a
 * €49 refund and a €49 purchase are different events that happen to share a number.
 */
function directionAgrees(doc: InvoiceDocument, tx: InvoiceCandidateTx): boolean {
	if (tx.amount === 0) return false;
	return doc.credit ? tx.amount > 0 : tx.amount < 0;
}

/**
 * How well one transaction answers one document, 0-1, plus the reasoning behind the number.
 *
 * The weights encode an ordering rather than a formula anyone tuned: the amount is what a receipt and a
 * bank row are both *about*, so it carries half the score on its own; the merchant name is the next
 * strongest and worth a third; the date is corroboration rather than evidence, because the day a card
 * settles is not the day the receipt was printed. A reference number is the one signal that can be
 * decisive on its own, which is why it tops the total up rather than competing for room in it.
 */
export function scoreCandidate(doc: InvoiceDocument, tx: InvoiceCandidateTx, opts: InvoiceMatchOptions = {}): ScoredCandidate {
	const tolerance = opts.amountTolerance ?? DEFAULT_AMOUNT_TOLERANCE;
	const window = opts.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS;

	const haystack = referenceHaystack(tx);
	const signals: MatchSignals = {
		amountExact: false,
		amountClose: false,
		currencyConflict: false,
		referenceHit: referenceMatches(doc.invoiceNumber, haystack) || referenceMatches(doc.reference, haystack),
		dayGap: dayGap(doc.date, tx.date),
	};

	if (doc.total !== undefined && isFinite(doc.total)) {
		const difference = Math.abs(Math.abs(tx.amount) - Math.abs(doc.total));
		signals.amountExact = difference <= tolerance + 1e-9;
		// Two percent covers a card-network conversion or a rounded tip without stretching as far as
		// "these are different bills that happen to be similar".
		signals.amountClose = !signals.amountExact && difference <= Math.abs(doc.total) * 0.02;
	}
	if (doc.currency && tx.currency && doc.currency.toUpperCase() !== tx.currency.toUpperCase()) {
		signals.currencyConflict = true;
	}
	if (doc.vendor) {
		const text = merchantTextOf(tx);
		signals.vendorSimilarity = text ? similarity(doc.vendor, text) : 0;
	}

	const alreadyAttached = !!tx.attachmentPath;

	// A document that belongs on the other side of the ledger is not a weak match, it is the wrong
	// answer — so it scores nothing rather than scoring badly and turning up as a "Low" suggestion.
	if (!directionAgrees(doc, tx)) {
		return {
			tx,
			score: 0,
			confidence: "low",
			reason: doc.credit ? "This is a credit note; that row is a payment" : "That row is money in, not a payment",
			signals,
			alreadyAttached,
		};
	}
	if (signals.currencyConflict) {
		return {
			tx,
			score: 0,
			confidence: "low",
			reason: `Currency differs — document is ${doc.currency}, transaction is ${tx.currency}`,
			signals,
			alreadyAttached,
		};
	}

	let score = 0;
	if (signals.amountExact) score += 0.5;
	else if (signals.amountClose) score += 0.2;

	if (signals.vendorSimilarity !== undefined && signals.vendorSimilarity >= 0.4) {
		score += signals.vendorSimilarity * 0.3;
	}

	if (signals.dayGap !== undefined) {
		if (signals.dayGap === 0) score += 0.15;
		else if (signals.dayGap <= 3) score += 0.1;
		else if (signals.dayGap <= window) score += 0.05;
		// Beyond the window the date stops corroborating and starts arguing, so it takes score away.
		else score -= 0.15;
	}

	if (signals.referenceHit) score += 0.2;

	score = Math.max(0, Math.min(1, score));

	return {
		tx,
		score,
		confidence: bandFor(score, signals),
		reason: describeSignals(signals, doc),
		signals,
		alreadyAttached,
	};
}

/**
 * Turning a number into one of three words, with the amount holding a veto.
 *
 * "High" is a claim that this can be attached without anyone reading it, and no pile of soft evidence
 * earns that: a shop name and a date that agree while the totals do not describe two different visits
 * to the same shop, which is precisely the mistake that would file the wrong receipt against the wrong
 * expense and never be noticed.
 */
function bandFor(score: number, signals: MatchSignals): MatchConfidence {
	if (score >= 0.75 && signals.amountExact) return "high";
	if (score >= 0.45) return "medium";
	return "low";
}

/** The sentence beside a proposal — the signals that fired, in the order a person would check them. */
function describeSignals(signals: MatchSignals, doc: InvoiceDocument): string {
	const parts: string[] = [];

	if (signals.amountExact && signals.vendorSimilarity !== undefined && signals.vendorSimilarity >= 0.8) {
		parts.push("Exact amount and merchant");
	} else {
		if (signals.amountExact) parts.push("Exact amount");
		else if (signals.amountClose) parts.push("Amount within 2%");
		else if (doc.total !== undefined) parts.push("Amount differs");
		if (signals.vendorSimilarity !== undefined) {
			if (signals.vendorSimilarity >= 0.8) parts.push("merchant matches");
			else if (signals.vendorSimilarity >= 0.4) parts.push("merchant is similar");
			else parts.push("merchant looks different");
		}
	}

	if (signals.dayGap === 0) parts.push("same date");
	else if (signals.dayGap !== undefined) parts.push(`date difference ${signals.dayGap} day${signals.dayGap === 1 ? "" : "s"}`);

	if (signals.referenceHit) parts.push("reference found in the bank text");

	if (parts.length === 0) return "Nothing in the document to compare against this row";
	return `${parts[0]}${parts.length > 1 ? `; ${parts.slice(1).join("; ")}` : ""}`;
}

// ─── Ranking and assignment ───────────────────────────────────────────────────────────────────────

export interface InvoiceProposal {
	doc: InvoiceDocument;
	/** Best first, capped at `candidateLimit`. Empty when nothing in the period scored above zero. */
	candidates: ScoredCandidate[];
	/** The transaction this document is proposed against, once the batch has been shared out. */
	chosen?: ScoredCandidate;
	/** Ticked when the wizard opens. Only ever true for an unambiguous, high-confidence, unattached row. */
	selected: boolean;
	/** Why this is not selected, when it isn't — shown so a greyed row is never a mystery. */
	blockedReason?: string;
}

export interface InvoiceMatchPlan {
	proposals: InvoiceProposal[];
	/** How many transactions the period held — the number the summary sentence quotes. */
	searched: number;
	range: DateRange;
}

/**
 * Ranks every document against the period, then shares the transactions out between them.
 *
 * The sharing-out is the part that a per-document loop gets wrong. Two receipts from the same shop for
 * the same money would each independently pick the same bank row as their best answer, and the second
 * one would then either overwrite the first or be silently dropped. Working through every (document,
 * transaction) pair in score order instead means the strongest claim on a row wins it and the loser
 * falls through to its own next-best — which is usually the other identical row, and correct.
 */
export function matchInvoices(
	docs: InvoiceDocument[],
	transactions: InvoiceCandidateTx[],
	period: InvoicePeriod,
	opts: InvoiceMatchOptions = {}
): InvoiceMatchPlan {
	const limit = opts.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
	const inPeriod = transactionsInPeriod(transactions, period);

	const proposals: InvoiceProposal[] = docs.map((doc) => {
		const scored = inPeriod
			.map((tx) => scoreCandidate(doc, tx, opts))
			.filter((candidate) => candidate.score > 0)
			.sort((a, b) => b.score - a.score || compareDateDesc(a.tx.date, b.tx.date));
		return { doc, candidates: scored.slice(0, limit), selected: false };
	});

	assignBestFirst(proposals);

	for (const proposal of proposals) {
		const decision = decideSelection(proposal);
		proposal.selected = decision.selected;
		proposal.blockedReason = decision.blockedReason;
	}

	return { proposals, searched: inPeriod.length, range: invoicePeriodRange(period) };
}

/**
 * Newest first, and genuinely equal when the dates are equal.
 *
 * The nought matters. A comparator that answers 1 for a pair it considers tied tells the sort those two
 * are in the wrong order, so two candidates scoring identically swap places on every re-rank — and the
 * proposal a person is looking at changes under them for no reason they can see.
 */
function compareDateDesc(a: string, b: string): number {
	if (a === b) return 0;
	return a > b ? -1 : 1;
}

/** Hands each transaction to whichever document has the strongest claim on it, best pair first. */
function assignBestFirst(proposals: InvoiceProposal[]): void {
	const pairs: { proposal: InvoiceProposal; candidate: ScoredCandidate }[] = [];
	for (const proposal of proposals) {
		for (const candidate of proposal.candidates) pairs.push({ proposal, candidate });
	}
	pairs.sort((a, b) => b.candidate.score - a.candidate.score);

	const takenTx = new Set<string>();
	for (const { proposal, candidate } of pairs) {
		if (proposal.chosen || takenTx.has(candidate.tx.id)) continue;
		proposal.chosen = candidate;
		takenTx.add(candidate.tx.id);
	}
}

/** How close a runner-up may score before the pair is called a coin toss rather than a match. */
const AMBIGUITY_MARGIN = 0.08;

/**
 * Whether a proposal may arrive pre-ticked, and what to say when it may not.
 *
 * Everything here is a veto, not a weighting. A row that already carries a receipt is refused outright
 * because this feature must never replace an attachment; a near-tie is refused because "these two are
 * equally good" is not something a default can resolve and a person can; and anything short of High is
 * refused because High is the only band that claims to be safe unread.
 */
function decideSelection(proposal: InvoiceProposal): { selected: boolean; blockedReason?: string } {
	const chosen = proposal.chosen;
	if (!chosen) return { selected: false, blockedReason: "No confident match" };
	if (chosen.alreadyAttached) return { selected: false, blockedReason: "Already attached" };

	const runnerUp = proposal.candidates.find((c) => c.tx.id !== chosen.tx.id);
	if (runnerUp && chosen.score - runnerUp.score < AMBIGUITY_MARGIN) {
		// Demoted as well as unticked: leaving it labelled "High" while refusing to tick it would read
		// as the interface disagreeing with itself.
		chosen.confidence = chosen.confidence === "high" ? "medium" : chosen.confidence;
		return { selected: false, blockedReason: "Another transaction in this period scores just as well" };
	}
	if (chosen.confidence !== "high") {
		return { selected: false, blockedReason: chosen.confidence === "medium" ? "Worth a look before attaching" : "Weak match" };
	}
	return { selected: true };
}

/** Claude's verdicts for one document, keyed back to real transaction ids by the caller. */
export interface AiRanking {
	docId: string;
	verdicts: { txId: string; confidence: number; reason: string }[];
}

/** How much of the final score the model's opinion is worth against the arithmetic's. */
const AI_WEIGHT = 0.4;

/**
 * Folds Claude's opinion into a plan the deterministic pass already made.
 *
 * A suggestion, and only a suggestion. The model can move a candidate up or down inside a shortlist
 * this module already vetted, and that is genuinely useful — it is the only participant that knows
 * "CCV*AH TO GO" is the receipt's Albert Heijn. What it cannot do is reach past the guards: the score
 * it influences is still fed through the same banding, which refuses "High" without an exact amount,
 * and through the same tie-break, which refuses to tick anything with a rival on its heels. A model
 * that came back certain about a row whose total is wrong moves it to the top of the list and gets a
 * "Medium" for its trouble, which is exactly the outcome intended.
 *
 * Pure and total: a docId or txId that no longer exists is ignored rather than throwing, because these
 * arrive from a network reply and the plan they refer to is not guaranteed to be the one in hand.
 */
export function applyAiRanking(plan: InvoiceMatchPlan, rankings: AiRanking[]): InvoiceMatchPlan {
	const byDoc = new Map(rankings.map((r) => [r.docId, r]));

	const proposals = plan.proposals.map((proposal) => {
		const ranking = byDoc.get(proposal.doc.id);
		if (!ranking) return { ...proposal, chosen: undefined };

		const byTx = new Map(ranking.verdicts.map((v) => [v.txId, v]));
		const candidates = proposal.candidates
			.map((candidate) => {
				const verdict = byTx.get(candidate.tx.id);
				if (!verdict) return { ...candidate };
				const blended = Math.max(0, Math.min(1, candidate.score * (1 - AI_WEIGHT) + verdict.confidence * AI_WEIGHT));
				return {
					...candidate,
					score: blended,
					confidence: bandFor(blended, candidate.signals),
					aiConfidence: verdict.confidence,
					aiReason: verdict.reason,
				};
			})
			.sort((a, b) => b.score - a.score || compareDateDesc(a.tx.date, b.tx.date));

		return { ...proposal, candidates, chosen: undefined };
	});

	assignBestFirst(proposals);
	for (const proposal of proposals) {
		const decision = decideSelection(proposal);
		proposal.selected = decision.selected;
		proposal.blockedReason = decision.blockedReason;
	}

	return { ...plan, proposals };
}

/**
 * A readable name for the document, for a result row's heading.
 *
 * Falls back through what is actually known: the vendor Claude or the PDF text gave up, then the
 * filename, which is at least always there.
 */
export function documentLabel(doc: InvoiceDocument): string {
	return doc.vendor?.trim() || merchantDisplayName(doc.filename.replace(/\.[a-z0-9]+$/i, "")) || doc.filename;
}

// ─── Applying ─────────────────────────────────────────────────────────────────────────────────────

export interface AttachOutcome {
	attached: number;
	skipped: number;
	unmatched: number;
	failed: number;
}

/**
 * What a finished run comes to.
 *
 * "Unmatched" and "skipped" are counted apart on purpose: one means the batch had nothing to offer and
 * the other means you were offered something and said no, and a summary that merged them would hide
 * whether the pass worked.
 */
export function summarizeOutcome(proposals: InvoiceProposal[], attached: Set<string>, failed: Set<string>): AttachOutcome {
	let outcome: AttachOutcome = { attached: 0, skipped: 0, unmatched: 0, failed: 0 };
	for (const proposal of proposals) {
		if (failed.has(proposal.doc.id)) outcome = { ...outcome, failed: outcome.failed + 1 };
		else if (attached.has(proposal.doc.id)) outcome = { ...outcome, attached: outcome.attached + 1 };
		else if (!proposal.chosen) outcome = { ...outcome, unmatched: outcome.unmatched + 1 };
		else outcome = { ...outcome, skipped: outcome.skipped + 1 };
	}
	return outcome;
}

/** One line for the Notice shown when the writes finish. */
export function describeOutcome(outcome: AttachOutcome): string {
	const parts = [`${outcome.attached} attached`];
	if (outcome.skipped > 0) parts.push(`${outcome.skipped} skipped`);
	if (outcome.unmatched > 0) parts.push(`${outcome.unmatched} unmatched`);
	if (outcome.failed > 0) parts.push(`${outcome.failed} failed`);
	return parts.join(" · ");
}
