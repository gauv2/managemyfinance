import { convert } from "./currency";
import { formatMoney } from "./money";
import type { Subscription, SubscriptionBillingCycle, Transaction } from "./types";

export const SUBSCRIPTION_CATEGORIES = [
	"AI",
	"Streaming",
	"Software",
	"Cloud & Storage",
	"Gaming",
	"Music",
	"News & Media",
	"Health & Fitness",
	"Finance",
	"Utilities",
	"Entertainment",
	"Other",
];

export function subCurrency(sub: Pick<Subscription, "currency">): string {
	return sub.currency ?? "EUR";
}

/** A subscription's own cost in its own currency — totals across currencies go through the EUR
 *  conversion helpers below instead. Separator convention follows the vault's number-format setting. */
export function formatSubMoney(n: number, currency: string): string {
	return formatMoney(n, { currency });
}

export const BILLING_CYCLE_LABEL: Record<SubscriptionBillingCycle, string> = {
	weekly: "Weekly",
	monthly: "Monthly",
	quarterly: "Quarterly",
	yearly: "Yearly",
};

const MONTHLY_FACTOR: Record<SubscriptionBillingCycle, number> = {
	weekly: 52 / 12,
	monthly: 1,
	quarterly: 1 / 3,
	yearly: 1 / 12,
};

export function monthlyCost(sub: Subscription): number {
	return sub.cost * MONTHLY_FACTOR[sub.billingCycle];
}

export function yearlyCost(sub: Subscription): number {
	return monthlyCost(sub) * 12;
}

/**
 * The period a figure is *quoted* in, which is a separate question from `billingCycle`, the period it
 * is actually *charged* in. A quarterly subscription is billed four times a year and can still be
 * quoted per month or per year; conflating the two is why "monthly total" and "yearly total" used to
 * be the only two fixed numbers on the page.
 */
export type DisplayCycle = "monthly" | "yearly";

/** The Subscriptions page's setting: a fixed basis for everything, or let each subscription choose. */
export type SubscriptionViewMode = DisplayCycle | "per-subscription";

export const DISPLAY_CYCLE_SUFFIX: Record<DisplayCycle, string> = {
	monthly: "/mo",
	yearly: "/yr",
};

export const DISPLAY_CYCLE_LABEL: Record<DisplayCycle, string> = {
	monthly: "Per month",
	yearly: "Per year",
};

/** Which basis one subscription is quoted in: the page's, unless the page defers to each subscription. */
export function effectiveDisplayCycle(sub: Pick<Subscription, "displayCycle">, view: SubscriptionViewMode | undefined): DisplayCycle {
	if (view === "monthly" || view === "yearly") return view;
	return sub.displayCycle ?? "monthly";
}

/** Everything normalises through the monthly figure, so switching basis is exactly a factor of 12 —
 *  a yearly-billed subscription and a weekly one stay comparable in either. */
export function costForCycle(sub: Subscription, cycle: DisplayCycle): number {
	return cycle === "yearly" ? yearlyCost(sub) : monthlyCost(sub);
}

/** Scales an already-monthly aggregate (a total, a chart value) into the requested basis. */
export function scaleMonthly(monthlyAmount: number, cycle: DisplayCycle): number {
	return cycle === "yearly" ? monthlyAmount * 12 : monthlyAmount;
}

/** Manual, user-maintained rate table (Settings → Currency) — 1 unit of the key currency = that many EUR. No network calls, ever. */
export type ExchangeRates = Record<string, number>;

/** Converts an amount from `currency` into the app's base currency, at today's rate — a subscription's
 *  cost is a recurring current figure, not a dated flow, so there's no "as of" date to convert at.
 *  `baseCurrency` defaults to EUR, which is what every caller meant before it became a setting. Missing
 *  or invalid rates return NaN (see currency.ts's convert) rather than a plausible 1:1 passthrough. */
export function toBaseCurrency(amount: number, currency: string, rates: ExchangeRates | undefined, baseCurrency?: string): number {
	return convert(amount, currency, { baseCurrency, rates });
}

/** monthlyCost(), converted into EUR for cross-currency aggregation — use this for totals/comparisons, monthlyCost() for a subscription's own display. */
export function monthlyCostInBase(sub: Subscription, rates: ExchangeRates | undefined): number {
	return toBaseCurrency(monthlyCost(sub), subCurrency(sub), rates);
}

function isoDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function addCycle(date: Date, cycle: SubscriptionBillingCycle): Date {
	const d = new Date(date);
	switch (cycle) {
		case "weekly":
			d.setDate(d.getDate() + 7);
			break;
		case "monthly":
			d.setMonth(d.getMonth() + 1);
			break;
		case "quarterly":
			d.setMonth(d.getMonth() + 3);
			break;
		case "yearly":
			d.setFullYear(d.getFullYear() + 1);
			break;
	}
	return d;
}

