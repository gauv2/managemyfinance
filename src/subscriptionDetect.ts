import type { KpiStore } from "./kpi";
import {
	CYCLES_PER_YEAR,
	amountSpread,
	merchantKeysOverlap,
	normalizeMerchantKey,
	recurringSeries,
	type RecurringSeries,
} from "./recurring";
import type { Subscription, SubscriptionBillingCycle } from "./types";

/**
 * Flow E1 — "these look like subscriptions you aren't tracking".
 *
 * Every `Subscription` in the app today was typed in by hand, while the ledger has been sitting on the
 * evidence the whole time. This module reads the P6 series from recurring.ts and decides which of them
 * a user would actually recognise as a subscription.
 *
 * **Precision over recall, deliberately.** A false positive costs a dismissal click and, worse, teaches
 * the user that this panel is noise — after which they stop reading it and the true positives are lost
 * too. A miss costs nothing they didn't already have. Every threshold below is therefore tuned to
 * reject when unsure, and the one that does most of the work is amount stability: a supermarket is
 * every bit as regular in *time* as Netflix and nothing like it in *amount*.
 */

/** `recurring.ts`'s cycle vocabulary is the same union as `Subscription.billingCycle` — the candidate
 *  can be handed straight to the existing subscription wizard with no translation. */
export type DetectedCycle = SubscriptionBillingCycle;

export interface RecurringCandidate {
	/** Normalized grouping key — also the dismissal key, so "not a subscription" survives re-import. */
	merchantKey: string;
	/** Title-cased merchant. */
	displayName: string;
	/** Modal account of the group. */
	accountId: string;
	/** Most recent amount, absolute — what you'd actually be charged next, not a historical average. */
	cost: number;
	billingCycle: DetectedCycle;
	/** Last seen plus one cycle. */
	nextDueDate: string;
	occurrences: number;
	firstSeen: string;
	lastSeen: string;
	monthlyCost: number;
	confidence: "high" | "medium" | "low";
	sampleTransactionIds: string[];
}

/**
 * A subscription with Flow E3's optional ledger link. Stated structurally rather than relying on
 * `Subscription` alone so this module keeps working whether or not `merchantKey` is present on the
 * shared type — it reads the field when a record carries one and falls back to name matching when not.
 */
export type TrackedSubscription = Subscription & { merchantKey?: string };

export interface DetectOptions {
	/** Pre-computed P6 series — pass the dashboard's own so one render does the grouping once. */
	series?: RecurringSeries[];
	/** Amounts must sit within ±this of each other across the most recent charges. */
	maxAmountSpread?: number;
	/** Reject a series whose gaps wander more than this, relative to the median gap. */
	maxGapSpread?: number;
	/** Ignore charges below this — a €0.01 verification charge is regular but is not a subscription. */
	minCost?: number;
}

const DEFAULTS = {
	/** The spec's ±15%. Netflix moves 0% between charges and a few % on a price rise; a weekly grocery
	 *  run moves 40–200%, which is exactly what this number is here to throw away. */
	maxAmountSpread: 0.15,
	/** A subscription's billing date drifts by a day or two (weekends, month lengths) and no more. Above
	 *  ~25% of the cycle the "series" is really a habit — a weekly-ish coffee, not a standing charge. */
	maxGapSpread: 0.25,
	minCost: 1,
};

/** The most recent charges the ±15% stability test looks at. Three is the spec's number and it is the
 *  right one: two can't distinguish a stable price from a coincidence, and more than three punishes a
 *  legitimate price rise by dragging an old price into the window. */
const STABILITY_WINDOW = 3;

/**
 * Recurring payments in the ledger that are not already tracked as subscriptions and have not been
 * dismissed, most valuable first.
 *
 * `existing` and `dismissed` are both suppression inputs rather than post-filters, so a candidate that
 * a user has already answered "no" to never re-enters the ranking and never displaces a live one.
 */
