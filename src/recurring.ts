import type { KpiStore } from "./kpi";
import type { Transaction } from "./types";

/**
 * P6 — recurring-series detection over the raw ledger.
 *
 * The app's second universe (hand-entered `Subscription` records) never touches the first (imported
 * transactions), so a price rise, a phantom charge or a cancelled-but-still-billing service is
 * invisible today. Everything needed to see them is already in the ledger: a counterparty, an amount
 * and a date. This module turns those three fields into series — "this merchant charges you roughly
 * this much, roughly this often" — and four separate features (subscription detection, price drift,
 * phantom/zombie subscriptions, next-paycheck prediction) all read from it rather than each
 * re-deriving their own grouping.
 *
 * Pure: no Obsidian imports, no `Date.now()` except where a caller explicitly declines to pass a
 * reference date. Every date is an ISO `YYYY-MM-DD` string and all arithmetic runs in UTC, so a
 * series spanning a DST boundary doesn't gain or lose a day and drift out of its cycle band.
 */

export type RecurringCycle = "weekly" | "monthly" | "quarterly" | "yearly";
/** Money leaving (a charge) vs money arriving (salary, refunds). Never mixed into one series — a €50
 *  refund from a merchant you pay €10/month to would poison both the median amount and the gaps. */
export type RecurringDirection = "debit" | "credit";

/** Charges per year for each cycle — the multiplier that turns a per-charge delta into an annual €
 *  impact. Deliberately the single place cycle arithmetic lives; equals subscriptions.ts's
 *  MONTHLY_FACTOR × 12 exactly, so a detected candidate and a hand-entered subscription that agree on
 *  cost also agree on monthly cost. */
export const CYCLES_PER_YEAR: Record<RecurringCycle, number> = {
	weekly: 52,
	monthly: 12,
	quarterly: 4,
	yearly: 1,
};

/** Generous upper bound on a cycle's length in days — used for "how long before I call it missing?"
 *  windows, where over-waiting costs nothing and under-waiting cries wolf every February. */
export const CYCLE_MAX_DAYS: Record<RecurringCycle, number> = {
	weekly: 7,
	monthly: 31,
	quarterly: 92,
	yearly: 366,
};

/**
 * Median-gap bands from the spec. Deliberately wide enough to absorb the real world — a "monthly"
 * subscription billed on the 1st has 28–31 day gaps, a card processor that skips weekends shifts a
 * charge by two days — and narrow enough that a fortnightly pattern (14d) or a twice-monthly one
 * (15d) falls through rather than being mislabelled monthly.
 */
const CYCLE_BANDS: { cycle: RecurringCycle; min: number; max: number }[] = [
	{ cycle: "weekly", min: 6, max: 8 },
	{ cycle: "monthly", min: 26, max: 35 },
	{ cycle: "quarterly", min: 85, max: 95 },
	{ cycle: "yearly", min: 350, max: 380 },
];

// ---------- UTC date arithmetic ----------

/** Milliseconds for an ISO `YYYY-MM-DD` at UTC midnight, or undefined for anything unparseable.
 *  Parsing the parts by hand (rather than `new Date(str)`) keeps a bare date out of local-time
 *  interpretation, which is where the off-by-one-day DST bugs come from. */
export function parseIsoUtc(iso: string | undefined): number | undefined {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
	if (!m) return undefined;
	const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return isNaN(ms) ? undefined : ms;
}

