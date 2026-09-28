import { describe, it, expect } from "vitest";
import { netWorthAsOf, type KpiStore } from "./kpi";
import { bucketTotals, change, sampleDates, worthHistory } from "./netWorthHistory";
import type { Account, Transaction } from "./types";

const checking: Account = { id: "chk", name: "Checking", type: "debit", currency: "EUR", openingBalance: 1000 };
const card: Account = { id: "cc", name: "Credit card", type: "credit", currency: "EUR", openingBalance: 0 };
const pension: Account = { id: "pen", name: "Pension", type: "pension", currency: "EUR", openingBalance: 5000 };
const loan: Account = { id: "loan", name: "Car loan", type: "loan", currency: "EUR", openingBalance: 2000 };

let n = 0;
const tx = (accountId: string, date: string, amount: number): Transaction => ({
	id: `t${++n}`,
	accountId,
	date,
	amount,
	description: "x",
	currency: "EUR",
	source: "manual",
});

const store = (): KpiStore => ({
	accounts: [checking, card, pension, loan],
	categories: [],
	transactions: [tx("chk", "2026-01-10", 2500), tx("chk", "2026-02-03", -400), tx("cc", "2026-02-05", -150)],
});

describe("sampleDates", () => {
	it("ends today and samples a month daily", () => {
		const d = sampleDates("1m", "2026-03-15");
		expect(d[0]).toBe("2026-02-15");
		expect(d[d.length - 1]).toBe("2026-03-15");
		expect(d.length).toBe(29);
	});

	it("goes weekly for a year and monthly for all time, starting at the first transaction", () => {
		expect(sampleDates("1y", "2026-03-15").length).toBeLessThan(60);
		const all = sampleDates("all", "2026-03-15", "2025-01-31");
		expect(all.slice(0, 3)).toEqual(["2025-01-31", "2025-02-28", "2025-03-31"]);
		expect(all[all.length - 1]).toBe("2026-03-15");
	});

	it("never starts before there was anything to show", () => {
		expect(sampleDates("1y", "2026-03-15", "2026-03-01")[0]).toBe("2026-03-01");
	});
});

describe("worthHistory", () => {
	it("totals the accounts, valued exactly as netWorthAsOf values them", () => {
		const s = store();
		const h = worthHistory(s, ["2026-01-01", "2026-03-01"]);
		expect(h.total[1]).toBeCloseTo(netWorthAsOf(s, "2026-03-01"));
		expect(h.accounts.find((a) => a.account.id === "chk")?.values).toEqual([1000, 3100]);
		expect(h.accounts.find((a) => a.account.id === "loan")?.end).toBe(-2000);
	});

	it("groups accounts into buckets, debts negative", () => {
		const totals = bucketTotals(worthHistory(store(), ["2026-03-01"]));
		expect(totals).toEqual([
			{ bucket: "cash", value: 3100 },
			{ bucket: "retirement", value: 5000 },
			{ bucket: "credit", value: -150 },
			{ bucket: "loans", value: -2000 },
		]);
	});
});

describe("change", () => {
	it("reports the move and the share of where it started", () => {
		expect(change([200, 250])).toEqual({ amount: 50, pct: 0.25 });
		expect(change([-200, -100])).toEqual({ amount: 100, pct: 0.5 });
		expect(change([0, 100]).pct).toBeUndefined();
	});
});