export function detectRecurring(
	store: KpiStore,
	existing: TrackedSubscription[] = [],
	dismissed: string[] = [],
	opts: DetectOptions = {}
): RecurringCandidate[] {
	const maxAmountSpread = opts.maxAmountSpread ?? DEFAULTS.maxAmountSpread;
	const maxGapSpread = opts.maxGapSpread ?? DEFAULTS.maxGapSpread;
	const minCost = opts.minCost ?? DEFAULTS.minCost;

	const series = opts.series ?? recurringSeries(store);
	const dismissedKeys = new Set(dismissed.map((d) => normalizeMerchantKey(d) || d));

	const candidates: RecurringCandidate[] = [];
	for (const s of series) {
		// Money coming *in* on a schedule is a salary, not a subscription.
		if (s.direction !== "debit") continue;
		if (s.occurrences.length < 3) continue;
		// Three charges inside one month is a billing quirk or a retry storm, not a monthly commitment.
		if (s.distinctMonths < 2) continue;
		if (s.gapSpread > maxGapSpread) continue;

		const recent = s.occurrences.slice(-STABILITY_WINDOW).map((o) => Math.abs(o.amount));
		const spread = amountSpread(recent);
		if (spread > maxAmountSpread) continue;
		if (s.lastAmount < minCost) continue;

		if (dismissedKeys.has(s.key)) continue;
		if (isAlreadyTracked(s, existing)) continue;

		candidates.push({
			merchantKey: s.key,
			displayName: s.displayName,
			accountId: s.accountId,
			cost: s.lastAmount,
			billingCycle: s.cycle,
			nextDueDate: s.expectedNextDate,
			occurrences: s.occurrences.length,
			firstSeen: s.firstDate,
			lastSeen: s.lastDate,
			monthlyCost: (s.lastAmount * CYCLES_PER_YEAR[s.cycle]) / 12,
			confidence: confidenceOf(s, spread),
			// Newest first: when a user is deciding whether this is really a subscription, the charges
			// they might actually remember are the recent ones.
			sampleTransactionIds: s.occurrences.slice(-5).reverse().map((o) => o.id),
		});
	}

	return candidates.sort((a, b) => {
		const byCost = b.monthlyCost - a.monthlyCost;
		if (byCost !== 0) return byCost;
		return a.merchantKey < b.merchantKey ? -1 : a.merchantKey > b.merchantKey ? 1 : 0;
	});
}

/**
 * Whether a series is already covered by a hand-entered subscription. Two independent signals, because
 * neither alone is enough: the ledger's merchant text rarely matches the name a user typed ("NETFLIX.COM"
 * vs "Netflix"), and an account+amount match alone would suppress a second, genuinely different
 * subscription that happens to cost the same.
 */
function isAlreadyTracked(s: RecurringSeries, existing: TrackedSubscription[]): boolean {
	for (const sub of existing) {
		if (sub.archived) continue;

		if (merchantKeysOverlap(normalizeMerchantKey(sub.merchantKey ?? sub.name), s.key)) return true;

		if (sub.accountId && sub.accountId === s.accountId && Math.abs(sub.cost - s.lastAmount) <= Math.max(0.01, s.lastAmount * 0.05)) {
			return true;
		}
	}
	return false;
}

/**
 * How sure we are, as the product of three independent signals — how many times we've seen it, how
 * metronomic the timing is, how still the amount is. A product rather than a sum on purpose: a series
 * that is weak on any one axis should not be rescued by being strong on the other two.
 */
function confidenceOf(s: RecurringSeries, spread: number): "high" | "medium" | "low" {
	const occurrenceScore = s.occurrences.length >= 6 ? 1 : s.occurrences.length >= 4 ? 0.75 : 0.5;
	const regularityScore = s.gapSpread <= 0.05 ? 1 : s.gapSpread <= 0.12 ? 0.75 : 0.5;
	const stabilityScore = spread <= 0.02 ? 1 : spread <= 0.07 ? 0.75 : 0.5;

	const score = occurrenceScore * regularityScore * stabilityScore;
	if (score >= 0.55) return "high";
	if (score >= 0.28) return "medium";
	return "low";
}
