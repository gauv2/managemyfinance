import { categoryChain, descendantIds } from "../categories";
import { baseCurrencyOf, convert, unconvertibleCurrencies, type FxContext } from "../currency";
import { classifyTransaction, isEconomicallyNeutral, type ClassifyStore } from "../finance/semantics";
import { merchantKey, merchantLabel } from "../import/merchantKey";
import type { Account, Category, Transaction } from "../types";

/**
 * Ad-hoc reporting: "what did I spend on restaurants in 2025", "what has the car cost me", "both of
 * those together, per month".
 *
 * The existing report builders answer fixed questions — this month, this year, net worth — which is
 * the right shape for a recurring snapshot and the wrong shape entirely for a question you thought of
 * five seconds ago. This module is the other half: one query object describing an arbitrary slice,
 * and one result object carrying both the matching rows and every total worth quoting about them.
 *
 * Everything here is pure. The UI, the CSV, the spreadsheet and the PDF all run through runReport()
 * and render the same ReportResult, so an exported file can never disagree with the screen it was
 * exported from — the same reason the monthly/yearly builders share their calculation modules.
 */

/**
 * Which of two different questions a report is answering (v1.2.7 remediation Phase 2):
 *
 * "economic" (the default) is the same meaning every other screen in the app uses — income/expense as
 * `classifyTransaction` reads them. A refund nets against the purchase it returned; a transfer, trade,
 * or debt-principal payment isn't spending or income at all. This is what "what did I spend on
 * restaurants" or "what's my income" should mean, and it's what makes a report agree with the
 * dashboard/budgets on the same figure.
 *
 * "cash-flow" is the literal, unfiltered question: how much money moved through this account,
 * regardless of what it meant. A refund is just another inbound euro, not netted against anything; a
 * trade's full buy/sell cash and a transfer's full amount count too — `includeTransfers` defaults to
 * true in this mode for exactly that reason, though an explicit `includeTransfers: false` still wins.
 * This is the right mode for "how much cash moved through this account this month", never for a
 * spending/income figure — see the report spec's FIN-002/FIN-005 residual findings for why conflating
 * the two was the bug.
 */
export type ReportMeasure = "economic" | "cash-flow";

/** What a report asks for. Every field is optional; an empty query means "the whole ledger". */
export interface ReportQuery {
	/** Inclusive "YYYY-MM-DD" bounds. */
	from?: string;
	to?: string;
	/**
	 * Categories to include. A primary id pulls in its secondaries too — asking for "Transport" and
	 * getting only rows tagged at the primary level, while every "Transport › Fuel" row is silently
	 * dropped, would under-report the exact question being asked. The literal "__uncategorized"
	 * selects rows with no category at all.
	 */
	categoryIds?: string[];
	accountIds?: string[];
	/** Free text over description, counterparty and notes. */
	search?: string;
	/** Defaults to "economic" — see `ReportMeasure`. Changes what "out"/"in" below mean. */
	measure?: ReportMeasure;
	/**
	 * In "economic" mode (the default): "out" means an economic expense (affectsExpense !== 0 — a
	 * purchase and any refund against it, netted); "in" means economic income (affectsIncome !== 0 —
	 * excludes a refund, which is not income). In "cash-flow" mode: "out"/"in" are the transaction's raw
	 * signed amount, exactly as before.
	 */
	direction?: "all" | "out" | "in";
	/** Transfers between your own accounts, trades (a buy/sell of equal cash and security value), and
	 *  debt-principal payments aren't spending; excluded unless asked for. Named for the most familiar
	 *  case, but gates all three — see classifyTransaction in ../finance/semantics. Defaults to true in
	 *  "cash-flow" mode (see `ReportMeasure`), false otherwise. */
	includeTransfers?: boolean;
}

export const UNCATEGORIZED = "__uncategorized";

export interface ReportGroup {
	key: string;
	label: string;
	count: number;
	/** Signed, in base currency. Negative is money out. */
	total: number;
}

export interface ReportResult {
	rows: Transaction[];
	count: number;
	/** Money out over the period, as a positive number, in base currency. */
	spent: number;
	/** Money in over the period, in base currency. */
	received: number;
	/** received − spent. */
	net: number;
	/** Largest single expense in the slice, as a positive number. */
	largest: number;
	/** Distinct "YYYY-MM" months the matching rows fall in — the divisor for a monthly average. */
	months: number;
	byCategory: ReportGroup[];
	byMonth: ReportGroup[];
	byMerchant: ReportGroup[];
	byAccount: ReportGroup[];
	/** Currencies present that no rate could convert, so a UI can say the totals mix at 1:1. */
	mixedCurrencies: string[];
	baseCurrency: string;
}

