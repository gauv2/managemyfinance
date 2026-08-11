import { requestUrl } from "obsidian";
import { CURRENCIES } from "./constants";

const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest";

/**
 * Today's ECB reference rates for every non-EUR currency this app knows about, via Frankfurter
 * (api.frankfurter.dev) — free, keyless, no rate limit, just a JSON wrapper around the ECB's own
 * daily publication. Only ever called when the user explicitly clicks "Fetch latest rates" in
 * Settings; the request carries nothing but currency codes, no vault data of any kind.
 */
export async function fetchLatestRates(): Promise<Record<string, number>> {
	const symbols = CURRENCIES.filter((c) => c !== "EUR").join(",");
	const res = await requestUrl({ url: `${FRANKFURTER_URL}?base=EUR&symbols=${symbols}` });
	const rates = res.json?.rates as Record<string, number> | undefined;
	if (!rates) throw new Error("Unexpected response from the exchange-rate API.");

	// Frankfurter answers "1 EUR = X {code}"; this app stores "1 {code} = ? EUR", so invert.
	// Rounded to 6dp — full float precision (15+ digits) is noise no one will ever type or read.
	const inverted: Record<string, number> = {};
	for (const [code, rate] of Object.entries(rates)) {
		if (rate > 0) inverted[code] = Math.round((1 / rate) * 1e6) / 1e6;
	}
	return inverted;
}
