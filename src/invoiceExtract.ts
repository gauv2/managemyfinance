import type { InvoiceDocument } from "./invoiceMatch";
import { parseMoney } from "./money";

/**
 * Reading an invoice without asking anyone.
 *
 * Every field this finds locally is a field that never has to be sent anywhere, which is the whole
 * point: a digitally generated invoice states its vendor, its date and its total in plain text, and
 * paying a model to read them back would be both slower and a needless disclosure. Only what survives
 * this pass unanswered is worth a request.
 *
 * The parsing is deliberately label-led rather than layout-led. A PDF's text comes out of the file in
 * drawing order, not reading order, so columns interleave and whitespace means nothing — but the word
 * "Totaal" is still immediately followed by the number it labels, because that is how the document was
 * drawn. Anchoring on the labels survives that scrambling; anything positional does not.
 */

/** Everything a local pass can find. A subset of InvoiceDocument, since it never invents an id. */
export type ExtractedFields = Pick<InvoiceDocument, "vendor" | "date" | "total" | "currency" | "invoiceNumber" | "reference" | "credit">;

const MONTHS_EN = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];

/** Dutch month names, because this plugin's ledgers are Dutch and so are half the invoices in them. */
const MONTHS_NL = [
	"januari",
	"februari",
	"maart",
	"april",
	"mei",
	"juni",
	"juli",
	"augustus",
	"september",
	"oktober",
	"november",
	"december",
];

function monthNumber(name: string): number | undefined {
	const lower = name.toLowerCase();
	for (const list of [MONTHS_EN, MONTHS_NL]) {
		const index = list.findIndex((m) => m.startsWith(lower.slice(0, 3)) && lower.startsWith(m.slice(0, 3)));
		if (index !== -1) return index + 1;
	}
	return undefined;
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** A date is only accepted if it is one — "31/02/2026" is a typo, not the last day of February. */
function isoIfReal(year: number, month: number, day: number): string | undefined {
	if (month < 1 || month > 12 || day < 1) return undefined;
	if (year < 1970 || year > 2200) return undefined;
	if (day > new Date(year, month, 0).getDate()) return undefined;
	return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Every date in a piece of text, in the order they appear.
 *
 * Numeric dates are read day-first. That is a genuine ambiguity — 03/04/2026 is the 3rd of April to a
 * European supplier and the 4th of March to an American one — and it is resolved the way this plugin
 * resolves every other such ambiguity: in favour of the locale its ledgers come from. A day-first
 * misread also fails safely here, because the date is corroboration in the score rather than evidence,
 * and a wrong one costs a few points rather than a wrong answer.
 */
export function findDates(text: string): string[] {
	const found: string[] = [];

	const iso = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
	const dmy = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g;
	const dMonthY = /\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-zA-Z]{3,10})\.?[\s-]+(\d{4})\b/g;
	const monthDY = /\b([a-zA-Z]{3,10})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g;

	const push = (value?: string): void => {
		if (value && !found.includes(value)) found.push(value);
	};

	for (const m of text.matchAll(iso)) push(isoIfReal(Number(m[1]), Number(m[2]), Number(m[3])));
	for (const m of text.matchAll(dmy)) push(isoIfReal(Number(m[3]), Number(m[2]), Number(m[1])));
	for (const m of text.matchAll(dMonthY)) {
		const month = monthNumber(m[2]);
		if (month) push(isoIfReal(Number(m[3]), month, Number(m[1])));
	}
	for (const m of text.matchAll(monthDY)) {
		const month = monthNumber(m[1]);
		if (month) push(isoIfReal(Number(m[3]), month, Number(m[2])));
	}

	return found;
}

/**
 * Date labels, most specific first.
 *
 * Order is the whole trick. An invoice usually carries two dates — when it was issued and when it is
 * due — and picking the wrong one shifts every date comparison by thirty days. "Due" is never in this
 * list, and the issue-date labels are tried before the bare word "date".
 */
