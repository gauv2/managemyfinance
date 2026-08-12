import { describe, it, expect, afterEach } from "vitest";
import {
	decimalSeparator,
	formatMoney,
	formatMoneyForInput,
	parseMoney,
	parseMoneyOr,
	setNumberFormatPreference,
} from "./money";

afterEach(() => setNumberFormatPreference("auto"));

describe("parseMoney — plain numbers", () => {
	it("passes finite numbers straight through", () => {
		expect(parseMoney(12.34)).toBe(12.34);
		expect(parseMoney(-5)).toBe(-5);
		expect(parseMoney(0)).toBe(0);
	});

	it("rejects non-finite numbers and blanks", () => {
		expect(parseMoney(NaN)).toBeUndefined();
		expect(parseMoney(Infinity)).toBeUndefined();
		expect(parseMoney("")).toBeUndefined();
		expect(parseMoney("   ")).toBeUndefined();
		expect(parseMoney(null)).toBeUndefined();
		expect(parseMoney(undefined)).toBeUndefined();
	});

	it("reads unseparated integers and decimals", () => {
		expect(parseMoney("42")).toBe(42);
		expect(parseMoney("0")).toBe(0);
		expect(parseMoney("1234567")).toBe(1234567);
	});
});

describe("parseMoney — decimal separator", () => {
	it("accepts either separator for cents", () => {
		expect(parseMoney("12.34")).toBe(12.34);
		expect(parseMoney("12,34")).toBe(12.34);
		expect(parseMoney("0,05")).toBe(0.05);
		expect(parseMoney("0.05")).toBe(0.05);
	});

	it("reads a single non-cents fraction as a decimal, not a grouping", () => {
		expect(parseMoney("1,5")).toBe(1.5);
		expect(parseMoney("1.5")).toBe(1.5);
		expect(parseMoney("2,7182")).toBe(2.7182);
	});

	it("handles a separator with nothing after it", () => {
		expect(parseMoney("12.")).toBe(12);
		expect(parseMoney("12,")).toBe(12);
	});

	it("handles a leading separator", () => {
		expect(parseMoney(",50")).toBe(0.5);
		expect(parseMoney(".50")).toBe(0.5);
	});
});

describe("parseMoney — thousands grouping", () => {
	// The regression this module exists for: the old parsers turned 1.234,56 into 1.234.
	it("reads Dutch/European grouping", () => {
		expect(parseMoney("1.234,56")).toBe(1234.56);
		expect(parseMoney("1.234.567,89")).toBe(1234567.89);
		expect(parseMoney("12.345,00")).toBe(12345);
	});

	it("reads Anglo grouping", () => {
		expect(parseMoney("1,234.56")).toBe(1234.56);
		expect(parseMoney("1,234,567.89")).toBe(1234567.89);
	});

	it("reads a lone clean grouping as thousands in both conventions", () => {
		expect(parseMoney("1.234")).toBe(1234);
		expect(parseMoney("1,234")).toBe(1234);
		expect(parseMoney("999.999")).toBe(999999);
	});

	it("does not mistake a 3-digit fraction for a grouping when the whole part is too long", () => {
		expect(parseMoney("1234,567")).toBe(1234.567);
		expect(parseMoney("1234.567")).toBe(1234.567);
	});

	it("reads space and apostrophe grouping", () => {
		expect(parseMoney("1 234,56")).toBe(1234.56);
		expect(parseMoney("1 234,56")).toBe(1234.56);
		expect(parseMoney("1'234.56")).toBe(1234.56);
	});
});

describe("parseMoney — signs", () => {
	it("reads leading and trailing minus signs", () => {
		expect(parseMoney("-1.234,56")).toBe(-1234.56);
		expect(parseMoney("1.234,56-")).toBe(-1234.56);
		expect(parseMoney("+42,50")).toBe(42.5);
	});

	it("reads accountancy parentheses as negative", () => {
		expect(parseMoney("(1.234,56)")).toBe(-1234.56);
		expect(parseMoney("(42)")).toBe(-42);
	});

	it("does not double-negate parentheses around an already-negative number", () => {
		expect(parseMoney("(-42)")).toBe(42);
	});
});

