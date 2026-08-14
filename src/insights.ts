import { budgetForMonth } from "./budgets";
import { stableHash } from "./hash";
import type { KpiStore } from "./kpi";
import {
	CYCLES_PER_YEAR,
	CYCLE_MAX_DAYS,
	addDaysIso,
	addMonthsIso,
	amountSpread,
	daysBetweenIso,
	isTransferLike,
	mad,
	median,
	merchantKeysOverlap,
	merchantSourceText,
	normalizeMerchantKey,
	recurringSeries,
	todayIso,
	type RecurringSeries,
} from "./recurring";
import type { Category, Subscription, Transaction } from "./types";

/**
 * §2.7 — the insights feed.
 *
 * Everything here is a pure function over data the app already has; none of it needs a schema change,
 * a network call or a background job. The unifying idea is that the interesting facts in a ledger are
 * all *comparisons* — this charge against its own history, this month against the last three, what you
 * think you pay against what you're actually charged — and none of those comparisons is made anywhere
 * in the app today.
 *
 * Every insight carries an `impactEUR` so the feed can be ranked by money rather than by detector
 * order, and a deterministic `id` (a hash of kind + a stable natural key) so "dismiss" survives a
 * recompute, a re-import and a plugin reload. Ids deliberately fold in the *state* that made the
 * insight true — the charged amount, the month, the date last seen — so dismissing "Netflix went to
 * €12.99" doesn't also silence "Netflix went to €15.99" six months later.
 */

export type InsightSeverity = "high" | "medium" | "low";

export type InsightKind =
	| "recurring-price-drift"
	| "stale-subscription-cost"
	| "phantom-subscription"
	| "zombie-subscription"
	| "category-delta"
	| "duplicate-charge"
	| "category-outlier"
	| "budget-overrun"
	| "missing-income"
	| "uncategorized-backlog"
	| "stale-account";

/** Where a card sends the user. Structured rather than a URL string so the view layer routes with the
 *  app's own navigation (settings-encoded active view + ledger filter state) instead of parsing text. */
export type InsightDeepLink =
	| { type: "ledger"; accountId?: string; categoryId?: string; search?: string; dateFrom?: string; dateTo?: string; uncategorizedOnly?: boolean }
	| { type: "transaction"; transactionId: string }
	| { type: "subscription"; subscriptionId: string }
	| { type: "detected-subscription"; merchantKey: string }
	| { type: "budgets"; categoryId?: string; month?: string }
	| { type: "account"; accountId: string };

/**
 * One run of insight copy.
 *
 * The feed's strings interpolate merchant names and exact euro amounts, and a pre-formatted string
 * cannot carry the two hooks the rest of the app redacts on (`.fpih-money`, `.fpih-sensitive`) — which is
 * why privacy mode used to leave the five most prominent cards on the overview fully legible. Splitting
 * the copy into parts lets the view wrap each run in the right span while this module stays the single
 * owner of the wording.
 */
export interface InsightPart {
	text: string;
	/** A figure privacy mode must redact. */
	money?: boolean;
	/** Merchant, account or counterparty text — identifying, so redacted alongside money. */
	sensitive?: boolean;
}

export interface Insight {
	id: string;
	kind: InsightKind;
	severity: InsightSeverity;
	/** Always the exact concatenation of `titleParts`, and the fallback for any renderer that ignores them. */
	title: string;
	detail: string;
	/** Structured `title` — see InsightPart. Optional so an Insight built outside this module still compiles. */
	titleParts?: InsightPart[];
	/** Structured `detail` — see InsightPart. */
	detailParts?: InsightPart[];
	/** Annualized where the insight is about an ongoing commitment, one-off where it's about a single
	 *  event. Always a positive magnitude — direction lives in the copy. */
	impactEUR: number;
	deepLink: InsightDeepLink;
}

/** A flat "this category is allowed this much this month" view, which is all the budget detector
 *  needs. Deliberately structural rather than `Category[]`: a caller scoping to another month, or
 *  previewing a proposed budget set that isn't saved anywhere yet, can hand over plain numbers.
 *  See budgetsFromCategories for the default derived from the store. */
export interface BudgetsContext {
	categories: { id: string; name?: string; budget?: number }[];
	/** `YYYY-MM`; defaults to the month `today` falls in. */
	month?: string;
}

/**
 * The budget context a month's worth of categories implies, resolved through `budgetForMonth` so
 * per-month history and "breakdown" primaries (whose limit is the sum of their secondaries, not a
 * number stored on themselves) both read correctly rather than as an absent budget.
 */
export function budgetsFromCategories(categories: Category[], month: string): BudgetsContext {
	return {
		month,
		categories: categories.map((c) => ({ id: c.id, name: c.name, budget: budgetForMonth(categories, c, month) })),
	};
}

export interface InsightOptions {
	today?: Date;
	/** Ids the user has dismissed. */
	dismissed?: Iterable<string>;
	/** Pre-computed P6 series, so a render that already has them doesn't group the ledger twice. */
	series?: RecurringSeries[];
	/** Cap the ranked feed (the overview shows 5). */
	limit?: number;
}

