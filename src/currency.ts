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
 * even when you're reading everything in dollars. Changing the base currency needs no separate
 * handling beyond that: transaction amounts are never rewritten (see below), and this pivot-through-EUR
 * formula already produces the right number for whatever currency `baseCurrency` names next.
 *
 * Deliberately stateless and rate-table-driven rather than storing a converted amount per
 * transaction: a transaction's own currency and amount are what the bank actually did, and that
 * shouldn't be rewritten every time a rate moves or the base currency changes.
 *
 * Flow vs stock (v1.2.7 remediation Phase 3, FIN-008): a *flow* — a dated transaction — should be
 * valued at the rate that applied on its own date, not today's; a *stock* — a current account balance,
 * today's net worth — should use today's rate, since there's no "as of" for a number that only exists
 * right now. Pass a `date` to get flow behavior; omit it for stock behavior. `history` is this pivot's
 * dated counterpart to `rates` — see `optionalRateFor` for exactly how the two combine.
 */

export const DEFAULT_BASE_CURRENCY = "EUR";

/** 1 unit of the key currency = this many EUR. Missing entries mean "no rate known". */
export type ExchangeRates = Record<string, number>;

/** ECB reference rates for a specific past date, keyed by ISO "YYYY-MM-DD" — the dated counterpart to
 *  `FxContext.rates`. Populated by an explicit backfill action (see fx.ts's fetchHistoricalRates), not
 *  fetched automatically — a vault with years of foreign-currency history could mean dozens of distinct
 *  dates, and this module stays a pure, synchronous calculation either way. */
export type FxHistory = Record<string, ExchangeRates>;

/** Everything the conversion needs, threaded through calculations as one object rather than two args. */
export interface FxContext {
	/** The currency every total is expressed in. Defaults to EUR when unset. */
	baseCurrency?: string;
	rates?: ExchangeRates;
	/** Dated rates for flow (transaction-date) conversion — see `convert`'s `date` parameter. */
	history?: FxHistory;
}

function normalizeCode(currency: string | undefined): string {
	return (currency || DEFAULT_BASE_CURRENCY).trim().toUpperCase();
}

export function baseCurrencyOf(fx: FxContext | undefined): string {
	return normalizeCode(fx?.baseCurrency);
}

/** How many EUR one unit of `currency` is worth, from a specific rate table. Undefined when no rate is
 *  known and it isn't EUR — EUR is always exactly 1 EUR, in every table, on every date. */
function rateToEur(currency: string, rates: ExchangeRates | undefined): number | undefined {
	const code = normalizeCode(currency);
	if (code === "EUR") return 1;
	const rate = rates?.[code];
	return typeof rate === "number" && isFinite(rate) && rate > 0 ? rate : undefined;
}

/**
 * The rate to use for one currency, given an optional date: the historical rate for that exact date if
 * one has been backfilled, else the current rate table, else undefined. Preferring history when it
 * exists (rather than always falling back to current) is what makes a backfilled transaction's value
 * genuinely stable — changing today's rate afterward can't move it, since the lookup never reaches the
 * current table for that currency+date again. Falling back to the current table when no historical
 * entry exists yet is a deliberate, visible-in-the-UI compromise rather than marking every
 * not-yet-backfilled historical row "incomplete" outright: most vaults have years of foreign-currency
 * history, and treating all of it as unknown the moment this feature ships would be a worse regression
 * than the approximation it replaces. Genuinely unknown currencies (no rate anywhere, current or
 * historical) still resolve to undefined here, which is what makes `convert` return NaN for them.
 */
function optionalRateFor(currency: string, fx: FxContext | undefined, date: string | undefined): number | undefined {
	if (date) {
		const historical = rateToEur(currency, fx?.history?.[date]);
		if (historical !== undefined) return historical;
	}
	return rateToEur(currency, fx?.rates);
}

/**
 * Converts `amount` from `currency` into the base currency, optionally as of a specific date — pass
 * the transaction's own date for a flow conversion (see the module doc comment), omit it for a stock
 * (current-balance) conversion.
 *
 * Returns `NaN`, not a plausible-looking number, when the rate genuinely can't be resolved — neither a
 * historical rate for the given date nor a current rate exists for the currency. A missing rate used to
 * pass the amount through unconverted, silently assuming 1:1; that reads as a real number and a caller
 * that doesn't separately check `canConvert`/`unconvertibleCurrencies` would never know it was wrong by
 * exactly the exchange rate (FIN-008). NaN can't be mistaken for a real total — every formatter in this
 * app (see money.ts's formatMoney) renders it as "Incomplete" rather than silently defaulting to 0 the
 * way `isFinite` guards elsewhere in this codebase normally would, and NaN propagates through any sum
 * it's part of, so a whole aggregate correctly reads as incomplete rather than quietly short by one row.
 *
 * A currency identical to the base currency is a same-unit passthrough regardless of date or rates —
 * there's nothing to look up.
 */
export function convert(amount: number, currency: string | undefined, fx: FxContext | undefined, date?: string): number {
	if (!isFinite(amount)) return 0;
	const from = normalizeCode(currency);
	const base = baseCurrencyOf(fx);
	if (from === base) return amount;

	const fromRate = optionalRateFor(from, fx, date);
	const baseRate = optionalRateFor(base, fx, date);
	if (fromRate === undefined || baseRate === undefined) return NaN;
	return (amount * fromRate) / baseRate;
}

/** Whether an amount in `currency` can be converted into the base currency with the current rate table
 *  on hand — deliberately not date-aware: this answers "is this currency configured at all", which
 *  `unconvertibleCurrencies` uses for the vault-wide "add a rate for this currency" warning, not "is
 *  this specific historical row fully accurate". */
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
