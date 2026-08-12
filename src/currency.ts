/**
 * One place that turns an amount in some currency into an amount in *your* currency.
 *
 * Every total in this app — net worth, income, expenses, budgets, category rollups — is a sum over
 * transactions that may not share a currency. Before this module existed those sums added dollars to
 * euros as if they were the same unit, which is silently wrong in the one direction nobody notices:
 * the number still looks like money.
 *
 * The rate table is the user-maintained one from Settings → Currency, stored as "1 unit of this
 * currency = N units of EUR" regardless of which currency is the display base, so EUR stays the pivot
 * even when you're reading everything in dollars.
 *
 * Deliberately stateless and rate-table-driven rather than storing a converted amount per
 * transaction: a transaction's own currency and amount are what the bank actually did, and that
 * shouldn't be rewritten every time a rate moves. The trade-off is that historical figures are valued
 * at today's rates — a 2019 dollar balance is shown at the rate you last fetched, not 2019's.
 */

export const DEFAULT_BASE_CURRENCY = "EUR";

/** 1 unit of the key currency = this many EUR. Missing entries mean "no rate known". */
export type ExchangeRates = Record<string, number>;

/** Everything the conversion needs, threaded through calculations as one object rather than two args. */
export interface FxContext {
	/** The currency every total is expressed in. Defaults to EUR when unset. */
	baseCurrency?: string;
	rates?: ExchangeRates;
}

function normalizeCode(currency: string | undefined): string {
	return (currency || DEFAULT_BASE_CURRENCY).trim().toUpperCase();
}

export function baseCurrencyOf(fx: FxContext | undefined): string {
	return normalizeCode(fx?.baseCurrency);
}

/** How many EUR one unit of `currency` is worth. Undefined when no rate is known and it isn't EUR. */
function rateToEur(currency: string, rates: ExchangeRates | undefined): number | undefined {
	const code = normalizeCode(currency);
	if (code === "EUR") return 1;
	const rate = rates?.[code];
	return typeof rate === "number" && isFinite(rate) && rate > 0 ? rate : undefined;
}

/**
 * Converts `amount` from `currency` into the base currency.
 *
 * An unknown rate passes the amount through unconverted rather than dropping it or zeroing it. That
 * is the least-wrong option of the three: a missing rate means the total is off by the exchange
 * rate, whereas dropping the row means the total is off by the whole transaction — and a user who
 * has never opened the currency settings has one currency anyway, where 1:1 is exactly right.
 */
export function convert(amount: number, currency: string | undefined, fx: FxContext | undefined): number {
	if (!isFinite(amount)) return 0;
	const from = normalizeCode(currency);
	const base = baseCurrencyOf(fx);
	if (from === base) return amount;

	const fromRate = rateToEur(from, fx?.rates);
	const baseRate = rateToEur(base, fx?.rates);
	if (fromRate === undefined || baseRate === undefined) return amount;
	return (amount * fromRate) / baseRate;
}

/** Whether an amount in `currency` can be converted into the base currency with the rates on hand. */
export function canConvert(currency: string | undefined, fx: FxContext | undefined): boolean {
	const from = normalizeCode(currency);
	const base = baseCurrencyOf(fx);
	if (from === base) return true;
	return rateToEur(from, fx?.rates) !== undefined && rateToEur(base, fx?.rates) !== undefined;
}

/**
 * The currencies present in `items` that can't be converted into the base currency — what a UI needs
 * to warn "these totals mix currencies at 1:1 because no rate is set" instead of quietly being wrong.
 */
export function unconvertibleCurrencies(items: { currency?: string }[], fx: FxContext | undefined): string[] {
	const missing = new Set<string>();
	for (const item of items) {
		const code = normalizeCode(item.currency);
		if (!canConvert(code, fx)) missing.add(code);
	}
	return Array.from(missing).sort();
}
