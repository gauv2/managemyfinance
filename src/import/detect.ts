import { isCamt053 } from "./camt053";
import { isMt940 } from "./mt940";
import { isOfx } from "./ofx";
import { isQif } from "./qif";
import { matchBankProfile } from "./bankProfiles";

/** A table's shape, once its header row has been read. Bank profiles (Revolut/bunq/N26) come back as
 *  their own source id so the wizard can pre-fill that bank's column mapping. */
export type DetectedFormat =
	| "ing"
	| "trade-republic"
	| "revolut"
	| "bunq"
	| "n26"
	| "knab"
	/** Statement formats, decided from file content rather than a header row — see detectFileFormat. */
	| "camt"
	| "mt940"
	| "ofx"
	| "qif"
	| "unknown";

/** Formats that carry an account identifier on every row, so a multi-account file can be split up. */
export const IBAN_BEARING_FORMATS: DetectedFormat[] = ["ing", "camt", "mt940", "ofx"];

/** What kind of file this is at all, decided from its content before any CSV parsing happens. */
export type DetectedFileFormat = "camt053" | "mt940" | "ofx" | "qif" | "xlsx" | "csv";

function norm(h: string): string {
	return h.trim().toLowerCase();
}

/**
 * Which statement format a file's *content* is, independent of its extension — a bank that names its
 * CAMT export ".txt" or its OFX ".qfx" is common enough that trusting the extension alone would
 * reject perfectly readable files. The extension is used only for the binary case (.xlsx), which
 * can't be sniffed as text.
 */
export function detectFileFormat(text: string, fileName = ""): DetectedFileFormat {
	if (fileName.toLowerCase().endsWith(".xlsx")) return "xlsx";
	if (isCamt053(text)) return "camt053";
	if (isOfx(text)) return "ofx";
	if (isMt940(text)) return "mt940";
	if (isQif(text)) return "qif";
	return "csv";
}

/** Detects a known bank/broker export purely from its header row, so no manual mapping is needed for supported sources. */
export function detectFormat(headers: string[]): DetectedFormat {
	const set = new Set(headers.map(norm));
	const hasAll = (...cols: string[]) => cols.every((c) => set.has(c));

	if (hasAll("date", "name / description", "counterparty", "debit/credit")) {
		return "ing";
	}
	// ING's raw CSV download (as opposed to the curated English workbook) comes out in Dutch when
	// the account's locale is Dutch: Datum, Naam / Omschrijving, Tegenrekening, Af Bij.
	if (hasAll("datum", "naam / omschrijving", "tegenrekening", "af bij")) {
		return "ing";
	}
	// The "all accounts" / savings export uses a plain "Description" column instead of "Name / Description".
	if (hasAll("date", "description", "counterparty", "debit/credit")) {
		return "ing";
	}
	if (
		(set.has("action") || set.has("type")) &&
		(set.has("ticker") || set.has("isin") || set.has("symbol")) &&
		(set.has("amount") || set.has("amount (eur)"))
	) {
		return "trade-republic";
	}

	// Checked after the two formats with dedicated parsers, so a profile's looser signature can never
	// steal a file one of those would have read better.
	const profile = matchBankProfile(headers);
	if (profile) return profile.id as DetectedFormat;

	return "unknown";
}
