import { describe, it, expect } from "vitest";
import {
	addCycleIso,
	addDaysIso,
	addMonthsIso,
	amountSpread,
	daysBetweenIso,
	findSeries,
	mad,
	median,
	merchantKeysOverlap,
	normalizeMerchantKey,
	recurringSeries,
	todayIso,
	type RecurringCycle,
} from "./recurring";
import type { KpiStore } from "./kpi";
import type { Account, Category, Transaction } from "./types";

// ---------- fixtures ----------

const checking: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR", openingBalance: 0 };
const savings: Account = { id: "acc-savings", name: "Savings", type: "saving", currency: "EUR", openingBalance: 0 };

const catFood: Category = { id: "cat-food", name: "Food", color: "#000", icon: "utensils", aliases: [] };
const catTransfers: Category = { id: "cat-transfers", name: "Transfers", color: "#000", icon: "arrow", aliases: [] };

let nextId = 0;
function tx(partial: Partial<Transaction> & Pick<Transaction, "date" | "amount">): Transaction {
	nextId++;
	return {
		id: `tx-${nextId}`,
		accountId: checking.id,
		description: "test",
		currency: "EUR",
		source: "manual",
		...partial,
	};
}

function store(transactions: Transaction[], overrides: Partial<KpiStore> = {}): KpiStore {
	return {
		accounts: [checking, savings],
		categories: [catFood, catTransfers],
		transactions,
		...overrides,
	};
}

/** `count` transactions for one counterparty, each `gapDays` after the last — the shape every cycle-band
 *  assertion needs. */
function series(counterparty: string, startIso: string, gapDays: number, count: number, amount: number, extra: Partial<Transaction> = {}): Transaction[] {
	const out: Transaction[] = [];
	let date = startIso;
	for (let i = 0; i < count; i++) {
		out.push(tx({ date, amount, counterparty, ...extra }));
		date = addDaysIso(date, gapDays);
	}
	return out;
}

// ---------- UTC date arithmetic ----------