// ---------- shared helpers ----------

const SEVERITY_RANK: Record<InsightSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Deterministic id from the insight kind plus whatever natural key makes this instance *this*
 *  instance. Reuses the ledger's own `stableHash` rather than adding a hashing dependency. */
function insightId(kind: InsightKind, ...key: (string | number)[]): string {
	return `ins-${stableHash([kind, ...key])}`;
}

/* Part builders. Deliberately terse — every insight below composes its copy out of them, and the flat
   `title`/`detail` strings are then `joinParts` of the same arrays, so the two can never drift apart. */

/** Plain copy: no figure, nothing identifying. */
function txt(text: string): InsightPart {
	return { text };
}

/** A money figure — redacted in privacy mode. */
function amt(text: string): InsightPart {
	return { text, money: true };
}

/** Merchant / account / counterparty text — redacted in privacy mode. */
function who(text: string): InsightPart {
	return { text, sensitive: true };
}

function joinParts(parts: InsightPart[]): string {
	return parts.map((part) => part.text).join("");
}

function eur(n: number): string {
	return `€${Math.abs(n).toLocaleString("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Whole euros — the right precision for "€180 above your average", where cents are noise. */
function eur0(n: number): string {
	return `€${Math.round(Math.abs(n)).toLocaleString("en-IE")}`;
}

function monthKeyOf(iso: string): string {
	return iso.slice(0, 7);
}

function shiftMonthKey(monthKey: string, delta: number): string {
	return monthKeyOf(addMonthsIso(`${monthKey}-01`, delta));
}

function daysInMonth(monthKey: string): number {
	const [y, m] = monthKey.split("-").map(Number);
	return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function lastDayOfMonth(monthKey: string): string {
	return `${monthKey}-${String(daysInMonth(monthKey)).padStart(2, "0")}`;
}

/**
 * How far through its month `today` is, as a fraction. This is the number that makes an early-month
 * comparison honest: €200 spent by the 3rd is not "€200 less than last month", it is a €2,000 pace.
 * A month that isn't the current one is complete by definition, so it elapses fully.
 */
function elapsedFraction(monthKey: string, today: string): number {
	if (monthKeyOf(today) !== monthKey) return today > monthKey ? 1 : 0;
	const day = Number(today.slice(8, 10));
	return day / daysInMonth(monthKey);
}

/** Before roughly the 5th of the month, dividing by the elapsed fraction amplifies a single grocery run
 *  into a €3,000 projection. Waiting a few days costs nothing and stops the feed being wrong every month.
 *  Shared by every detector that paces a partial month — `categoryDeltas` and `budgetOverruns` — because
 *  two different floors would mean the overview contradicts itself on the 2nd. */
const MIN_ELAPSED_FOR_PROJECTION = 0.15;

/** The `n` complete months ending at M-1 — never including the partial current month, which is what
 *  makes every "vs your average" comparison in this file a fair one. */
function completeMonths(today: string, n: number): string[] {
	const m0 = monthKeyOf(today);
	const out: string[] = [];
	for (let i = 1; i <= n; i++) out.push(shiftMonthKey(m0, -i));
	return out;
}

function isExpense(store: KpiStore, tx: Transaction): boolean {
	return tx.amount < 0 && !isTransferLike(store, tx);
}

/** Expense totals per category over an inclusive ISO date range. Uncategorized rows bucket under the
 *  same `"uncategorized"` key kpi.ts uses, so the two agree. */
function categorySpendRange(store: KpiStore, fromIso: string, toIso: string, accountId?: string): Map<string, number> {
	const totals = new Map<string, number>();
	for (const tx of store.transactions) {
		if (!tx.date || tx.date < fromIso || tx.date > toIso) continue;
		if (accountId && tx.accountId !== accountId) continue;
		if (!isExpense(store, tx)) continue;
		const key = tx.categoryId ?? "uncategorized";
		totals.set(key, (totals.get(key) ?? 0) + -tx.amount);
	}
	return totals;
}

function categorySpendMonth(store: KpiStore, monthKey: string): Map<string, number> {
	return categorySpendRange(store, `${monthKey}-01`, lastDayOfMonth(monthKey), undefined);
}

function categoryNameOf(store: KpiStore, categoryId: string): string {
	if (categoryId === "uncategorized") return "Uncategorized";
	return store.categories.find((c) => c.id === categoryId)?.name ?? "Uncategorized";
}

function latestTxDate(transactions: Transaction[], accountId?: string): string | undefined {
	let latest: string | undefined;
	for (const tx of transactions) {
		if (!tx.date) continue;
		if (accountId && tx.accountId !== accountId) continue;
		if (!latest || tx.date > latest) latest = tx.date;
	}
	return latest;
}

function earliestTxDate(transactions: Transaction[], accountId?: string): string | undefined {
	let earliest: string | undefined;
	for (const tx of transactions) {
		if (!tx.date) continue;
		if (accountId && tx.accountId !== accountId) continue;
		if (!earliest || tx.date < earliest) earliest = tx.date;
	}
	return earliest;
}

// ---------- MUST tier ----------

/**
 * A recurring charge whose most recent amount has moved away from its own recent history.
 *
 * Compared against the median of up to three *preceding* charges rather than against the whole series,
 * so a subscription that has risen twice is measured from its current price and not from what it cost
 * three years ago. Debits only: a salary increase is genuinely detectable here but is not something a
 * user needs a warning card about.
 */
export function recurringPriceDrift(series: RecurringSeries[]): Insight[] {
	const out: Insight[] = [];
	for (const s of series) {
		if (s.direction !== "debit") continue;
		if (s.occurrences.length < 3) continue;

		const previous = s.occurrences.slice(-4, -1).map((o) => Math.abs(o.amount));
		if (previous.length < 2) continue;
		const baseline = median(previous);
		if (baseline <= 0) continue;

		const delta = s.lastAmount - baseline;
		// Absolute floor and relative floor together: €0.50 stops VAT-rounding noise on a €5 service,
		// 2% stops a €3 fluctuation on a €200 charge from reading as a price rise.
		if (Math.abs(delta) <= Math.max(0.5, baseline * 0.02)) continue;

		const impactEUR = Math.abs(delta) * CYCLES_PER_YEAR[s.cycle];
		const titleParts = [who(s.displayName), txt(delta > 0 ? " went up to " : " went down to "), amt(eur(s.lastAmount))];
		const detailParts = [
			txt("Was "),
			amt(eur(baseline)),
			txt(` per ${s.cycle === "yearly" ? "year" : s.cycle.replace("ly", "")}, charged `),
			amt(eur(s.lastAmount)),
			txt(` on ${s.lastDate} — `),
			amt(eur0(impactEUR)),
			txt(`/year ${delta > 0 ? "more" : "less"}.`),
		];
		out.push({
			id: insightId("recurring-price-drift", s.key, s.lastDate, s.lastAmount.toFixed(2)),
			kind: "recurring-price-drift",
			severity: impactEUR >= 60 ? "high" : impactEUR >= 12 ? "medium" : "low",
			title: joinParts(titleParts),
			detail: joinParts(detailParts),
			titleParts,
			detailParts,
			impactEUR,
			deepLink: { type: "ledger", accountId: s.accountId, search: s.displayName },
		});
	}
	return out;
}

/**
 * A tracked subscription whose stored `cost` disagrees with what the ledger says you're actually
 * charged. The stored number was typed in once, months or years ago; the ledger is the truth. This is
 * the cheapest possible fix for C3 — the tracked total and the real total silently diverging.
 */
export function staleSubscriptionCost(subscriptions: Subscription[], series: RecurringSeries[]): Insight[] {
	const out: Insight[] = [];
	for (const sub of subscriptions) {
		if (sub.archived) continue;
		const match = matchSeries(sub, series);
		if (!match) continue;

		const delta = match.lastAmount - sub.cost;
		if (Math.abs(delta) <= 0.5) continue;

		const impactEUR = Math.abs(delta) * CYCLES_PER_YEAR[sub.billingCycle];
		const titleParts = [who(sub.name), txt(" costs "), amt(eur(match.lastAmount)), txt(", not "), amt(eur(sub.cost))];
		const detailParts = [
			txt("You track "),
			who(sub.name),
			txt(" at "),
			amt(eur(sub.cost)),
			txt(` but the last charge on ${match.lastDate} was `),
			amt(eur(match.lastAmount)),
			txt(" — "),
			amt(eur0(impactEUR)),
			txt(`/year ${delta > 0 ? "more" : "less"} than your subscription total says.`),
		];
		out.push({
			id: insightId("stale-subscription-cost", sub.id, match.lastAmount.toFixed(2)),
			kind: "stale-subscription-cost",
			severity: impactEUR >= 60 ? "high" : "medium",
			title: joinParts(titleParts),
			detail: joinParts(detailParts),
			titleParts,
			detailParts,
			impactEUR,
			deepLink: { type: "subscription", subscriptionId: sub.id },
		});
	}
	return out;
}

/**
 * A recurring charge that isn't in the subscription list at all.
 *
 * The amount-stability gate is not in §2.7's wording but is inherited deliberately from Flow E1: P6
 * groups a weekly supermarket run exactly as happily as it groups Netflix, and a feed that calls
 * "Albert Heijn" a phantom subscription is a feed users stop reading.
 */
export function phantomSubscriptions(subscriptions: Subscription[], series: RecurringSeries[]): Insight[] {
	const out: Insight[] = [];
	for (const s of series) {
		if (s.direction !== "debit") continue;
		if (s.occurrences.length < 3) continue;
		if (amountSpread(s.occurrences.slice(-3).map((o) => Math.abs(o.amount))) > 0.15) continue;
		if (subscriptions.some((sub) => !sub.archived && matchesSeries(sub, s))) continue;

		const impactEUR = s.lastAmount * CYCLES_PER_YEAR[s.cycle];
		const titleParts = [who(s.displayName), txt(" isn't in your subscriptions")];
		const detailParts = [
			amt(eur(s.lastAmount)),
			txt(` ${s.cycle}, ${s.occurrences.length} payments since ${s.firstDate} — `),
			amt(eur0(impactEUR)),
			txt("/year that your committed spend doesn't count."),
		];
		out.push({
			id: insightId("phantom-subscription", s.key, s.direction),
			kind: "phantom-subscription",
			severity: impactEUR >= 120 ? "high" : "medium",
			title: joinParts(titleParts),
			detail: joinParts(detailParts),
			titleParts,
			detailParts,
			impactEUR,
			deepLink: { type: "detected-subscription", merchantKey: s.key },
		});
	}
	return out;
}

/**
 * A subscription you're still tracking that has stopped appearing in the ledger.
 *
 * Two guards keep this from crying wolf, and both matter: the ledger has to be *current* (a user who
 * last imported in March would otherwise see every subscription flagged), and it has to span at least
 * one full billing cycle (a brand-new account has no charge history to be missing from).
 */
export function zombieSubscriptions(store: KpiStore, subscriptions: Subscription[], today: Date = new Date()): Insight[] {
	const now = todayIso(today);
	const out: Insight[] = [];

	for (const sub of subscriptions) {
		if (sub.archived) continue;
		if (sub.endDate && sub.endDate < now) continue;
		if (!sub.nextDueDate || sub.nextDueDate > now) continue; // nothing has come due yet

		const scope = sub.accountId;
		const ledgerEnd = latestTxDate(store.transactions, scope);
		const ledgerStart = earliestTxDate(store.transactions, scope);
		if (!ledgerEnd || !ledgerStart) continue;
		// A stale import is a stale import, not a cancelled subscription.
		if (daysBetweenIso(ledgerEnd, now) > 45) continue;

		const graceDays = CYCLE_MAX_DAYS[sub.billingCycle] + 10;
		if (daysBetweenIso(ledgerStart, now) < graceDays) continue;

		const subKey = normalizeMerchantKey(sub.name);
		let lastCharge: string | undefined;
		if (subKey) {
			for (const tx of store.transactions) {
				if (tx.amount >= 0 || !tx.date) continue;
				if (scope && tx.accountId !== scope) continue;
				const key = normalizeMerchantKey(merchantSourceText(tx));
				if (!merchantKeysOverlap(key, subKey)) continue;
				if (!lastCharge || tx.date > lastCharge) lastCharge = tx.date;
			}
		}
		if (lastCharge && daysBetweenIso(lastCharge, now) <= graceDays) continue;

		const impactEUR = (sub.cost * CYCLES_PER_YEAR[sub.billingCycle]);
		const titleParts = [txt("No charge seen for "), who(sub.name)];
		const detailParts = [
			txt(
				lastCharge
					? `Last charged ${lastCharge}, ${daysBetweenIso(lastCharge, now)} days ago, on a ${sub.billingCycle} cycle — cancelled, or paid from an untracked account? `
					: "No matching charge anywhere in this ledger — cancelled, or paid from an untracked account? "
			),
			amt(eur0(impactEUR)),
			txt("/year is riding on the answer."),
		];
		out.push({
			id: insightId("zombie-subscription", sub.id, lastCharge ?? "never"),
			kind: "zombie-subscription",
			severity: "medium",
			title: joinParts(titleParts),
			detail: joinParts(detailParts),
			titleParts,
			detailParts,
			impactEUR,
			deepLink: { type: "subscription", subscriptionId: sub.id },
		});
	}
	return out;
}

/**
 * The categories whose current-month spend has moved furthest from their own recent normal.
 *
 * Current-month spend is divided by the elapsed fraction of the month before comparison, so this reads
 * correctly on the 3rd as well as the 30th — the single fix that makes an early-month dashboard honest.
 * "Uncategorized" is excluded: it has its own, better-targeted insight, and a card telling you your
 * uncategorized spend is up isn't advice, it's a chore notification.
 *
 * Dividing by a tiny elapsed fraction is the same trap `budgetOverruns` guards against, and this
 * detector fell into it: one €100 grocery run on the 1st became "€3,100 this month at today's pace,
 * €2,800 above your average" — with an impactEUR of 2,800 it took the top slot of the five-card feed on
 * the 1st of every month. Same threshold, same reason.
 */
export function categoryDeltas(store: KpiStore, today: Date = new Date(), max = 3): Insight[] {
	const now = todayIso(today);
	const m0 = monthKeyOf(now);
	const elapsed = elapsedFraction(m0, now);
	if (elapsed < MIN_ELAPSED_FOR_PROJECTION) return [];

	const current = categorySpendMonth(store, m0);
	const priorMonths = completeMonths(now, 3).map((m) => categorySpendMonth(store, m));
	if (priorMonths.length === 0) return [];

	const categoryIds = new Set<string>(current.keys());
	for (const m of priorMonths) for (const id of m.keys()) categoryIds.add(id);

	const scored: { categoryId: string; delta: number; pace: number; priorMean: number }[] = [];
	for (const categoryId of categoryIds) {
		if (categoryId === "uncategorized") continue;
		const priorMean = priorMonths.reduce((sum, m) => sum + (m.get(categoryId) ?? 0), 0) / priorMonths.length;
		const pace = (current.get(categoryId) ?? 0) / elapsed;
		const delta = pace - priorMean;
		if (Math.abs(delta) < Math.max(25, priorMean * 0.25)) continue;
		scored.push({ categoryId, delta, pace, priorMean });
	}

	return scored
		.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
		.slice(0, max)
		.map(({ categoryId, delta, pace, priorMean }) => {
			const name = categoryNameOf(store, categoryId);
			const up = delta > 0;
			// The category name is the user's own label, not a merchant or an account, so it stays plain.
			const titleParts = [txt(`${name} `), amt(eur0(delta)), txt(` ${up ? "above" : "below"} your 3-month average`)];
			const detailParts = [
				amt(eur0(pace)),
				txt(" this month at today's pace against a "),
				amt(eur0(priorMean)),
				txt(" average over the last 3 complete months."),
			];
			return {
				id: insightId("category-delta", m0, categoryId),
				kind: "category-delta" as const,
				severity: up ? (Math.abs(delta) >= 200 ? "high" : "medium") : ("low" as InsightSeverity),
				title: joinParts(titleParts),
				detail: joinParts(detailParts),
				titleParts,
				detailParts,
				impactEUR: Math.abs(delta),
				deepLink: { type: "ledger" as const, categoryId, dateFrom: `${m0}-01`, dateTo: lastDayOfMonth(m0) },
			};
		});
}

/** Duplicate detection looks this far back. Older duplicates are still true but no longer actionable —
 *  no bank will reverse a double charge from 2019 — and they would otherwise outrank live insights. */
const DUPLICATE_WINDOW_DAYS = 90;

/**
 * The same merchant charging the same amount twice within three days on one account.
 *
 * The disambiguation that makes this usable: two charges that are *consecutive occurrences of a known
 * recurring series* are the subscription working, not a double charge. A weekly service whose billing
 * slipped — say a 2-day gap inside an otherwise 7-day rhythm — is precisely the false positive a naive
 * amount+proximity rule produces, and precisely what §2.7 says not to flag.
 */
export function duplicateCharges(store: KpiStore, series: RecurringSeries[] = [], today: Date = new Date()): Insight[] {
	const now = todayIso(today);
	const cutoff = addDaysIso(now, -DUPLICATE_WINDOW_DAYS);

	const knownPairs = consecutiveOccurrencePairs(series);

	const groups = new Map<string, Transaction[]>();
	for (const tx of store.transactions) {
		if (!tx.date || tx.date < cutoff || tx.date > now) continue;
		if (tx.amount >= 0 || Math.abs(tx.amount) < 5) continue;
		if (isTransferLike(store, tx)) continue;
		const key = normalizeMerchantKey(merchantSourceText(tx));
		if (!key) continue;
		const groupId = `${tx.accountId}|${key}`;
		const group = groups.get(groupId);
		if (group) group.push(tx);
		else groups.set(groupId, [tx]);
	}

	const out: Insight[] = [];
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const sorted = group.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));

		// Matching rows are unioned into clusters rather than emitted per pair. Three identical charges
		// produce the pairs (0,1), (0,2) and (1,2) — three cards, same merchant, same amount, same impact,
		// three of the five slots on the overview spent telling one fact three times. The union also keeps
		// the one-cent tolerance transitive (49.95/49.96/49.97 is one cluster, not two overlapping pairs).
		const parent = new Map<string, string>();
		for (const tx of sorted) parent.set(tx.id, tx.id);
		const find = (id: string): string => {
			let root = id;
			while (parent.get(root) !== root) root = parent.get(root)!;
			while (parent.get(id) !== root) {
				const next = parent.get(id)!;
				parent.set(id, root);
				id = next;
			}
			return root;
		};
		const union = (a: string, b: string): void => {
			const ra = find(a);
			const rb = find(b);
			if (ra !== rb) parent.set(rb, ra);
		};

		// Only forward within a 3-day window, so a merchant with hundreds of rows stays linear.
		for (let i = 0; i < sorted.length; i++) {
			for (let j = i + 1; j < sorted.length; j++) {
				const a = sorted[i];
				const b = sorted[j];
				if (daysBetweenIso(a.date, b.date) > 3) break;
				if (a.id === b.id) continue;
				if (Math.abs(Math.abs(a.amount) - Math.abs(b.amount)) > 0.011) continue;
				if (knownPairs.has(pairKey(a.id, b.id))) continue;
				union(a.id, b.id);
			}
		}

		const clusters = new Map<string, Transaction[]>();
		for (const tx of sorted) {
			const root = find(tx.id);
			const cluster = clusters.get(root);
			if (cluster) cluster.push(tx);
			else clusters.set(root, [tx]);
		}

		for (const cluster of clusters.values()) {
			if (cluster.length < 2) continue; // a row that matched nothing is its own singleton cluster
			const last = cluster[cluster.length - 1];
			const amount = Math.abs(last.amount);
			const times = cluster.length;
			const dates = cluster.map((tx) => tx.date);
			const dateText = `${dates.slice(0, -1).join(", ")} and ${dates[dates.length - 1]}`;
			// One extra charge per member beyond the first — the money actually at risk, and identical to
			// the old per-pair figure for the two-charge case.
			const impactEUR = amount * (times - 1);
			const titleParts = [
				amt(eur(amount)),
				txt(times === 2 ? " charged twice by " : ` charged ${times} times by `),
				who(merchantSourceText(last) || "the same merchant"),
			];
			const detailParts = [txt(`${dateText}, same account, same amount — worth checking before it's too late to dispute.`)];
			out.push({
				id: insightId("duplicate-charge", ...cluster.map((tx) => tx.id).sort()),
				kind: "duplicate-charge",
				severity: amount >= 50 ? "high" : "medium",
				title: joinParts(titleParts),
				detail: joinParts(detailParts),
				titleParts,
				detailParts,
				impactEUR,
				deepLink: { type: "transaction", transactionId: last.id },
			});
		}
	}
	return out;
}

