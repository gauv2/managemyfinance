import { describe, expect, it } from "vitest";
import { baseCurrencyOf, canConvert, convert, unconvertibleCurrencies } from "./currency";

/**
 * The rate table stores "1 unit of X = N EUR" regardless of which currency is on display, so EUR
 * stays the pivot even when the base is something else. These tests pin that down, along with the
 * v1.2.7 contract that a genuinely unresolvable rate returns NaN rather than a plausible-looking
 * number (FIN-008) — the earlier "pass it through 1:1" behavior these tests used to encode was exactly
 * the silent-wrong-arithmetic bug the audit's later pass flagged as still open.
 */
describe("convert", () => {
	const rates = { USD: 0.9, GBP: 1.15 };

	it("leaves an amount already in the base currency untouched", () => {
		expect(convert(100, "EUR", { baseCurrency: "EUR", rates })).toBe(100);
		expect(convert(100, "USD", { baseCurrency: "USD", rates })).toBe(100);
	});

	it("converts into EUR using the stored rate", () => {
		expect(convert(100, "USD", { baseCurrency: "EUR", rates })).toBeCloseTo(90, 6);
	});

	it("converts between two non-EUR currencies through EUR", () => {
		// 100 GBP = 115 EUR; 115 EUR / 0.9 = 127.78 USD
		expect(convert(100, "GBP", { baseCurrency: "USD", rates })).toBeCloseTo(127.777_78, 4);
	});

	it("returns NaN — not a plausible-looking 1:1 passthrough — when no rate is known", () => {
		expect(convert(100, "SEK", { baseCurrency: "EUR", rates })).toBeNaN();
	});

	it("ignores a rate that isn't a usable number, same as no rate at all", () => {
		expect(convert(100, "USD", { baseCurrency: "EUR", rates: { USD: 0 } })).toBeNaN();
		expect(convert(100, "USD", { baseCurrency: "EUR", rates: { USD: -1 } })).toBeNaN();
	});

	it("treats currency codes case-insensitively and defaults a missing one to base", () => {
		expect(convert(100, "usd", { baseCurrency: "EUR", rates })).toBeCloseTo(90, 6);
		expect(convert(100, undefined, { baseCurrency: "EUR", rates })).toBe(100);
	});

	it("returns 0 rather than NaN for a non-finite amount", () => {
		expect(convert(NaN, "EUR", { baseCurrency: "EUR", rates })).toBe(0);
		expect(convert(Infinity, "USD", { baseCurrency: "EUR", rates })).toBe(0);
	});

	it("defaults to EUR when no fx context is given, and still can't invent a USD rate out of nothing", () => {
		expect(baseCurrencyOf(undefined)).toBe("EUR");
		expect(convert(100, "USD", undefined)).toBeNaN();
		// A currency that already matches the (defaulted) base still passes through untouched — there's
		// nothing to convert regardless of whether an fx context exists at all.
		expect(convert(100, "EUR", undefined)).toBe(100);
	});
});

// ---------- flow vs stock FX (v1.2.7 remediation Phase 3) ----------

describe("convert — historical (dated) rates", () => {
	const rates = { USD: 0.9 }; // "today's" rate
	const history = { "2020-01-01": { USD: 0.8 } }; // 2020's rate, different from today's

	it("uses the historical rate for a date that's been backfilled, not today's rate", () => {
		expect(convert(100, "USD", { baseCurrency: "EUR", rates, history }, "2020-01-01")).toBeCloseTo(80, 6);
	});

	it("historical stability: once backfilled, a later change to today's rate doesn't move the historical total", () => {
		const changedRates = { USD: 0.5 }; // today's rate moved a lot since
		expect(convert(100, "USD", { baseCurrency: "EUR", rates: changedRates, history }, "2020-01-01")).toBeCloseTo(80, 6);
	});

	it("current (stock) conversion still uses today's rate and does move when it changes", () => {
		expect(convert(100, "USD", { baseCurrency: "EUR", rates })).toBeCloseTo(90, 6);
		const changedRates = { USD: 0.5 };
		expect(convert(100, "USD", { baseCurrency: "EUR", rates: changedRates })).toBeCloseTo(50, 6);
	});

	it("falls back to today's rate for a date that hasn't been backfilled yet, rather than failing outright", () => {
		expect(convert(100, "USD", { baseCurrency: "EUR", rates, history }, "2019-06-01")).toBeCloseTo(90, 6);
	});

	it("still returns NaN for a date-aware conversion when no rate exists anywhere, historical or current", () => {
		expect(convert(100, "SEK", { baseCurrency: "EUR", rates, history }, "2020-01-01")).toBeNaN();
	});

	it("pivots correctly through EUR for a non-EUR base at a historical date (base-currency-change scenario)", () => {
		// Base is USD; GBP's historical rate that day was 1.1 EUR, USD's was 0.8 EUR.
		const gbpHistory = { "2020-01-01": { USD: 0.8, GBP: 1.1 } };
		// 100 GBP = 110 EUR; 110 EUR / 0.8 = 137.5 USD.
		expect(convert(100, "GBP", { baseCurrency: "USD", rates: { GBP: 1.15 }, history: gbpHistory }, "2020-01-01")).toBeCloseTo(137.5, 6);
	});
});

describe("canConvert / unconvertibleCurrencies", () => {
	it("reports which currencies have no usable rate at all — what convert() would return NaN for", () => {
		const fx = { baseCurrency: "EUR", rates: { USD: 0.9 } };
		expect(canConvert("USD", fx)).toBe(true);
		expect(canConvert("EUR", fx)).toBe(true);
		expect(canConvert("SEK", fx)).toBe(false);

		const items = [{ currency: "EUR" }, { currency: "USD" }, { currency: "SEK" }, { currency: "NOK" }];
		expect(unconvertibleCurrencies(items, fx)).toEqual(["NOK", "SEK"]);
	});

	it("finds nothing unconvertible when everything is already in the base currency", () => {
		expect(unconvertibleCurrencies([{ currency: "EUR" }, { currency: undefined }], { baseCurrency: "EUR" })).toEqual([]);
	});
});