/**
 * The next payment date on or after `today`, rolling `nextDueDate` forward by whole billing
 * cycles — so a subscription's stored anchor date doesn't need editing after every payment.
 * Returns undefined once that roll-forward would land past `endDate` (the subscription has lapsed).
 */
export function nextOccurrence(sub: Subscription, today: Date = new Date()): string | undefined {
	if (!sub.nextDueDate) return undefined;
	const todayIso = isoDate(today);
	let d = new Date(`${sub.nextDueDate}T00:00:00`);
	if (isNaN(d.getTime())) return undefined;

	let guard = 0;
	while (isoDate(d) < todayIso && guard < 2000) {
		d = addCycle(d, sub.billingCycle);
		guard++;
	}
	const occurrence = isoDate(d);
	if (sub.endDate && occurrence > sub.endDate) return undefined;
	return occurrence;
}

export function isActive(sub: Subscription, today: Date = new Date()): boolean {
	if (sub.archived) return false;
	if (sub.endDate && sub.endDate < isoDate(today)) return false;
	return true;
}

export function daysUntil(dateStr: string, today: Date = new Date()): number {
	const target = new Date(`${dateStr}T00:00:00`);
	const t0 = new Date(`${isoDate(today)}T00:00:00`);
	return Math.round((target.getTime() - t0.getTime()) / 86400000);
}

export interface SubscriptionTotals {
	perMonth: number;
	perYear: number;
	privatePerMonth: number;
	businessPerMonth: number;
	activeCount: number;
	dueSoonCount: number;
}

/** `dueSoonDays` window uses each subscription's rolled-forward next occurrence, not the stored anchor date. */
export function subscriptionTotals(
	subs: Subscription[],
	rates: ExchangeRates | undefined,
	today: Date = new Date(),
	dueSoonDays = 7
): SubscriptionTotals {
	const active = subs.filter((s) => isActive(s, today));
	const perMonth = active.reduce((sum, s) => sum + monthlyCostInBase(s, rates), 0);
	const dueSoonCount = active.filter((s) => {
		const next = nextOccurrence(s, today);
		if (!next) return false;
		const d = daysUntil(next, today);
		return d >= 0 && d <= dueSoonDays;
	}).length;

	return {
		perMonth,
		perYear: perMonth * 12,
		privatePerMonth: active.filter((s) => s.paidVia === "private").reduce((sum, s) => sum + monthlyCostInBase(s, rates), 0),
		businessPerMonth: active.filter((s) => s.paidVia === "business").reduce((sum, s) => sum + monthlyCostInBase(s, rates), 0),
		activeCount: active.length,
		dueSoonCount,
	};
}

export function totalsByCategory(
	subs: Subscription[],
	rates: ExchangeRates | undefined,
	today: Date = new Date()
): { label: string; value: number }[] {
	const totals = new Map<string, number>();
	for (const s of subs.filter((s) => isActive(s, today))) {
		totals.set(s.category, (totals.get(s.category) ?? 0) + monthlyCostInBase(s, rates));
	}
	return Array.from(totals.entries())
		.map(([label, value]) => ({ label, value }))
		.sort((a, b) => b.value - a.value);
}

export function totalsByBillingCycle(
	subs: Subscription[],
	rates: ExchangeRates | undefined,
	today: Date = new Date()
): { label: string; value: number }[] {
	const totals = new Map<SubscriptionBillingCycle, number>();
	for (const s of subs.filter((s) => isActive(s, today))) {
		totals.set(s.billingCycle, (totals.get(s.billingCycle) ?? 0) + monthlyCostInBase(s, rates));
	}
	return Array.from(totals.entries())
		.map(([cycle, value]) => ({ label: BILLING_CYCLE_LABEL[cycle], value }))
		.sort((a, b) => b.value - a.value);
}

export function totalsByPaidVia(
	subs: Subscription[],
	rates: ExchangeRates | undefined,
	today: Date = new Date()
): { label: string; value: number }[] {
	const active = subs.filter((s) => isActive(s, today));
	return [
		{ label: "Private", value: active.filter((s) => s.paidVia === "private").reduce((sum, s) => sum + monthlyCostInBase(s, rates), 0) },
		{ label: "Business", value: active.filter((s) => s.paidVia === "business").reduce((sum, s) => sum + monthlyCostInBase(s, rates), 0) },
	];
}