// ---------- SHOULD tier ----------

/** Below this many trailing samples a "normal" for the category doesn't exist yet, and every larger
 *  purchase would read as an outlier. */
const OUTLIER_MIN_SAMPLES = 8;

/**
 * A single current-month expense far outside its category's own trailing-year distribution.
 *
 * Threshold is `median + 3 × MAD`, **not** `mean + 3 × stdev`: spending is fat-tailed, so a handful of
 * legitimately big months inflate a standard deviation past the point where it flags anything, while
 * the same data barely moves a median absolute deviation. A zero MAD (a category where every charge is
 * identical) is skipped rather than treated as infinite sensitivity.
 */
export function categoryOutliers(store: KpiStore, today: Date = new Date()): Insight[] {
	const now = todayIso(today);
	const m0 = monthKeyOf(now);
	const ttmFrom = `${shiftMonthKey(m0, -12)}-01`;
	const ttmTo = lastDayOfMonth(shiftMonthKey(m0, -1));

	const history = new Map<string, number[]>();
	for (const tx of store.transactions) {
		if (!tx.date || tx.date < ttmFrom || tx.date > ttmTo) continue;
		if (!isExpense(store, tx)) continue;
		const key = tx.categoryId ?? "uncategorized";
		const bucket = history.get(key);
		if (bucket) bucket.push(-tx.amount);
		else history.set(key, [-tx.amount]);
	}

	const out: Insight[] = [];
	for (const tx of store.transactions) {
		if (!tx.date || monthKeyOf(tx.date) !== m0) continue;
		if (!isExpense(store, tx)) continue;
		const amount = -tx.amount;
		if (amount < 50) continue;

		const key = tx.categoryId ?? "uncategorized";
		const samples = history.get(key);
		if (!samples || samples.length < OUTLIER_MIN_SAMPLES) continue;
		const centre = median(samples);
		const deviation = scaleOf(samples, centre);
		if (deviation <= 0) continue;
		if (amount <= centre + 3 * deviation) continue;

		const titleParts = [amt(eur(amount)), txt(` on ${categoryNameOf(store, key)} is unusual`)];
		const detailParts = [
			who(merchantSourceText(tx) || tx.description),
			txt(` on ${tx.date}. Your typical ${categoryNameOf(store, key)} charge over the last 12 months is `),
			amt(eur0(centre)),
			txt("."),
		];
		out.push({
			id: insightId("category-outlier", tx.id),
			kind: "category-outlier",
			severity: "medium",
			title: joinParts(titleParts),
			detail: joinParts(detailParts),
			titleParts,
			detailParts,
			impactEUR: amount - centre,
			deepLink: { type: "transaction", transactionId: tx.id },
		});
	}
	return out;
}

