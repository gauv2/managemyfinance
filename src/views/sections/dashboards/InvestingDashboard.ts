import { investingActivityByYear, investingHoldings } from "../../../kpi";
import type FinancePlugin from "../../../main";
import type { Account } from "../../../types";
import { emptyState, statTile } from "../../../ui/dom";
import { formatEUR, metricRow, yearHeaderRow } from "../../../ui/metricsTable";

/**
 * There's no market-price feed here, so an investing account can't show live portfolio value or
 * unrealized P/L honestly. What it *can* show accurately from the ledger alone: what you've put in
 * (cost basis, contributions), what came back out (dividends), what it cost (fees), and what you
 * currently hold, by ticker.
 */
export function renderInvestingDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account): void {
	const store = plugin.store;
	const holdings = investingHoldings(store, account.id);
	const activity = investingActivityByYear(store, account.id);

	const totalCostBasis = holdings.reduce((sum, h) => sum + h.netInvested, 0);
	const netContributions = activity.reduce((sum, y) => sum + y.deposits - y.withdrawals, 0);
	const totalDividends = activity.reduce((sum, y) => sum + y.dividends, 0);
	const totalFees = activity.reduce((sum, y) => sum + y.fees, 0);

	const tiles = container.createDiv({ cls: "fp-stat-grid" });
	statTile(tiles, { label: "Holdings (at cost)", value: formatEUR(totalCostBasis), sub: "not live market value", iconName: "candlestick-chart" });
	statTile(tiles, { label: "Net contributions", value: formatEUR(netContributions), sub: "deposits − withdrawals", iconName: "download" });
	statTile(tiles, { label: "Dividends received", value: formatEUR(totalDividends), iconName: "coins", tone: totalDividends > 0 ? "good" : "neutral" });
	statTile(tiles, { label: "Fees paid", value: formatEUR(totalFees), iconName: "receipt", tone: "neutral" });

	const holdingsCard = container.createDiv({ cls: "fp-card" });
	holdingsCard.createEl("h3", { text: "Holdings" });
	if (holdings.length === 0) {
		emptyState(holdingsCard, {
			iconName: "candlestick-chart",
			title: "No open positions",
			description: "Buys and sells from this account will build a holdings breakdown here.",
		});
	} else {
		const table = holdingsCard.createEl("table", { cls: "fp-table" });
		const thead = table.createEl("thead").createEl("tr");
		["Ticker", "Asset class", "Shares", "Avg. cost", "Cost basis"].forEach((h, i) =>
			thead.createEl("th", { text: h, cls: i >= 2 ? "fp-table-num" : undefined })
		);
		const tbody = table.createEl("tbody");
		holdings.forEach((h) => {
			const tr = tbody.createEl("tr");
			tr.createEl("td", { text: h.ticker });
			tr.createEl("td", { text: h.assetClass || "—" });
			tr.createEl("td", { text: h.shares.toFixed(4), cls: "fp-table-num" });
			tr.createEl("td", { text: formatEUR(h.avgCost), cls: "fp-table-num fp-money" });
			tr.createEl("td", { text: formatEUR(h.netInvested), cls: "fp-table-num fp-money" });
		});
	}

	if (activity.length > 0) {
		const activityCard = container.createDiv({ cls: "fp-card" });
		activityCard.createEl("h3", { text: "Activity by year" });
		const table = activityCard.createEl("table", { cls: "fp-table fp-table-metrics" });
		yearHeaderRow(table, activity.map((y) => y.year));
		const tbody = table.createEl("tbody");
		metricRow(tbody, "Deposits", activity.map((y) => y.deposits), formatEUR, { heat: "normal" });
		metricRow(tbody, "Withdrawals", activity.map((y) => y.withdrawals), formatEUR);
		metricRow(tbody, "Dividends", activity.map((y) => y.dividends), formatEUR, { heat: "normal" });
		metricRow(tbody, "Fees", activity.map((y) => y.fees), formatEUR, { heat: "invert" });
	}
}
