import { descendantIds, resolvePrimaryId } from "./categories";
import { convert, type FxContext } from "./currency";
import { inRange, transactionYears, type DateRange } from "./period";
import { isLiabilityType, type Account, type BalanceSnapshot, type Category, type Transaction } from "./types";

/**
 * The slice of FinanceStore these calculations actually read. Kept structural (not `FinanceStore`
 * itself, which needs a real Obsidian `App` to construct) so this pure-calculation module has no
 * runtime dependency on Obsidian and is trivially unit-testable with a plain object literal — a real
 * `FinanceStore` instance satisfies this automatically since it has these same public fields.
 */
export interface KpiStore {
	accounts: Account[];
	categories: Category[];
	transactions: Transaction[];
	/** Hand-recorded balances — see BalanceSnapshot. Absent behaves exactly as before they existed. */
	snapshots?: BalanceSnapshot[];
	/** Base currency + rate table. Absent means "everything is already in one currency", which is the
	 *  1:1 passthrough these calculations did unconditionally before multi-currency support. */
	fx?: FxContext;
}

/**
 * A transaction's amount in the store's base currency. Every sum in this file goes through here —
 * adding a dollar row straight into a euro total is the kind of wrong that still looks like money.
 */
function amountIn(store: KpiStore, tx: Transaction): number {
	return store.fx ? convert(tx.amount, tx.currency, store.fx) : tx.amount;
}

/** An account-denominated figure (opening balance, snapshot) in the store's base currency. */
function accountAmountIn(store: KpiStore, account: Account, amount: number): number {
	return store.fx ? convert(amount, account.currency, store.fx) : amount;
}

export interface YearSummary {
	year: string;
	income: number;
	expenses: number;
	net: number;
	savingsRate: number;
	netWorthEOY: number;
	passiveIncome: number;
	/** True when a period filter clipped this year, so the figures cover only part of it. Views that
	 *  print a year per column say so rather than letting a half-year read as a whole one. */
	partial?: boolean;
}

/**
 * Whether a transaction date falls in `period` — either a "YYYY"/"YYYY-MM" prefix, or an inclusive
 * range (see `inRange`, so the range maths stays in one place).
 */
function inPeriod(date: string | undefined, period: string | DateRange | undefined): boolean {
	if (!period) return true;
	if (typeof period === "string") return !!date && date.startsWith(period);
	return inRange(date, period);
}

/** Moving your own money between your own accounts (e.g. checking → savings) is neither income nor expense.
 *  "Savings & Transfers" is this app's older category name, kept for backward compatibility.
 *  Matching is case-insensitive/trimmed since imported or hand-typed category names can vary in casing. */
const TRANSFER_CATEGORY_NAMES = new Set(["transfers", "savings", "savings & transfers"]);
/** Trade Republic (and any importer using the same vocabulary) tags cash moved into/out of a brokerage,
 *  as opposed to an actual trade, with these `action` values — see investingActivityByYear, which already
 *  treats them separately from buy/sell/dividend activity. ING's own export uses the same concept but puts
 *  it in the `type` field instead ("Withdrawal"/"Deposit"), and its category auto-mapping isn't reliable for
 *  these rows (e.g. a savings withdrawal can land in "Cash/ATM" instead of "Transfers") — checking both
 *  fields against this vocabulary catches the transfer regardless of which importer or category it got. */
const TRANSFER_ACCOUNT_MARKERS = new Set(["deposit", "withdraw", "withdrawal"]);
/**
 * A transaction is a transfer if its two legs have been linked to each other (`transferGroupId` — the
 * only signal that's actually *knowable* rather than inferred, see src/transfers.ts), if it's
 * explicitly categorized as one, or if it's cash moving into/out of a savings or investing account
 * per its own `action`/`type` (see TRANSFER_ACCOUNT_MARKERS).
 *
 * The linked case is checked first and on purpose: matching the two halves of a movement is the thing
 * that lets a transfer between two everyday (debit/credit/cash) accounts be recognized at all. The
 * category and broker-marker heuristics below remain for the many rows whose sibling leg was never
 * imported — a transfer to an account this vault doesn't track has only one half to go on.
 */
