import { describe, expect, it } from "vitest";
import type { KpiStore } from "../kpi";
import type { Account, Category, Transaction } from "../types";
import { buildMonthlyReport, buildNetWorthReport, buildYearlyReport, type ReportContext } from "./markdown";

const account: Account = { id: "acc", name: "Checking", type: "debit", currency: "EUR", openingBalance: 1000 };
const food: Category = { id: "cat-food", name: "Food", color: "#000", icon: "utensils", aliases: [], budgetHistory: { "2024-03": 400 } };
const income: Category = { id: "cat-income", name: "Income", color: "#000", icon: "coins", aliases: [] };

let nextId = 0;
function tx(date: string, amount: number, categoryId?: string): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, date, accountId: account.id, description: "test", amount, currency: "EUR", source: "manual", categoryId };
}

function context(transactions: Transaction[]): ReportContext {
	const store: KpiStore = { accounts: [account], categories: [food, income], transactions };
	return { store, categories: [food, income], baseCurrency: "EUR", generatedAt: "2024-04-01T00:00:00Z", pluginVersion: "1.3.0" };
}

/** Parses the YAML frontmatter of a generated note into key/value pairs. */
function frontmatter(markdown: string): Record<string, string> {
	const match = /^---\n([\s\S]*?)\n---/.exec(markdown);
	if (!match) throw new Error("no frontmatter");
	const out: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx !== -1) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return out;
}

/**
 * A report is a real note in someone's vault, so its frontmatter is a data contract: Dataview has to
 * be able to do arithmetic on these values, which means plain unformatted numbers rather than
 * anything that has been through a currency formatter.
 */
describe("buildMonthlyReport", () => {
	const markdown = buildMonthlyReport(context([tx("2024-03-01", 2500, income.id), tx("2024-03-05", -300, food.id)]), "2024-03");

	it("stamps queryable frontmatter", () => {
		const fm = frontmatter(markdown);
		expect(fm.type).toBe("finance-report");
		expect(fm.period).toBe("month");
		expect(fm.month).toBe("2024-03");
		expect(fm.year).toBe("2024");
		expect(fm.currency).toBe("EUR");
	});

	it("writes numbers Dataview can add up, not formatted currency", () => {
		const fm = frontmatter(markdown);
		expect(fm.income).toBe("2500.00");
		expect(fm.expenses).toBe("300.00");
		expect(fm.net).toBe("2200.00");
		expect(Number(fm.savings_rate)).toBeCloseTo(0.88, 2);
		expect(fm.income).not.toMatch(/[€,]/);
	});

	it("includes the month's spending and budget tables", () => {
		expect(markdown).toContain("# March 2024");
		expect(markdown).toContain("## Spending by category");
		expect(markdown).toContain("## Budgets");
		expect(markdown).toContain("Food");
	});

	it("says so plainly when a section has nothing in it", () => {
		const empty = buildMonthlyReport(context([]), "2024-03");
		expect(empty).toContain("_Nothing to report._");
	});
});

describe("buildYearlyReport", () => {
	const markdown = buildYearlyReport(context([tx("2024-03-01", 2500, income.id), tx("2024-03-05", -300, food.id)]), "2024");

	it("stamps year-scoped frontmatter", () => {
		const fm = frontmatter(markdown);
		expect(fm.period).toBe("year");
		expect(fm.year).toBe("2024");
		expect(fm.income).toBe("2500.00");
	});

	it("walks every month and reviews the budget plan against what happened", () => {
		expect(markdown).toContain("## By month");
		expect(markdown).toContain("| January |");
		expect(markdown).toContain("## Budget: planned vs actual");
	});
});

describe("buildNetWorthReport", () => {
	it("reports the current figure and lists every account", () => {
		const markdown = buildNetWorthReport(context([tx("2024-03-05", -300, food.id)]));
		expect(frontmatter(markdown).period).toBe("net-worth");
		expect(markdown).toContain("# Net worth");
		expect(markdown).toContain("Checking");
	});
});
