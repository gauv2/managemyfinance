/**
 * KNAB's spreadsheet export, which carries no header row at all.
 *
 * Every other format here is recognised by reading its header row. KNAB's .xlsx opens straight into
 * data — cell A1 is the first transaction's date — so header detection is handed a transaction,
 * calls it unknown, and the sheet is dropped. A 3,203-row file then reports "no data in this file",
 * which is both wrong and unactionable.
 *
 * With no names to read, the columns have to be recognised by their content. The fingerprint below is
 * deliberately narrow: a column holding nothing but "Bij" and "Af" beside a column of dd-mm-yyyy
 * dates and a column of unsigned numbers, eight columns wide. That combination is not something a
 * random spreadsheet stumbles into, and every part of it is checked against every row rather than a
 * sample, so a file that merely starts out looking like KNAB is not silently misread as one.
 *
 * Recognising it produces KNAB's own column names, and from there the ordinary bank-profile path
 * takes over: `BANK_PROFILES` matches those names and pre-fills the mapping, including the
 * direction column that turns an unsigned amount into a signed one.
 */

/** KNAB's own column names, in export order — supplied for a sheet that ships without them. */
export const KNAB_HEADERS = [
	"Datum",
	"Transactienummer",
	"Soort",
	"Af Bij",
	"Bedrag",
	"Omschrijving",
	"Tegenpartij",
	"Tegenrekening",
] as const;

const DUTCH_DATE = /^\d{2}-\d{2}-\d{4}$/;
const DIRECTIONS = new Set(["bij", "af"]);

function text(value: unknown): string {
	return value === null || value === undefined ? "" : String(value).trim();
}

/**
 * Does this headerless sheet have KNAB's shape?
 *
 * Requires a handful of rows before answering yes: two or three rows of anything can look like
 * anything, and the cost of a false positive here is a file imported under the wrong column meanings.
 */
export function looksLikeKnabSheet(rows: unknown[][]): boolean {
	const usable = rows.filter((row) => row.some((cell) => text(cell) !== ""));
	if (usable.length < 5) return false;
	if (!usable.every((row) => row.length === KNAB_HEADERS.length)) return false;

	return usable.every((row) => {
		if (!DUTCH_DATE.test(text(row[0]))) return false;
		if (!DIRECTIONS.has(text(row[3]).toLowerCase())) return false;
		// Unsigned throughout — the direction column is what carries the sign, and a negative here
		// would mean this is some other layout that happens to share the first four columns.
		const amount = row[4];
		return typeof amount === "number" ? amount >= 0 : /^\d+([.,]\d+)?$/.test(text(amount));
	});
}