function isTransfer(store: KpiStore, tx: Transaction): boolean {
	if (tx.transferGroupId) return true;
	if (tx.categoryId) {
		// Resolve through a secondary category to its primary first, so e.g. a "Savings Transfer"
		// secondary nested under "Transfers" is still recognized as a transfer.
		const primaryId = resolvePrimaryId(store.categories, tx.categoryId);
		const cat = store.categories.find((c) => c.id === primaryId);
		if (cat && TRANSFER_CATEGORY_NAMES.has(cat.name.trim().toLowerCase())) return true;
	}
	const account = store.accounts.find((a) => a.id === tx.accountId);
	if (account && (account.type === "saving" || account.type === "investing")) {
		const action = (tx.action ?? "").trim().toLowerCase();
		const type = (tx.type ?? "").trim().toLowerCase();
		if (TRANSFER_ACCOUNT_MARKERS.has(action) || TRANSFER_ACCOUNT_MARKERS.has(type)) return true;
	}
	return false;
}

/** Dividends and interest payouts, identified from the broker action/type text (e.g. Trade Republic exports). */
function isPassiveIncome(tx: Transaction): boolean {
	const text = `${tx.action ?? ""} ${tx.type ?? ""}`.toLowerCase();
	return /dividend|interest/.test(text);
}

/**
 * (income - expenses) / income, clamped to [-100%, 100%]. A period with next-to-no recorded income
 * (e.g. a year where only a few cents of interest were ever categorized as income) makes the raw ratio
 * balloon toward -Infinity for perfectly ordinary expenses — mathematically "correct" but meaningless,
 * and it wrecks any chart's scale by dwarfing every other data point. Clamping keeps "way overspent
 * relative to income" visible without one sparse period distorting everything else.
 */
function savingsRateOf(income: number, expenses: number): number {
	if (income <= 0) return 0;
	return Math.max(-1, Math.min(1, (income - expenses) / income));
}

/**
 * When `accountId` is given, every KPI here is scoped to that one account instead of the whole store.
 *
 * With a `range`, only the years it covers come back and only its own transactions count toward them
 * — a year the range clips is marked `partial`, and its closing net worth is taken at the end of the
 * range rather than at a year end the range never reached. Activity *before* the range is still
 * folded into the opening position (see `carried` below): a period filter narrows what's being
 * measured, but it can't make money you already had disappear.
 */
