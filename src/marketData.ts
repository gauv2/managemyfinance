import { requestUrl } from "obsidian";

export interface PriceQuote {
	price: number;
	currency: string;
}

/** ISIN: two letters (country), nine alphanumeric (security id), one numeric check digit. */
const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/** Ticker → CoinGecko coin id, for the handful of cryptocurrencies a broker export is likely to carry.
 *  An unlisted ticker returns undefined rather than guessing, so a typo'd or obscure coin fails
 *  visibly (falls back to manual entry) instead of silently pricing the wrong asset. */
const CRYPTO_IDS: Record<string, string> = {
	BTC: "bitcoin",
	ETH: "ethereum",
	SOL: "solana",
	ADA: "cardano",
	XRP: "ripple",
	LTC: "litecoin",
	DOGE: "dogecoin",
	DOT: "polkadot",
};

/** Resolves an ISIN to a tradeable ticker symbol via Yahoo Finance's public (unofficial, undocumented)
 *  search endpoint — the only free, keyless way to go from "IE00B5BMR087" to something a price lookup
 *  can actually query. Picks the first result with a symbol; Yahoo's own relevance ranking decides
 *  which listing that is when a security trades on more than one exchange. */
async function resolveYahooSymbol(isin: string): Promise<string | undefined> {
	const res = await requestUrl({ url: `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(isin)}` });
	const quotes = res.json?.quotes as { symbol?: string }[] | undefined;
	return quotes?.find((q) => q.symbol)?.symbol;
}

async function fetchYahooPrice(isin: string): Promise<PriceQuote | undefined> {
	const symbol = await resolveYahooSymbol(isin);
	if (!symbol) return undefined;
	// The chart endpoint over quote: it stays reachable anonymously, where Yahoo's newer quote endpoint
	// increasingly wants a session cookie/crumb this plugin has no business holding.
	const res = await requestUrl({ url: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` });
	const meta = res.json?.chart?.result?.[0]?.meta as { regularMarketPrice?: number; currency?: string } | undefined;
	if (typeof meta?.regularMarketPrice !== "number" || !meta.currency) return undefined;
	return { price: meta.regularMarketPrice, currency: meta.currency };
}

async function fetchCryptoPrice(ticker: string, vsCurrency: string): Promise<PriceQuote | undefined> {
	const id = CRYPTO_IDS[ticker.toUpperCase()];
	if (!id) return undefined;
	const vs = vsCurrency.toLowerCase();
	const res = await requestUrl({ url: `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=${vs}` });
	const price = res.json?.[id]?.[vs];
	if (typeof price !== "number") return undefined;
	return { price, currency: vsCurrency.toUpperCase() };
}

/**
 * Today's price for one holding's ticker — an ISIN (stocks/ETFs, via Yahoo Finance) or a recognised
 * crypto symbol (via CoinGecko). Only ever called from an explicit "Refresh price" click, never
 * automatically or in the background, and the request carries nothing but the ticker itself — no
 * vault data, no share counts, no euro amounts.
 *
 * Both APIs are free and keyless; Yahoo's is unofficial with no uptime guarantee, so `undefined` here
 * is an expected outcome (a delisted ISIN, an unrecognised exchange, a rate limit) rather than a bug —
 * callers should fall back to manual entry, not surface it as an error.
 */
export async function fetchPrice(ticker: string, accountCurrency: string): Promise<PriceQuote | undefined> {
	try {
		if (ISIN_PATTERN.test(ticker)) return await fetchYahooPrice(ticker);
		return await fetchCryptoPrice(ticker, accountCurrency);
	} catch {
		return undefined;
	}
}
