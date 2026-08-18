import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { fetchHistoricalRates, fetchLatestRates } from "./fx";

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, requestUrl: vi.fn() };
});

const mockRequest = vi.mocked(requestUrl);

/**
 * The plugin's one and only outbound request. What matters here isn't the network call but the
 * inversion: Frankfurter answers "1 EUR = X foreign", and this app stores "1 foreign = ? EUR". Getting
 * that backwards would quietly value every foreign holding at the reciprocal of the truth.
 */
describe("fetchLatestRates", () => {
	beforeEach(() => mockRequest.mockReset());

	it("inverts the API's rates into this app's convention", async () => {
		// 1 EUR = 1.10 USD, so 1 USD = 0.909091 EUR.
		mockRequest.mockResolvedValue({ json: { rates: { USD: 1.1, GBP: 0.8 } } } as never);

		const rates = await fetchLatestRates();

		expect(rates.USD).toBeCloseTo(0.909_091, 6);
		expect(rates.GBP).toBeCloseTo(1.25, 6);
	});

	it("rounds to 6dp, since full float precision is noise nobody reads", async () => {
		mockRequest.mockResolvedValue({ json: { rates: { USD: 3 } } } as never);
		const rates = await fetchLatestRates();
		expect(rates.USD).toBe(0.333_333);
	});

	it("asks only for currency codes — nothing from the vault ever goes out", async () => {
		mockRequest.mockResolvedValue({ json: { rates: {} } } as never);
		await fetchLatestRates();

		// requestUrl takes a string or an options object; this module always passes the object form.
		const url = (mockRequest.mock.calls[0][0] as { url: string }).url;
		expect(url).toContain("base=EUR");
		expect(url).toContain("symbols=");
		expect(url).not.toContain("EUR,EUR");
	});

	it("drops a nonsensical rate rather than dividing by it", async () => {
		mockRequest.mockResolvedValue({ json: { rates: { USD: 0, GBP: -1, CHF: 2 } } } as never);
		const rates = await fetchLatestRates();

		expect(rates.USD).toBeUndefined();
		expect(rates.GBP).toBeUndefined();
		expect(rates.CHF).toBe(0.5);
	});

	it("throws a readable error when the response isn't what it should be", async () => {
		mockRequest.mockResolvedValue({ json: {} } as never);
		await expect(fetchLatestRates()).rejects.toThrow(/Unexpected response/);
	});
});

describe("fetchHistoricalRates", () => {
	beforeEach(() => mockRequest.mockReset());

	it("hits the dated endpoint instead of /latest, same inversion as fetchLatestRates", async () => {
		mockRequest.mockResolvedValue({ json: { rates: { USD: 1.1 } } } as never);
		const rates = await fetchHistoricalRates("2020-03-15");
		expect(rates.USD).toBeCloseTo(0.909_091, 6);
		const url = (mockRequest.mock.calls[0][0] as { url: string }).url;
		expect(url).toContain("/2020-03-15?");
		expect(url).not.toContain("/latest");
	});

	it("throws a readable, date-identifying error when the response isn't what it should be", async () => {
		mockRequest.mockResolvedValue({ json: {} } as never);
		await expect(fetchHistoricalRates("2020-03-15")).rejects.toThrow(/2020-03-15/);
	});
});