export interface ReportSource {
	transactions: Transaction[];
	categories: Category[];
	accounts: Account[];
	fx?: FxContext;
}

/** Expands the chosen category ids into the full set a row's categoryId is actually tested against. */
export function expandCategoryIds(categories: Category[], chosen: string[] | undefined): Set<string> | undefined {
	if (!chosen || chosen.length === 0) return undefined;
	const out = new Set<string>();
	for (const id of chosen) {
		out.add(id);
		if (id === UNCATEGORIZED) continue;
		for (const child of descendantIds(categories, id)) out.add(child);
	}
	return out;
}

/** Whether one transaction belongs in the slice. Exported so a UI can count without building a result. */
export function matchesQuery(
	tx: Transaction,
	query: ReportQuery,
	categoryIds: Set<string> | undefined,
	store: ClassifyStore
): boolean {
	if (query.from && tx.date < query.from) return false;
	if (query.to && tx.date > query.to) return false;
	if (query.accountIds && query.accountIds.length > 0 && !query.accountIds.includes(tx.accountId)) return false;

	if (categoryIds) {
		const id = tx.categoryId;
		if (!id) {
			if (!categoryIds.has(UNCATEGORIZED)) return false;
		} else if (!categoryIds.has(id)) return false;
	}

	const measure = query.measure ?? "economic";
	const direction = query.direction ?? "all";
	if (measure === "economic") {
		// "out"/"in" mean economic expense/income, not raw sign — a refund passes an "out" (expense)
		// filter (it nets against the purchase it returned) but fails an "in" (income) filter (it isn't
		// income), which is exactly backwards from what raw-sign filtering did before (FIN-002/FIN-005).
		const classified = classifyTransaction(store, tx);
		if (direction === "out" && classified.affectsExpense === 0) return false;
		if (direction === "in" && classified.affectsIncome === 0) return false;
	} else if (direction === "out" && tx.amount >= 0) {
		return false;
	} else if (direction === "in" && tx.amount <= 0) {
		return false;
	}

	// A transfer is the same money appearing twice, once on each side; a trade exchanges cash for a
	// security of equal value; a debt-principal payment reduces what's owed. None of the three is
	// spending or income — counting them as such would make "what did I spend this year" include every
	// euro moved to savings, or an ETF purchase show up as €2,000 of spending (FIN-002). Cash-flow mode
	// wants the opposite by default: every euro that actually moved, transfers and trades included.
	const includeTransfers = query.includeTransfers ?? measure === "cash-flow";
	if (!includeTransfers && isEconomicallyNeutral(classifyTransaction(store, tx))) return false;

	const needle = (query.search ?? "").trim().toLowerCase();
	if (needle) {
		const haystack = `${tx.description ?? ""} ${tx.counterparty ?? ""} ${tx.notes ?? ""}`.toLowerCase();
		if (!haystack.includes(needle)) return false;
	}

	return true;
}

