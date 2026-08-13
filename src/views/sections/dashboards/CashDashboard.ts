import { netWorth, summarizeByYear, summarizeTotal, yearSummaryFor } from "../../../kpi";
import type FinancePlugin from "../../../main";
import { describeRange, inRange, type DateRange } from "../../../period";
import type { Account } from "../../../types";
import { statTile } from "../../../ui/dom";
import { formatEUR } from "../../../ui/metricsTable";

/** Physical cash is rarely tracked transaction-by-transaction, so this stays deliberately light: balance and activity, nothing more. */
export function renderCashDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account, range?: DateRange): void {
	const store = plugin.store;
	const balance = netWorth(store, account.id);
	const years = summarizeByYear(store, account.id, range);
	const current = range ? summarizeTotal(years) : yearSummaryFor(years);
	const onAccount = store.transactions.filter((t) => t.accountId === account.id);
	const count = onAccount.filter((t) => inRange(t.date, range)).length;

	const tiles = container.createDiv({ cls: "fp-stat-grid" });
	statTile(tiles, { label: "Current balance", value: formatEUR(balance), iconName: "banknote" });
	statTile(tiles, {
		label: range ? `Net · ${describeRange(range)}` : "Net this year",
		value: current ? formatEUR(current.net) : "—",
		iconName: "trending-up",
	});
	statTile(tiles, { label: "Transactions logged", value: String(count), iconName: "list", money: false });

	if (onAccount.length === 0) {
		const card = container.createDiv({ cls: "fp-card" });
		card.createEl("p", {
			cls: "fp-step-desc",
			text: `No transactions recorded on this account yet — its balance reflects the opening balance you set (${formatEUR(balance)}).`,
		});
	}
}