/** Every active subscription's next payment, soonest first — the feed behind "Upcoming payments". */
export function upcomingPayments(subs: Subscription[], today: Date = new Date()): { sub: Subscription; date: string; daysUntil: number }[] {
	return subs
		.filter((s) => isActive(s, today))
		.map((sub) => {
			const date = nextOccurrence(sub, today);
			return date ? { sub, date, daysUntil: daysUntil(date, today) } : undefined;
		})
		.filter((x): x is { sub: Subscription; date: string; daysUntil: number } => x !== undefined)
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Subscriptions ↔ the ledger
//
// A subscription tracker that never meets the transactions is a list of what you *think* you pay.
// Linking the two closes that gap: what actually left the account, whether a price quietly went up,
// and which recurring payments you're not tracking at all.
// ---------------------------------------------------------------------------

/** Searchable text for a transaction — the same pairing rules and merchant matching use. */
function matchText(tx: Transaction): string {
	return `${tx.description ?? ""} ${tx.counterparty ?? ""}`.toLowerCase();
}

/**
 * The text a subscription recognizes its own payments by. A match pattern set when you first linked a
 * payment is the reliable signal; the subscription's name is a reasonable fallback, since "Netflix"
 * really does appear in a Netflix charge.
 */
export function subscriptionPattern(sub: Subscription): string {
	return (sub.matchPattern || sub.name || "").trim().toLowerCase();
}

/** Whether a transaction looks like a payment for this subscription (ignoring any explicit link). */
export function looksLikePaymentFor(tx: Transaction, sub: Subscription): boolean {
	if (tx.amount >= 0) return false;
	const pattern = subscriptionPattern(sub);
	if (!pattern) return false;
	return matchText(tx).includes(pattern);
}

export interface SubscriptionPayment {
	transaction: Transaction;
	/** Positive magnitude actually paid, in the transaction's own currency. */
	amount: number;
	date: string;
}

/**
 * Payments explicitly linked to this subscription, newest first.
 *
 * Only explicit links count here, never a text match: what a subscription *has cost you* is a claim
 * that shouldn't rest on a substring. Text matching's job is to suggest links (see
 * `suggestPaymentsFor`), and confirming one is what makes it real.
 */
export function paymentsFor(transactions: Transaction[], sub: Subscription): SubscriptionPayment[] {
	return transactions
		.filter((tx) => tx.subscriptionId === sub.id)
		.map((tx) => ({ transaction: tx, amount: Math.abs(tx.amount), date: tx.date }))
		.sort((a, b) => b.date.localeCompare(a.date));
}

/** Unlinked transactions that look like they belong to this subscription — the "map records" candidates. */
export function suggestPaymentsFor(transactions: Transaction[], sub: Subscription, limit = 50): Transaction[] {
	return transactions
		.filter((tx) => !tx.subscriptionId && looksLikePaymentFor(tx, sub))
		.sort((a, b) => b.date.localeCompare(a.date))
		.slice(0, limit);
}

export interface SubscriptionSpend {
	/** Total actually paid, summed in base currency. */
	total: number;
	count: number;
	firstDate?: string;
	lastDate?: string;
	/** Most recent payment amount, for comparing against what the subscription claims to cost. */
	lastAmount?: number;
	/** Mean payment — a fairer "what does this really cost" than the last one alone. */
	average: number;
}

export function spendOn(transactions: Transaction[], sub: Subscription, rates?: ExchangeRates, baseCurrency?: string): SubscriptionSpend {
	const payments = paymentsFor(transactions, sub);
	if (payments.length === 0) return { total: 0, count: 0, average: 0 };
	const total = payments.reduce((sum, p) => sum + toBaseCurrency(p.amount, p.transaction.currency || "EUR", rates, baseCurrency), 0);
	return {
		total,
		count: payments.length,
		firstDate: payments[payments.length - 1].date,
		lastDate: payments[0].date,
		lastAmount: payments[0].amount,
		average: total / payments.length,
	};
}

export interface PriceChange {
	from: number;
	to: number;
	/** Fraction: 0.2 is a 20% rise. Negative for a price cut. */
	delta: number;
	date: string;
}

/**
 * Price changes across a subscription's linked payments, oldest first.
 *
 * Only changes above `tolerance` count, because real charges wobble for reasons that aren't price
 * rises: a foreign-currency subscription moves with the exchange rate every month, and VAT rounding
 * shifts the odd cent. A 1% floor keeps the answer to "did this get more expensive" honest.
 */
export function priceChanges(transactions: Transaction[], sub: Subscription, tolerance = 0.01): PriceChange[] {
	const payments = paymentsFor(transactions, sub).slice().reverse();
	const changes: PriceChange[] = [];
	for (let i = 1; i < payments.length; i++) {
		const from = payments[i - 1].amount;
		const to = payments[i].amount;
		if (from <= 0) continue;
		const delta = (to - from) / from;
		if (Math.abs(delta) < tolerance) continue;
		changes.push({ from, to, delta, date: payments[i].date });
	}
	return changes;
}

/** The latest price rise, if the most recent change was one — what a "price went up" badge needs. */
export function latestPriceIncrease(transactions: Transaction[], sub: Subscription, tolerance = 0.01): PriceChange | undefined {
	const changes = priceChanges(transactions, sub, tolerance);
	const last = changes[changes.length - 1];
	return last && last.delta > 0 ? last : undefined;
}

export interface RecurringCandidate {
	/** The merchant text the run was grouped by. */
	key: string;
	label: string;
	occurrences: number;
	/** Typical (median) amount, positive magnitude. */
	amount: number;
	currency: string;
	/** Median gap between payments, in days — what the billing cycle is inferred from. */
	medianGapDays: number;
	billingCycle: SubscriptionBillingCycle;
	lastDate: string;
	accountId: string;
	transactionIds: string[];
}

const CYCLE_BY_GAP: [number, number, SubscriptionBillingCycle][] = [
	[5, 10, "weekly"],
	[25, 38, "monthly"],
	[80, 100, "quarterly"],
	[330, 400, "yearly"],
];

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function dayNumber(date: string): number {
	const ms = Date.parse(`${(date || "").slice(0, 10)}T00:00:00Z`);
	return isNaN(ms) ? 0 : Math.round(ms / 86_400_000);
}

/** Normalizes a merchant string enough to group repeat charges that carry a varying reference number. */
function groupKey(tx: Transaction): string {
	const raw = (tx.counterparty || tx.description || "").toLowerCase();
	return raw
		.replace(/\d{4,}/g, " ")
		.replace(/[^a-z ]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 28);
}

/**
 * Recurring payments in the ledger that aren't tracked as subscriptions yet.
 *
 * The test for "recurring" is regular spacing, not merely repeated: a supermarket you visit three
 * times a week is repetitive and is not a subscription, whereas three charges 30 days apart almost
 * always are. Grouping by merchant, then requiring both a consistent gap and a stable amount, is what
 * separates the two — and it's why the gap has to fall inside one of the known billing cycles rather
 * than just being "roughly even".
 */
export function detectRecurring(
	transactions: Transaction[],
	subs: Subscription[],
	opts: { minOccurrences?: number; amountTolerance?: number } = {}
): RecurringCandidate[] {
	const minOccurrences = opts.minOccurrences ?? 3;
	const amountTolerance = opts.amountTolerance ?? 0.15;
	const alreadyTracked = subs.map((s) => subscriptionPattern(s)).filter(Boolean);

	const groups = new Map<string, Transaction[]>();
	for (const tx of transactions) {
		if (tx.amount >= 0 || tx.subscriptionId) continue;
		const key = groupKey(tx);
		if (key.length < 3) continue;
		const bucket = groups.get(key);
		if (bucket) bucket.push(tx);
		else groups.set(key, [tx]);
	}

	const out: RecurringCandidate[] = [];
	for (const [key, group] of groups) {
		if (group.length < minOccurrences) continue;
		if (alreadyTracked.some((pattern) => key.includes(pattern) || pattern.includes(key))) continue;

		const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
		const gaps: number[] = [];
		for (let i = 1; i < sorted.length; i++) gaps.push(dayNumber(sorted[i].date) - dayNumber(sorted[i - 1].date));
		const medianGapDays = median(gaps);
		const cycle = CYCLE_BY_GAP.find(([min, max]) => medianGapDays >= min && medianGapDays <= max)?.[2];
		if (!cycle) continue;

		// Every gap has to look like the same cycle, or a merchant you happen to pay at irregular
		// intervals sneaks in on the strength of its median alone.
		const [minGap, maxGap] = CYCLE_BY_GAP.find(([, , c]) => c === cycle)!;
		if (!gaps.every((gap) => gap >= minGap * 0.6 && gap <= maxGap * 1.4)) continue;

		const amounts = sorted.map((tx) => Math.abs(tx.amount));
		const typical = median(amounts);
		if (typical <= 0) continue;
		// A charge that swings wildly month to month is a bill, not a subscription — the amounts have
		// to be recognizably the same payment. (A price rise is a step change, and survives this.)
		const withinTolerance = amounts.filter((a) => Math.abs(a - typical) / typical <= amountTolerance).length;
		if (withinTolerance < Math.ceil(amounts.length * 0.6)) continue;

		const last = sorted[sorted.length - 1];
		out.push({
			key,
			label: (last.counterparty || last.description || key).trim(),
			occurrences: sorted.length,
			amount: typical,
			currency: last.currency || "EUR",
			medianGapDays,
			billingCycle: cycle,
			lastDate: last.date,
			accountId: last.accountId,
			transactionIds: sorted.map((tx) => tx.id),
		});
	}

	return out.sort((a, b) => b.amount * b.occurrences - a.amount * a.occurrences);
}