describe("parseMoney — currency decoration", () => {
	it("strips symbols and codes on either side", () => {
		expect(parseMoney("€ 1.234,56")).toBe(1234.56);
		expect(parseMoney("$1,234.56")).toBe(1234.56);
		expect(parseMoney("1.234,56 EUR")).toBe(1234.56);
		expect(parseMoney("EUR 1.234,56")).toBe(1234.56);
		expect(parseMoney("£99.99")).toBe(99.99);
		expect(parseMoney("-€ 42,00")).toBe(-42);
	});
});

describe("parseMoney — rejects what it cannot read", () => {
	it("refuses text rather than guessing a number out of it", () => {
		expect(parseMoney("n/a")).toBeUndefined();
		expect(parseMoney("12abc")).toBeUndefined();
		expect(parseMoney("--5")).toBeUndefined();
	});

	it("refuses contradictory separator layouts", () => {
		expect(parseMoney("1.2.3")).toBeUndefined();
		expect(parseMoney("1,2,3")).toBeUndefined();
		expect(parseMoney("1.234.5,6,7")).toBeUndefined();
	});
});

describe("parseMoneyOr", () => {
	it("falls back only when the value is unreadable", () => {
		expect(parseMoneyOr("1.234,56", 0)).toBe(1234.56);
		expect(parseMoneyOr("", 0)).toBe(0);
		expect(parseMoneyOr("n/a", 0)).toBe(0);
		expect(parseMoneyOr("0", 99)).toBe(0);
	});
});

describe("formatMoney", () => {
	it("writes the preferred separators", () => {
		setNumberFormatPreference("dot");
		expect(formatMoney(1234.56, { plain: true })).toBe("1,234.56");
		setNumberFormatPreference("comma");
		expect(formatMoney(1234.56, { plain: true })).toBe("1.234,56");
	});

	it("round-trips through parseMoney under either preference", () => {
		for (const pref of ["dot", "comma", "space"] as const) {
			setNumberFormatPreference(pref);
			expect(parseMoney(formatMoney(1234.56, { plain: true }))).toBe(1234.56);
			expect(parseMoney(formatMoney(-987654.32, { plain: true }))).toBe(-987654.32);
		}
	});

	it("includes the currency unless plain is set", () => {
		setNumberFormatPreference("dot");
		expect(formatMoney(10, { currency: "EUR" })).toContain("10.00");
		expect(formatMoney(10, { currency: "EUR" })).not.toBe("10.00");
		expect(formatMoney(10, { plain: true })).toBe("10.00");
	});

	it("prefixes non-negative values when signed", () => {
		setNumberFormatPreference("dot");
		expect(formatMoney(10, { plain: true, signed: true })).toBe("+10.00");
		expect(formatMoney(-10, { plain: true, signed: true })).toBe("-10.00");
	});
});

describe("formatMoneyForInput", () => {
	it("writes an ungrouped value using the preferred decimal separator", () => {
		setNumberFormatPreference("comma");
		expect(formatMoneyForInput(1234.56)).toBe("1234,56");
		expect(decimalSeparator()).toBe(",");
		setNumberFormatPreference("dot");
		expect(formatMoneyForInput(1234.56)).toBe("1234.56");
		expect(decimalSeparator()).toBe(".");
	});

	it("round-trips back through parseMoney", () => {
		for (const pref of ["dot", "comma"] as const) {
			setNumberFormatPreference(pref);
			expect(parseMoney(formatMoneyForInput(1234.56))).toBe(1234.56);
			expect(parseMoney(formatMoneyForInput(-0.05))).toBe(-0.05);
		}
	});

	it("is blank for an unset amount", () => {
		expect(formatMoneyForInput(undefined)).toBe("");
	});
});
