import { parseMoney } from "../money";
import { toCanonicalTable, type CanonicalRow, type CanonicalTable } from "./canonical";

/**
 * QIF — Quicken Interchange Format. Ancient, under-specified, and still what a surprising number of
 * tools export. Records are single-letter-prefixed lines terminated by a lone `^`:
 *
 *   D  date            T  amount            P  payee
 *   M  memo            N  cheque/reference   L  category
 *   C  cleared status  ^  end of record
 *
 * The format's real flaw is dates: it specifies no order, so "01/05/2024" is the 1st of May to a
 * European export and the 5th of January to an American one. Guessing per row is how ledgers end up
 * with two different calendars in them, so the order is decided once for the whole file (see
 * detectDateOrder) and applied uniformly.
 */

export type QifDateOrder = "dmy" | "mdy";

/**
 * Works out whether a file's dates are day-first or month-first from the file as a whole.
 *
 * A component above 12 can only be a day, so one unambiguous date settles the entire file. With no
 * such date anywhere — a file where every date happens to fall in the first twelve days of a month —
 * it falls back to day-first, matching the European convention the rest of this plugin assumes.
 */
export function detectDateOrder(dates: string[]): QifDateOrder {
	for (const raw of dates) {
		const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(raw.trim());
		if (!m) continue;
		const first = parseInt(m[1], 10);
		const second = parseInt(m[2], 10);
		if (first > 12 && second <= 12) return "dmy";
		if (second > 12 && first <= 12) return "mdy";
	}
	return "dmy";
}

/** QIF dates: "D01/05/24", "D1/ 5'24" (Quicken's apostrophe year), or an ISO date if you're lucky. */
export function parseQifDate(raw: string, order: QifDateOrder): string {
	const s = raw.trim().replace(/'/g, "/").replace(/\s+/g, "");
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

	const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
	if (!m) return "";
	const [, a, b, rawYear] = m;
	const day = order === "dmy" ? a : b;
	const month = order === "dmy" ? b : a;
	const year = rawYear.length === 2 ? (Number(rawYear) > 70 ? `19${rawYear}` : `20${rawYear}`) : rawYear;
	return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function isQif(text: string): boolean {
	return /^\s*!Type:/im.test(text.slice(0, 2000));
}

export function parseQif(text: string): CanonicalTable {
	const lines = text.split(/\r\n|\r|\n/);

	// Two passes: the first only to settle the date order, since a decision made from the whole file
	// is the only way every row lands on the same calendar.
	const order = detectDateOrder(lines.filter((l) => l.startsWith("D")).map((l) => l.slice(1)));

	const out: CanonicalRow[] = [];
	let record: Record<string, string> = {};

	const flush = (): void => {
		if (record.T === undefined && record.U === undefined) {
			record = {};
			return;
		}
		const amount = parseMoney(record.T ?? record.U ?? "");
		const date = parseQifDate(record.D ?? "", order);
		if (amount === undefined || !date) {
			record = {};
			return;
		}
		const payee = (record.P ?? "").trim();
		const memo = (record.M ?? "").trim();
		out.push({
			date,
			description: payee || memo || "(no description)",
			counterparty: payee || undefined,
			amount,
			currency: "",
			// QIF's L field is the exporting tool's own category. Kept in "transaction type" so the
			// existing category-alias lookup can pick it up, exactly as it does for a bank CSV's own
			// category column, rather than being thrown away.
			type: (record.L ?? "").replace(/^[[\]]/g, "").trim(),
			code: (record.N ?? "").trim(),
			notes: memo && memo !== payee ? memo : undefined,
		});
		record = {};
	};

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith("!")) continue;
		if (line === "^") {
			flush();
			continue;
		}
		const key = line[0];
		const value = line.slice(1);
		// Split lines (S/E/$) repeat within one record; keeping the first is right for a flat ledger.
		record[key] = record[key] === undefined ? value : record[key];
	}
	flush();

	if (out.length === 0) throw new Error("No usable records found — this doesn't look like a QIF file.");
	return toCanonicalTable(out);
}