describe("date arithmetic", () => {
	it("counts whole days across a DST boundary without an off-by-one", () => {
		// Europe/Amsterdam springs forward on 31 March 2024; local-time arithmetic loses an hour here and
		// rounds a 30-day gap down to 29.
		expect(daysBetweenIso("2024-03-01", "2024-03-31")).toBe(30);
		expect(daysBetweenIso("2024-10-01", "2024-11-01")).toBe(31);
		expect(daysBetweenIso("2024-11-01", "2024-10-01")).toBe(-31);
	});

	it("clamps month arithmetic to the end of a shorter target month", () => {
		expect(addMonthsIso("2024-01-31", 1)).toBe("2024-02-29"); // leap year
		expect(addMonthsIso("2023-01-31", 1)).toBe("2023-02-28");
		expect(addMonthsIso("2024-03-31", 1)).toBe("2024-04-30");
	});

	it("advances one cycle per band", () => {
		expect(addCycleIso("2024-03-01", "weekly")).toBe("2024-03-08");
		expect(addCycleIso("2024-03-01", "monthly")).toBe("2024-04-01");
		expect(addCycleIso("2024-03-01", "quarterly")).toBe("2024-06-01");
		expect(addCycleIso("2024-03-01", "yearly")).toBe("2025-03-01");
	});

	it("leaves an unparseable date untouched instead of producing NaN dates", () => {
		expect(addDaysIso("not-a-date", 5)).toBe("not-a-date");
		expect(daysBetweenIso("not-a-date", "2024-01-01")).toBe(0);
	});

	it("reads today from the local calendar", () => {
		expect(todayIso(new Date(2024, 6, 4))).toBe("2024-07-04");
		expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

// ---------- statistics ----------

describe("statistics", () => {
	it("takes the median of odd and even length runs", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([6, 8])).toBe(7);
		expect(median([])).toBe(0);
	});

	it("MAD ignores the fat tail that inflates a standard deviation", () => {
		// Ten ordinary €20 shops plus two genuine big months. Those two drag the mean and the stdev up so
		// far that median + 3·stdev ≈ €394 — a €250 charge sails under it. MAD is unmoved by them, so
		// median + 3·MAD ≈ €23 flags the €250 as the outlier it is. This is why §2.7 specifies MAD.
		const amounts = [20, 20, 21, 19, 20, 22, 18, 20, 21, 20, 300, 400];
		const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
		const stdev = Math.sqrt(amounts.reduce((sum, a) => sum + (a - mean) ** 2, 0) / amounts.length);
		const suspect = 250;
		expect(median(amounts) + 3 * stdev).toBeGreaterThan(suspect); // stdev-based threshold misses it
		expect(median(amounts) + 3 * mad(amounts)).toBeLessThan(suspect); // MAD-based threshold catches it
	});

	it("measures amount spread as max/min − 1 and rejects non-positive amounts", () => {
		expect(amountSpread([10, 10, 10])).toBe(0);
		expect(amountSpread([10, 11.5])).toBeCloseTo(0.15, 6);
		expect(amountSpread([10, 0])).toBe(Infinity);
		expect(amountSpread([])).toBe(Infinity);
	});
});

// ---------- normalizeMerchantKey ----------

describe("normalizeMerchantKey", () => {
	it("folds case, punctuation and store numbers into one key", () => {
		expect(normalizeMerchantKey("ALBERT HEIJN 1234")).toBe("albert heijn");
		expect(normalizeMerchantKey("Albert Heijn 5567")).toBe("albert heijn");
		expect(normalizeMerchantKey("  albert heijn  ")).toBe("albert heijn");
		expect(normalizeMerchantKey("NETFLIX.COM")).toBe("netflix com");
	});

	it("strips diacritics so the same merchant does not split on encoding", () => {
		expect(normalizeMerchantKey("Café Amsterdam")).toBe("cafe amsterdam");
	});

	it("strips a payment-processor prefix", () => {
		expect(normalizeMerchantKey("SUMUP *CAFE DE SPORT")).toBe("cafe de sport");
		expect(normalizeMerchantKey("PAYPAL *NETFLIX")).toBe("netflix");
	});

	it("keeps leading digits that are part of the brand", () => {
		expect(normalizeMerchantKey("7 ELEVEN")).toBe("7 eleven");
	});

	it("never collapses an all-numeric counterparty to an empty key", () => {
		// Every such merchant would otherwise land in one bogus mega-series.
		expect(normalizeMerchantKey("123456")).toBe("123456");
		expect(normalizeMerchantKey("987654")).toBe("987654");
	});

	it("returns an empty key for empty input", () => {
		expect(normalizeMerchantKey("")).toBe("");
		expect(normalizeMerchantKey(undefined)).toBe("");
	});
});

describe("merchantKeysOverlap", () => {
	it("matches exact, contained and shared-brand-token keys", () => {
		expect(merchantKeysOverlap("netflix", "netflix")).toBe(true);
		expect(merchantKeysOverlap("netflix", "netflix premium")).toBe(true);
		expect(merchantKeysOverlap("netflix com", "netflix premium")).toBe(true);
	});

	it("does not let a 3-character key swallow a longer merchant", () => {
		expect(merchantKeysOverlap("bol", "bolt eu")).toBe(false);
		expect(merchantKeysOverlap("", "netflix")).toBe(false);
		expect(merchantKeysOverlap("spotify", "netflix")).toBe(false);
	});
});

// ---------- cycle bands ----------

describe("recurringSeries cycle bands", () => {
	const cases: { gap: number; cycle: RecurringCycle }[] = [
		{ gap: 6, cycle: "weekly" },
		{ gap: 7, cycle: "weekly" },
		{ gap: 8, cycle: "weekly" },
		{ gap: 26, cycle: "monthly" },
		{ gap: 30, cycle: "monthly" },
		{ gap: 35, cycle: "monthly" },
		{ gap: 85, cycle: "quarterly" },
		{ gap: 95, cycle: "quarterly" },
		{ gap: 350, cycle: "yearly" },
		{ gap: 380, cycle: "yearly" },
	];

	for (const { gap, cycle } of cases) {
		it(`classifies a ${gap}-day median gap as ${cycle}`, () => {
			const s = recurringSeries(store(series("NETFLIX", "2020-01-06", gap, 4, -10)));
			expect(s).toHaveLength(1);
			expect(s[0].cycle).toBe(cycle);
			expect(s[0].medianGapDays).toBe(gap);
		});
	}

	const rejected = [5, 9, 14, 25, 36, 60, 84, 96, 200, 349, 381];
	for (const gap of rejected) {
		it(`rejects a ${gap}-day median gap as belonging to no band`, () => {
			expect(recurringSeries(store(series("NETFLIX", "2020-01-06", gap, 4, -10)))).toHaveLength(0);
		});
	}

	it("uses the median gap, so one missed month does not lose the series", () => {
		// Monthly, but January's charge failed and retried in March: gaps 30, 60, 30, 30.
		const s = recurringSeries(
			store([
				tx({ date: "2024-01-05", amount: -10, counterparty: "SPOTIFY" }),
				tx({ date: "2024-02-04", amount: -10, counterparty: "SPOTIFY" }),
				tx({ date: "2024-04-04", amount: -10, counterparty: "SPOTIFY" }),
				tx({ date: "2024-05-04", amount: -10, counterparty: "SPOTIFY" }),
				tx({ date: "2024-06-03", amount: -10, counterparty: "SPOTIFY" }),
			])
		);
		expect(s).toHaveLength(1);
		expect(s[0].cycle).toBe("monthly");
	});

	it("keeps a real calendar-monthly series inside the monthly band across a DST change", () => {
		const s = recurringSeries(
			store([
				tx({ date: "2024-02-01", amount: -12.99, counterparty: "NETFLIX" }),
				tx({ date: "2024-03-01", amount: -12.99, counterparty: "NETFLIX" }),
				tx({ date: "2024-04-01", amount: -12.99, counterparty: "NETFLIX" }),
				tx({ date: "2024-05-01", amount: -12.99, counterparty: "NETFLIX" }),
			])
		);
		expect(s[0].cycle).toBe("monthly");
		expect(s[0].expectedNextDate).toBe("2024-06-01");
	});
});

// ---------- recurringSeries grouping and fields ----------

describe("recurringSeries", () => {
	it("returns nothing for an empty store and does not crash", () => {
		expect(recurringSeries({ accounts: [], categories: [], transactions: [] })).toEqual([]);
		expect(recurringSeries(store([]))).toEqual([]);
	});

	it("requires minOccurrences transactions", () => {
		const two = store(series("NETFLIX", "2024-01-05", 30, 2, -10));
		expect(recurringSeries(two)).toHaveLength(0);

		const three = store(series("NETFLIX", "2024-01-05", 30, 3, -10));
		expect(recurringSeries(three)).toHaveLength(1);
		expect(recurringSeries(three, 4)).toHaveLength(0);
	});

	it("groups store numbers and casing variants into one series", () => {
		const s = recurringSeries(
			store([
				tx({ date: "2024-01-05", amount: -10, counterparty: "ALBERT HEIJN 1234" }),
				tx({ date: "2024-02-04", amount: -10, counterparty: "Albert Heijn 9988" }),
				tx({ date: "2024-03-05", amount: -10, counterparty: "albert heijn" }),
			])
		);
		expect(s).toHaveLength(1);
		expect(s[0].key).toBe("albert heijn");
		expect(s[0].occurrences).toHaveLength(3);
	});

	it("title-cases the most common raw counterparty as the display name", () => {
		const s = recurringSeries(store(series("NETFLIX.COM", "2024-01-05", 30, 3, -10)));
		expect(s[0].displayName).toBe("Netflix.com");
	});

	it("splits debits and credits into separate series", () => {
		const s = recurringSeries(
			store([
				...series("ACME BV", "2024-01-05", 30, 3, -10),
				...series("ACME BV", "2024-01-20", 30, 3, 2500),
			])
		);
		expect(s).toHaveLength(2);
		expect(s.map((x) => x.direction).sort()).toEqual(["credit", "debit"]);
		expect(s.find((x) => x.direction === "credit")!.medianAmount).toBe(2500);
	});

	it("reports absolute amounts, first/last dates and the expected next date", () => {
		const s = recurringSeries(
			store([
				tx({ date: "2024-01-05", amount: -9.99, counterparty: "SPOTIFY" }),
				tx({ date: "2024-02-05", amount: -9.99, counterparty: "SPOTIFY" }),
				tx({ date: "2024-03-05", amount: -11.99, counterparty: "SPOTIFY" }),
			])
		);
		expect(s[0]).toMatchObject({
			direction: "debit",
			cycle: "monthly",
			medianAmount: 9.99,
			lastAmount: 11.99,
			firstDate: "2024-01-05",
			lastDate: "2024-03-05",
			expectedNextDate: "2024-04-05",
			distinctMonths: 3,
			accountId: checking.id,
		});
	});

	it("excludes transfers so a standing order into savings is not a merchant relationship", () => {
		const s = recurringSeries(
			store([
				...series("OWN SAVINGS", "2024-01-05", 30, 4, -500, { categoryId: catTransfers.id }),
				...series("NETFLIX", "2024-01-05", 30, 4, -10),
			])
		);
		expect(s.map((x) => x.key)).toEqual(["netflix"]);
	});

	it("excludes a savings-account Deposit/Withdrawal marker even when it is miscategorized", () => {
		const s = recurringSeries(
			store(series("SPAARREKENING", "2024-01-05", 30, 4, -500, { accountId: savings.id, type: "Withdrawal", categoryId: catFood.id }))
		);
		expect(s).toHaveLength(0);
	});

	it("sees a category renamed in place, despite the id lookups being cached (review-flows: hoisted finds)", () => {
		// The classifier's category/account lookups are cached by array identity + length so they aren't
		// re-scanned per transaction. The cache holds the live objects, so renaming one must take effect
		// immediately — that is the whole reason it isn't a name snapshot.
		const renamed: Category = { ...catFood, name: "Food" };
		const s = store(series("OWN SAVINGS", "2024-01-05", 30, 4, -500, { categoryId: renamed.id }), {
			categories: [renamed, catTransfers],
		});
		expect(recurringSeries(s)).toHaveLength(1);

		renamed.name = "Savings & Transfers";
		expect(recurringSeries(s)).toHaveLength(0);
	});

	it("honours an injected transfer classifier", () => {
		const s = recurringSeries(store(series("NETFLIX", "2024-01-05", 30, 4, -10)), 3, { isTransfer: () => true });
		expect(s).toHaveLength(0);
	});

	it("exposes gap spread so consumers can set their own regularity bar", () => {
		const metronome = recurringSeries(store(series("NETFLIX", "2024-01-05", 30, 5, -10)));
		expect(metronome[0].gapSpread).toBe(0);

		const ragged = recurringSeries(
			store([
				tx({ date: "2024-01-05", amount: -10, counterparty: "RAGGED" }),
				tx({ date: "2024-02-04", amount: -10, counterparty: "RAGGED" }),
				tx({ date: "2024-03-30", amount: -10, counterparty: "RAGGED" }),
				tx({ date: "2024-04-15", amount: -10, counterparty: "RAGGED" }),
			])
		);
		expect(ragged[0].gapSpread).toBeGreaterThan(0.2);
	});

	it("ranks by annualized value so the biggest commitment leads", () => {
		const s = recurringSeries(
			store([
				...series("SMALL", "2024-01-05", 30, 4, -5), // €60/yr
				...series("BIG", "2024-01-05", 30, 4, -50), // €600/yr
			])
		);
		expect(s.map((x) => x.key)).toEqual(["big", "small"]);
	});

	it("ignores rows with no counterparty text, no amount or an unparseable date", () => {
		const s = recurringSeries(
			store([
				tx({ date: "2024-01-05", amount: -10, counterparty: "", description: "" }),
				tx({ date: "2024-02-04", amount: 0, counterparty: "NETFLIX" }),
				tx({ date: "garbage", amount: -10, counterparty: "NETFLIX" }),
			])
		);
		expect(s).toEqual([]);
	});

	it("falls back to the description when the bank recorded no counterparty", () => {
		const s = recurringSeries(
			store([
				tx({ date: "2024-01-05", amount: -10, description: "NETFLIX MONTHLY" }),
				tx({ date: "2024-02-04", amount: -10, description: "NETFLIX MONTHLY" }),
				tx({ date: "2024-03-05", amount: -10, description: "NETFLIX MONTHLY" }),
			])
		);
		expect(s[0].key).toBe("netflix monthly");
	});

	it("finds a series by key and direction", () => {
		const s = recurringSeries(store(series("NETFLIX", "2024-01-05", 30, 3, -10)));
		expect(findSeries(s, "netflix")?.cycle).toBe("monthly");
		expect(findSeries(s, "netflix", "credit")).toBeUndefined();
		expect(findSeries(s, "nothing")).toBeUndefined();
	});
});
