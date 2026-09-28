import { describe, it, expect } from "vitest";
import { accountMonth } from "./accountMonth";
import type { KpiStore } from "./kpi";
import type { Transaction } from "./types";

let n = 0;
const tx = (date: string, amount: number): Transaction => ({ id: `t${++n}`, accountId: "cc", date, amount, description: "x", currency: "EUR", source: "manual" });

const store = (): KpiStore => ({
	accounts: [{ id: "cc", name: "Card", type: "credit", currency: "EUR", openingBalance: 0 }],
	categories: [],
	transactions: [tx("2026-08-20", -1000), tx("2026-09-03", -200), tx("2026-09-10", -300), tx("2026-09-22", 1000), tx("2026-09-25", 40)],
});

describe("accountMonth", () => {
	const month = accountMonth(store(), "cc", "2026-09", "2026-09-26");

	it("walks the balance day by day", () => {
		expect(month.balances[0]).toBe(-1000);
		expect(month.balances[2]).toBe(-1200);
		expect(month.balances[21]).toBe(-500);
		expect(month.balance).toBe(-460);
	});

	it("holds today's balance flat for the days still to come", () => {
		expect(month.todayIndex).toBe(25);
		expect(month.balances[29]).toBe(-460);
	});

	it("splits spending from payments and finds the biggest payment", () => {
		expect(month.spent).toBe(500);
		expect(month.paid).toBe(1040);
		expect(month.biggestPayment).toEqual({ index: 21, amount: 1000 });
	});

	it("reads a finished month to its last day", () => {
		const aug = accountMonth(store(), "cc", "2026-08", "2026-09-26");
		expect(aug.todayIndex).toBeUndefined();
		expect(aug.balance).toBe(-1000);
	});
});
