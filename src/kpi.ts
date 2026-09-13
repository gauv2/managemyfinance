import { descendantIds, resolvePrimaryId } from "./categories";
import { tracksBalance } from "./accounts";
import { convert, type FxContext } from "./currency";
import { classifyTransaction, isEconomicallyNeutral, type ClassifiedTransaction } from "./finance/semantics";
import { inRange, lastCompleteMonthKey, monthKeysBetween, monthsInRange, shiftMonthKey, transactionYears, type DateRange } from "./period";
import { isLiabilityType, isLiquidType, type Account, type BalanceSnapshot, type Category, type Transaction } from "./types";

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
 *
 * A transaction is a flow, so this always converts at its *own* date — see currency.ts's convert() doc
 * comment for flow-vs-stock. Once a historical rate for that date has been backfilled, the result is
 * stable regardless of what today's rate later becomes; until then it falls back to today's rate rather
 * than reading as incomplete outright (a deliberate compromise — see convert()'s `optionalRateFor`).
 */
export function amountIn(store: KpiStore, tx: Transaction): number {
	return store.fx ? convert(tx.amount, tx.currency, store.fx, tx.date) : tx.amount;
}

/** An account-denominated figure (opening balance, snapshot) in the store's base currency. An opening
 *  balance has no date of its own and is a *current* starting point, so it always uses today's rate
 *  (`date` omitted). A snapshot is dated, and — being a stock observation as of that date, not a flow —
 *  should be valued at *that date's* rate, not today's; pass `snapshot.date` for that case. */
function accountAmountIn(store: KpiStore, account: Account, amount: number, date?: string): number {
	return store.fx ? convert(amount, account.currency, store.fx, date) : amount;
}

export interface YearSummary {
	year: string;
	income: number;
	expenses: number;
	net: number;
	/** (income − expenses) / income, or undefined when income isn't positive — see savingsRateOf. */
	savingsRate: number | undefined;
	netWorthEOY: number;
	passiveIncome: number;
	/** Debt-principal payments this year — a credit/loan/mortgage account being paid down. Economically
	 *  neutral (a balance-sheet movement, not spending or income), so it's tracked separately rather than
	 *  folded into `income`: a card's "Paid off" figure reads from this, not from `income`, which is
	 *  correctly ~0 for a credit account most years (FIN-012). */
	debtPrincipal: number;
	/** Months this year's liquid (debit/savings/cash) balance at year-end would have covered, at that
	 *  year's own monthly spend, if income stopped entirely — a personal financial runway. 0 when the
	 *  year had no recorded expenses to divide by. */
	runwayMonths: number;
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

/**
 * Whether a transaction should be excluded from income/expense entirely — a transfer between the
 * user's own accounts, a trade (cash exchanged for a security of equal value), or a debt-principal
 * movement (paying down what's owed). Delegates to the shared economic classifier — see
 * src/finance/semantics.ts, which is the one place this decision is made; kpi.ts used to keep its own
 * copy of the transfer/trade marker sets, which is exactly the drift the classifier exists to end.
 */
export function isTransfer(store: KpiStore, tx: Transaction): boolean {
	return isEconomicallyNeutral(classifyTransaction(store, tx));
}

/**
 * (income − expenses) / income — undefined when income isn't positive, rather than a clamped or
 * zeroed number (FIN-009).
 *
 * A period with next-to-no recorded income (a year where only a few cents of interest were ever
 * categorized as income) used to make this clamp to -100%, and a period with literally zero income
 * used to read as a flat 0% — both of which state a real, calculable percentage that happens to look
 * tame, when the honest answer is that the ratio isn't meaningful at all (dividing by ~€0 or by €0).
 * Silently substituting a presentable number for "not applicable" is exactly the kind of financial
 * inconsistency this pass exists to remove; a caller that wants a chart with no gaps decides that for
 * itself at render time; this function's job is only to say what's true. Callers show "N/A" for
 * undefined — see formatPct.
 */
function savingsRateOf(income: number, expenses: number): number | undefined {
	if (income <= 0) return undefined;
	return (income - expenses) / income;
}

/** The principal-only portion of a debt payment, in base currency: the full (already-converted) payment
 *  amount when no explicit principal/interest/fee split is recorded on the transaction (the common
 *  case — a bare credit-card payoff is pure principal, same as before these fields existed), or the
 *  proportional slice `principalAmount` represents of the transaction's own raw amount, applied to the
 *  base-currency total, when a split is present (v1.2.7 Phase 4, FIN-012). Scaling proportionally
 *  rather than converting `principalAmount` separately avoids a second currency lookup for what's
 *  already the same currency and date as the transaction it's part of. */
function debtPrincipalPortion(tx: Transaction, amountBase: number): number {
	if (tx.principalAmount === undefined || !tx.amount) return amountBase;
	return amountBase * (tx.principalAmount / tx.amount);
}

/**
 * Scales a classified field (`affectsIncome`/`affectsExpense`, in the transaction's own currency —
 * classification is currency-agnostic, see semantics.ts) into base currency, proportionally against the
 * transaction's own raw `tx.amount` rather than substituting `amountBase`'s full magnitude directly.
 *
 * For every kind before v1.2.7 Phase 4, this scaling factor was always exactly ±1
 * (`affectsIncome === amount`, `affectsExpense === -amount` for both a plain expense and a refund), so
 * `amountBase` itself and the properly-scaled value were always identical — every caller of this
 * function used to just use `amountBase` directly, which happened to work by coincidence, not by
 * design. A split debt payment breaks that coincidence: `affectsExpense` there is only the interest+fee
 * portion of a much larger `tx.amount` (the rest is principal, economically neutral), so substituting
 * the full converted amount would book the *entire* payment as an expense instead of just its real cost
 * — the one place every caller below needed to change together.
 */
export function scaledEconomicAmount(tx: Transaction, fieldValue: number, amountBase: number): number {
	return tx.amount ? amountBase * (fieldValue / tx.amount) : 0;
}

/** Applies one classified transaction's economic effect to an income/expense/passiveIncome bucket, in
 *  the store's base currency — the one place summarizeByYear and summarizeByMonth agree on how a
 *  classified row turns into a number, so the same transaction can never be read two different ways by
 *  the two loops that walk it. See `scaledEconomicAmount` for why this isn't just `amountBase` directly. */
function applyClassified(
	bucket: { income: number; expenses: number; passiveIncome: number },
	tx: Transaction,
	classified: ClassifiedTransaction,
	amountBase: number
): void {
	if (classified.affectsIncome > 0) {
		const scaled = scaledEconomicAmount(tx, classified.affectsIncome, amountBase);
		bucket.income += scaled;
		if (classified.kind === "dividend" || classified.kind === "interest-income") bucket.passiveIncome += scaled;
	} else if (classified.affectsExpense !== 0) {
		bucket.expenses += scaledEconomicAmount(tx, classified.affectsExpense, amountBase);
	}
}

/** Liquid (debit/savings/cash) accounts only, as of a date — the pool a runway figure draws from.
 *  Forward-referenced from summarizeByYear; defined near netWorthAsOf below since it wraps it. */
function liquidNetWorthAsOf(store: KpiStore, asOf: string, accountId?: string): number {
	return store.accounts
		.filter((a) => isLiquidType(a.type) && (!accountId || a.id === accountId))
		.reduce((sum, a) => sum + netWorthAsOf(store, asOf, a.id), 0);
}

/** Months of runway a liquid balance buys at a given monthly spend — 0 when there's no spend to divide
 *  by, since "runway" against zero burn is undefined, not infinite. */
function runwayOf(liquid: number, monthlyExpenses: number): number {
	return monthlyExpenses > 0 ? liquid / monthlyExpenses : 0;
}

/** Today, as "YYYY-MM-DD" in local time — matching every other "today" reading in this app (see
 *  budgets.ts's currentMonth), not UTC, which can read a different calendar day near midnight. */
function todayIsoLocal(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
		{ income: number; expenses: number; passiveIncome: number; debtPrincipal: number; netChange: number; transferAmount: number }
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
		if (!map.has(year)) map.set(year, { income: 0, expenses: 0, passiveIncome: 0, debtPrincipal: 0, netChange: 0, transferAmount: 0 });
		const bucket = map.get(year)!;
		const amount = amountIn(store, tx);
		bucket.netChange += amount;
		const classified = classifyTransaction(store, tx);
		// Tracked unconditionally, not only in the fully-neutral branch below: a split debt payment
		// (interest/fee carved out — Phase 4) is *not* economically neutral overall, but its principal
		// portion is still a real debt-principal movement that belongs in this bucket.
		if (classified.kind === "debt-principal") bucket.debtPrincipal += debtPrincipalPortion(tx, amount);
		if (isEconomicallyNeutral(classified)) {
			bucket.transferAmount += amount;
			continue;
		}
		// A split payment (Phase 4) is only *partially* economic — the rest of `amount` that
		// applyClassified below won't touch is still a neutral, balance-sheet-only movement (the
		// principal portion of a split debt payment) and must still land in transferAmount, or this
		// year's `income - expenses + transferAmount` stops reconstructing `netChange` for that one
		// transaction, silently drifting the no-snapshots aggregate net-worth walk away from what
		// netWorthAsOf computes directly from the raw ledger. `economicConsumption` is expressed in the
		// same signed convention as `amount` itself (unlike `applyClassified`'s bucket fields, which flip
		// sign for expenses), so `amount - economicConsumption` is exactly the leftover to carry forward.
		const economicConsumption =
			classified.affectsIncome > 0
				? scaledEconomicAmount(tx, classified.affectsIncome, amount)
				: -scaledEconomicAmount(tx, classified.affectsExpense, amount);
		bucket.transferAmount += amount - economicConsumption;
		applyClassified(bucket, tx, classified, amount);
	}

	const years = Array.from(map.keys()).sort((a, b) => a.localeCompare(b));

	/** A year's closing date, pulled back to the end of the range when the range stops inside it. */
	const closingDate = (year: string): string => {
		const yearEnd = `${year}-12-31`;
		return range?.to && range.to < yearEnd ? range.to : yearEnd;
	};
	const isPartial = (year: string): boolean =>
		!!range && ((!!range.from && range.from > `${year}-01-01`) || (!!range.to && range.to < `${year}-12-31`));

	/** How many calendar months this year's own `income`/`expenses` figures actually cover — never a
	 *  flat 12 (FIN-010). A range filter can clip a year at either end, and the current calendar year is
	 *  clipped at today regardless of any filter, since it hasn't finished yet; dividing a partial year's
	 *  total by 12 understates its monthly rate and, for runway, overstates how long savings would last. */
	const today = todayIsoLocal();
	const monthsElapsedIn = (year: string): number => {
		const yearStart = `${year}-01-01`;
		const effectiveFrom = range?.from && range.from > yearStart ? range.from : yearStart;
		const naturalEnd = closingDate(year);
		const effectiveTo = naturalEnd < today ? naturalEnd : today;
		return monthsInRange({ from: effectiveFrom, to: effectiveTo });
	};

	// With hand-recorded balances on file, each year's closing net worth is simply what the accounts
	// were actually worth at that date — no walking, no inference. That's strictly better than the
	// reconstruction below, which only exists because an untracked account's balance is otherwise a
	// single flat number that never moves. See netWorthAsOf.
	if (hasSnapshots(store)) {
		return years.map((year) => {
			const { income, expenses, passiveIncome, debtPrincipal } = map.get(year)!;
			return {
				year,
				income,
				expenses,
				net: income - expenses,
				savingsRate: savingsRateOf(income, expenses),
				netWorthEOY: netWorthAsOf(store, closingDate(year), accountId),
				passiveIncome,
				debtPrincipal,
				runwayMonths: runwayOf(liquidNetWorthAsOf(store, closingDate(year), accountId), expenses / monthsElapsedIn(year)),
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
		const { income, expenses, passiveIncome, debtPrincipal, netChange, transferAmount } = map.get(year)!;
		cumulative += useNetSavingsOnly ? income - expenses + transferAmount : netChange;
		return {
			year,
			income,
			expenses,
			net: income - expenses,
			savingsRate: savingsRateOf(income, expenses),
			netWorthEOY: cumulative,
			passiveIncome,
			debtPrincipal,
			runwayMonths: runwayOf(liquidNetWorthAsOf(store, closingDate(year), accountId), expenses / monthsElapsedIn(year)),
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
		debtPrincipal: years.reduce((sum, y) => sum + y.debtPrincipal, 0),
		// A point-in-time figure like netWorthEOY, not a flow — the period's ending runway, not a sum.
		runwayMonths: last.runwayMonths,
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
	savingsRate: number | undefined;
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
		const classified = classifyTransaction(store, tx);
		if (isEconomicallyNeutral(classified)) continue;
		applyClassified(bucket, tx, classified, amountIn(store, tx));
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
	// A snapshot is a dated observation — what the account was worth on snapshot.date — so its foreign-
	// currency amount is converted at *that* date's rate, not today's (v1.2.7 Phase 3's "historical
	// snapshots use snapshot-date FX" requirement).
	return accountAmountIn(store, account, isLiabilityType(account.type) ? -snapshot.balance : snapshot.balance, snapshot.date);
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

/** One account's raw ledger balance as of a date — the anchor (a recorded snapshot if one exists on or
 *  before `asOf`, else the opening balance) plus every transaction dated after that anchor and up to
 *  `asOf`, converted to base currency. Pure cash-in/cash-out: for an investing/crypto account, a Buy
 *  leaves this figure the same way any other cash outflow would, so this is the cash sitting in the
 *  account, not the value of what it holds — see netWorthAsOf, which adds the open cost basis of
 *  holdings back on top for exactly that reason. */
function rawLedgerBalanceAsOf(
	store: KpiStore,
	account: Account,
	asOf: string,
	txByAccount: Map<string, Transaction[]>
): { balance: number; snapshot: BalanceSnapshot | undefined } {
	const snapshot = snapshotAsOf(store, account.id, asOf);
	let balance = snapshot ? signedSnapshotBalance(store, account, snapshot) : signedOpeningBalance(store, account);
	for (const tx of txByAccount.get(account.id) ?? []) {
		const date = (tx.date || "").slice(0, 10);
		if (!date || date > asOf) continue;
		if (snapshot && date <= snapshot.date) continue;
		balance += amountIn(store, tx);
	}
	return { balance, snapshot };
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
 *
 * An investing/crypto account is valued differently (FIN-001/FIN-003): a Buy moves cash into a
 * security, and a plain raw-cash sum has no way to record that the security is still worth roughly
 * what was paid for it — the balance would silently drop by the purchase amount and never recover, and
 * a Sell's full proceeds double-counts money already reflected in that account's value. See
 * investingTotalValueAsOf for the anchor-plus-analytical-extrapolation this uses instead.
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
		// A register-only account has no balance to contribute. Counting it as zero would be a claim
		// that it holds nothing, which is a different and false statement — see Account.trackBalance.
		if (!tracksBalance(account)) continue;
		if (HOLDS_POSITIONS_TYPES.has(account.type)) {
			total += investingTotalValueAsOf(store, account, asOf, byAccount.get(account.id) ?? []);
		} else {
			total += rawLedgerBalanceAsOf(store, account, asOf, byAccount).balance;
		}
	}
	return total;
}

/** Everything's worth right now — the headline number. See netWorthAsOf for how each account is valued. */
export function netWorth(store: KpiStore, accountId?: string): number {
	return netWorthAsOf(store, "9999-12-31", accountId);
}

/** The anchor an account's balance counts from, and the movement since. See accountBalanceParts. */
export interface AccountBalanceParts {
	/** The recorded balance if one exists, otherwise the opening balance — in the account's currency. */
	anchor: number;
	/** Transactions counted from that anchor, converted into `currency`. */
	movement: number;
	/** Set when a recorded balance supersedes the opening balance, which then no longer moves the total. */
	snapshot?: BalanceSnapshot;
	/** How many transactions `movement` is the sum of. */
	counted: number;
	/** Transactions deliberately left out — no usable date, or already covered by the snapshot. */
	ignored: number;
}

/**
 * The two halves of one account's balance equation: the anchor it counts from, and the movement since.
 *
 * Exists because the account editor needs exactly the figure the dashboard shows for that account, and
 * reproducing the rules by hand is precisely how the two drifted apart. A plain `sum(tx.amount)` adds
 * dollars straight into a euro total, counts rows whose date never parsed, and ignores a recorded
 * balance that supersedes the opening one — so on a multi-currency account the editor's "current
 * balance" could sit hundreds off the number every other view showed, while inviting you to type over
 * it and silently rewrite the opening balance to match the wrong total.
 *
 * Amounts are stated in as-entered terms with no liability sign flip: netWorthAsOf negates a
 * liability's balance when rolling accounts up, which is a question about net worth, not about what
 * this account holds. `anchor` is returned in the account's own currency (the unit `openingBalance` is
 * stored in) and left unconverted — only the transactions are converted into `currency`, which is what
 * lets the editor relabel an account's currency without rewriting the number you typed.
 */
export function accountBalanceParts(store: KpiStore, accountId: string, currency: string): AccountBalanceParts {
	const fx: FxContext | undefined = store.fx ? { baseCurrency: currency, rates: store.fx.rates } : undefined;
	const account = store.accounts.find((a) => a.id === accountId);
	const snapshot = snapshotAsOf(store, accountId, "9999-12-31");
	const anchor = snapshot ? snapshot.balance : account?.openingBalance ?? 0;

	let movement = 0;
	let counted = 0;
	let ignored = 0;
	for (const tx of store.transactions) {
		if (tx.accountId !== accountId) continue;
		const date = (tx.date || "").slice(0, 10);
		// Mirrors netWorthAsOf exactly: an undated row can't be placed on the timeline, and a row the
		// recorded balance already accounts for would be counted twice.
		if (!date || (snapshot && date <= snapshot.date)) {
			ignored++;
			continue;
		}
		movement += fx ? convert(tx.amount, tx.currency, fx) : tx.amount;
		counted++;
	}
	return { anchor, movement, snapshot, counted, ignored };
}

/** Simulates monthly compounding to estimate years until `netWorthNow` reaches `target`. */
/**
 * Years until `netWorthNow`, compounding monthly at `annualReturn` with `monthlyContribution` added
 * each month, reaches `target` — the FI countdown.
 *
 * The monthly rate is the one that actually compounds twelve times to the stated *annual* rate —
 * `(1 + annualReturn)^(1/12) − 1` — not `annualReturn / 12` (FIN-011). The two are close for small
 * returns but diverge as the return grows: at a 7% annual return the naive division uses a 0.5833%
 * monthly rate, when the rate that truly compounds to 7% a year is 0.5654% — understating compounding
 * and quietly overstating how long reaching FI takes. `annualReturn` is expected to already be a real
 * (inflation-adjusted) rate — see the settings label this feeds from.
 */
export function fiProjection(
	netWorthNow: number,
	monthlyContribution: number,
	annualReturn: number,
	target: number
): number | undefined {
	if (target <= 0) return undefined;
	if (netWorthNow >= target) return 0;
	if (monthlyContribution <= 0 && annualReturn <= 0) return undefined;

	const monthlyReturn = Math.pow(1 + annualReturn, 1 / 12) - 1;
	let balance = netWorthNow;
	for (let month = 1; month <= 12 * 60; month++) {
		balance = balance * (1 + monthlyReturn) + monthlyContribution;
		if (balance >= target) return month / 12;
	}
	return undefined;
}

/** Spend by category id exactly as tagged on each transaction — a secondary and its primary are
 *  separate keys here. Use `primaryCategoryTotals` when you want secondaries rolled up into their
 *  parent. `period` takes a plain "YYYY"/"YYYY-MM" prefix (unchanged calendar behaviour) or a
 *  DateRange — the same choice `primaryCategoryTotals` already offers, needed so a pay-cycle budget
 *  (see payCycle.ts) can read a secondary category's spend for its own irregular date range. */
export function categoryTotals(store: KpiStore, period?: string | DateRange, accountId?: string): Map<string, number> {
	const totals = new Map<string, number>();
	for (const tx of store.transactions) {
		if (!inPeriod(tx.date, period)) continue;
		if (accountId && tx.accountId !== accountId) continue;
		// A refund nets off the category it came back into, exactly as it does in the year and month
		// summaries — otherwise a returned purchase leaves the category showing the full original spend
		// while the headline expense figure has already dropped, and the two views disagree. Neutral
		// kinds (transfers, trades, debt principal) have no expense contribution and fall out here too.
		// A split debt payment (Phase 4) only contributes its interest+fee portion — see
		// scaledEconomicAmount for why this can't just be the full converted amount.
		const classified = classifyTransaction(store, tx);
		if (classified.affectsExpense === 0) continue;
		const key = tx.categoryId ?? "uncategorized";
		totals.set(key, (totals.get(key) ?? 0) + scaledEconomicAmount(tx, classified.affectsExpense, amountIn(store, tx)));
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
		if (!inPeriod(tx.date, period)) continue;
		if (accountId && tx.accountId !== accountId) continue;
		const classified = classifyTransaction(store, tx);
		if (classified.affectsExpense === 0) continue;
		const key = resolvePrimaryId(store.categories, tx.categoryId) ?? "uncategorized";
		totals.set(key, (totals.get(key) ?? 0) + scaledEconomicAmount(tx, classified.affectsExpense, amountIn(store, tx)));
	}
	return totals;
}

/**
 * Economic income by primary category — the income-actual path FIN-006 requires: an income-kind
 * category's "spent" must come from money actually earned into it, not from the expense-only totals
 * above. A transaction the classifier calls investment-sell/investment-buy/internal-transfer/
 * debt-principal never counts here even if a user mis-categorized it under an income category — the
 * account+action evidence behind `kind` outranks the category label (see semantics.ts).
 */
export function primaryCategoryIncomeTotals(store: KpiStore, period?: string | DateRange, accountId?: string): Map<string, number> {
	const totals = new Map<string, number>();
	for (const tx of store.transactions) {
		if (!inPeriod(tx.date, period)) continue;
		if (accountId && tx.accountId !== accountId) continue;
		const classified = classifyTransaction(store, tx);
		if (classified.affectsIncome === 0) continue;
		const key = resolvePrimaryId(store.categories, tx.categoryId) ?? "uncategorized";
		totals.set(key, (totals.get(key) ?? 0) + scaledEconomicAmount(tx, classified.affectsIncome, amountIn(store, tx)));
	}
	return totals;
}

/**
 * One category's spend bucketed by whatever period key `keyOf` derives from a transaction's date, in
 * a single pass — same filters as `primaryCategoryTotals` (net of refunds, transfers/trades/debt-
 * principal excluded, converted to base currency). Feeds `rolloverInto`'s carry-forward chain, so a
 * refund must net here exactly the way it does in the budget page's own "spent" figure the rollover is
 * supposed to agree with (v1.2.7 remediation Phase 5.1) — a sign-only `tx.amount >= 0` skip used to
 * drop every refund entirely instead of netting it, so a category's rollover balance and its plain
 * "spent" total could disagree.
 *
 * Exists because walking a rollover chain period by period would otherwise re-read the entire ledger
 * once per period walked, for every rollover category, on every render of the budgets page.
 * `monthlySpendFor` and `payCycle.ts`'s `payCycleSpendFor` are both thin wrappers over this — the
 * bucketing key is the only thing that differs between calendar and pay-cycle budgeting.
 */
export function spendByPeriod(store: KpiStore, categoryId: string, keyOf: (date: string) => string | undefined): Map<string, number> {
	const ids = new Set(descendantIds(store.categories, categoryId));
	const byPeriod = new Map<string, number>();
	for (const tx of store.transactions) {
		if (!tx.categoryId || !ids.has(tx.categoryId)) continue;
		const classified = classifyTransaction(store, tx);
		if (classified.affectsExpense === 0) continue;
		if (!tx.date) continue;
		const key = keyOf(tx.date);
		if (!key) continue;
		byPeriod.set(key, (byPeriod.get(key) ?? 0) + scaledEconomicAmount(tx, classified.affectsExpense, amountIn(store, tx)));
	}
	return byPeriod;
}

/** `spendByPeriod` keyed by calendar month ("YYYY-MM"). See that function for what's netted/excluded. */
export function monthlySpendFor(store: KpiStore, categoryId: string): Map<string, number> {
	return spendByPeriod(store, categoryId, (date) => date.slice(0, 7));
}

/** The individual expense transactions behind one category's total for a given month — same filters
 *  (expenses only, transfers excluded) as `categoryTotals`/`primaryCategoryTotals`. When `categoryId`
 *  is a primary category, this includes transactions tagged with any of its secondary categories too. */
export function categoryTransactions(store: KpiStore, categoryId: string, period: string | DateRange): Transaction[] {
	const ids = new Set(descendantIds(store.categories, categoryId));
	return store.transactions
		.filter((tx) => tx.amount < 0 && inPeriod(tx.date, period) && tx.categoryId !== undefined && ids.has(tx.categoryId) && !isTransfer(store, tx))
		.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Transaction count and net total for one account — the at-a-glance numbers shown in the accounts manager. */
export function accountStats(store: KpiStore, accountId: string): { count: number; netWorth: number } {
	const count = store.transactions.filter((t) => t.accountId === accountId).length;
	return { count, netWorth: netWorth(store, accountId) };
}

/**
 * Average monthly spend across the given accounts (or every account, if omitted) — the denominator for
 * "months of runway", the reserve target, and the FI expense base.
 *
 * Averaged over every complete calendar month between the ledger's earliest and latest tracked activity
 * on these accounts — not just the months that happen to contain a qualifying expense (FIN-010). A month
 * with genuinely zero spend is still a real data point: dropping it from the divisor overstates the
 * average by treating "no expense rows this month" as "this month doesn't count" instead of "spent €0
 * this month". The window never reaches past the last *complete* calendar month — the current,
 * still-in-progress month is excluded rather than averaged in as if it had run its full course.
 */
export function averageMonthlyExpenses(store: KpiStore, accountIds?: string[]): number {
	let earliestMonth: string | undefined;
	let latestMonth: string | undefined;
	const byMonth = new Map<string, number>();
	for (const tx of store.transactions) {
		if (accountIds && !accountIds.includes(tx.accountId)) continue;
		const month = tx.date?.slice(0, 7);
		if (!month) continue;
		if (!earliestMonth || month < earliestMonth) earliestMonth = month;
		if (!latestMonth || month > latestMonth) latestMonth = month;
		if (tx.amount >= 0) continue;
		if (isTransfer(store, tx)) continue;
		byMonth.set(month, (byMonth.get(month) ?? 0) + -amountIn(store, tx));
	}
	if (!earliestMonth || !latestMonth) return 0;

	const endMonth = latestMonth < lastCompleteMonthKey() ? latestMonth : lastCompleteMonthKey();
	const months = monthKeysBetween(earliestMonth, endMonth);
	if (months.length === 0) return 0;
	const total = months.reduce((sum, m) => sum + (byMonth.get(m) ?? 0), 0);
	return total / months.length;
}

export interface FiExpenseBase {
	/** Annualized expense figure — multiply by the FI multiplier to get the FI number. */
	annual: number;
	/** Annualized net (income − expenses) over the same window — the monthly-contribution rate a FI
	 *  projection should compound forward, on the same trailing-12-month basis as `annual` rather than a
	 *  different window (a mismatch that understates or overstates "current pace" relative to the FI
	 *  number it's being compared against). */
	netAnnual: number;
	/** How many of the trailing 12 complete months actually have tracked history behind them. */
	monthsCovered: number;
	/** False once fewer than 12 complete months of history exist, so `annual` is extrapolated from a
	 *  shorter window rather than a genuine trailing year — callers should label it as an estimate. */
	complete: boolean;
}

/**
 * The annualized expense figure financial-independence math should be built on (FIN-011): the trailing
 * 12 complete calendar months of spending, or however many complete months exist if there's less than a
 * year of history yet, annualized either way.
 *
 * A single calendar year's raw total used to stand in for this — correct once that year has actually
 * run its full course, but for the current, still-in-progress year (the common case: viewing "this
 * year" on the dashboard any month but December) it silently used a partial year's spend as if it were
 * a whole year's, understating the FI number and making progress look further along than it really is.
 * Zero-spend months inside the window still count in the average (FIN-010's fix, applied here too), and
 * `complete: false` tells a caller to label the figure as an estimate rather than state it flatly.
 */
export function fiExpenseBase(store: KpiStore, accountIds?: string[]): FiExpenseBase {
	let earliestMonth: string | undefined;
	const expenseByMonth = new Map<string, number>();
	const incomeByMonth = new Map<string, number>();
	for (const tx of store.transactions) {
		if (accountIds && !accountIds.includes(tx.accountId)) continue;
		const month = tx.date?.slice(0, 7);
		if (!month) continue;
		if (!earliestMonth || month < earliestMonth) earliestMonth = month;
		const classified = classifyTransaction(store, tx);
		const amount = amountIn(store, tx);
		// See scaledEconomicAmount: affectsExpense/affectsIncome are in the transaction's own currency
		// and, for a split debt payment, only a fraction of tx.amount — scaled proportionally rather
		// than assuming the full converted amount applies.
		if (classified.affectsExpense !== 0) {
			expenseByMonth.set(month, (expenseByMonth.get(month) ?? 0) + scaledEconomicAmount(tx, classified.affectsExpense, amount));
		}
		if (classified.affectsIncome > 0) {
			incomeByMonth.set(month, (incomeByMonth.get(month) ?? 0) + scaledEconomicAmount(tx, classified.affectsIncome, amount));
		}
	}
	if (!earliestMonth) return { annual: 0, netAnnual: 0, monthsCovered: 0, complete: false };

	const end = lastCompleteMonthKey();
	const twelveBack = shiftMonthKey(end, -11);
	const windowStart = earliestMonth > twelveBack ? earliestMonth : twelveBack;
	const months = monthKeysBetween(windowStart, end);
	if (months.length === 0) return { annual: 0, netAnnual: 0, monthsCovered: 0, complete: false };

	const totalExpense = months.reduce((sum, m) => sum + (expenseByMonth.get(m) ?? 0), 0);
	const totalIncome = months.reduce((sum, m) => sum + (incomeByMonth.get(m) ?? 0), 0);
	return {
		annual: (totalExpense / months.length) * 12,
		netAnnual: ((totalIncome - totalExpense) / months.length) * 12,
		monthsCovered: months.length,
		complete: months.length >= 12,
	};
}

export interface Holding {
	ticker: string;
	assetClass?: string;
	shares: number;
	/** Open cost basis for the shares still held — moving-average accounting: a buy adds its cash cost,
	 *  a sell removes cost proportional to the pre-sale average unit cost. Not a live market value. */
	netInvested: number;
	avgCost: number;
	/** Realized profit/loss this ticker has booked to date — proceeds from every sell minus the cost
	 *  removed at that sell's pre-sale average unit cost. Distinct from netInvested, which only ever
	 *  reflects what's still open; summing the two across a full sell-out reproduces total cash return. */
	realizedPnL: number;
}

interface InvestmentBucket {
	shares: number;
	costBasis: number;
	assetClass?: string;
	realizedPnL: number;
}

/**
 * Per-ticker Buy/Sell activity for one account, as of a date, using moving-average cost-basis
 * accounting — the analytical (not tax) basis: a buy adds its cash cost to the ticker's basis in
 * proportion to shares bought; a sell removes basis proportional to the *pre-sale average unit cost*,
 * never to the sale proceeds. Removing basis at the proceeds price (the previous behavior) let a
 * profitable sell erase more cost than was ever paid, and a loss-making sell leave phantom cost behind
 * — silently fabricating or hiding gains. Returns every ticker ever traded, including fully closed ones,
 * because a closed position's realized P/L still belongs in the account-level total.
 */
function investmentBucketsAsOf(store: KpiStore, accountId: string, asOf: string): Map<string, InvestmentBucket> {
	// Moving-average accounting depends on processing each ticker's buys/sells in chronological order —
	// a sell's pre-sale average cost is only meaningful relative to the buys that actually preceded it.
	// store.transactions carries no ordering guarantee (import order, manual entry order, whatever a
	// provider happened to hand back), so this sorts a filtered copy rather than trusting array order.
	const relevant = store.transactions.filter((tx) => {
		if (tx.accountId !== accountId) return false;
		if (!tx.ticker || tx.ticker === "CASH") return false;
		const date = (tx.date || "").slice(0, 10);
		if (!date || date > asOf) return false;
		const action = (tx.action ?? "").toLowerCase();
		return action === "buy" || action === "sell";
	});
	relevant.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

	const byTicker = new Map<string, InvestmentBucket>();
	for (const tx of relevant) {
		const ticker = tx.ticker as string;
		const action = (tx.action ?? "").toLowerCase();
		const bucket = byTicker.get(ticker) ?? { shares: 0, costBasis: 0, assetClass: tx.assetClass, realizedPnL: 0 };
		const shares = tx.shares ?? 0;
		const cash = Math.abs(amountIn(store, tx));
		if (action === "buy") {
			bucket.shares += shares;
			bucket.costBasis += cash;
		} else {
			const preSaleShares = bucket.shares;
			const avgCost = preSaleShares > 1e-9 ? bucket.costBasis / preSaleShares : 0;
			const soldShares = Math.min(shares, preSaleShares);
			const costRemoved = avgCost * soldShares;
			bucket.realizedPnL += cash - costRemoved;
			bucket.shares -= soldShares;
			bucket.costBasis -= costRemoved;
		}
		if (tx.assetClass) bucket.assetClass = tx.assetClass;
		byTicker.set(ticker, bucket);
	}
	return byTicker;
}

/**
 * Current holdings inferred purely from Buy/Sell activity — there's no market-price feed here, so this is
 * cost-basis accounting (what you put in), not portfolio valuation (what it's worth today). Only open
 * positions are returned; see `investingRealizedPnLAsOf` for the P/L booked by everything already sold.
 */
export function investingHoldings(store: KpiStore, accountId: string, asOf = "9999-12-31"): Holding[] {
	const byTicker = investmentBucketsAsOf(store, accountId, asOf);
	return Array.from(byTicker.entries())
		.filter(([, b]) => b.shares > 1e-6)
		.map(([ticker, b]) => ({
			ticker,
			assetClass: b.assetClass,
			shares: b.shares,
			netInvested: b.costBasis,
			avgCost: b.shares > 0 ? b.costBasis / b.shares : 0,
			realizedPnL: b.realizedPnL,
		}))
		.sort((a, b) => b.netInvested - a.netInvested);
}

/** Total realized profit/loss for an account, as of a date — every ticker ever traded, open or closed. */
export function investingRealizedPnLAsOf(store: KpiStore, accountId: string, asOf = "9999-12-31"): number {
	let total = 0;
	for (const b of investmentBucketsAsOf(store, accountId, asOf).values()) total += b.realizedPnL;
	return total;
}

/** Sum of open cost basis across every currently-held ticker in an account, as of a date — the
 *  "what you'd still have to have bought back" figure that stands in for market value absent a price
 *  feed. See `investingTotalValueAsOf`. */
export function investingOpenCostBasisAsOf(store: KpiStore, accountId: string, asOf = "9999-12-31"): number {
	return investingHoldings(store, accountId, asOf).reduce((sum, h) => sum + h.netInvested, 0);
}

/** Account types that hold priced positions rather than plain cash — see TRADE_ACCOUNT_TYPES in
 *  src/finance/semantics.ts, which this mirrors; kept local since kpi.ts only needs the type check, not
 *  the full classifier. */
const HOLDS_POSITIONS_TYPES = new Set(["investing", "crypto"]);

/** Whether a transaction is a trade (Buy/Sell) inside an account that holds priced positions — the one
 *  kind of cash movement whose effect on total account value is handled analytically (cost basis +
 *  realized P/L) rather than by its raw cash amount. See investingTotalValueAsOf. */
function isTrade(tx: Transaction, account: Account): boolean {
	if (!HOLDS_POSITIONS_TYPES.has(account.type)) return false;
	const action = (tx.action ?? "").toLowerCase();
	return action === "buy" || action === "sell";
}

/** An account's cash position as of a date, from the raw ledger alone — opening balance plus every
 *  transaction's amount, completely ignoring any recorded snapshot. Deliberately snapshot-blind: it
 *  exists only so investmentBucketsForValuation can ask "how much of the snapshot's total is cash, so
 *  the rest can be attributed to securities" without that question answering itself circularly. */
function pureCashAsOf(store: KpiStore, account: Account, asOf: string): number {
	let balance = signedOpeningBalance(store, account);
	for (const tx of store.transactions) {
		if (tx.accountId !== account.id) continue;
		const date = (tx.date || "").slice(0, 10);
		if (!date || date > asOf) continue;
		balance += amountIn(store, tx);
	}
	return balance;
}

/**
 * The cost-basis buckets to use for *valuation* as of a date — as opposed to `investmentBucketsAsOf`,
 * which is pure historical-cost accounting and stays that way for `investingHoldings`/
 * `investingRealizedPnLAsOf` (a user's real, all-time cost basis and realized gain, for their own
 * record). This function exists only to feed `investingTotalValueAsOf`, and differs in one way: when a
 * snapshot exists, every currently-held ticker's cost basis is rescaled at the snapshot date so the
 * total reconciles with what the snapshot actually said the account was worth then.
 *
 * Why: a snapshot states real market value, which is exactly the number historical cost is *not* — a
 * position bought for €1,000 and worth €1,500 at snapshot time is still carried at €1,000 of historical
 * cost. Selling it after the snapshot for €1,500 books a €500 "realized gain" against that historical
 * cost — true, but already fully reflected in the snapshot's own €1,500. Adding it again double-counts
 * appreciation the snapshot had already captured (this was a real bug: see the regression tests below).
 * Rescaling at the snapshot date treats "you were worth what the snapshot said" as the new starting
 * point for valuation purposes — a mark-to-market reset — so a sale at exactly the snapshot-implied
 * price now nets to zero, and only genuinely *new* gain/loss since the snapshot shows up.
 *
 * The rescale is proportional across every ticker held at snapshot time, weighted by pre-reset cost
 * basis: `impliedSecuritiesValue = snapshot.balance − cash(asOf snapshot.date)` backs out the known cash
 * from the snapshot's total, and whatever's left is distributed across tickers in proportion to what
 * each was already carrying, on the assumption that a single whole-account balance can't say which
 * ticker specifically moved by how much. A ticker bought only *after* the snapshot is untouched by this
 * — it starts fresh at its own real cost, same as investmentBucketsAsOf.
 *
 * MVP simplification (documented limitations, not attempted here):
 * - With more than one snapshot on record, only the most recent one on or before `asOf` resets
 *   anything — an earlier snapshot's own reset isn't chained forward. Correct for the common case (one
 *   snapshot, or snapshots taken well apart); a position revalued at *two* snapshots in sequence would
 *   need chained resets to be exactly right.
 * - The single account-wide `resetFactor` is applied uniformly to every ticker held at snapshot time.
 *   If two tickers moved in *different* directions before the snapshot (one up, one down) but happened
 *   to net to roughly the same combined value, each ticker's individual post-reset basis can still be
 *   wrong even though the *account total* is exactly right — a whole-account balance genuinely can't
 *   say which position moved by how much. Fully correct per-ticker attribution would need
 *   position-level snapshot state (the audit's "preferred approach"), not attempted here.
 * - Degenerate case, handled rather than silently reproducing the bug: if every ticker held at snapshot
 *   time has ~€0 of historical cost basis (originalOpenCostBasis ≈ 0), the proportional-scaling ratio
 *   is undefined (dividing by ~0) — `impliedSecuritiesValue` is split evenly across those tickers
 *   instead. Exactly right for the common instance of this (a single near-zero-cost position); an even
 *   split is still an assumption, not a derivation, when multiple near-zero-cost tickers are held at
 *   once — but leaving `resetFactor` at a no-op `1` here (the reset never applying) would have quietly
 *   reintroduced the exact double-count this function exists to fix, for exactly the positions where
 *   the bug's effect is largest (a huge gain relative to a near-zero cost basis).
 */
function investmentBucketsForValuation(store: KpiStore, account: Account, asOf: string): Map<string, InvestmentBucket> {
	const snapshot = snapshotAsOf(store, account.id, asOf);
	if (!snapshot) return investmentBucketsAsOf(store, account.id, asOf);

	const atSnapshot = investmentBucketsAsOf(store, account.id, snapshot.date);
	const originalOpenCostBasis = Array.from(atSnapshot.values()).reduce((sum, b) => sum + b.costBasis, 0);
	const cashAtSnapshot = pureCashAsOf(store, account, snapshot.date);
	const impliedSecuritiesValue = signedSnapshotBalance(store, account, snapshot) - cashAtSnapshot;
	const resetFactor = originalOpenCostBasis > 1e-9 ? impliedSecuritiesValue / originalOpenCostBasis : undefined;
	const evenShare = atSnapshot.size > 0 ? impliedSecuritiesValue / atSnapshot.size : 0;

	const buckets = new Map<string, InvestmentBucket>();
	for (const [ticker, b] of atSnapshot) {
		const costBasis = resetFactor !== undefined ? b.costBasis * resetFactor : evenShare;
		buckets.set(ticker, { shares: b.shares, costBasis, assetClass: b.assetClass, realizedPnL: 0 });
	}

	// Continue moving-average accounting from the reset baseline for everything after the snapshot date
	// — same algorithm as investmentBucketsAsOf, just starting from `buckets` instead of empty ones. A
	// ticker with no pre-snapshot position (bought fresh after the snapshot) simply isn't in `buckets`
	// yet and starts at {0, 0} the first time it's touched, exactly as investmentBucketsAsOf would.
	const relevant = store.transactions.filter((tx) => {
		if (tx.accountId !== account.id) return false;
		if (!tx.ticker || tx.ticker === "CASH") return false;
		const date = (tx.date || "").slice(0, 10);
		if (!date || date <= snapshot.date || date > asOf) return false;
		const action = (tx.action ?? "").toLowerCase();
		return action === "buy" || action === "sell";
	});
	relevant.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

	for (const tx of relevant) {
		const ticker = tx.ticker as string;
		const action = (tx.action ?? "").toLowerCase();
		const bucket = buckets.get(ticker) ?? { shares: 0, costBasis: 0, assetClass: tx.assetClass, realizedPnL: 0 };
		const shares = tx.shares ?? 0;
		const cash = Math.abs(amountIn(store, tx));
		if (action === "buy") {
			bucket.shares += shares;
			bucket.costBasis += cash;
		} else {
			const preSaleShares = bucket.shares;
			const avgCost = preSaleShares > 1e-9 ? bucket.costBasis / preSaleShares : 0;
			const soldShares = Math.min(shares, preSaleShares);
			const costRemoved = avgCost * soldShares;
			bucket.realizedPnL += cash - costRemoved;
			bucket.shares -= soldShares;
			bucket.costBasis -= costRemoved;
		}
		if (tx.assetClass) bucket.assetClass = tx.assetClass;
		buckets.set(ticker, bucket);
	}
	return buckets;
}

/**
 * Total value of an investing/crypto account as of a date: an anchor (a recorded snapshot on or before
 * `asOf` if one exists, else the opening balance) plus every non-trade cash movement since that anchor
 * (deposits, withdrawals, dividends, fees — real money crossing the account boundary) plus the realized
 * P/L booked by every sell since the anchor.
 *
 * A Buy is deliberately left out of the sum: converting cash into a security assumed worth what was
 * paid changes nothing about total value. A Sell's raw proceeds are left out too, in favor of just the
 * realized gain/loss — the "return of capital" portion of those proceeds is already accounted for,
 * either as open cost basis (no-snapshot case) or as part of the snapshot's own observed value
 * (with-snapshot case).
 *
 * The no-snapshot case uses plain historical-cost realized P/L (`investingRealizedPnLAsOf`), which is
 * exactly right when the anchor is €0/the opening balance — there's nothing for historical cost to
 * disagree with yet. Once a snapshot exists, though, historical cost and the snapshot's own market
 * value are two different numbers for the same position, and using historical-cost realized P/L there
 * double-counts whatever gain/loss the snapshot had already captured — see
 * `investmentBucketsForValuation`'s doc comment for the concrete failure case and the fix: a rescaled
 * ("mark-to-market") bucket set anchored at the snapshot, used only for this valuation window.
 *
 * A prior version of this fallback only applied the analytical add-back when no snapshot existed at
 * all, and once a snapshot was recorded, every trade *after* it went back to draining the account by
 * its full raw cash amount. A version after that fixed trades on positions opened *after* the snapshot,
 * but still double-counted a *pre-snapshot* position's already-captured appreciation when it was sold
 * post-snapshot. This version handles both.
 */
function investingTotalValueAsOf(store: KpiStore, account: Account, asOf: string, txs: Transaction[]): number {
	const snapshot = snapshotAsOf(store, account.id, asOf);
	const anchor = snapshot ? signedSnapshotBalance(store, account, snapshot) : signedOpeningBalance(store, account);
	const anchorDate = snapshot ? snapshot.date : "0000-01-01";

	let nonTradeCash = 0;
	for (const tx of txs) {
		const date = (tx.date || "").slice(0, 10);
		if (!date || date > asOf || date <= anchorDate) continue;
		if (isTrade(tx, account)) continue;
		nonTradeCash += amountIn(store, tx);
	}

	const realizedPnLWindow = snapshot
		? Array.from(investmentBucketsForValuation(store, account, asOf).values()).reduce((sum, b) => sum + b.realizedPnL, 0)
		: investingRealizedPnLAsOf(store, account.id, asOf) - investingRealizedPnLAsOf(store, account.id, anchorDate);
	return anchor + nonTradeCash + realizedPnLWindow;
}

export interface InvestmentState {
	/** Cash sitting in the account, in base currency — the account's raw ledger sum, which already nets
	 *  every deposit, withdrawal, dividend, fee, buy, and sell in cash terms. */
	cash: number;
	holdings: Holding[];
	/** Sum of open cost basis across current holdings — see investingOpenCostBasisAsOf. */
	openCostBasis: number;
	/** Realized P/L across every ticker ever traded in this account, open or closed. */
	realizedPnL: number;
	/** The account's most recent recorded balance, when one exists — the literal last observation, not
	 *  extrapolated forward. See `totalValue` for the figure that accounts for activity since then. */
	marketValue?: number;
	/** The resolved total value as of the requested date — see investingTotalValueAsOf. */
	totalValue: number;
}

/** The full investment picture for one account, as of a date — cash, holdings, open cost basis, and
 *  realized P/L, plus the resolved total value. `cash` is the raw ledger balance (see
 *  rawLedgerBalanceAsOf) — deliberately not `totalValue`, which values trades analytically instead of
 *  at raw cash; reusing `cash` as the total would double-count in exactly the way netWorthAsOf's
 *  docstring warns against. */
export function investmentStateAsOf(store: KpiStore, accountId: string, asOf: string): InvestmentState {
	const holdings = investingHoldings(store, accountId, asOf);
	const openCostBasis = holdings.reduce((sum, h) => sum + h.netInvested, 0);
	const realizedPnL = investingRealizedPnLAsOf(store, accountId, asOf);
	const account = store.accounts.find((a) => a.id === accountId);
	if (!account) return { cash: 0, holdings, openCostBasis, realizedPnL, totalValue: openCostBasis };

	const txs = store.transactions.filter((t) => t.accountId === accountId);
	const txByAccount = new Map<string, Transaction[]>([[accountId, txs]]);
	const { balance: cash, snapshot } = rawLedgerBalanceAsOf(store, account, asOf, txByAccount);
	const marketValue = snapshot ? signedSnapshotBalance(store, account, snapshot) : undefined;
	return {
		cash,
		holdings,
		openCostBasis,
		realizedPnL,
		marketValue,
		totalValue: investingTotalValueAsOf(store, account, asOf, txs),
	};
}

export interface InvestingYearActivity {
	year: string;
	deposits: number;
	withdrawals: number;
	dividends: number;
	fees: number;
}

/** Deposits/withdrawals/dividends/fees for a broker account, by year — the cash-flow side of investing.
 *  `tx.fee` is denominated in the transaction's own currency, same as `tx.amount`, unless an importer
 *  explicitly records otherwise — so it's converted the same way, at the transaction's own date
 *  (v1.2.7 remediation Phase 5.3: `fee` used to be summed raw, so a $10 fee on a EUR-base vault was
 *  silently presented as €10). */
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
		if (tx.fee) {
			const feeBase = store.fx ? convert(tx.fee, tx.currency, store.fx, tx.date) : tx.fee;
			bucket.fees += Math.abs(feeBase);
		}
	}
	return Array.from(map.values()).sort((a, b) => a.year.localeCompare(b.year));
}
