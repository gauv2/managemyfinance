import { describe, it, expect } from "vitest";
import { buildCashFlow, layoutSankey } from "./cashFlow";
import { primaryCategoryIncomeTotals, primaryCategoryTotals, type KpiStore } from "./kpi";
import type { Account, Category, Transaction } from "./types";

const checking: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR", openingBalance: 0 };
const savings: Account = { id: "acc-savings", name: "Savings", type: "saving", currency: "EUR", openingBalance: 0 };

const salary: Category = { id: "cat-salary", name: "Salary", color: "#0a0", icon: "coins", aliases: [], kind: "income" };
const food: Category = { id: "cat-food", name: "Food", color: "#f90", icon: "utensils", aliases: [] };
const groceries: Category = { id: "cat-groceries", name: "Groceries", color: "#fa0", icon: "cart", aliases: [], parentId: "cat-food" };
const dining: Category = { id: "cat-dining", name: "Dining", color: "#fb0", icon: "wine", aliases: [], parentId: "cat-food" };
const bills: Category = { id: "cat-bills", name: "Bills", color: "#00f", icon: "bolt", aliases: [] };

let nextId = 0;
function tx(partial: Partial<Transaction> & Pick<Transaction, "date" | "amount">): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, accountId: checking.id, description: partial.description ?? "test", currency: "EUR", source: "manual", ...partial };
}

function store(transactions: Transaction[]): KpiStore {
	return { accounts: [checking, savings], categories: [salary, food, groceries, dining, bills], transactions };
}

const ledger = () =>
	store([
		tx({ date: "2026-01-25", amount: 3000, categoryId: salary.id, description: "ACME BV salaris" }),
		tx({ date: "2026-01-03", amount: -120, categoryId: groceries.id, description: "Albert Heijn 1234" }),
		tx({ date: "2026-01-10", amount: -80, categoryId: groceries.id, description: "Albert Heijn 1234" }),
		tx({ date: "2026-01-12", amount: -60, categoryId: dining.id, description: "Pizzeria Roma" }),
		tx({ date: "2026-01-14", amount: -40, categoryId: food.id, description: "Bakker Bart" }),
		tx({ date: "2026-01-20", amount: -900, categoryId: bills.id, description: "Vattenfall" }),
		tx({ date: "2026-01-21", amount: -25, description: "Mystery charge" }),
	]);

describe("buildCashFlow", () => {
	it("totals income, expenses and what was kept", () => {
		const flow = buildCashFlow(ledger());
		expect(flow.income.total).toBe(3000);
		expect(flow.expenses.total).toBe(1225);
		expect(flow.net).toBe(1775);
	});

	it("rolls categories up into their primary group, largest first", () => {
		const flow = buildCashFlow(ledger());
		expect(flow.expenses.groups.map((g) => [g.name, g.amount])).toEqual([
			["Bills", 900],
			["Food", 300],
			["Uncategorized", 25],
		]);
		const foodGroup = flow.expenses.groups.find((g) => g.id === food.id)!;
		// A row tagged with the primary itself is its own line, named after the primary.
		expect(foodGroup.categories.map((c) => [c.name, c.amount])).toEqual([
			["Groceries", 200],
			["Dining", 60],
			["Food", 40],
		]);
	});

	it("agrees with the dashboard's own category totals", () => {
		const s = ledger();
		const flow = buildCashFlow(s);
		for (const [id, amount] of primaryCategoryTotals(s)) expect(flow.expenses.groups.find((g) => g.id === id)?.amount).toBeCloseTo(amount);
		for (const [id, amount] of primaryCategoryIncomeTotals(s)) expect(flow.income.groups.find((g) => g.id === id)?.amount).toBeCloseTo(amount);
	});

	it("groups a merchant's rows together", () => {
		const flow = buildCashFlow(ledger());
		const ah = flow.expenses.merchants.find((m) => m.name.startsWith("Albert Heijn"));
		expect(ah?.amount).toBe(200);
	});

	it("leaves transfers between your own accounts out entirely", () => {
		const s = ledger();
		s.transactions.push(
			tx({ date: "2026-01-26", amount: -500, transferGroupId: "t1", description: "to savings" }),
			tx({ date: "2026-01-26", amount: 500, accountId: savings.id, transferGroupId: "t1", description: "from checking" })
		);
		const flow = buildCashFlow(s);
		expect(flow.income.total).toBe(3000);
		expect(flow.expenses.total).toBe(1225);
	});

	it("respects the period", () => {
		const s = ledger();
		s.transactions.push(tx({ date: "2025-12-31", amount: -999, categoryId: bills.id }));
		expect(buildCashFlow(s, { from: "2026-01-01", to: "2026-01-31" }).expenses.total).toBe(1225);
		expect(buildCashFlow(s).expenses.total).toBe(2224);
	});

	it("nets a refund against the category it came back into", () => {
		const s = ledger();
		s.transactions.push(tx({ date: "2026-01-28", amount: 60, categoryId: dining.id, description: "Pizzeria Roma refund" }));
		const flow = buildCashFlow(s);
		expect(flow.income.total).toBe(3000);
		expect(flow.expenses.groups.find((g) => g.id === food.id)?.amount).toBe(240);
		// Fully refunded, so it has nothing left to say about where the money went.
		expect(flow.expenses.categories.find((c) => c.id === dining.id)).toBeUndefined();
	});
});

