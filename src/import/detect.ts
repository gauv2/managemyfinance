export type DetectedFormat = "ing" | "trade-republic" | "unknown";

function norm(h: string): string {
	return h.trim().toLowerCase();
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
	return "unknown";
}
