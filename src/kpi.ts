import { descendantIds, resolvePrimaryId } from "./categories";
import type { Account, Category, Transaction } from "./types";

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
}

export interface YearSummary {
	year: string;
	income: number;
	expenses: number;
	net: number;
	savingsRate: number;
	netWorthEOY: number;
	passiveIncome: number;
}

/** Moving your own money between your own accounts (e.g. checking → savings) is neither income nor expense.
 *  "Savings & Transfers" is this app's old (pre-eMoney) category name, kept for backward compatibility.
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
 * A transaction is a transfer if it's explicitly categorized as one, OR if it's cash moving into/out of a
 * savings or investing account per its own `action`/`type` (see TRANSFER_ACCOUNT_MARKERS) — both signals
 * the current data model actually supports. There is no account-to-account link on Transaction (no
 * "destination account" field, and `counterparty` is free text, not an account id), so a genuinely
 * uncategorized transfer between two everyday (debit/credit/cash) accounts cannot be detected here.
 */
function isTransfer(store: KpiStore, tx: Transaction): boolean {
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

/** When `accountId` is given, every KPI here is scoped to that one account instead of the whole store. */
export function summarizeByYear(store: KpiStore, accountId?: string): YearSummary[] {
	const map = new Map<
		string,
		{ income: number; expenses: number; passiveIncome: number; netChange: number; transferAmount: number }
	>();
	for (const tx of store.transactions) {
		if (accountId && tx.accountId !== accountId) continue;
		const year = tx.date?.slice(0, 4);
		if (!year) continue;
		if (!map.has(year)) map.set(year, { income: 0, expenses: 0, passiveIncome: 0, netChange: 0, transferAmount: 0 });
		const bucket = map.get(year)!;
		bucket.netChange += tx.amount;
		if (isTransfer(store, tx)) {
			bucket.transferAmount += tx.amount;
			continue;
		}
		if (tx.amount >= 0) {
			bucket.income += tx.amount;
			if (isPassiveIncome(tx)) bucket.passiveIncome += tx.amount;
		} else {
			bucket.expenses += -tx.amount;
		}
	}

	const years = Array.from(map.keys()).sort((a, b) => a.localeCompare(b));
	let cumulative = store.accounts
		.filter((a) => !accountId || a.id === accountId)
		.reduce((sum, a) => sum + (a.openingBalance ?? 0), 0);

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
		};
	});
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
		if (tx.amount >= 0) {
			bucket.income += tx.amount;
			if (isPassiveIncome(tx)) bucket.passiveIncome += tx.amount;
		} else {
			bucket.expenses += -tx.amount;
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

export function netWorth(store: KpiStore, accountId?: string): number {
	let total = 0;
	for (const acc of store.accounts) {
		if (accountId && acc.id !== accountId) continue;
		total += acc.openingBalance ?? 0;
	}
	for (const tx of store.transactions) {
		if (accountId && tx.accountId !== accountId) continue;
		total += tx.amount;
	}
	return total;
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
		totals.set(key, (totals.get(key) ?? 0) + -tx.amount);
	}
	return totals;
}

/** Same as `categoryTotals`, but a transaction tagged with a secondary category counts toward its
 *  primary category's total — the view budgets and dashboards want, so spend doesn't fragment across
 *  however many secondary categories a primary happens to have. */
export function primaryCategoryTotals(store: KpiStore, year?: string, accountId?: string): Map<string, number> {
	const totals = new Map<string, number>();
	for (const tx of store.transactions) {
		if (tx.amount >= 0) continue;
		if (year && !tx.date?.startsWith(year)) continue;
		if (accountId && tx.accountId !== accountId) continue;
		if (isTransfer(store, tx)) continue;
		const key = resolvePrimaryId(store.categories, tx.categoryId) ?? "uncategorized";
		totals.set(key, (totals.get(key) ?? 0) + -tx.amount);
	}
	return totals;
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
		byMonth.set(month, (byMonth.get(month) ?? 0) + -tx.amount);
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
		if (action === "buy") {
			bucket.shares += shares;
			bucket.net += Math.abs(tx.amount);
		} else {
			bucket.shares -= shares;
			bucket.net -= Math.abs(tx.amount);
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
		if (action === "deposit") bucket.deposits += Math.abs(tx.amount);
		else if (action === "withdraw") bucket.withdrawals += Math.abs(tx.amount);
		else if (action === "dividend" || action.startsWith("interest")) bucket.dividends += Math.abs(tx.amount);
		if (tx.fee) bucket.fees += Math.abs(tx.fee);
	}
	return Array.from(map.values()).sort((a, b) => a.year.localeCompare(b.year));
}