export function summarizeByYear(store: KpiStore, accountId?: string, range?: DateRange): YearSummary[] {
	const map = new Map<
		string,
		{ income: number; expenses: number; passiveIncome: number; netChange: number; transferAmount: number }
	>();
	/** Everything that happened before the range started, as a single opening figure. */
	let carried = 0;
	for (const tx of store.transactions) {
		if (accountId && tx.accountId !== accountId) continue;
		const year = tx.date?.slice(0, 4);
		if (!year) continue;
		if (!inPeriod(tx.date, range)) {
			if (range?.from && tx.date! < range.from) carried += amountIn(store, tx);
			continue;
		}
		if (!map.has(year)) map.set(year, { income: 0, expenses: 0, passiveIncome: 0, netChange: 0, transferAmount: 0 });
		const bucket = map.get(year)!;
		const amount = amountIn(store, tx);
		bucket.netChange += amount;
		if (isTransfer(store, tx)) {
			bucket.transferAmount += amount;
			continue;
		}
		if (amount >= 0) {
			bucket.income += amount;
			if (isPassiveIncome(tx)) bucket.passiveIncome += amount;
		} else {
			bucket.expenses += -amount;
		}
	}

	const years = Array.from(map.keys()).sort((a, b) => a.localeCompare(b));

	/** A year's closing date, pulled back to the end of the range when the range stops inside it. */
	const closingDate = (year: string): string => {
		const yearEnd = `${year}-12-31`;
		return range?.to && range.to < yearEnd ? range.to : yearEnd;
	};
	const isPartial = (year: string): boolean =>
		!!range && ((!!range.from && range.from > `${year}-01-01`) || (!!range.to && range.to < `${year}-12-31`));

	// With hand-recorded balances on file, each year's closing net worth is simply what the accounts
	// were actually worth at that date — no walking, no inference. That's strictly better than the
	// reconstruction below, which only exists because an untracked account's balance is otherwise a
	// single flat number that never moves. See netWorthAsOf.
	if (hasSnapshots(store)) {
		return years.map((year) => {
			const { income, expenses, passiveIncome } = map.get(year)!;
			return {
				year,
				income,
				expenses,
				net: income - expenses,
				savingsRate: savingsRateOf(income, expenses),
				netWorthEOY: netWorthAsOf(store, closingDate(year), accountId),
				passiveIncome,
				partial: isPartial(year),
			};
		});
	}

	let cumulative =
		carried +
		store.accounts.filter((a) => !accountId || a.id === accountId).reduce((sum, a) => sum + signedOpeningBalance(store, a), 0);

	// Aggregate ("All Accounts") mode only: a transfer between your own accounts must never move
	// combined net worth. But an account with no transaction history of its own carries its
	// *current* balance as a flat "opening balance" applied to every year alike, so a transfer into
	// it is never credited in the year it actually happened — the total can look flat, or even dip,
	// in a year you clearly saved well (see e.g. a savings account tracked only by today's balance).
	// Walking forward on income-minus-expenses (plus that year's own transfers, added back in below),
	// with the running balance seeded by opening balances alone, moves the trajectory only in the
	// years real saving happened. Each year only ever folds in *its own* transfers — never a future
	// year's — so every year's netWorthEOY reflects activity only up through that year's end; the
	// final year still lands on exactly the same total as netWorth(store), since summed across every
	// year, income - expenses + transferAmount covers every transaction exactly once.
	const useNetSavingsOnly = !accountId;

	return years.map((year) => {
		const { income, expenses, passiveIncome, netChange, transferAmount } = map.get(year)!;
		cumulative += useNetSavingsOnly ? income - expenses + transferAmount : netChange;
		return {
			year,
			income,
			expenses,
			net: income - expenses,
			savingsRate: savingsRateOf(income, expenses),
			netWorthEOY: cumulative,
			passiveIncome,
			partial: isPartial(year),
		};
	});
}

/**
 * Several years rolled into the one summary a period spanning them adds up to, or undefined when the
 * period contains nothing at all. Closing net worth is the last year's — where the period ends.
 */
export function summarizeTotal(years: YearSummary[]): YearSummary | undefined {
	if (years.length === 0) return undefined;
	const income = years.reduce((sum, y) => sum + y.income, 0);
	const expenses = years.reduce((sum, y) => sum + y.expenses, 0);
	const last = years[years.length - 1];
	return {
		year: years.length === 1 ? last.year : `${years[0].year}–${last.year}`,
		income,
		expenses,
		net: income - expenses,
		savingsRate: savingsRateOf(income, expenses),
		netWorthEOY: last.netWorthEOY,
		passiveIncome: years.reduce((sum, y) => sum + y.passiveIncome, 0),
		partial: years.some((y) => y.partial),
	};
}

/**
 * The summary for `year` (defaults to today's real calendar year) — never just "whichever year
 * happens to be last in the array". Without this, "this year" would silently mean "last year" the
 * moment a new calendar year starts and no transactions have been imported for it yet.
 */
export function yearSummaryFor(years: YearSummary[], year: string = String(new Date().getFullYear())): YearSummary | undefined {
	return years.find((y) => y.year === year);
}

export interface MonthSummary {
	/** "01"–"12" */
	month: string;
	income: number;
	expenses: number;
	net: number;
	savingsRate: number;
	passiveIncome: number;
}

