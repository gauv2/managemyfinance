import { requestUrl } from "obsidian";
import { CURRENCIES } from "./constants";

const FRANKFURTER_BASE = "https://api.frankfurter.dev/v1";

/** Frankfurter answers "1 EUR = X {code}"; this app stores "1 {code} = ? EUR", so invert. Rounded to
 *  6dp — full float precision (15+ digits) is noise no one will ever type or read. */
function invertRates(rates: Record<string, number>): Record<string, number> {
	const inverted: Record<string, number> = {};
	for (const [code, rate] of Object.entries(rates)) {
		if (rate > 0) inverted[code] = Math.round((1 / rate) * 1e6) / 1e6;
	}
	return inverted;
}

/**
 * Today's ECB reference rates for every non-EUR currency this app knows about, via Frankfurter
 * (api.frankfurter.dev) — free, keyless, no rate limit, just a JSON wrapper around the ECB's own
 * daily publication. Only ever called when the user explicitly clicks "Fetch latest rates" in
 * Settings; the request carries nothing but currency codes, no vault data of any kind.
 */
export async function fetchLatestRates(): Promise<Record<string, number>> {
	const symbols = CURRENCIES.filter((c) => c !== "EUR").join(",");
	const res = await requestUrl({ url: `${FRANKFURTER_BASE}/latest?base=EUR&symbols=${symbols}` });
	const rates = res.json?.rates as Record<string, number> | undefined;
	if (!rates) throw new Error("Unexpected response from the exchange-rate API.");
	return invertRates(rates);
}

/**
 * The ECB reference rates as of a specific past date, via the same Frankfurter endpoint dated instead
 * of "latest" — the basis for historical/as-of conversion (v1.2.7 remediation Phase 3, FIN-008
 * residual). The ECB doesn't publish on weekends/holidays; Frankfurter already resolves a non-trading
 * date to the most recent prior trading day server-side, so this never needs to retry with an adjusted
 * date itself. Only ever called from an explicit "Backfill historical rates" action or a batch import,
 * never silently in the background — one request per date, and a vault with years of foreign-currency
 * history could mean dozens of distinct dates to fetch.
 */
export async function fetchHistoricalRates(date: string): Promise<Record<string, number>> {
	// The date is interpolated straight into the URL *path*, and it arrives from a transaction's own
	// `date` field, which is not guaranteed to be a date at all: `parseFlexibleDate` hands back
	// whatever it was given when it cannot read it, so a bank export with an unrecognised format
	// leaves raw text in there. Unchecked, that text becomes part of the request path — and a key in
	// the saved rate table, which then never matches anything again.
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error(`"${date}" isn't a date I can ask for a rate on — expected YYYY-MM-DD.`);
	}
	const symbols = CURRENCIES.filter((c) => c !== "EUR").join(",");
	const res = await requestUrl({ url: `${FRANKFURTER_BASE}/${encodeURIComponent(date)}?base=EUR&symbols=${symbols}` });
	const rates = res.json?.rates as Record<string, number> | undefined;
	if (!rates) throw new Error(`Unexpected response from the exchange-rate API for ${date}.`);
	return invertRates(rates);
}
