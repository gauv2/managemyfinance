import { averageMonthlyExpenses, netWorth, summarizeByYear, yearSummaryFor } from "../../../kpi";
import type FinancePlugin from "../../../main";
import { MonthDrilldownModal } from "../../../modals/MonthDrilldownModal";
import type { Account } from "../../../types";
import { statTile } from "../../../ui/dom";
import { deltaRow, formatEUR, metricRow, yearHeaderRow, yoy } from "../../../ui/metricsTable";

/**
 * A savings account's job is to hold a buffer and grow — so its KPIs center on balance growth and
 * how many months of everyday spending that balance would cover (the emergency-fund read).
 */
export function renderSavingsDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account): void {
	const store = plugin.store;
	const years = summarizeByYear(store, account.id);
	const currentYear = yearSummaryFor(years);
	const previousYear = yearSummaryFor(years, String(new Date().getFullYear() - 1));
	const balance = netWorth(store, account.id);

	const spendingAccountIds = store.accounts.filter((a) => a.type === "debit" || a.type === "cash").map((a) => a.id);
	const avgMonthlyExpenses = averageMonthlyExpenses(store, spendingAccountIds.length > 0 ? spendingAccountIds : undefined);
	const monthsCovered = avgMonthlyExpenses > 0 ? balance / avgMonthlyExpenses : undefined;

	const balanceDelta = currentYear && previousYear ? yoy(currentYear.netWorthEOY, previousYear.netWorthEOY) : undefined;

	const tiles = container.createDiv({ cls: "fp-stat-grid" });
	statTile(tiles, { label: "Current balance", value: formatEUR(balance), iconName: "piggy-bank" });
	statTile(tiles, {
		label: "Balance growth (YoY)",
		value: balanceDelta === undefined ? "—" : `${balanceDelta >= 0 ? "+" : ""}${(balanceDelta * 100).toFixed(1)}%`,
		iconName: "trending-up",
		tone: balanceDelta === undefined ? "neutral" : balanceDelta >= 0 ? "good" : "bad",
		money: false,
	});
	statTile(tiles, {
		label: "Emergency fund coverage",
		value: monthsCovered === undefined ? "—" : `${monthsCovered.toFixed(1)} mo`,
		sub: "vs. average monthly spending",
		iconName: "shield",
		tone: monthsCovered === undefined ? "neutral" : monthsCovered >= 6 ? "good" : monthsCovered >= 3 ? "warn" : "bad",
		money: false,
	});
	statTile(tiles, {
		label: "Net deposits this year",
		value: currentYear ? formatEUR(currentYear.net) : "—",
		iconName: "download",
	});

	if (years.length > 0) {
		const card = container.createDiv({ cls: "fp-card" });
		card.createEl("h3", { text: "Balance history" });
		const table = card.createEl("table", { cls: "fp-table fp-table-metrics" });
		yearHeaderRow(table, years.map((y) => y.year), {
			onClick: (year) => new MonthDrilldownModal(plugin.app, plugin, year, account.name, account.id).open(),
		});
		const tbody = table.createEl("tbody");
		metricRow(tbody, "Balance (EOY)", years.map((y) => y.netWorthEOY), formatEUR, { emphasize: true, heat: "normal" });
		deltaRow(tbody, years.map((y) => y.netWorthEOY));
		metricRow(tbody, "Net deposits", years.map((y) => y.net), formatEUR, { heat: "normal" });
	} else {
		const card = container.createDiv({ cls: "fp-card" });
		card.createEl("p", {
			cls: "fp-step-desc",
			text: `No transactions recorded on this account yet — its balance reflects the opening balance you set (${formatEUR(balance)}).`,
		});
	}
}
