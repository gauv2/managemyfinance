import { ACCOUNT_TYPE_META } from "../../../constants";
import { netWorth, netWorthAsOf } from "../../../kpi";
import type FinancePlugin from "../../../main";
import { isLiabilityType, type Account } from "../../../types";
import { lineChart } from "../../../ui/charts";
import { emptyState, icon, statTile } from "../../../ui/dom";
import { formatEUR } from "../../../ui/metricsTable";

/**
 * The dashboard for everything that has a balance but no transaction feed: a house, a pension, a
 * mortgage, a personal loan.
 *
 * These are the accounts that make net worth true rather than merely bank-shaped, and they're kept up
 * to date by hand — so this page is built around the recorded balances themselves. What it's worth
 * now, how that has moved, and one obvious button to record the next one. There is nothing to import
 * here and no spending to break down; pretending otherwise would be pure decoration.
 */
export function renderBalanceDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account): void {
	const store = plugin.store;
	const liability = isLiabilityType(account.type);
	const snapshots = store.snapshots.filter((s) => s.accountId === account.id).sort((a, b) => a.date.localeCompare(b.date));
	const latest = snapshots[snapshots.length - 1];
	const value = netWorth(store, account.id);

	const tiles = container.createDiv({ cls: "fp-stat-grid" });
	statTile(tiles, {
		label: liability ? "Still owed" : "Current value",
		value: formatEUR(Math.abs(value)),
		sub: latest ? `recorded ${latest.date}` : "from its opening balance",
		iconName: ACCOUNT_TYPE_META[account.type].icon,
		tone: liability ? (Math.abs(value) > 0 ? "warn" : "good") : "neutral",
	});

	if (snapshots.length >= 2) {
		const first = snapshots[0];
		const change = (liability ? -1 : 1) * (latest.balance - first.balance);
		statTile(tiles, {
			label: liability ? "Paid down" : "Change on record",
			value: formatEUR(Math.abs(change)),
			sub: `since ${first.date}`,
			iconName: change >= 0 ? "trending-up" : "trending-down",
			tone: change >= 0 ? "good" : "bad",
		});
		// A mortgage's remaining term is the question anyone actually has, and the pace it's been
		// paid down at so far is the only evidence available for it here.
		if (liability && change > 0) {
			const months = Math.max(1, monthsBetween(first.date, latest.date));
			const perMonth = change / months;
			if (perMonth > 0) {
				statTile(tiles, {
					label: "Clear in",
					value: `${(Math.abs(value) / perMonth / 12).toFixed(1)} yrs`,
					sub: `at ${formatEUR(perMonth)}/month, the pace so far`,
					iconName: "calendar-clock",
					money: false,
				});
			}
		}
	}

	statTile(tiles, {
		label: "Balances recorded",
		value: String(snapshots.length),
		sub: snapshots.length === 0 ? "none yet" : `first ${snapshots[0].date}`,
		iconName: "scale",
		money: false,
	});

	const card = container.createDiv({ cls: "fp-card" });
	const head = card.createDiv({ cls: "fp-section-title-row" });
	head.createEl("h3", { text: "Recorded balances" });
	const recordBtn = head.createEl("button", { cls: "fp-btn fp-btn-primary" });
	icon(recordBtn, "plus");
	recordBtn.createSpan({ text: "Record a balance" });
	recordBtn.addEventListener("click", () => plugin.openBalanceSnapshot(account.id));

	if (snapshots.length === 0) {
		emptyState(card, {
			iconName: "scale",
			title: "Nothing recorded yet",
			description: liability
				? "Record what's still owed and it starts counting against your net worth properly."
				: "Record what this is worth now, and again whenever it changes — that's what keeps net worth honest.",
			actionLabel: "Record a balance",
			onAction: () => plugin.openBalanceSnapshot(account.id),
		});
		return;
	}

	if (snapshots.length >= 2) {
		lineChart(
			card,
			snapshots.map((s) => s.date),
			[
				{
					label: liability ? "Owed" : "Value",
					color: liability ? "var(--fp-chart-expenses)" : "var(--fp-chart-net)",
					// Charted as the raw recorded figure, which for a liability is the amount owed —
					// a mortgage chart that slopes downward as you pay it off reads correctly.
					values: snapshots.map((s) => s.balance),
				},
			]
		);
	}

	const table = card.createEl("table", { cls: "fp-table" });
	const headRow = table.createEl("thead").createEl("tr");
	["Date", liability ? "Owed" : "Value", "Note", "Net worth then"].forEach((h, i) =>
		headRow.createEl("th", { text: h, cls: i === 1 || i === 3 ? "fp-table-num" : undefined })
	);
	const tbody = table.createEl("tbody");
	[...snapshots].reverse().forEach((snap) => {
		const tr = tbody.createEl("tr");
		tr.createEl("td", { text: snap.date });
		tr.createEl("td", { cls: "fp-table-num fp-money", text: formatEUR(snap.balance) });
		tr.createEl("td", { text: snap.note ?? "—" });
		tr.createEl("td", { cls: "fp-table-num fp-money", text: formatEUR(netWorthAsOf(store, snap.date)) });
	});
}

function monthsBetween(fromISO: string, toISO: string): number {
	const from = new Date(`${fromISO}T00:00:00Z`);
	const to = new Date(`${toISO}T00:00:00Z`);
	if (isNaN(from.getTime()) || isNaN(to.getTime())) return 0;
	return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}
