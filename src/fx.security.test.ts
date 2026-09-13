import { describe, expect, it, vi } from "vitest";

const requestUrl = vi.fn();
vi.mock("obsidian", () => ({ requestUrl: (...a: unknown[]) => requestUrl(...a) }));

import { fetchHistoricalRates } from "./fx";

describe("fetchHistoricalRates guards the date it puts in a URL", () => {
	it("refuses anything that isn't a plain ISO date", async () => {
		// `parseFlexibleDate` returns its input unchanged when it can't read it, so a bank export in an
		// unrecognised format leaves raw text in `tx.date` — which used to be interpolated into the
		// request path verbatim.
		for (const bad of ["../../etc", "2014-13", "not a date", "", "2014-01-01/../x"]) {
			await expect(fetchHistoricalRates(bad)).rejects.toThrow(/isn't a date/);
		}
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it("asks for a well-formed date normally", async () => {
		requestUrl.mockResolvedValue({ json: { rates: { USD: 1.1 } } });
		await fetchHistoricalRates("2019-08-12");
		expect(requestUrl).toHaveBeenCalledOnce();
		expect(requestUrl.mock.calls[0][0].url).toContain("/2019-08-12?");
	});
});
