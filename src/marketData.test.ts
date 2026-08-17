import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { fetchPrice } from "./marketData";

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, requestUrl: vi.fn() };
});

const mockRequest = vi.mocked(requestUrl);

describe("fetchPrice", () => {
	beforeEach(() => mockRequest.mockReset());

	it("resolves an ISIN via Yahoo's search endpoint, then prices the resolved symbol", async () => {
		mockRequest
			.mockResolvedValueOnce({ json: { quotes: [{ symbol: "IWDA.AS" }] } } as never)
			.mockResolvedValueOnce({ json: { chart: { result: [{ meta: { regularMarketPrice: 102.34, currency: "EUR" } }] } } } as never);

		const quote = await fetchPrice("IE00B4L5Y983", "EUR");

		expect(quote).toEqual({ price: 102.34, currency: "EUR" });
		expect(mockRequest.mock.calls[0][0]).toMatchObject({ url: expect.stringContaining("IE00B4L5Y983") });
		expect(mockRequest.mock.calls[1][0]).toMatchObject({ url: expect.stringContaining("IWDA.AS") });
	});

	it("returns undefined when Yahoo's search turns up no symbol, without a second request", async () => {
		mockRequest.mockResolvedValueOnce({ json: { quotes: [] } } as never);

		const quote = await fetchPrice("IE00B4L5Y983", "EUR");

		expect(quote).toBeUndefined();
		expect(mockRequest).toHaveBeenCalledTimes(1);
	});

	it("prices a known crypto ticker via CoinGecko instead of Yahoo", async () => {
		mockRequest.mockResolvedValueOnce({ json: { bitcoin: { eur: 61234.5 } } } as never);

		const quote = await fetchPrice("BTC", "EUR");

		expect(quote).toEqual({ price: 61234.5, currency: "EUR" });
		const url = (mockRequest.mock.calls[0][0] as { url: string }).url;
		expect(url).toContain("coingecko.com");
		expect(url).toContain("bitcoin");
	});

	it("returns undefined for an unrecognised non-ISIN ticker without making a request", async () => {
		const quote = await fetchPrice("NOTACOIN", "EUR");

		expect(quote).toBeUndefined();
		expect(mockRequest).not.toHaveBeenCalled();
	});

	it("sends only the ticker — nothing from the vault (shares, amounts, account names) goes out", async () => {
		mockRequest
			.mockResolvedValueOnce({ json: { quotes: [{ symbol: "IWDA.AS" }] } } as never)
			.mockResolvedValueOnce({ json: { chart: { result: [{ meta: { regularMarketPrice: 100, currency: "EUR" } }] } } } as never);

		await fetchPrice("IE00B4L5Y983", "EUR");

		for (const call of mockRequest.mock.calls) {
			const url = (call[0] as { url: string }).url;
			expect(url).not.toMatch(/shares|amount|balance/i);
		}
	});

	it("returns undefined rather than throwing when the network call rejects", async () => {
		mockRequest.mockRejectedValueOnce(new Error("network down"));

		await expect(fetchPrice("IE00B4L5Y983", "EUR")).resolves.toBeUndefined();
	});
});