const DATE_LABELS = [
	/(?:invoice|receipt|document|order|transaction)\s*date\s*[:#]?\s*/i,
	/(?:factuur|bon|order|transactie)datum\s*[:#]?\s*/i,
	/\b(?:issued|dated)\s*(?:on)?\s*[:#]?\s*/i,
	/\bdatum\s*[:#]?\s*/i,
	/\bdate\s*[:#]?\s*/i,
];

/** The date the document is *about*, preferring a labelled one over whatever appears first. */
export function findInvoiceDate(text: string): string | undefined {
	for (const label of DATE_LABELS) {
		const match = label.exec(text);
		if (!match) continue;
		// Only the text right after the label — far enough to clear a line break, short enough that the
		// next field's date can't be picked up instead.
		const after = text.slice(match.index + match[0].length, match.index + match[0].length + 40);
		const dates = findDates(after);
		if (dates.length > 0) return dates[0];
	}
	return findDates(text)[0];
}

/**
 * Total labels in tiers, strongest first.
 *
 * An invoice states several totals — net, VAT, gross — and they are all called "total" something. The
 * one that matters is the one the bank actually moved, which is the payable gross, so the labels that
 * can only mean that ("amount due", "te betalen", "totaal incl") are tried before the ones that could
 * mean any of them.
 */
const TOTAL_LABEL_TIERS: RegExp[][] = [
	[
		/(?:amount|balance)\s+due\s*[:#]?\s*/gi,
		/\bte\s+betalen\b\s*[:#]?\s*/gi,
		/\bgrand\s+total\b\s*[:#]?\s*/gi,
		/\btotaal\s+(?:incl|inclusief)[a-z.]*\s*(?:btw)?\s*[:#]?\s*/gi,
		/\btotal\s+(?:incl|including)[a-z.]*\s*(?:vat)?\s*[:#]?\s*/gi,
	],
	[/\btotaalbedrag\b\s*[:#]?\s*/gi, /\btotal\b\s*[:#]?\s*/gi, /\btotaal\b\s*[:#]?\s*/gi],
	[/\b(?:amount|bedrag|paid|betaald)\b\s*[:#]?\s*/gi],
];

const CURRENCY_BY_SYMBOL: Record<string, string> = { "€": "EUR", $: "USD", "£": "GBP", "¥": "JPY", "₹": "INR" };

/** An amount plus whatever currency decoration sat next to it, read out of a short run of text. */
function readAmount(fragment: string): { total: number; currency?: string } | undefined {
	const match = /([€$£¥₹]|\b(?:EUR|USD|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK|PLN|INR)\b)?\s*(-?[\d][\d.,\s']*\d|\d)\s*([€$£¥₹]|\b(?:EUR|USD|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK|PLN|INR)\b)?/i.exec(
		fragment
	);
	if (!match) return undefined;
	const total = parseMoney(match[2]);
	if (total === undefined) return undefined;
	const marker = (match[1] || match[3] || "").trim();
	const currency = marker ? (CURRENCY_BY_SYMBOL[marker] ?? marker.toUpperCase()) : undefined;
	return { total: Math.abs(total), currency };
}

/** The payable total, and the currency it was quoted in when the document said. */
export function findTotal(text: string): { total: number; currency?: string } | undefined {
	for (const tier of TOTAL_LABEL_TIERS) {
		let best: { total: number; currency?: string } | undefined;
		for (const label of tier) {
			label.lastIndex = 0;
			for (const match of text.matchAll(label)) {
				const amount = readAmount(text.slice(match.index + match[0].length, match.index + match[0].length + 30));
				if (!amount) continue;
				// Within one tier the largest wins. A gross total is by definition the biggest number a
				// "total" label can be attached to, so this settles net-vs-gross without needing to know
				// which words the supplier chose for each.
				if (!best || amount.total > best.total) best = amount;
			}
		}
		if (best) return best;
	}
	return undefined;
}

const NUMBER_LABELS = [
	/\b(?:invoice|receipt|order|document)\s*(?:no\.?|number|nr\.?|#)\s*[:#]?\s*/i,
	/\b(?:factuur|bon|order)(?:nummer|nr\.?)\s*[:#]?\s*/i,
	/\binvoice\s*[:#]\s*/i,
	/\bfactuur\s*[:#]\s*/i,
];

const REFERENCE_LABELS = [
	/\b(?:payment\s*)?reference\s*[:#]?\s*/i,
	/\b(?:betaal)?(?:kenmerk|referentie)\s*[:#]?\s*/i,
	/\bending\s+in\s*/i,
	/\bcard\s*(?:no\.?|number)?\s*[:#*x]*\s*/i,
];

/** The token right after a label — an identifier, so digits, letters and the punctuation between them. */
function readIdentifier(text: string, labels: RegExp[]): string | undefined {
	for (const label of labels) {
		const match = label.exec(text);
		if (!match) continue;
		const after = text.slice(match.index + match[0].length, match.index + match[0].length + 40);
		const token = /^[\s]*([A-Za-z0-9][A-Za-z0-9._/-]{2,29})/.exec(after);
		const value = token?.[1]?.replace(/[._/-]+$/, "");
		// A label followed by a word is a label followed by the next sentence, not by an identifier.
		if (value && /\d/.test(value)) return value;
	}
	return undefined;
}

const CREDIT_MARKERS = /\b(credit\s*note|creditnota|creditfactuur|refund|restitutie|terugbetaling|rembours)\b/i;

/**
 * The line most likely to be the supplier's name.
 *
 * Invoices put it at the top, so this reads from the top — but "INVOICE" is also at the top, and so is
 * the customer's own address on a right-hand column that PDF text order will happily interleave. What
 * survives is the first line that reads like a name: has letters, isn't a document-type heading, isn't
 * a date or an amount, and isn't long enough to be a sentence.
 */
const VENDOR_SKIP = /^(invoice|factuur|receipt|bon|kassabon|bill|rekening|tax\s+invoice|credit\s*note|creditnota|page\s*\d)/i;

export function findVendor(text: string): string | undefined {
	const lines = text
		.split(/[\r\n]+/)
		.map((line) => line.trim())
		.filter(Boolean);

	for (const line of lines.slice(0, 12)) {
		if (line.length < 2 || line.length > 60) continue;
		if (VENDOR_SKIP.test(line)) continue;
		if (!/[a-zA-Z]{2}/.test(line)) continue;
		// A line that is mostly digits is an address, a reference or a total, never a company name.
		const digits = (line.match(/\d/g) ?? []).length;
		if (digits > line.length / 3) continue;
		if (/^(www\.|https?:|[\w.]+@)/i.test(line)) continue;
		return line.replace(/\s{2,}/g, " ");
	}
	return undefined;
}

/** Everything the document's own text gives up. */
export function fieldsFromText(text: string): ExtractedFields {
	const fields: ExtractedFields = {};
	if (!text.trim()) return fields;

	const total = findTotal(text);
	if (total) {
		fields.total = total.total;
		if (total.currency) fields.currency = total.currency;
	}
	const date = findInvoiceDate(text);
	if (date) fields.date = date;
	const vendor = findVendor(text);
	if (vendor) fields.vendor = vendor;
	const number = readIdentifier(text, NUMBER_LABELS);
	if (number) fields.invoiceNumber = number;
	const reference = readIdentifier(text, REFERENCE_LABELS);
	if (reference) fields.reference = reference;
	if (CREDIT_MARKERS.test(text)) fields.credit = true;

	return fields;
}

/**
 * What the filename alone is willing to say.
 *
 * Worth doing before anything clever, because people name receipts well — "2026-04-12 Bol.com 49,99.pdf"
 * is a complete answer, and for a photographed till receipt it may be the only one there is. It is also
 * the entire local capability for images, which have no text to read at all.
 */
export function fieldsFromFilename(filename: string): ExtractedFields {
	const stem = filename.replace(/\.[a-z0-9]+$/i, "").replace(/[_]+/g, " ");
	const fields: ExtractedFields = {};

	const date = findDates(stem)[0];
	if (date) fields.date = date;

	// An amount in a filename is written with a separator and two decimals; a bare integer is far more
	// likely to be an invoice number or a phone camera's counter, and reading it as euros would put a
	// confident wrong total on the row.
	const amount = /(?:^|[\s€$£-])(\d{1,3}(?:[.,\s]\d{3})*[.,]\d{2})(?![\d])/.exec(stem);
	if (amount) {
		const total = parseMoney(amount[1]);
		if (total !== undefined) fields.total = Math.abs(total);
	}
	if (/[€]|\beur\b/i.test(stem)) fields.currency = "EUR";

	const words = stem
		.replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g, " ")
		.replace(/\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/g, " ")
		.replace(/(?:invoice|receipt|factuur|bon|scan|img|image|doc)\b/gi, " ")
		.replace(/[\d€$£]+[.,]?\d*/g, " ")
		.replace(/[-–—]+/g, " ")
		.trim()
		.replace(/\s{2,}/g, " ");
	if (words.length >= 2) fields.vendor = words;

	if (CREDIT_MARKERS.test(stem)) fields.credit = true;

	return fields;
}

/**
 * Builds the document, preferring what the text said over what the filename guessed.
 *
 * Field by field rather than object by object: a PDF whose text yields a total but no vendor should
 * still take the vendor from a well-named file, and an all-or-nothing merge would throw that away.
 */
export function buildInvoiceDocument(id: string, filename: string, text?: string): InvoiceDocument {
	const fromText = text ? fieldsFromText(text) : {};
	const fromName = fieldsFromFilename(filename);

	const merged: ExtractedFields = { ...fromName };
	for (const [key, value] of Object.entries(fromText) as [keyof ExtractedFields, unknown][]) {
		if (value !== undefined && value !== "") (merged as Record<string, unknown>)[key] = value;
	}

	const anyFromText = Object.keys(fromText).length > 0;
	const anyAtAll = Object.keys(merged).length > 0;

	return {
		id,
		filename,
		...merged,
		source: anyFromText ? "text" : anyAtAll ? "filename" : "none",
	};
}

/**
 * Whether the local pass found enough to skip asking Claude.
 *
 * The total is non-negotiable — it carries half the match score, and without it even a perfect vendor
 * name only ever reaches "Medium". A second corroborating field is required alongside it because an
 * amount on its own matches every other row in the period that cost the same.
 */
export function localExtractionSufficient(doc: InvoiceDocument): boolean {
	if (doc.total === undefined) return false;
	return !!doc.vendor || !!doc.invoiceNumber || !!doc.date;
}
