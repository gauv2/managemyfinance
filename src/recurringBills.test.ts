import { describe, it, expect } from "vitest";
import type { KpiStore } from "./kpi";
import { billsForMonth } from "./recurringBills";
import type { Account, Category, Transaction } from "./types";

const checking: Account = { id: "chk", name: "Checking", type: "debit", currency: "EUR", openingBalance: 0 };
const housing: Category = { id: "cat-housing", name: "Housing", color: "#e11d48", icon: "home", aliases: [] };

let n = 0;
const tx = (date: string, amount: number, description: string, categoryId?: string): Transaction => ({
	id: `t${++n}`,
	accountId: "chk",
	date,
	amount,
	description,
	currency: "EUR",
	source: "manual",
	categoryId,
});

function ledger(): KpiStore {
	const t: Transaction[] = [];
	const power = [80, 84.5, 88, 83];
	["2026-05", "2026-06", "2026-07", "2026-08"].forEach((m, i) => {
		t.push(tx(`${m}-01`, -1850, "Oakridge Apartments", housing.id));
		t.push(tx(`${m}-25`, 2760, "Ridgeline Inc salary"));
		t.push(tx(`${m}-12`, -power[i], "City Power"));
		t.push(tx(`${m}-28`, 0.06, "Spaarrente"));
	});
	t.push(tx("2026-09-01", -1850, "Oakridge Apartments", housing.id));
	for (let d = 1; d <= 29; d += 7) {
		t.push(tx(`2026-08-${String(d).padStart(2, "0")}`, -106, "Harvest Lane Market"));
		t.push(tx(`2026-09-${String(d).padStart(2, "0")}`, -106, "Harvest Lane Market"));
	}
	return { accounts: [checking], categories: [housing], transactions: t };
}

describe("billsForMonth", () => {
	const bills = billsForMonth(ledger(), "2026-09", "2026-09-10");

	it("pins a bill that has posted this month as paid, on the day it posted", () => {
		const rent = bills.bills.find((b) => b.name.startsWith("Oakridge"))!;
		expect(rent).toMatchObject({ day: 1, amount: 1850, paid: true, approx: false, color: housing.color });
	});

	it("pins one that hasn't as expected, on the day its cycle says, marked approximate when it varies", () => {
		const power = bills.bills.find((b) => b.name.startsWith("City Power"))!;
		expect(power).toMatchObject({ day: 12, paid: false, approx: true });
	});

	it("puts regular income above the bills rather than among them", () => {
		expect(bills.income.map((b) => [b.day, b.amount, b.paid])).toEqual([[25, 2760, false]]);
		expect(bills.bills.some((b) => b.name.startsWith("Ridgeline"))).toBe(false);
	});

	it("leaves out income too small to be worth a pin", () => {
		expect(bills.income.some((b) => b.name.startsWith("Spaarrente"))).toBe(false);
	});

	it("lists weekly spending separately instead of pinning it five times", () => {
		expect(bills.weekly.map((w) => [w.name, w.amount])).toEqual([["Harvest Lane Market", 106]]);
		expect(bills.bills.some((b) => b.name.startsWith("Harvest"))).toBe(false);
	});

	it("doesn't invent an upcoming charge for a month that's already over", () => {
		const past = billsForMonth(ledger(), "2026-04", "2026-09-10");
		expect(past.bills).toEqual([]);
	});

	it("drops a bill that stopped", () => {
		const later = billsForMonth(ledger(), "2027-03", "2027-03-01");
		expect(later.bills).toEqual([]);
	});
});
