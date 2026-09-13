import { investingActivityByYear, investingHoldings, investingRealizedPnLAsOf, netWorth, snapshotAsOf } from "../../../kpi";
import type FinancePlugin from "../../../main";
import type { Account } from "../../../types";
import { emptyState, icon, statTile } from "../../../ui/dom";
import { formatEUR, metricRow, metricsTable, yearHeaderRow } from "../../../ui/metricsTable";

/**
 * Crypto used to fall through to the investing dashboard, which is close but wrong in the one way
 * that matters: a brokerage's cost basis is a reasonable proxy for its value, and a crypto wallet's
 * emphatically is not. A position bought at €4,000 and now worth €90,000 (or €400) reads as €4,000
 * either way, and nothing on the page admits it.
 *
 * So this leads with the recorded balance where there is one — a wallet value you noted yourself is
 * the only honest valuation available without a price feed — and shows cost basis beside it as what
 * it actually is: what you put in, not what you have.
 */
export function renderCryptoDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account): void {
	const store = plugin.store;
	const holdings = investingHoldings(store, account.id);
	const activity = investingActivityByYear(store, account.id);
	const snapshot = snapshotAsOf(store, account.id, "9999-12-31");

	const costBasis = holdings.reduce((sum, h) => sum + h.netInvested, 0);
	const netContributions = activity.reduce((sum, y) => sum + y.deposits - y.withdrawals, 0);
	const value = netWorth(store, account.id);
	const realizedPnL = investingRealizedPnLAsOf(store, account.id);

	const tiles = container.createDiv({ cls: "fp-stat-grid" });
	statTile(tiles, {
		label: snapshot ? "Recorded value" : "Value (from ledger)",
		value: formatEUR(value),
		sub: snapshot ? `as of ${snapshot.date}` : "no balance recorded — this is cost, not market value",
		iconName: "bitcoin",
		tone: snapshot ? "good" : "warn",
	});
	statTile(tiles, { label: "Invested (at cost)", value: formatEUR(costBasis), sub: "what you paid", iconName: "download" });
	statTile(tiles, { label: "Net contributions", value: formatEUR(netContributions), sub: "deposits − withdrawals", iconName: "arrow-left-right" });
	if (realizedPnL !== 0) {
		statTile(tiles, {
			label: realizedPnL >= 0 ? "Realized gain (all-time)" : "Realized loss (all-time)",
			value: formatEUR(Math.abs(realizedPnL)),
			sub: "booked by sells to date, at moving-average cost",
			iconName: realizedPnL >= 0 ? "trending-up" : "trending-down",
			tone: realizedPnL >= 0 ? "good" : "bad",
		});
	}

	if (snapshot && costBasis > 0) {
		const gain = value - costBasis;
		statTile(tiles, {
			label: gain >= 0 ? "Unrealized gain" : "Unrealized loss",
			value: formatEUR(Math.abs(gain)),
			sub: `${((gain / costBasis) * 100).toFixed(1)}% against cost`,
			iconName: gain >= 0 ? "trending-up" : "trending-down",
			tone: gain >= 0 ? "good" : "bad",
		});
	}

	if (!snapshot) {
		const notice = container.createDiv({ cls: "fp-card" });
		const row = notice.createDiv({ cls: "fp-linked-row" });
		icon(row, "info", "fp-linked-icon");
		row.createSpan({
			text: "There's no price feed here, so this wallet is valued at what you paid for it. Record what it's actually worth and every figure above becomes real.",
		});
		const btn = row.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(btn, "scale");
		btn.createSpan({ text: "Record a balance" });
		btn.addEventListener("click", () => plugin.openBalanceSnapshot(account.id));
	}

	const holdingsCard = container.createDiv({ cls: "fp-card" });
	holdingsCard.createEl("h3", { text: "Holdings" });
	if (holdings.length === 0) {
		emptyState(holdingsCard, {
			iconName: "bitcoin",
			title: "No positions tracked",
			description: "Buys and sells imported from an exchange export build a per-coin breakdown here.",
		});
	} else {
		const table = holdingsCard.createEl("table", { cls: "fp-table" });
		const thead = table.createEl("thead").createEl("tr");
		["Coin", "Units", "Avg. cost", "Invested", "Realized P/L"].forEach((h, i) =>
			thead.createEl("th", { text: h, cls: i >= 1 ? "fp-table-num" : undefined })
		);
		const tbody = table.createEl("tbody");
		holdings.forEach((h) => {
			const tr = tbody.createEl("tr");
			tr.createEl("td", { text: h.ticker });
			// More decimals than an equity dashboard shows, because a fraction of a coin is normal.
			tr.createEl("td", { text: h.shares.toFixed(8).replace(/0+$/, "").replace(/\.$/, ""), cls: "fp-table-num" });
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
		metricRow(tbody, "Fees", activity.map((y) => y.fees), formatEUR, { heat: "invert" });
	}
}