/**
 * A budgeted category on pace to finish the month over its limit. Pacing, not `spent/budget`, is what
 * separates a budget tool from a progress bar: 20% spent on the 3rd is a 200% month.
 */
export function budgetOverruns(store: KpiStore, budgets: BudgetsContext, today: Date = new Date()): Insight[] {
	const now = todayIso(today);
	const month = budgets.month ?? monthKeyOf(now);
	const elapsed = elapsedFraction(month, now);
	if (elapsed < MIN_ELAPSED_FOR_PROJECTION) return [];

	const spend = categorySpendMonth(store, month);
	const out: Insight[] = [];
	for (const category of budgets.categories) {
		const budget = category.budget ?? 0;
		if (budget <= 0) continue;
		const spent = spend.get(category.id) ?? 0;
		const projected = spent / elapsed;
		// The 10% cushion keeps a category that will land a hair over from generating a card every month.
		if (projected <= budget * 1.1) continue;

		const name = category.name ?? categoryNameOf(store, category.id);
		const titleParts = [txt(`${name} on pace for `), amt(eur0(projected)), txt(" against a "), amt(eur0(budget)), txt(" limit")];
		const detailParts = [amt(eur0(spent)), txt(` spent with ${Math.round((1 - elapsed) * 100)}% of the month left.`)];
		out.push({
			id: insightId("budget-overrun", month, category.id),
			kind: "budget-overrun",
			severity: projected > budget * 1.5 ? "high" : "medium",
			title: joinParts(titleParts),
			detail: joinParts(detailParts),
			titleParts,
			detailParts,
			impactEUR: projected - budget,
			deepLink: { type: "budgets", categoryId: category.id, month },
		});
	}
	return out;
}

