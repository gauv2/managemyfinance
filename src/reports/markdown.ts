import { budgetStatuses, yearReview } from "../budgets";
import { primaryCategories } from "../categories";
import { baseCurrencyOf } from "../currency";
import {
	netWorth,
	primaryCategoryTotals,
	summarizeByMonth,
	summarizeByYear,
	yearSummaryFor,
	type KpiStore,
	type YearSummary,
} from "../kpi";
import { formatMoney } from "../money";
import type { Category } from "../types";

/**
 * Finance data written back into the vault as ordinary markdown.
 *
 * This is the half of an Obsidian plugin that a web app can't do: a report generated here is a real
 * note — linkable, searchable, syncable, greppable, and queryable by Dataview through its
 * frontmatter — rather than a view that only exists while the plugin is open. The numbers stay
 * authoritative in the ledger; these notes are a durable snapshot you can write around.
 *
 * Everything here is a pure string builder over the same calculation modules the dashboards use, so a
 * report can never disagree with the screen it was generated from.
 */

export interface ReportContext {
	store: KpiStore;
	categories: Category[];
	baseCurrency?: string;
	/** Written into the frontmatter so a regenerated report is obviously newer than an older copy. */
	generatedAt?: string;
	pluginVersion?: string;
	portfolioName?: string;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function monthLabel(month: string): string {
	const index = parseInt(month.slice(5, 7), 10) - 1;
	return index >= 0 && index < 12 ? `${MONTH_NAMES[index]} ${month.slice(0, 4)}` : month;
}

/** A number for frontmatter: plain, unformatted, two decimals — Dataview has to be able to do maths on
 *  it. Undefined (a savings rate with no meaningful denominator) writes a blank value rather than a
 *  fabricated 0, which YAML/Dataview both read as null instead of a real reading of zero. */
function numeric(n: number | undefined): string {
	if (n === undefined) return "";
	return (Math.round(n * 100) / 100).toFixed(2);
}

/** A percentage for a markdown table cell — "N/A" for undefined instead of a fabricated 0%. */
function pct(n: number | undefined): string {
	return n === undefined ? "N/A" : `${Math.round(n * 100)}%`;
}

function money(n: number, currency: string): string {
	return formatMoney(n, { currency });
}

/** YAML frontmatter from ordered key/value pairs. Values are pre-rendered; strings are quoted here. */
function frontmatter(pairs: [string, string | number][]): string {
	const lines = pairs.map(([key, value]) => `${key}: ${typeof value === "number" ? value : value}`);
	return ["---", ...lines, "---", ""].join("\n");
}

function table(headers: string[], rows: string[][]): string {
	if (rows.length === 0) return "_Nothing to report._\n";
	const head = `| ${headers.join(" | ")} |`;
	const sep = `| ${headers.map(() => "---").join(" | ")} |`;
	const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
	return [head, sep, body, ""].join("\n");
}

function categoryBreakdown(ctx: ReportContext, period: string, currency: string): string {
	const totals = primaryCategoryTotals(ctx.store, period);
	const byId = new Map(ctx.categories.map((c) => [c.id, c]));
	const rows = Array.from(totals.entries())
		.sort((a, b) => b[1] - a[1])
		.map(([id, amount]) => [byId.get(id)?.name ?? "Uncategorized", money(amount, currency)]);
	return table(["Category", "Spent"], rows);
}

/**
 * One month as a note: the headline figures in frontmatter (so a folder of these is a queryable
 * dataset), then spending by category and budget performance as readable tables.
 */
export function buildMonthlyReport(ctx: ReportContext, month: string): string {
	const currency = baseCurrencyOf({ baseCurrency: ctx.baseCurrency });
	const year = month.slice(0, 4);
	const monthIndex = parseInt(month.slice(5, 7), 10) - 1;
	const months = summarizeByMonth(ctx.store, year);
	const summary = months[monthIndex] ?? { income: 0, expenses: 0, net: 0, savingsRate: 0, passiveIncome: 0, month: month.slice(5, 7) };

	const statuses = budgetStatuses(ctx.store, ctx.categories, month);
	const byId = new Map(ctx.categories.map((c) => [c.id, c]));

	const out: string[] = [];
	out.push(
		frontmatter([
			["type", "finance-report"],
			["period", "month"],
			["month", month],
			["year", year],
			["currency", currency],
			["income", numeric(summary.income)],
			["expenses", numeric(summary.expenses)],
			["net", numeric(summary.net)],
			["savings_rate", numeric(summary.savingsRate)],
			["passive_income", numeric(summary.passiveIncome)],
			["net_worth", numeric(netWorth(ctx.store))],
			["generated", ctx.generatedAt ?? ""],
			...(ctx.portfolioName ? ([["portfolio", ctx.portfolioName]] as [string, string][]) : []),
		])
	);

	out.push(`# ${monthLabel(month)}\n`);
	out.push(
		table(
			["Metric", "Amount"],
			[
				["Income", money(summary.income, currency)],
				["Expenses", money(summary.expenses, currency)],
				["Net", money(summary.net, currency)],
				["Savings rate", pct(summary.savingsRate)],
				["Net worth (today)", money(netWorth(ctx.store), currency)],
			]
		)
	);

	out.push("## Spending by category\n");
	out.push(categoryBreakdown(ctx, month, currency));

	out.push("## Budgets\n");
	out.push(
		table(
			["Category", "Budget", "Spent", "Left", "Used"],
			statuses.map((s) => [
				byId.get(s.categoryId)?.name ?? s.categoryId,
				money(s.available, currency),
				money(s.spent, currency),
				money(s.remaining, currency),
				`${Math.round(s.pct * 100)}%`,
			])
		)
	);

	if (ctx.pluginVersion) out.push(`\n_Generated by Manage My Finance v${ctx.pluginVersion}._\n`);
	return out.join("\n");
}

function yearRow(y: YearSummary, currency: string): string[] {
	return [y.year, money(y.income, currency), money(y.expenses, currency), money(y.net, currency), pct(y.savingsRate), money(y.netWorthEOY, currency)];
}

/**
 * One year as a note: the same headline figures, plus the month-by-month walk and the plan-vs-actual
 * review that `budgetHistory` has been quietly accumulating all year.
 */
export function buildYearlyReport(ctx: ReportContext, year: string): string {
	const currency = baseCurrencyOf({ baseCurrency: ctx.baseCurrency });
	const years = summarizeByYear(ctx.store);
	const summary = yearSummaryFor(years, year);
	const months = summarizeByMonth(ctx.store, year);

	const out: string[] = [];
	out.push(
		frontmatter([
			["type", "finance-report"],
			["period", "year"],
			["year", year],
			["currency", currency],
			["income", numeric(summary?.income ?? 0)],
			["expenses", numeric(summary?.expenses ?? 0)],
			["net", numeric(summary?.net ?? 0)],
			["savings_rate", numeric(summary?.savingsRate)],
			["net_worth_eoy", numeric(summary?.netWorthEOY ?? netWorth(ctx.store))],
			["generated", ctx.generatedAt ?? ""],
			...(ctx.portfolioName ? ([["portfolio", ctx.portfolioName]] as [string, string][]) : []),
		])
	);

	out.push(`# ${year}\n`);
	out.push(table(["Year", "Income", "Expenses", "Net", "Savings rate", "Net worth (EOY)"], summary ? [yearRow(summary, currency)] : []));

	out.push("## By month\n");
	out.push(
		table(
			["Month", "Income", "Expenses", "Net", "Savings rate"],
			months.map((m, i) => [MONTH_NAMES[i], money(m.income, currency), money(m.expenses, currency), money(m.net, currency), pct(m.savingsRate)])
		)
	);

	out.push("## Spending by category\n");
	out.push(categoryBreakdown(ctx, year, currency));

	out.push("## Budget: planned vs actual\n");
	const review = yearReview(ctx.store, ctx.categories, year);
	out.push(
		table(
			["Category", "Planned", "Actual", "Variance", "Months on target"],
			review.map((r) => [
				r.categoryName,
				money(r.plannedTotal, currency),
				money(r.actualTotal, currency),
				money(r.variance, currency),
				r.monthsPlanned > 0 ? `${r.monthsOnTarget}/${r.monthsPlanned}` : "—",
			])
		)
	);

	if (ctx.pluginVersion) out.push(`\n_Generated by Manage My Finance v${ctx.pluginVersion}._\n`);
	return out.join("\n");
}

/** A net-worth-and-trajectory note, independent of any single period. */
export function buildNetWorthReport(ctx: ReportContext): string {
	const currency = baseCurrencyOf({ baseCurrency: ctx.baseCurrency });
	const years = summarizeByYear(ctx.store);
	const worth = netWorth(ctx.store);

	const out: string[] = [];
	out.push(
		frontmatter([
			["type", "finance-report"],
			["period", "net-worth"],
			["currency", currency],
			["net_worth", numeric(worth)],
			["generated", ctx.generatedAt ?? ""],
		])
	);
	out.push("# Net worth\n");
	out.push(`Current net worth: **${money(worth, currency)}**\n`);
	out.push(table(["Year", "Income", "Expenses", "Net", "Savings rate", "Net worth (EOY)"], years.map((y) => yearRow(y, currency))));

	out.push("## Accounts\n");
	out.push(
		table(
			["Account", "Type", "Balance"],
			ctx.store.accounts.map((a) => [a.name, a.type, money(netWorth(ctx.store, a.id), currency)])
		)
	);
	return out.join("\n");
}

/** Categories that have any budget planned in a month — used to decide whether a report is worth writing. */
export function hasBudgetsFor(categories: Category[], month: string): boolean {
	return primaryCategories(categories).some((c) => (c.budgetHistory?.[month] ?? 0) > 0);
}
