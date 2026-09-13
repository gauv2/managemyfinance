import { describe, expect, it } from "vitest";
import { KNAB_HEADERS, looksLikeKnabSheet } from "./knabSheet";
import { detectFormat } from "./detect";
import { matchBankProfile } from "./bankProfiles";

/** A KNAB row, in the export's own eight-column order. */
function row(date: string, direction: "Bij" | "Af", amount: number, desc = "Albert Heijn", payee = "AH BUNNIK"): unknown[] {
	return [date, "13450416", "Betaalautomaat", direction, amount, desc, payee, "NL04RABO0356343936"];
}

function sheet(n = 6): unknown[][] {
	return Array.from({ length: n }, (_, i) => row(`${String(i + 1).padStart(2, "0")}-11-2014`, i % 2 ? "Bij" : "Af", 12.5 + i));
}

describe("looksLikeKnabSheet", () => {
	it("recognises the export's shape without a header row", () => {
		expect(looksLikeKnabSheet(sheet())).toBe(true);
	});

	it("tolerates the empty cells the export really contains", () => {
		// Description is blank on 427 rows of the real file and the counter-account on 1,247.
		const rows = sheet();
		rows[0][5] = null;
		rows[1][7] = null;
		expect(looksLikeKnabSheet(rows)).toBe(true);
	});

	it("ignores wholly blank rows rather than failing on them", () => {
		expect(looksLikeKnabSheet([...sheet(), ["", "", "", "", "", "", "", ""]])).toBe(true);
	});

	it("refuses a sheet that merely starts out looking like KNAB", () => {
		// Every row is checked, not a sample — a file misread as KNAB would import under the wrong
		// column meanings, which is worse than not importing at all.
		const rows = sheet();
		rows[4][3] = "Credit";
		expect(looksLikeKnabSheet(rows)).toBe(false);
	});

	it("refuses a signed amount column", () => {
		// KNAB's amounts are unsigned; the direction column carries the sign. A negative here means
		// some other layout that happens to share the first four columns.
		const rows = sheet();
		rows[2][4] = -12.5;
		expect(looksLikeKnabSheet(rows)).toBe(false);
	});

	it("refuses ISO dates, which KNAB does not write", () => {
		const rows = sheet();
		rows[3][0] = "2014-11-04";
		expect(looksLikeKnabSheet(rows)).toBe(false);
	});

	it("refuses a sheet of the wrong width", () => {
		expect(looksLikeKnabSheet(sheet().map((r) => r.slice(0, 7)))).toBe(false);
	});

	it("refuses too few rows to be sure", () => {
		expect(looksLikeKnabSheet(sheet(3))).toBe(false);
	});

	it("refuses an ordinary headed sheet", () => {
		const headed: unknown[][] = [
			["Date", "Description", "Counterparty", "Amount", "Currency", "Type", "Code", "Notes"],
			...sheet(),
		];
		expect(looksLikeKnabSheet(headed)).toBe(false);
	});
});

describe("the headers KNAB's sheet is given", () => {
	it("are recognised as KNAB by the ordinary detector", () => {
		expect(detectFormat([...KNAB_HEADERS])).toBe("knab");
	});

	it("map the payee's name to counterparty, not their account number", () => {
		// "Tegenrekening" holds an IBAN. Filing that as the counterparty makes every merchant look
		// like a different one and defeats merchant memory entirely.
		const mapping = matchBankProfile([...KNAB_HEADERS])!.mapping([...KNAB_HEADERS]);
		expect(mapping.counterparty).toBe("Tegenpartij");
		expect(mapping.amount).toBe("Bedrag");
		expect(mapping.date).toBe("Datum");
	});

	it("carry the direction column, so an unsigned amount gets its sign", () => {
		const mapping = matchBankProfile([...KNAB_HEADERS])!.mapping([...KNAB_HEADERS]);
		expect(mapping.debitCredit).toBe("Af Bij");
		expect(mapping.debitValue).toBe("Af");
	});
});
