import { describe, expect, it } from "vitest";
import { buildStats, daysBetween, longestQuietStreak } from "./stats";
import type { Transaction } from "./types";

let seq = 0;
const tx = (date: string | undefined, amount: number, description = "row"): Transaction =>
	({ id: `t${seq++}`, date, amount, description, accountId: "a", source: "s" }) as unknown as Transaction;

const nameOf = (t: Transaction): string | undefined => t.description || undefined;

describe("daysBetween", () => {
	it("counts whole days", () => {
		expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
	});

	it("counts across a leap day", () => {
		expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
	});

	it("is unaffected by the clocks changing", () => {
		// Europe/Amsterdam moves on 2026-03-29. A local-time subtraction loses an hour here and rounds
		// to 30 days; UTC on both sides keeps it at 31.
		expect(daysBetween("2026-03-01", "2026-04-01")).toBe(31);
	});

	it("is zero for nonsense rather than NaN", () => {
		expect(daysBetween("not-a-date", "2026-01-01")).toBe(0);
	});
});

describe("longestQuietStreak", () => {
	it("is the gap between spending days, exclusive", () => {
		// 5th and 10th: the 6th, 7th, 8th and 9th were quiet.
		expect(longestQuietStreak(["2026-01-05", "2026-01-10"])).toBe(4);
	});

	it("is zero when spending happens on consecutive days", () => {
		expect(longestQuietStreak(["2026-01-01", "2026-01-02", "2026-01-03"])).toBe(0);
	});

	it("ignores repeats of the same day", () => {
		expect(longestQuietStreak(["2026-01-01", "2026-01-01", "2026-01-03"])).toBe(1);
	});

	it("needs two days to have a gap at all", () => {
		expect(longestQuietStreak(["2026-01-01"])).toBe(0);
		expect(longestQuietStreak([])).toBe(0);
	});

	it("takes the longest gap, not the last", () => {
		expect(longestQuietStreak(["2026-01-01", "2026-01-20", "2026-01-22"])).toBe(18);
	});
});

describe("buildStats", () => {
	const ledger = [
		tx("2020-02-05", 1500, "Payment from Jagai"),
		tx("2021-06-01", -12000, "Car dealer"),
		tx("2023-03-03", -20, "Albert Heijn"),
		tx("2023-03-03", -30, "Albert Heijn"),
		tx("2023-03-03", -10, "Coffee"),
		tx("2026-08-12", 13698.67, "Big refund"),
	];

	it("finds the first and latest rows, not just their dates", () => {
		const s = buildStats(ledger, nameOf);
		expect(s.first?.description).toBe("Payment from Jagai");
		expect(s.latest?.description).toBe("Big refund");
	});

	it("measures the span the ledger covers", () => {
		const s = buildStats(ledger, nameOf);
		expect(s.spanDays).toBe(daysBetween("2020-02-05", "2026-08-12"));
	});

	it("reports the biggest expense as a positive magnitude with its row", () => {
		const s = buildStats(ledger, nameOf);
		expect(s.biggestExpense?.amount).toBe(12000);
		expect(s.biggestExpense?.transaction.description).toBe("Car dealer");
	});

	it("reports the biggest income", () => {
		const s = buildStats(ledger, nameOf);
		expect(s.biggestIncome?.amount).toBeCloseTo(13698.67);
	});

	it("totals money out and money in separately", () => {
		const s = buildStats(ledger, nameOf);
		expect(s.totalSpent).toBe(12060);
		expect(s.totalReceived).toBeCloseTo(15198.67);
	});

	it("finds the busiest day by count", () => {
		const s = buildStats(ledger, nameOf);
		expect(s.busiestDay?.date).toBe("2023-03-03");
		expect(s.busiestDay?.count).toBe(3);
	});

	it("finds the heaviest day by money, which need not be the busiest", () => {
		const s = buildStats(ledger, nameOf);
		expect(s.heaviestDay?.date).toBe("2021-06-01");
		expect(s.heaviestDay?.total).toBe(12000);
	});

	it("separates the merchant you spend most at from the one you visit most", () => {
		const s = buildStats(ledger, nameOf);
		expect(s.topMerchantBySpend?.name).toBe("Car dealer");
		expect(s.topMerchantByVisits?.name).toBe("Albert Heijn");
		expect(s.topMerchantByVisits?.count).toBe(2);
	});

	it("averages expenses per row, not per day", () => {
		const s = buildStats(ledger, nameOf);
		expect(s.averageExpense).toBeCloseTo(12060 / 4);
	});

	it("counts undated rows out of the figures and says how many", () => {
		const s = buildStats([...ledger, tx(undefined, -99), tx("", -99)], nameOf);
		expect(s.undated).toBe(2);
		expect(s.counted).toBe(ledger.length);
		expect(s.totalSpent).toBe(12060);
	});

	it("returns something sane for an empty ledger", () => {
		const s = buildStats([], nameOf);
		expect(s.counted).toBe(0);
		expect(s.first).toBeUndefined();
		expect(s.averageExpense).toBe(0);
	});

	it("has no heaviest day when nothing was ever spent", () => {
		const s = buildStats([tx("2026-01-01", 50, "in")], nameOf);
		expect(s.heaviestDay).toBeUndefined();
		expect(s.biggestExpense).toBeUndefined();
	});
});

describe("transfers", () => {
	// Iwan's ledger sweeps money into a savings account constantly, so before this the "biggest spend"
	// and the "most visited shop" were both that savings account — true, and useless.
	const ledger = [
		tx("2026-01-01", -12000, "To Instant Access Savings"),
		tx("2026-01-02", -40, "Albert Heijn"),
		tx("2026-01-03", -60, "Albert Heijn"),
	];
	const isSweep = (t: Transaction): boolean => /Savings/.test(t.description ?? "");

	it("leaves transfers out of the records entirely", () => {
		const s = buildStats(ledger, nameOf, isSweep);
		expect(s.counted).toBe(2);
		expect(s.totalSpent).toBe(100);
		expect(s.biggestExpense?.amount).toBe(60);
		expect(s.topMerchantBySpend?.name).toBe("Albert Heijn");
	});

	it("counts everything when no predicate is supplied", () => {
		const s = buildStats(ledger, nameOf);
		expect(s.counted).toBe(3);
		expect(s.biggestExpense?.amount).toBe(12000);
	});
});