/** The 12 months of `year`, always all 12 even when some have no activity — the drill-down behind a year click. */
export function summarizeByMonth(store: KpiStore, year: string, accountId?: string): MonthSummary[] {
	const buckets: { income: number; expenses: number; passiveIncome: number }[] = Array.from({ length: 12 }, () => ({
		income: 0,
		expenses: 0,
		passiveIncome: 0,
	}));
	for (const tx of store.transactions) {
		if (accountId && tx.accountId !== accountId) continue;
		if (!tx.date?.startsWith(year)) continue;
		const monthIdx = parseInt(tx.date.slice(5, 7), 10) - 1;
		if (isNaN(monthIdx) || monthIdx < 0 || monthIdx > 11) continue;
		const bucket = buckets[monthIdx];
		if (isTransfer(store, tx)) continue;
		const amount = amountIn(store, tx);
		if (amount >= 0) {
			bucket.income += amount;
			if (isPassiveIncome(tx)) bucket.passiveIncome += amount;
		} else {
			bucket.expenses += -amount;
		}
	}
	return buckets.map((b, i) => ({
		month: String(i + 1).padStart(2, "0"),
		income: b.income,
		expenses: b.expenses,
		net: b.income - b.expenses,
		savingsRate: savingsRateOf(b.income, b.expenses),
		passiveIncome: b.passiveIncome,
	}));
}

function hasSnapshots(store: KpiStore): boolean {
	return (store.snapshots?.length ?? 0) > 0;
}

/**
 * An account's opening balance as a contribution to net worth, in base currency.
 *
 * Liability accounts (a loan, a mortgage) are entered as the amount *owed* — a positive number, the
 * way anyone would say it out loud ("€240,000 left on the mortgage") — and negated here. Transactions
 * on such an account keep ordinary ledger signs, so a repayment lands as a positive amount and
 * correctly moves the account's value toward zero.
 */
function signedOpeningBalance(store: KpiStore, account: Account): number {
	const raw = account.openingBalance ?? 0;
	return accountAmountIn(store, account, isLiabilityType(account.type) ? -raw : raw);
}

function signedSnapshotBalance(store: KpiStore, account: Account, snapshot: BalanceSnapshot): number {
	return accountAmountIn(store, account, isLiabilityType(account.type) ? -snapshot.balance : snapshot.balance);
}

/** The most recent snapshot for `accountId` dated on or before `asOf`, if any. */
export function snapshotAsOf(store: KpiStore, accountId: string, asOf: string): BalanceSnapshot | undefined {
	let best: BalanceSnapshot | undefined;
	for (const snap of store.snapshots ?? []) {
		if (snap.accountId !== accountId) continue;
		if (snap.date > asOf) continue;
		if (!best || snap.date > best.date) best = snap;
	}
	return best;
}

/**
 * What everything was worth on a given date, in base currency.
 *
 * Each account starts from the best evidence available on that date — a balance you recorded by hand
 * if there is one, its opening balance otherwise — and then applies only the transactions that
 * happened *after* that evidence and up to the date asked about. A snapshot therefore supersedes
 * every assumption before it without discarding the activity since, which is what makes an account
 * you don't import (a pension, a house, a savings account you check twice a year) carry a real value
 * that moves over time instead of one flat number applied to every year alike.
 */
export function netWorthAsOf(store: KpiStore, asOf: string, accountId?: string): number {
	const byAccount = new Map<string, Transaction[]>();
	for (const tx of store.transactions) {
		if (accountId && tx.accountId !== accountId) continue;
		const bucket = byAccount.get(tx.accountId);
		if (bucket) bucket.push(tx);
		else byAccount.set(tx.accountId, [tx]);
	}

	let total = 0;
	for (const account of store.accounts) {
		if (accountId && account.id !== accountId) continue;
		const snapshot = snapshotAsOf(store, account.id, asOf);
		total += snapshot ? signedSnapshotBalance(store, account, snapshot) : signedOpeningBalance(store, account);
		for (const tx of byAccount.get(account.id) ?? []) {
			const date = (tx.date || "").slice(0, 10);
			if (!date || date > asOf) continue;
			if (snapshot && date <= snapshot.date) continue;
			total += amountIn(store, tx);
		}
	}
	return total;
}

/** Everything's worth right now — the headline number. See netWorthAsOf for how each account is valued. */
export function netWorth(store: KpiStore, accountId?: string): number {
	return netWorthAsOf(store, "9999-12-31", accountId);
}

