import { Notice } from "obsidian";
import { convert } from "../../../currency";
import { investingActivityByYear, investingHoldings, investingRealizedPnLAsOf, type Holding } from "../../../kpi";
import type FinancePlugin from "../../../main";
import { fetchPrice } from "../../../marketData";
import { BalanceSnapshotModal } from "../../../modals/BalanceSnapshotModal";
import type { Account } from "../../../types";
import { emptyState, icon, statTile } from "../../../ui/dom";
import { formatEUR, metricRow, metricsTable, yearHeaderRow } from "../../../ui/metricsTable";

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
	const realizedPnL = investingRealizedPnLAsOf(store, account.id);

	const tiles = container.createDiv({ cls: "fp-stat-grid" });
	statTile(tiles, { label: "Holdings (at cost)", value: formatEUR(totalCostBasis), sub: "not live market value", iconName: "candlestick-chart" });
	statTile(tiles, { label: "Net contributions", value: formatEUR(netContributions), sub: "deposits − withdrawals", iconName: "download" });
	statTile(tiles, { label: "Dividends received", value: formatEUR(totalDividends), iconName: "coins", tone: totalDividends > 0 ? "good" : "neutral" });
	statTile(tiles, { label: "Fees paid", value: formatEUR(totalFees), iconName: "receipt", tone: "neutral" });
	statTile(tiles, {
		label: realizedPnL >= 0 ? "Realized gain (all-time)" : "Realized loss (all-time)",
		value: formatEUR(Math.abs(realizedPnL)),
		sub: "booked by sells to date, at moving-average cost",
		iconName: realizedPnL >= 0 ? "trending-up" : "trending-down",
		tone: realizedPnL >= 0 ? "good" : "bad",
	});

	const holdingsCard = container.createDiv({ cls: "fp-card" });
	const holdingsHead = holdingsCard.createDiv({ cls: "fp-card-head-row" });
	holdingsHead.createEl("h3", { text: "Holdings" });
	if (holdings.length === 0) {
		emptyState(holdingsCard, {
			iconName: "candlestick-chart",
			title: "No open positions",
			description: "Buys and sells from this account will build a holdings breakdown here.",
		});
	} else {
		const refreshBtn = holdingsHead.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(refreshBtn, "refresh-cw");
		refreshBtn.createSpan({ text: "Refresh price" });
		refreshBtn.setAttribute(
			"title",
			"Fetch today's price per holding (Yahoo Finance for ISINs, CoinGecko for crypto) and record it as an updated balance"
		);
		refreshBtn.addEventListener("click", () => void refreshHoldingsPrice(plugin, account, holdings, refreshBtn));

		const table = holdingsCard.createEl("table", { cls: "fp-table" });
		const thead = table.createEl("thead").createEl("tr");
		["Ticker", "Asset class", "Shares", "Avg. cost", "Cost basis", "Realized P/L"].forEach((h, i) =>
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
			tr.createEl("td", {
				text: h.realizedPnL === 0 ? "—" : formatEUR(h.realizedPnL),
				cls: `fp-table-num fp-money${h.realizedPnL > 0 ? " fp-delta-good" : h.realizedPnL < 0 ? " fp-delta-bad" : ""}`,
			});
		});
	}

	if (activity.length > 0) {
		const activityCard = container.createDiv({ cls: "fp-card" });
		activityCard.createEl("h3", { text: "Activity by year" });
		const table = metricsTable(activityCard);
		yearHeaderRow(table, activity.map((y) => y.year));
		const tbody = table.createEl("tbody");
		metricRow(tbody, "Deposits", activity.map((y) => y.deposits), formatEUR, { heat: "normal" });
		metricRow(tbody, "Withdrawals", activity.map((y) => y.withdrawals), formatEUR);
		metricRow(tbody, "Dividends", activity.map((y) => y.dividends), formatEUR, { heat: "normal" });
		metricRow(tbody, "Fees", activity.map((y) => y.fees), formatEUR, { heat: "invert" });
	}
}

/**
 * Fetches today's price for every current holding, sums shares × price into the account's currency,
 * and opens BalanceSnapshotModal pre-filled with that total — priced holdings only, deliberately not
 * including whatever cash is sitting uninvested in the account, since nothing in the ledger can derive
 * that figure independently once a snapshot exists (a snapshot supersedes the raw transaction-sum that
 * would otherwise stand in for "cash remaining"). Checking one cash figure in the broker's own app is a
 * small manual step left in place; pricing every position by hand is the tedious part this automates.
 */
async function refreshHoldingsPrice(plugin: FinancePlugin, account: Account, holdings: Holding[], btn: HTMLButtonElement): Promise<void> {
	btn.disabled = true;
	new Notice("Fetching current prices…");

	let total = 0;
	const failed: string[] = [];
	for (const h of holdings) {
		const quote = await fetchPrice(h.ticker, account.currency);
		if (!quote) {
			failed.push(h.ticker);
			continue;
		}
		const priceInAccountCurrency = quote.currency === account.currency ? quote.price : convert(quote.price, quote.currency, plugin.store.fx);
		total += h.shares * priceInAccountCurrency;
	}
	btn.disabled = false;

	if (failed.length === holdings.length) {
		new Notice(`Couldn't find a price for any holding (${failed.join(", ")}) — enter the balance manually instead.`);
		new BalanceSnapshotModal(plugin.app, plugin, { accountId: account.id, onSaved: () => plugin.refreshViews() }).open();
		return;
	}
	if (failed.length > 0) {
		new Notice(`Priced ${holdings.length - failed.length} of ${holdings.length} holdings — couldn't find a price for ${failed.join(", ")}. Add those to the total manually before saving.`);
	}

	new BalanceSnapshotModal(plugin.app, plugin, {
		accountId: account.id,
		prefillBalance: total,
		prefillNote: `Priced holdings as of ${new Date().toISOString().slice(0, 10)} — plus any uninvested cash, added by hand`,
		onSaved: () => plugin.refreshViews(),
	}).open();
}
