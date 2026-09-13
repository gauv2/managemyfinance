import { netWorth, summarizeByYear, summarizeTotal, yearSummaryFor } from "../../../kpi";
import type FinancePlugin from "../../../main";
import { MonthDrilldownModal } from "../../../modals/MonthDrilldownModal";
import { describeRange, monthsInRange, type DateRange } from "../../../period";
import type { Account } from "../../../types";
import { statTile } from "../../../ui/dom";
import { deltaRow, formatEUR, formatPct, metricRow, metricsTable, partialYearsNote, yearHeaderRow, yearLabeller } from "../../../ui/metricsTable";
import { renderSpendingByCategoryCard } from "./SpendingByCategoryCard";

/**
 * A checking account is the everyday spending/income hub, so its KPIs are cash-flow first:
 * balance, savings rate, and where the money actually goes.
 */
export function renderCheckingDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account, range?: DateRange): void {
	const store = plugin.store;
	const periodLabel = describeRange(range);
	const years = summarizeByYear(store, account.id, range);
	// The page filter's window, or this calendar year when it covers everything.
	const currentYear = range ? summarizeTotal(years) : yearSummaryFor(years);
	const scopeWord = range ? periodLabel : "this year";
	const balance = netWorth(store, account.id);

	const tiles = container.createDiv({ cls: "fp-stat-grid" });
	statTile(tiles, { label: "Current balance", value: formatEUR(balance), iconName: "landmark" });
	statTile(tiles, {
		label: `Savings rate (${scopeWord})`,
		value: currentYear ? formatPct(currentYear.savingsRate) : "—",
		iconName: "piggy-bank",
		tone:
			currentYear?.savingsRate === undefined
				? "neutral"
				: currentYear.savingsRate >= 0.4
					? "good"
					: currentYear.savingsRate >= 0.15
						? "warn"
						: "bad",
		money: false,
	});
	statTile(tiles, {
		label: range ? `Net · ${periodLabel}` : "Net this year",
		value: currentYear ? formatEUR(currentYear.net) : "—",
		iconName: "trending-up",
		tone: !currentYear ? "neutral" : currentYear.net >= 0 ? "good" : "bad",
	});
	statTile(tiles, {
		label: "Avg. monthly expenses",
		value: currentYear ? formatEUR(currentYear.expenses / (range ? monthsInRange(range) : 12)) : "—",
		sub: range ? `over ${periodLabel}` : undefined,
		iconName: "receipt",
	});

	if (years.length > 0) {
		const historyCard = container.createDiv({ cls: "fp-card" });
		historyCard.createEl("h3", { text: "Historical performance" });
		const table = metricsTable(historyCard);
		yearHeaderRow(table, years.map((y) => y.year), {
			onClick: (year) => new MonthDrilldownModal(plugin.app, plugin, year, account.name, account.id).open(),
			labelFor: yearLabeller(years),
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
		partialYearsNote(historyCard, years, periodLabel);
	}

	renderSpendingByCategoryCard(container, plugin, { accountId: account.id, scopeLabel: account.name, range, periodLabel });
}