/** A ledger this far behind describes the past, not the present — the same 45-day bar zombieSubscriptions
 *  uses, for the same reason. */
const STALE_LEDGER_DAYS = 45;

/**
 * The biggest regular incoming payment is late. Scoped to the largest monthly-cadence credit series
 * because that is a salary, and a salary that hasn't arrived is the one piece of news in this whole
 * file that a user wants *before* they check anything else.
 *
 * `store` is optional only so the exported signature stays compatible; pass it. Without it there is no
 * way to tell a genuinely missing salary from a ledger nobody has imported into since March, and a user
 * three months behind on imports gets a permanent high-severity "your salary hasn't arrived" pinned to
 * the top of the feed — the exact false alarm zombieSubscriptions already refuses to raise.
 */
export function missingIncome(series: RecurringSeries[], today: Date = new Date(), store?: KpiStore): Insight[] {
	const now = todayIso(today);
	let largest: RecurringSeries | undefined;
	for (const s of series) {
		if (s.direction !== "credit" || s.cycle !== "monthly") continue;
		if (!largest || s.medianAmount > largest.medianAmount) largest = s;
	}
	if (!largest) return [];

	if (store) {
		const ledgerEnd = latestTxDate(store.transactions);
		if (!ledgerEnd || daysBetweenIso(ledgerEnd, now) > STALE_LEDGER_DAYS) return [];
	}

	const daysLate = daysBetweenIso(largest.expectedNextDate, now);
	if (daysLate <= 5) return [];

	const titleParts = [who(largest.displayName), txt(" hasn't arrived")];
	const detailParts = [
		txt("Usually about "),
		amt(eur0(largest.medianAmount)),
		txt(` around the ${ordinal(Number(largest.lastDate.slice(8, 10)))} — expected ${largest.expectedNextDate}, ${daysLate} days ago.`),
	];
	return [
		{
			id: insightId("missing-income", largest.key, largest.expectedNextDate),
			kind: "missing-income",
			severity: "high",
			title: joinParts(titleParts),
			detail: joinParts(detailParts),
			titleParts,
			detailParts,
			impactEUR: largest.medianAmount,
			deepLink: { type: "ledger", accountId: largest.accountId, search: largest.displayName },
		},
	];
}