describe("layoutSankey", () => {
	it("balances the hub: what flows in equals what flows out", () => {
		const layout = layoutSankey(buildCashFlow(ledger()), "groups");
		const inflow = layout.links.filter((l) => l.target === "hub").reduce((s, l) => s + l.value, 0);
		const outflow = layout.links.filter((l) => l.source === "hub").reduce((s, l) => s + l.value, 0);
		expect(inflow).toBeCloseTo(outflow);
		expect(layout.nodes.find((n) => n.id === "savings")?.value).toBe(1775);
	});

	it("adds a shortfall source instead of savings when spending beats income", () => {
		const s = ledger();
		s.transactions.push(tx({ date: "2026-01-29", amount: -5000, categoryId: bills.id }));
		const layout = layoutSankey(buildCashFlow(s), "groups");
		expect(layout.nodes.find((n) => n.id === "savings")).toBeUndefined();
		expect(layout.nodes.find((n) => n.id === "shortfall")?.value).toBe(3225);
	});

	it("draws a group that refunds pushed below zero as money in, so savings still equals the net", () => {
		const s = ledger();
		s.transactions.push(tx({ date: "2026-01-30", amount: 1500, categoryId: bills.id, description: "Belastingdienst teruggave" }));
		const flow = buildCashFlow(s);
		expect(flow.expenses.groups.find((g) => g.id === bills.id)?.amount).toBe(-600);
		for (const detail of ["groups", "categories", "both"] as const) {
			const layout = layoutSankey(flow, detail);
			expect(layout.nodes.find((n) => n.id === "savings")?.value).toBeCloseTo(flow.net);
			expect(layout.nodes.find((n) => n.id === `refund:${bills.id}`)?.value).toBe(600);
			expect(layout.nodes.find((n) => n.id === "hub")?.label).toBe("Money in");
		}
	});

	it("uses one scale everywhere, so a ribbon is as thick as the bars at both of its ends", () => {
		const layout = layoutSankey(buildCashFlow(ledger()), "both");
		const foodNode = layout.nodes.find((n) => n.id === `out:${food.id}`)!;
		const leaves = layout.nodes.filter((n) => n.id.startsWith(`leaf:${food.id}:`));
		expect(leaves.reduce((s, n) => s + n.height, 0)).toBeCloseTo(foodNode.height);
		expect(layout.nodes.some((n) => n.column === 3)).toBe(true);
	});

	it("never lets two labels overlap", () => {
		const layout = layoutSankey(buildCashFlow(ledger()), "categories", { labelHeight: 30 });
		for (let c = 0; c < 3; c++) {
			const col = layout.nodes.filter((n) => n.column === c).sort((a, b) => a.y - b.y);
			for (let i = 1; i < col.length; i++) expect(col[i].y - col[i - 1].y).toBeGreaterThanOrEqual(30);
		}
	});

	it("draws nothing for an empty period", () => {
		expect(layoutSankey(buildCashFlow(store([])), "groups").nodes).toEqual([]);
	});
});