/** Simulates monthly compounding to estimate years until `netWorthNow` reaches `target`. */
export function fiProjection(
	netWorthNow: number,
	monthlyContribution: number,
	annualReturn: number,
	target: number
): number | undefined {
	if (target <= 0) return undefined;
	if (netWorthNow >= target) return 0;
	if (monthlyContribution <= 0 && annualReturn <= 0) return undefined;

	const monthlyReturn = annualReturn / 12;
	let balance = netWorthNow;
	for (let month = 1; month <= 12 * 60; month++) {
		balance = balance * (1 + monthlyReturn) + monthlyContribution;
		if (balance >= target) return month / 12;
	}
	return undefined;
}

/** Spend by category id exactly as tagged on each transaction — a secondary and its primary are
 *  separate keys here. Use `primaryCategoryTotals` when you want secondaries rolled up into their parent. */
export function categoryTotals(store: KpiStore, year?: string, accountId?: string): Map<string, number> {
	const totals = new Map<string, number>();
	for (const tx of store.transactions) {
		if (tx.amount >= 0) continue;
		if (year && !tx.date?.startsWith(year)) continue;
		if (accountId && tx.accountId !== accountId) continue;
		if (isTransfer(store, tx)) continue;
		const key = tx.categoryId ?? "uncategorized";
		totals.set(key, (totals.get(key) ?? 0) + -amountIn(store, tx));
	}
	return totals;
}

/** Same as `categoryTotals`, but a transaction tagged with a secondary category counts toward its
 *  primary category's total — the view budgets and dashboards want, so spend doesn't fragment across
 *  however many secondary categories a primary happens to have. `period` is a "YYYY"/"YYYY-MM" prefix
 *  for the budgets that think in whole months and years, or a date range for the page period filter. */
export function primaryCategoryTotals(store: KpiStore, period?: string | DateRange, accountId?: string): Map<string, number> {
	const totals = new Map<string, number>();
	for (const tx of store.transactions) {
		if (tx.amount >= 0) continue;
		if (!inPeriod(tx.date, period)) continue;
		if (accountId && tx.accountId !== accountId) continue;
		if (isTransfer(store, tx)) continue;
		const key = resolvePrimaryId(store.categories, tx.categoryId) ?? "uncategorized";
		totals.set(key, (totals.get(key) ?? 0) + -amountIn(store, tx));
	}
	return totals;
}

/**
 * One category's spend for many months in a single pass — same filters as `primaryCategoryTotals`
 * (expenses only, transfers excluded, converted to base currency), keyed by "YYYY-MM".
 *
 * Exists because walking a rollover chain month by month would otherwise re-read the entire ledger
 * once per month walked, for every rollover category, on every render of the budgets page.
 */
export function monthlySpendFor(store: KpiStore, categoryId: string): Map<string, number> {
	const ids = new Set(descendantIds(store.categories, categoryId));
	const byMonth = new Map<string, number>();
	for (const tx of store.transactions) {
		if (tx.amount >= 0) continue;
		if (!tx.categoryId || !ids.has(tx.categoryId)) continue;
		if (isTransfer(store, tx)) continue;
		const month = tx.date?.slice(0, 7);
		if (!month) continue;
		byMonth.set(month, (byMonth.get(month) ?? 0) + -amountIn(store, tx));
	}
	return byMonth;
}

/** The individual expense transactions behind one category's total for a given month — same filters
 *  (expenses only, transfers excluded) as `categoryTotals`/`primaryCategoryTotals`. When `categoryId`
 *  is a primary category, this includes transactions tagged with any of its secondary categories too. */