/** Above this share, every category number on every dashboard is a lower bound and nobody is told. */
const UNCATEGORIZED_WARN_SHARE = 0.15;

export function uncategorizedBacklog(store: KpiStore, today: Date = new Date()): Insight[] {
	const now = todayIso(today);
	const months = completeMonths(now, 3);
	if (months.length === 0) return [];
	const from = `${months[months.length - 1]}-01`;
	const to = lastDayOfMonth(months[0]);

	const spend = categorySpendRange(store, from, to);
	let total = 0;
	for (const value of spend.values()) total += value;
	if (total <= 0) return [];

	const uncategorized = spend.get("uncategorized") ?? 0;
	const share = uncategorized / total;
	if (share <= UNCATEGORIZED_WARN_SHARE) return [];

	const titleParts = [txt(`${Math.round(share * 100)}% of your recent spending is uncategorized`)];
	const detailParts = [
		amt(eur0(uncategorized)),
		txt(" of "),
		amt(eur0(total)),
		txt(" over the last 3 complete months has no category, so every category figure on your dashboards is a lower bound."),
	];
	return [
		{
			id: insightId("uncategorized-backlog", months[0]),
			kind: "uncategorized-backlog",
			severity: share > 0.3 ? "high" : "medium",
			title: joinParts(titleParts),
			detail: joinParts(detailParts),
			titleParts,
			detailParts,
			impactEUR: uncategorized,
			deepLink: { type: "ledger", uncategorizedOnly: true, dateFrom: from, dateTo: to },
		},
	];
}

