import type { Subscription, SubscriptionBillingCycle } from "./types";

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
	"Other",
];

export function subCurrency(sub: Pick<Subscription, "currency">): string {
	return sub.currency ?? "EUR";
}

export function formatMoney(n: number, currency: string): string {
	return new Intl.NumberFormat("en-IE", { style: "currency", currency }).format(n);
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

/** Manual, user-maintained rate table (Settings → Currency) — 1 unit of the key currency = that many EUR. No network calls, ever. */
export type ExchangeRates = Record<string, number>;

/** Converts an amount from `currency` into the app's base currency (EUR). Missing/invalid rates pass through unconverted (1:1), same as before rates existed. */
export function toBaseCurrency(amount: number, currency: string, rates: ExchangeRates | undefined): number {
	if (currency === "EUR") return amount;
	const rate = rates?.[currency];
	return rate && rate > 0 ? amount * rate : amount;
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
