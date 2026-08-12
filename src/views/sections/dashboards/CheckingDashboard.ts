import { netWorth, primaryCategoryTotals, summarizeByYear, yearSummaryFor } from "../../../kpi";
import type FinancePlugin from "../../../main";
import { CategoryDrilldownModal } from "../../../modals/CategoryDrilldownModal";
import { MonthDrilldownModal } from "../../../modals/MonthDrilldownModal";
import type { Account } from "../../../types";
import { barChart } from "../../../ui/charts";
import { statTile } from "../../../ui/dom";
import { deltaRow, formatEUR, formatPct, metricRow, yearHeaderRow } from "../../../ui/metricsTable";

/**
 * A checking account is the everyday spending/income hub, so its KPIs are cash-flow first:
 * balance, savings rate, and where the money actually goes.
 */
export function renderCheckingDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account): void {
	const store = plugin.store;
	const years = summarizeByYear(store, account.id);
	const currentYear = yearSummaryFor(years);
	const balance = netWorth(store, account.id);

	const tiles = container.createDiv({ cls: "fp-stat-grid" });
	statTile(tiles, { label: "Current balance", value: formatEUR(balance), iconName: "landmark" });
	statTile(tiles, {
		label: "Savings rate (this year)",
		value: currentYear ? formatPct(currentYear.savingsRate) : "—",
		iconName: "piggy-bank",
		tone: !currentYear ? "neutral" : currentYear.savingsRate >= 0.4 ? "good" : currentYear.savingsRate >= 0.15 ? "warn" : "bad",
		money: false,
	});
	statTile(tiles, {
		label: "Net this year",
		value: currentYear ? formatEUR(currentYear.net) : "—",
		iconName: "trending-up",
		tone: !currentYear ? "neutral" : currentYear.net >= 0 ? "good" : "bad",
	});
	statTile(tiles, {
		label: "Avg. monthly expenses",
		value: currentYear ? formatEUR(currentYear.expenses / 12) : "—",
		iconName: "receipt",
	});

	if (years.length > 0) {
		const historyCard = container.createDiv({ cls: "fp-card" });
		historyCard.createEl("h3", { text: "Historical performance" });
		const table = historyCard.createEl("table", { cls: "fp-table fp-table-metrics" });
		yearHeaderRow(table, years.map((y) => y.year), {
			onClick: (year) => new MonthDrilldownModal(plugin.app, plugin, year, account.name, account.id).open(),
		});
		const tbody = table.createEl("tbody");

		metricRow(tbody, "Total income", years.map((y) => y.income), formatEUR, { heat: "normal" });
		deltaRow(tbody, years.map((y) => y.income));

		metricRow(tbody, "Total expenses", years.map((y) => y.expenses), formatEUR, { heat: "invert" });
		deltaRow(tbody, years.map((y) => y.expenses), { invert: true });

		metricRow(tbody, "Net savings", years.map((y) => y.net), formatEUR, { emphasize: true, heat: "normal" });
		metricRow(tbody, "Savings rate", years.map((y) => y.savingsRate), (n) => formatPct(n), { heat: "normal" });

		metricRow(tbody, "Balance (EOY)", years.map((y) => y.netWorthEOY), formatEUR, { emphasize: true, heat: "normal" });
		deltaRow(tbody, years.map((y) => y.netWorthEOY));
	}

	const totals = primaryCategoryTotals(store, currentYear?.year, account.id);
	if (totals.size > 0) {
		const catCard = container.createDiv({ cls: "fp-card" });
		catCard.createEl("h3", { text: `Spending by category — ${currentYear?.year}` });
		const categoryById = new Map(store.categories.map((c) => [c.id, c]));
		const rows = Array.from(totals.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([catId, amount]) => {
				const cat = categoryById.get(catId);
				return {
					label: cat?.name ?? "Uncategorized",
					value: amount,
					color: cat?.color ?? "#6b7280",
					iconName: cat?.icon ?? "help-circle",
					// Scoped to this account, so the drill-down's total matches the bar exactly.
					onClick: () =>
						new CategoryDrilldownModal(plugin.app, plugin, {
							categoryId: catId,
							period: currentYear?.year,
							accountId: account.id,
							scopeLabel: account.name,
						}).open(),
				};
			});
		barChart(catCard, rows);
	}
}