/** An account that has gone quiet while the rest of the ledger kept moving is almost always a missed
 *  import, not a life change. */
const STALE_ACCOUNT_DAYS = 45;

export function staleAccounts(store: KpiStore, today: Date = new Date()): Insight[] {
	const now = todayIso(today);
	const storeLatest = latestTxDate(store.transactions);
	// If nothing anywhere is current, the whole ledger is behind — that's one message, not one per account.
	if (!storeLatest || daysBetweenIso(storeLatest, now) > STALE_ACCOUNT_DAYS) return [];

	const out: Insight[] = [];
	for (const account of store.accounts) {
		const latest = latestTxDate(store.transactions, account.id);
		if (!latest) continue; // never imported at all — not "stale", just empty
		const days = daysBetweenIso(latest, now);
		if (days <= STALE_ACCOUNT_DAYS) continue;

		const titleParts = [who(account.name), txt(" may need a re-import")];
		const detailParts = [txt(`No transactions since ${latest}, ${days} days ago, while your other accounts are current.`)];
		out.push({
			id: insightId("stale-account", account.id, latest),
			kind: "stale-account",
			severity: "low",
			// Impact is the activity you're *not* seeing — the account's own monthly expense average.
			title: joinParts(titleParts),
			detail: joinParts(detailParts),
			titleParts,
			detailParts,
			impactEUR: monthlyExpenseAverage(store, account.id),
			deepLink: { type: "account", accountId: account.id },
		});
	}
	return out;
}

