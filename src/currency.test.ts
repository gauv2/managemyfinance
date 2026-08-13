import { describe, expect, it } from "vitest";
import { baseCurrencyOf, canConvert, convert, unconvertibleCurrencies } from "./currency";

/**
 * The rate table stores "1 unit of X = N EUR" regardless of which currency is on display, so EUR
 * stays the pivot even when the base is something else. These tests pin that down, along with the
 * decision that a missing rate passes an amount through rather than dropping or zeroing it.
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

	it("passes an amount through unconverted when no rate is known", () => {
		// Wrong by the exchange rate, rather than wrong by the whole transaction — and exactly right
		// for the single-currency user who has never opened the rate settings.
		expect(convert(100, "SEK", { baseCurrency: "EUR", rates })).toBe(100);
	});

	it("ignores a rate that isn't a usable number", () => {
		expect(convert(100, "USD", { baseCurrency: "EUR", rates: { USD: 0 } })).toBe(100);
		expect(convert(100, "USD", { baseCurrency: "EUR", rates: { USD: -1 } })).toBe(100);
	});

	it("treats currency codes case-insensitively and defaults a missing one to base", () => {
		expect(convert(100, "usd", { baseCurrency: "EUR", rates })).toBeCloseTo(90, 6);
		expect(convert(100, undefined, { baseCurrency: "EUR", rates })).toBe(100);
	});

	it("returns 0 rather than NaN for a non-finite amount", () => {
		expect(convert(NaN, "EUR", { baseCurrency: "EUR", rates })).toBe(0);
		expect(convert(Infinity, "USD", { baseCurrency: "EUR", rates })).toBe(0);
	});

	it("defaults to EUR when no fx context is given", () => {
		expect(baseCurrencyOf(undefined)).toBe("EUR");
		expect(convert(100, "USD", undefined)).toBe(100);
	});
});

describe("canConvert / unconvertibleCurrencies", () => {
	it("reports which currencies are silently being counted 1:1", () => {
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
