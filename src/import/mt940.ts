import { parseMoney } from "../money";
import { toCanonicalTable, type CanonicalRow, type CanonicalTable } from "./canonical";

/**
 * SWIFT MT940 — the older statement format every European bank still offers alongside CAMT.053, and
 * the one you get when you ask for "the format my accounting software reads".
 *
 * The file is a sequence of `:NN:` tagged fields, one statement per `:20:` block:
 *
 *   :25:  account identification (IBAN, sometimes with the currency stuck on the end)
 *   :61:  the transaction itself — dates, direction, amount, type code, references
 *   :86:  free-text information about the :61: immediately before it, often several lines
 *
 * :61: is fixed-position rather than delimited, which is why it's parsed with an explicit regex
 * instead of split on anything: value date (YYMMDD), an optional entry date (MMDD), the credit/debit
 * mark, the amount with a comma decimal separator, then a type code and references.
 */

/** Continuation lines (anything not starting a new `:NN:` tag) belong to the field above them. */
interface Field {
	tag: string;
	value: string;
}

function splitFields(text: string): Field[] {
	const fields: Field[] = [];
	for (const rawLine of text.split(/\r\n|\r|\n/)) {
		const line = rawLine.replace(/\s+$/, "");
		const match = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
		if (match) {
			fields.push({ tag: match[1], value: match[2] });
		} else if (fields.length > 0 && line.trim() && line.trim() !== "-") {
			// Joined with a space, not a newline: a wrapped :86: is one sentence split by line length,
			// and preserving the break would put arbitrary whitespace in the middle of a merchant name.
			fields[fields.length - 1].value += ` ${line.trim()}`;
		}
	}
	return fields;
}

/** "YYMMDD" → ISO. Two-digit years are this century unless that would be implausibly far ahead. */
function shortDate(yymmdd: string): string {
	const yy = parseInt(yymmdd.slice(0, 2), 10);
	const year = yy > new Date().getFullYear() % 100 ? 1900 + yy : 2000 + yy;
	return `${year}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

const STATEMENT_LINE = /^(\d{6})(\d{4})?([A-Z]?)([CD])([A-Z]?)([\d.,]+)([A-Z]\w{3})?(.*)$/;

interface StatementLine {
	date: string;
	amount: number;
	typeCode: string;
	reference: string;
}

function parseStatementLine(value: string): StatementLine | undefined {
	const m = STATEMENT_LINE.exec(value.trim());
	if (!m) return undefined;
	const [, valueDate, entryDate, , mark, reversal, rawAmount, typeCode, rest] = m;

	const magnitude = parseMoney(rawAmount);
	if (magnitude === undefined) return undefined;

	// "RC"/"RD" are reversals — a reversed credit is money leaving, and vice versa.
	const isReversal = reversal === "R";
	const isDebit = mark === "D" ? !isReversal : isReversal;

	// The entry date carries only MMDD; it takes its year from the value date, rolling back a year
	// when a December booking settles in January.
	let date = shortDate(valueDate);
	if (entryDate) {
		const year = parseInt(date.slice(0, 4), 10);
		const valueMonth = parseInt(date.slice(5, 7), 10);
		const entryMonth = parseInt(entryDate.slice(0, 2), 10);
		const adjustedYear = valueMonth === 1 && entryMonth === 12 ? year - 1 : year;
		date = `${adjustedYear}-${entryDate.slice(0, 2)}-${entryDate.slice(2, 4)}`;
	}

	return {
		date,
		amount: isDebit ? -Math.abs(magnitude) : Math.abs(magnitude),
		typeCode: typeCode ?? "",
		reference: (rest ?? "").trim(),
	};
}

/**
 * Pulls a name and a remittance line out of a :86: field.
 *
 * Dutch banks write these as `/TRTP/SEPA OVERBOEKING/IBAN/NL..../NAME/ALBERT HEIJN/REMI/...`, which
 * is worth unpacking — the alternative is every transaction being described by one long slash-run.
 * Anything not in that shape is returned as-is, which is the correct reading of a free-text field.
 */
function parseInformation(value: string): { name: string; iban: string; remittance: string; raw: string } {
	const raw = value.trim();
	if (!raw.startsWith("/")) return { name: "", iban: "", remittance: raw, raw };

	const parts = raw.split("/").filter((p) => p !== "");
	const tags: Record<string, string> = {};
	for (let i = 0; i < parts.length - 1; i += 2) {
		const key = parts[i].toUpperCase();
		if (/^[A-Z]{3,4}$/.test(key)) tags[key] = (tags[key] ? `${tags[key]} ` : "") + parts[i + 1];
	}
	return {
		name: tags.NAME ?? tags.NAM ?? "",
		iban: tags.IBAN ?? "",
		remittance: tags.REMI ?? tags.EREF ?? "",
		raw,
	};
}

export function isMt940(text: string): boolean {
	const head = text.slice(0, 4000);
	return /^\s*:(?:20|25|28C?|60F):/m.test(head) && /^\s*:61:/m.test(head);
}

export function parseMt940(text: string): CanonicalTable {
	const fields = splitFields(text);
	const out: CanonicalRow[] = [];

	let account = "";
	let currency = "";
	let pending: StatementLine | undefined;

	const flush = (info?: ReturnType<typeof parseInformation>): void => {
		if (!pending) return;
		const description = info?.remittance || info?.name || info?.raw || pending.reference || "(no description)";
		out.push({
			date: pending.date,
			description,
			counterparty: info?.name || info?.iban || undefined,
			amount: pending.amount,
			currency: currency || "EUR",
			type: pending.typeCode,
			code: pending.typeCode.replace(/^N/, ""),
			notes: info?.raw && info.raw !== description ? info.raw : undefined,
			account: account || undefined,
		});
		pending = undefined;
	};

	for (const field of fields) {
		if (field.tag === "25") {
			// ":25:NL12INGB0001234567EUR" — the currency is optionally welded onto the end of the account.
			const value = field.value.trim().replace(/\s+/g, "");
			const withCurrency = /^(.*?)([A-Z]{3})$/.exec(value);
			if (withCurrency && /\d/.test(withCurrency[1])) {
				account = withCurrency[1];
				currency = withCurrency[2];
			} else {
				account = value;
			}
			continue;
		}
		if (field.tag === "60F" || field.tag === "60M") {
			const m = /^[CD]\d{6}([A-Z]{3})/.exec(field.value.trim());
			if (m) currency = m[1];
			continue;
		}
		if (field.tag === "61") {
			// A :61: with no :86: after it is still a transaction — flush the previous one unannotated.
			flush();
			pending = parseStatementLine(field.value);
			continue;
		}
		if (field.tag === "86") {
			flush(parseInformation(field.value));
			continue;
		}
	}
	flush();

	if (out.length === 0) throw new Error("No :61: transaction lines found — this doesn't look like an MT940 statement.");
	return toCanonicalTable(out);
}