// ---------- entry point ----------

/**
 * Every insight the store supports, dismissals removed, ranked by € impact.
 *
 * Ranking by money rather than by detector order is the whole point of `impactEUR`: with a five-card
 * cap on the overview, a €400/year price rise has to beat a €30 duplicate no matter which detector
 * happens to run first. Severity and id break ties so the order is stable across recomputes.
 */
export function computeInsights(
	store: KpiStore,
	subscriptions: Subscription[] = [],
	budgets?: BudgetsContext | null,
	opts: InsightOptions = {}
): Insight[] {
	const today = opts.today ?? new Date();
	const series = opts.series ?? recurringSeries(store);
	// A category's budget is kept per month (`budgetHistory`) and a "breakdown" primary holds no
	// number of its own, summing its secondaries instead — so the default context resolves each one
	// through budgetForMonth rather than reading a field off the category. A caller that passes its
	// own context (previewing a proposed set, or scoping to another month) bypasses this entirely.
	const budgetsCtx: BudgetsContext = budgets ?? budgetsFromCategories(store.categories, monthKeyOf(todayIso(today)));
	const dismissed = new Set(opts.dismissed ?? []);

	const all: Insight[] = [
		...recurringPriceDrift(series),
		...staleSubscriptionCost(subscriptions, series),
		...phantomSubscriptions(subscriptions, series),
		...zombieSubscriptions(store, subscriptions, today),
		...categoryDeltas(store, today),
		...duplicateCharges(store, series, today),
		...categoryOutliers(store, today),
		...budgetOverruns(store, budgetsCtx, today),
		...missingIncome(series, today, store),
		...uncategorizedBacklog(store, today),
		...staleAccounts(store, today),
	];

	const ranked = all
		.filter((insight) => !dismissed.has(insight.id))
		.sort((a, b) => {
			const byImpact = b.impactEUR - a.impactEUR;
			if (byImpact !== 0) return byImpact;
			const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
			if (bySeverity !== 0) return bySeverity;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});

	return opts.limit === undefined ? ranked : ranked.slice(0, Math.max(0, opts.limit));
}

// ---------- internals ----------

/**
 * The spread used as the outlier yardstick — MAD, with a fallback.
 *
 * MAD goes to exactly 0 whenever more than half the samples are identical, which is common in a tight
 * category (ten €20 charges and two holidays) and is precisely the distribution where an outlier is
 * most obvious. A 0 scale would make the threshold `median` and flag every charge above it, so the
 * `deviation <= 0` guard silences the detector on its best case. Falling back to the mean absolute
 * deviation restores a sensible scale there while never being reached for a genuinely varied category.
 * Only a category where every single charge is identical scores 0 on both, and that one is skipped.
 */
function scaleOf(samples: number[], centre: number): number {
	const robust = mad(samples);
	if (robust > 0) return robust;
	return samples.reduce((sum, value) => sum + Math.abs(value - centre), 0) / samples.length;
}

function ordinal(day: number): string {
	if (!Number.isFinite(day) || day <= 0) return "";
	const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
	return `${day}${suffix}`;
}

function matchesSeries(sub: Subscription, s: RecurringSeries): boolean {
	const subKey = normalizeMerchantKey((sub as Subscription & { merchantKey?: string }).merchantKey ?? sub.name);
	if (merchantKeysOverlap(subKey, s.key)) return true;
	return Boolean(sub.accountId && sub.accountId === s.accountId && Math.abs(sub.cost - s.lastAmount) <= Math.max(0.01, s.lastAmount * 0.05));
}

function matchSeries(sub: Subscription, series: RecurringSeries[]): RecurringSeries | undefined {
	return series.find((s) => s.direction === "debit" && matchesSeries(sub, s));
}

function pairKey(a: string, b: string): string {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Adjacent occurrences of a recurring series — the pairs duplicate detection must not flag. */
function consecutiveOccurrencePairs(series: RecurringSeries[]): Set<string> {
	const pairs = new Set<string>();
	for (const s of series) {
		for (let i = 1; i < s.occurrences.length; i++) {
			pairs.add(pairKey(s.occurrences[i - 1].id, s.occurrences[i].id));
		}
	}
	return pairs;
}

function monthlyExpenseAverage(store: KpiStore, accountId: string): number {
	const byMonth = new Map<string, number>();
	for (const tx of store.transactions) {
		if (tx.accountId !== accountId || !tx.date) continue;
		if (!isExpense(store, tx)) continue;
		const month = monthKeyOf(tx.date);
		byMonth.set(month, (byMonth.get(month) ?? 0) + -tx.amount);
	}
	if (byMonth.size === 0) return 0;
	let total = 0;
	for (const value of byMonth.values()) total += value;
	return total / byMonth.size;
}