function sortGroups(groups: Map<string, ReportGroup>): ReportGroup[] {
	// By magnitude, biggest first — the answer to "where did it go" is a ranking, not an alphabet.
	return Array.from(groups.values()).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

function bump(groups: Map<string, ReportGroup>, key: string, label: string, amount: number): void {
	const existing = groups.get(key);
	if (existing) {
		existing.count++;
		existing.total += amount;
		return;
	}
	groups.set(key, { key, label, count: 1, total: amount });
}

/**
 * Runs a query and returns the rows plus every total worth quoting about them.
 *
 * Totals are in the base currency: a report that summed a €40 dinner and a $60 one into "100" would
 * be quietly wrong, and the whole point of an expense report is a number you can rely on. Individual
 * rows keep their own currency for display — see `mixedCurrencies` for what couldn't be converted.
 */
export function runReport(source: ReportSource, query: ReportQuery): ReportResult {
	const categoryIds = expandCategoryIds(source.categories, query.categoryIds);
	const accountName = new Map(source.accounts.map((a) => [a.id, a.name]));

	const rows: Transaction[] = [];
	let spent = 0;
	let received = 0;
	let largest = 0;

	const byCategory = new Map<string, ReportGroup>();
	const byMonth = new Map<string, ReportGroup>();
	const byMerchant = new Map<string, ReportGroup>();
	const byAccount = new Map<string, ReportGroup>();
	const months = new Set<string>();

	const measure = query.measure ?? "economic";
	for (const tx of source.transactions) {
		if (!matchesQuery(tx, query, categoryIds, source)) continue;
		rows.push(tx);

		// A report row is a flow — convert at its own date (v1.2.7 Phase 3), not today's rate.
		const amount = convert(tx.amount, tx.currency, source.fx, tx.date);
		if (measure === "economic") {
			// A refund's affectsExpense is negative (it nets off the purchase it returned), so summing it
			// straight into `spent` alongside genuine expenses already nets correctly — no separate
			// "refund" bucket needed. A refund never has affectsIncome > 0, so it can never inflate
			// `received` either (FIN-002/FIN-005: raw-sign totals used to do both wrong).
			const classified = classifyTransaction(source, tx);
			if (classified.affectsExpense !== 0) {
				const expenseAmount = -amount;
				spent += expenseAmount;
				largest = Math.max(largest, expenseAmount);
			} else if (classified.affectsIncome > 0) {
				received += amount;
			}
		} else if (amount < 0) {
			spent += -amount;
			largest = Math.max(largest, -amount);
		} else {
			received += amount;
		}

		const chain = categoryChain(source.categories, tx.categoryId);
		const label = chain.primary
			? chain.secondary
				? `${chain.primary.name} › ${chain.secondary.name}`
				: chain.primary.name
			: "Uncategorized";
		bump(byCategory, tx.categoryId ?? UNCATEGORIZED, label, amount);

		const month = (tx.date || "").slice(0, 7);
		if (month) {
			months.add(month);
			bump(byMonth, month, month, amount);
		}

		const key = merchantKey(tx);
		bump(byMerchant, key ?? `__tx:${tx.id}`, key ? merchantLabel(key) : tx.description || "(no description)", amount);

		bump(byAccount, tx.accountId, accountName.get(tx.accountId) ?? tx.accountId, amount);
	}

	rows.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));

	return {
		rows,
		count: rows.length,
		spent,
		received,
		net: received - spent,
		largest,
		months: months.size,
		byCategory: sortGroups(byCategory),
		// Chronological, not ranked: a month breakdown is a trend, and sorting it by size destroys that.
		byMonth: Array.from(byMonth.values()).sort((a, b) => (a.key < b.key ? -1 : 1)),
		byMerchant: sortGroups(byMerchant),
		byAccount: sortGroups(byAccount),
		mixedCurrencies: unconvertibleCurrencies(rows, source.fx),
		baseCurrency: baseCurrencyOf(source.fx),
	};
}

/**
 * A short human name for what a query asked for — the report's own title, and the basis of the
 * exported filename. "Restaurants · 2025", "Car, Fuel · Mar–Aug 2025", "All spending · 2024".
 */
export function describeQuery(source: ReportSource, query: ReportQuery): string {
	const names: string[] = [];
	for (const id of query.categoryIds ?? []) {
		if (id === UNCATEGORIZED) {
			names.push("Uncategorized");
			continue;
		}
		const chain = categoryChain(source.categories, id);
		const name = chain.secondary?.name ?? chain.primary?.name;
		if (name) names.push(name);
	}

	const what =
		names.length > 0
			? names.join(", ")
			: query.direction === "in"
				? "All income"
				: query.direction === "out"
					? "All spending"
					: "All transactions";
	const when = describePeriod(query.from, query.to);
	return when ? `${what} · ${when}` : what;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthAbbr(date: string): string {
	const index = parseInt(date.slice(5, 7), 10) - 1;
	return index >= 0 && index < 12 ? MONTH_ABBR[index] : date.slice(5, 7);
}

/** "2025", "Mar 2025", "Mar–Aug 2025", "Nov 2024 – Mar 2025", "from 2025-03-01", "up to 2025-08-31". */
export function describePeriod(from: string | undefined, to: string | undefined): string {
	if (!from && !to) return "All time";
	if (from && !to) return `from ${from}`;
	if (!from && to) return `up to ${to}`;

	const fromYear = from!.slice(0, 4);
	const toYear = to!.slice(0, 4);
	const wholeYears = from!.endsWith("-01-01") && to!.endsWith("-12-31");
	if (wholeYears && fromYear === toYear) return fromYear;
	if (wholeYears) return `${fromYear}–${toYear}`;

	if (fromYear === toYear) {
		const fromMonth = monthAbbr(from!);
		const toMonth = monthAbbr(to!);
		return fromMonth === toMonth ? `${fromMonth} ${fromYear}` : `${fromMonth}–${toMonth} ${fromYear}`;
	}
	return `${monthAbbr(from!)} ${fromYear} – ${monthAbbr(to!)} ${toYear}`;
}

/** A filename-safe version of a report title. */
export function reportSlug(title: string): string {
	return (
		title
			.replace(/[·›]/g, "-")
			.replace(/[\\/:*?"<>|]+/g, " ")
			.replace(/\s+/g, " ")
			.trim() || "Report"
	);
}
