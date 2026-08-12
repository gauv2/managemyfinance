import { describe, expect, it } from "vitest";
import { parseCSV, toCSV } from "./csv";

/**
 * The codec the whole ledger is stored through. A bug here doesn't throw — it shifts a column, and
 * every amount in the vault silently becomes something else.
 */
describe("parseCSV", () => {
	it("reads a plain comma-separated file", () => {
		expect(parseCSV("a,b,c\n1,2,3\n")).toEqual([
			["a", "b", "c"],
			["1", "2", "3"],
		]);
	});

	it("switches to semicolons when the header uses them, as Dutch-locale exports do", () => {
		expect(parseCSV("a;b;c\n1;2;3\n")).toEqual([
			["a", "b", "c"],
			["1", "2", "3"],
		]);
	});

	it("keeps a comma that's inside a quoted field", () => {
		expect(parseCSV('a,b\n"Smith, John",42\n')).toEqual([
			["a", "b"],
			["Smith, John", "42"],
		]);
	});

	it("reads a doubled quote as one literal quote", () => {
		expect(parseCSV('a\n"He said ""hi"""\n')).toEqual([["a"], ['He said "hi"']]);
	});

	it("keeps a newline inside a quoted field rather than splitting the row", () => {
		expect(parseCSV('a,b\n"line one\nline two",x\n')).toEqual([
			["a", "b"],
			["line one\nline two", "x"],
		]);
	});

	it("handles CRLF and lone CR line endings", () => {
		expect(parseCSV("a,b\r\n1,2\r\n")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
		expect(parseCSV("a,b\r1,2")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});

	it("strips a UTF-8 BOM so the first header cell still matches", () => {
		const rows = parseCSV("﻿Date,Amount\n2024-01-01,5\n");
		expect(rows[0][0]).toBe("Date");
	});

	it("drops blank lines but keeps genuinely empty fields", () => {
		expect(parseCSV("a,b\n\n1,\n")).toEqual([
			["a", "b"],
			["1", ""],
		]);
	});

	it("returns nothing for empty input", () => {
		expect(parseCSV("")).toEqual([]);
	});
});

describe("toCSV", () => {
	it("quotes only the cells that need it", () => {
		expect(toCSV([["plain", "with,comma", 'with"quote', "with\nnewline"]])).toBe(
			'plain,"with,comma","with""quote","with\nnewline"\n'
		);
	});

	it("writes undefined and null as empty cells rather than the words", () => {
		expect(toCSV([["a", undefined, "b"]])).toBe("a,,b\n");
	});

	it("writes numbers without formatting them", () => {
		expect(toCSV([[1234.5, -0.01]])).toBe("1234.5,-0.01\n");
	});

	it("round-trips anything parseCSV can read", () => {
		const rows = [
			["id", "description", "amount"],
			["a", 'Payment for "goods", misc', "-12.50"],
			["b", "line one\nline two", "3"],
		];
		expect(parseCSV(toCSV(rows))).toEqual(rows);
	});
});