export function categoryTransactions(store: KpiStore, categoryId: string, month: string): Transaction[] {
	const ids = new Set(descendantIds(store.categories, categoryId));
	return store.transactions
		.filter((tx) => tx.amount < 0 && tx.date?.startsWith(month) && tx.categoryId !== undefined && ids.has(tx.categoryId) && !isTransfer(store, tx))
		.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Transaction count and net total for one account — the at-a-glance numbers shown in the accounts manager. */
export function accountStats(store: KpiStore, accountId: string): { count: number; netWorth: number } {
	const count = store.transactions.filter((t) => t.accountId === accountId).length;
	return { count, netWorth: netWorth(store, accountId) };
}

/** Average monthly spend across the given accounts (or every account, if omitted) — the denominator for "months of runway". */
export function averageMonthlyExpenses(store: KpiStore, accountIds?: string[]): number {
	const byMonth = new Map<string, number>();
	for (const tx of store.transactions) {
		if (accountIds && !accountIds.includes(tx.accountId)) continue;
		if (tx.amount >= 0) continue;
		if (isTransfer(store, tx)) continue;
		const month = tx.date?.slice(0, 7);
		if (!month) continue;
		byMonth.set(month, (byMonth.get(month) ?? 0) + -amountIn(store, tx));
	}
	const months = Array.from(byMonth.values());
	if (months.length === 0) return 0;
	return months.reduce((a, b) => a + b, 0) / months.length;
}

export interface Holding {
	ticker: string;
	assetClass?: string;
	shares: number;
	/** Net cash spent on the shares still held (buys minus sell proceeds) — a cost basis, not a live market value. */
	netInvested: number;
	avgCost: number;
}

/**
 * Current holdings inferred purely from Buy/Sell activity — there's no market-price feed here, so this is
 * cost-basis accounting (what you put in), not portfolio valuation (what it's worth today).
 */
export function investingHoldings(store: KpiStore, accountId: string): Holding[] {
	const byTicker = new Map<string, { shares: number; net: number; assetClass?: string }>();
	for (const tx of store.transactions) {
		if (tx.accountId !== accountId) continue;
		if (!tx.ticker || tx.ticker === "CASH") continue;
		const action = (tx.action ?? "").toLowerCase();
		if (action !== "buy" && action !== "sell") continue;
		const bucket = byTicker.get(tx.ticker) ?? { shares: 0, net: 0, assetClass: tx.assetClass };
		const shares = tx.shares ?? 0;
		const cash = Math.abs(amountIn(store, tx));
		if (action === "buy") {
			bucket.shares += shares;
			bucket.net += cash;
		} else {
			bucket.shares -= shares;
			bucket.net -= cash;
		}
		if (tx.assetClass) bucket.assetClass = tx.assetClass;
		byTicker.set(tx.ticker, bucket);
	}
	return Array.from(byTicker.entries())
		.filter(([, b]) => b.shares > 1e-6)
		.map(([ticker, b]) => ({
			ticker,
			assetClass: b.assetClass,
			shares: b.shares,
			netInvested: b.net,
			avgCost: b.shares > 0 ? b.net / b.shares : 0,
		}))
		.sort((a, b) => b.netInvested - a.netInvested);
}

export interface InvestingYearActivity {
	year: string;
	deposits: number;
	withdrawals: number;
	dividends: number;
	fees: number;
}

/** Deposits/withdrawals/dividends/fees for a broker account, by year — the cash-flow side of investing. */
export function investingActivityByYear(store: KpiStore, accountId: string): InvestingYearActivity[] {
	const map = new Map<string, InvestingYearActivity>();
	for (const tx of store.transactions) {
		if (tx.accountId !== accountId) continue;
		const year = tx.date?.slice(0, 4);
		if (!year) continue;
		if (!map.has(year)) map.set(year, { year, deposits: 0, withdrawals: 0, dividends: 0, fees: 0 });
		const bucket = map.get(year)!;
		const action = (tx.action ?? "").toLowerCase();
		const cash = Math.abs(amountIn(store, tx));
		if (action === "deposit") bucket.deposits += cash;
		else if (action === "withdraw") bucket.withdrawals += cash;
		else if (action === "dividend" || action.startsWith("interest")) bucket.dividends += cash;
		if (tx.fee) bucket.fees += Math.abs(tx.fee);
	}
	return Array.from(map.values()).sort((a, b) => a.year.localeCompare(b.year));
}