function isoOf(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` — positive when `to` is later. Returns 0 for unparseable input so a
 *  malformed ledger row degrades to "same day" instead of poisoning a median with NaN. */
export function daysBetweenIso(from: string, to: string): number {
	const a = parseIsoUtc(from);
	const b = parseIsoUtc(to);
	if (a === undefined || b === undefined) return 0;
	return Math.round((b - a) / 86400000);
}

export function addDaysIso(iso: string, days: number): string {
	const ms = parseIsoUtc(iso);
	if (ms === undefined) return iso;
	return isoOf(ms + days * 86400000);
}

/** Calendar-month arithmetic with end-of-month clamping: 31 Jan + 1 month is 28 Feb, not 3 March.
 *  A subscription anchored on the 31st otherwise walks forward through the year. */
export function addMonthsIso(iso: string, months: number): string {
	const ms = parseIsoUtc(iso);
	if (ms === undefined) return iso;
	const d = new Date(ms);
	const year = d.getUTCFullYear();
	const month = d.getUTCMonth();
	const day = d.getUTCDate();
	const lastDayOfTarget = new Date(Date.UTC(year, month + months + 1, 0)).getUTCDate();
	return isoOf(Date.UTC(year, month + months, Math.min(day, lastDayOfTarget)));
}

/** One cycle forward from `iso`. Weekly is a fixed 7 days; everything else is calendar-based, because
 *  a "monthly" charge follows the calendar, not a 30-day timer. */
export function addCycleIso(iso: string, cycle: RecurringCycle): string {
	switch (cycle) {
		case "weekly":
			return addDaysIso(iso, 7);
		case "monthly":
			return addMonthsIso(iso, 1);
		case "quarterly":
			return addMonthsIso(iso, 3);
		case "yearly":
			return addMonthsIso(iso, 12);
	}
}

/** The user's *calendar* day as an ISO string. "Today" is a local-calendar concept even though every
 *  subsequent computation runs in UTC — reading the local components here and staying in UTC after is
 *  what keeps both true at once. */
export function todayIso(today: Date = new Date()): string {
	return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

// ---------- statistics ----------

/** Median of an unsorted array; 0 for an empty one. Even-length medians average the two middle values,
 *  which is standard and matters for gap bands (gaps of 6 and 8 must read as a 7-day cycle). */
export function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = values.slice().sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation — the fat-tail-safe alternative to standard deviation. Spending
 *  distributions have a long right tail (one holiday, one laptop), and a stdev computed over them is
 *  dragged up by the very outliers it's meant to find, so ±3σ flags nothing while ±3·MAD flags the
 *  genuinely unusual. */
export function mad(values: number[]): number {
	if (values.length === 0) return 0;
	const m = median(values);
	return median(values.map((v) => Math.abs(v - m)));
}

/** Relative spread of a set of amounts: `max/min − 1`. 0 means every amount is identical; 0.15 is the
 *  spec's stability threshold. Returns Infinity when a zero or negative amount makes the ratio
 *  meaningless, so callers reject rather than divide by zero. */
export function amountSpread(amounts: number[]): number {
	if (amounts.length === 0) return Infinity;
	let min = Infinity;
	let max = -Infinity;
	for (const a of amounts) {
		if (a <= 0) return Infinity;
		if (a < min) min = a;
		if (a > max) max = a;
	}
	return max / min - 1;
}

// ---------- merchant normalization ----------

/**
 * Payment processors prefix the real merchant with their own name and a star — "SUMUP *CAFE DE
 * SPORT", "PAYPAL *NETFLIX". Stripping the prefix groups the months a merchant was billed through a
 * processor with the months it wasn't, which is exactly the discontinuity that breaks a series.
 */
const PROCESSOR_PREFIX = /^[a-z0-9][a-z0-9.\- ]{0,14}\*+\s*/;

/**
 * The grouping key for a counterparty. Lowercased, de-accented, punctuation flattened, and store /
 * reference numbers dropped, so "ALBERT HEIJN 1234", "Albert Heijn 5567" and "albert heijn" all land
 * in one series.
 *
 * Exported because three consumers need to agree on it exactly: series grouping here, suppression of
 * already-tracked subscriptions in subscriptionDetect.ts, and duplicate-charge pairing in
 * insights.ts. A private copy in any one of them would silently split groups.
 */
export function normalizeMerchantKey(raw: string | undefined): string {
	const lowered = (raw ?? "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.trim();
	if (!lowered) return "";

	const withoutProcessor = lowered.replace(PROCESSOR_PREFIX, "") || lowered;
	const flattened = withoutProcessor.replace(/[^a-z0-9]+/g, " ").trim();
	const tokens = flattened.split(" ").filter(Boolean);

	const kept = tokens.filter((token, i) => {
		if (!/^\d+$/.test(token)) return true;
		// A bare run of 3+ digits is a branch/reference number wherever it appears ("albert heijn 1234"),
		// and a short one is noise only when it trails ("shop 7") — leading digits are often the brand
		// itself ("7 eleven", "24 fitness"), so those stay.
		return !(token.length >= 3 || i === tokens.length - 1);
	});

	// Falling back matters: a counterparty that is *nothing but* digits must not normalize to "" and
	// collapse every such merchant into one bogus mega-series.
	return kept.join(" ").trim() || flattened || lowered;
}

/** The text a transaction is grouped on — the bank's counterparty when it recorded one, the free-text
 *  description otherwise. Mirrors the `groupKey` idiom already used by categorization.ts. */
export function merchantSourceText(tx: Transaction): string {
	return tx.counterparty?.trim() || tx.description?.trim() || "";
}

/** Title-cases bank text, which arrives SHOUTING far more often than not. Mixed-case words are left
 *  alone so a merchant that already styles itself "eBay" or "iCloud" isn't mangled into "Ebay". */
function titleCase(raw: string): string {
	return raw
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => {
			const isUniformCase = word === word.toUpperCase() || word === word.toLowerCase();
			if (!isUniformCase) return word;
			return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
		})
		.join(" ");
}

// ---------- transfer filtering ----------

/** Same vocabulary as kpi.ts's private `isTransfer`. Duplicated rather than imported on purpose: that
 *  helper is module-private there, and a recurring "transfer" between your own accounts is a
 *  bookkeeping artefact, not a merchant relationship — a standing order into savings would otherwise
 *  be detected as a subscription. Callers that have a better classifier can inject one. */
const TRANSFER_CATEGORY_NAMES = new Set(["transfers", "savings", "savings & transfers"]);
const TRANSFER_ACCOUNT_MARKERS = new Set(["deposit", "withdraw", "withdrawal"]);

/**
 * Id lookups for the two arrays `isTransferLike` consults, cached by array identity + length.
 *
 * This classifier runs once per transaction from `recurringSeries` and again from every insight
 * detector, and a linear `find` over categories *and* accounts inside that loop is the one hot spot in
 * detection — hundreds of thousands of comparisons on a 10k-row ledger, on every render. The map holds
 * the live objects rather than copies, so a renamed category takes effect immediately; only adding or
 * removing an entry changes the length, which is exactly what invalidates the cache. Same contract as
 * kpi.ts's transferPairCache.
 */
const idIndexCache = new WeakMap<{ id: string }[], { length: number; byId: Map<string, { id: string }> }>();

function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
	const cached = idIndexCache.get(items);
	if (cached && cached.length === items.length) return cached.byId as Map<string, T>;
	const byId = new Map<string, T>();
	for (const item of items) byId.set(item.id, item);
	idIndexCache.set(items, { length: items.length, byId });
	return byId;
}

export function isTransferLike(store: KpiStore, tx: Transaction): boolean {
	if (tx.categoryId) {
		const cat = indexById(store.categories).get(tx.categoryId);
		if (cat && TRANSFER_CATEGORY_NAMES.has(cat.name.trim().toLowerCase())) return true;
	}
	const account = indexById(store.accounts).get(tx.accountId);
	if (account && (account.type === "saving" || account.type === "investing")) {
		const action = (tx.action ?? "").trim().toLowerCase();
		const type = (tx.type ?? "").trim().toLowerCase();
		if (TRANSFER_ACCOUNT_MARKERS.has(action) || TRANSFER_ACCOUNT_MARKERS.has(type)) return true;
	}
	return false;
}

// ---------- series ----------

export interface RecurringOccurrence {
	id: string;
	date: string;
	/** Signed, exactly as it sits in the ledger — the sign is what `direction` is derived from. */
	amount: number;
	accountId: string;
}

export interface RecurringSeries {
	/** Normalized merchant key — the stable identity used for dismissals and subscription matching. */
	key: string;
	displayName: string;
	direction: RecurringDirection;
	cycle: RecurringCycle;
	/** The account most of the charges land on. A series that migrated between accounts still reports
	 *  one, because every consumer needs a single account to link to. */
	accountId: string;
	medianGapDays: number;
	/** Mean absolute deviation of the gaps relative to the median gap. 0 is a metronome. Exposed rather
	 *  than thresholded here, because precision-sensitive consumers (subscription detection) want a
	 *  tighter bar than an insight feed does. */
	gapSpread: number;
	/** Absolute amounts — the sign already lives in `direction`. */
	medianAmount: number;
	lastAmount: number;
	firstDate: string;
	lastDate: string;
	/** Last seen plus one cycle. Both "when is this due" and "this is overdue" read from it. */
	expectedNextDate: string;
	/** Chronological, oldest first. */
	occurrences: RecurringOccurrence[];
	distinctMonths: number;
}

export interface RecurringOptions {
	/** Override the transfer classifier — pass kpi.ts's once it becomes public. */
	isTransfer?: (store: KpiStore, tx: Transaction) => boolean;
}

/**
 * Every recurring merchant relationship in the ledger, strongest first.
 *
 * Grouping is by normalized counterparty *and* direction; the cycle is whichever band the **median**
 * inter-transaction gap falls into. Median rather than mean because one missed or double month
 * shifts a mean out of its band entirely while barely moving a median — which is the difference
 * between detecting a subscription and losing it the first time a payment retries.
 *
 * Series are returned unfiltered on regularity and amount stability; `gapSpread` and the raw
 * occurrence amounts are exposed so each consumer sets its own precision bar.
 */
export function recurringSeries(store: KpiStore, minOccurrences = 3, opts: RecurringOptions = {}): RecurringSeries[] {
	const isTransfer = opts.isTransfer ?? isTransferLike;

	const groups = new Map<string, { key: string; direction: RecurringDirection; raw: string[]; occurrences: RecurringOccurrence[] }>();
	for (const tx of store.transactions) {
		if (!tx.amount || !tx.date) continue;
		if (parseIsoUtc(tx.date) === undefined) continue;
		if (isTransfer(store, tx)) continue;

		const source = merchantSourceText(tx);
		const key = normalizeMerchantKey(source);
		if (!key) continue;

		const direction: RecurringDirection = tx.amount < 0 ? "debit" : "credit";
		const groupId = `${key}|${direction}`;
		let group = groups.get(groupId);
		if (!group) {
			group = { key, direction, raw: [], occurrences: [] };
			groups.set(groupId, group);
		}
		group.raw.push(source);
		group.occurrences.push({ id: tx.id, date: tx.date, amount: tx.amount, accountId: tx.accountId });
	}

	const series: RecurringSeries[] = [];
	for (const group of groups.values()) {
		if (group.occurrences.length < Math.max(2, minOccurrences)) continue;

		const occurrences = group.occurrences.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
		const gaps: number[] = [];
		for (let i = 1; i < occurrences.length; i++) gaps.push(daysBetweenIso(occurrences[i - 1].date, occurrences[i].date));
		if (gaps.length === 0) continue;

		const medianGap = median(gaps);
		const band = CYCLE_BANDS.find((b) => medianGap >= b.min && medianGap <= b.max);
		if (!band) continue;

		const amounts = occurrences.map((o) => Math.abs(o.amount));
		const last = occurrences[occurrences.length - 1];
		const gapSpread = medianGap > 0 ? gaps.reduce((sum, g) => sum + Math.abs(g - medianGap), 0) / gaps.length / medianGap : Infinity;

		series.push({
			key: group.key,
			displayName: titleCase(modeOf(group.raw) ?? group.key),
			direction: group.direction,
			cycle: band.cycle,
			accountId: modeOf(occurrences.map((o) => o.accountId)) ?? last.accountId,
			medianGapDays: medianGap,
			gapSpread,
			medianAmount: median(amounts),
			lastAmount: Math.abs(last.amount),
			firstDate: occurrences[0].date,
			lastDate: last.date,
			expectedNextDate: addCycleIso(last.date, band.cycle),
			occurrences,
			distinctMonths: new Set(occurrences.map((o) => o.date.slice(0, 7))).size,
		});
	}

	// Ranked by annualized value so the biggest commitments surface first under any card cap; the key
	// tiebreak keeps the order stable across recomputes, which dismissal-by-position would otherwise break.
	return series.sort((a, b) => {
		const byValue = b.medianAmount * CYCLES_PER_YEAR[b.cycle] - a.medianAmount * CYCLES_PER_YEAR[a.cycle];
		if (byValue !== 0) return byValue;
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});
}

/** Most frequent value, ties broken by first appearance — used for the display name and the account a
 *  series is attributed to. */
function modeOf(values: string[]): string | undefined {
	const counts = new Map<string, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	let best: string | undefined;
	let bestCount = 0;
	for (const [value, count] of counts) {
		if (count > bestCount) {
			best = value;
			bestCount = count;
		}
	}
	return best;
}

/**
 * Whether two normalized merchant keys refer to the same thing.
 *
 * Bank text and the name a user typed almost never agree exactly — "NETFLIX.COM" against "Netflix",
 * "netflix com" against "netflix premium" — so three rules run: equality, containment, and a shared
 * leading brand token. The brand-token rule is what handles the common case, and it's guarded at four
 * characters because a three-letter key ("bol") matches far too much ("bolt").
 *
 * Tuned to over-match rather than under-match: every caller uses this to decide "is this already
 * covered?", where a false match costs one missed suggestion and a missed match costs a duplicate
 * subscription the user has to notice and clean up.
 */
export function merchantKeysOverlap(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;

	const shorter = a.length <= b.length ? a : b;
	const longer = a.length <= b.length ? b : a;
	if (shorter.length >= 4 && longer.indexOf(shorter) !== -1) return true;

	const brandA = a.split(" ")[0];
	const brandB = b.split(" ")[0];
	return brandA.length >= 4 && brandA === brandB;
}

/** The series a merchant key belongs to, if any — the lookup every consumer needs when going from a
 *  transaction or a subscription back to its series. */
export function findSeries(series: RecurringSeries[], key: string, direction: RecurringDirection = "debit"): RecurringSeries | undefined {
	return series.find((s) => s.key === key && s.direction === direction);
}
