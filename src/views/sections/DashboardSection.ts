import { findCategorizationInconsistencies, type CategorizationFlag } from "../../categorization";
import { ACCOUNT_TYPE_META } from "../../constants";
import { fiProjection, netWorth, summarizeByYear, yearSummaryFor, YearSummary } from "../../kpi";
import type FinancePlugin from "../../main";
import { MonthDrilldownModal } from "../../modals/MonthDrilldownModal";
import { lineChart, stackedShareBar } from "../../ui/charts";
import { icon, tabSwitcher } from "../../ui/dom";
import { renderKpiCard, renderMeter } from "../../ui/kpiCard";
import { deltaRow, formatEUR, formatPct, metricRow, yearHeaderRow, yoy } from "../../ui/metricsTable";

const CAT_COLORS = ["var(--fp-cat-1)", "var(--fp-cat-2)", "var(--fp-cat-3)", "var(--fp-cat-4)", "var(--fp-cat-5)"];

const IBAN_PATTERN = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
/** Counterparty is sometimes a raw IBAN rather than a resolved merchant/person name (e.g. bank transfers) — worth blurring under privacy mode same as any other account number. */
function looksLikeIban(s: string): boolean {
	return IBAN_PATTERN.test(s.replace(/\s+/g, "").toUpperCase());
}

async function switchToAccount(plugin: FinancePlugin, accountId: string): Promise<void> {
	plugin.settings.activeAccountId = accountId;
	await plugin.saveSettings();
	plugin.refreshViews();
}

/**
 * Self-hiding data-quality nudge: recurring counterparties that are mostly tagged one category but
 * have a few outlier transactions tagged differently — the exact pattern that silently hid real
 * income inside a "Transfers" category in practice. Renders nothing when there's nothing to flag.
 */
function renderCategorizationFlags(container: HTMLElement, plugin: FinancePlugin): void {
	const wrap = container.createDiv();

	function render(): void {
		wrap.empty();
		const flags = findCategorizationInconsistencies(plugin.store);
		if (flags.length === 0) return;

		const card = wrap.createDiv({ cls: "fp-card fp-flags-card" });
		const head = card.createDiv({ cls: "fp-card-head-row" });
		head.createEl("h3", { text: "Possible categorization issues" });
		const headRight = head.createDiv({ cls: "fp-flags-head-right" });
		const refreshBtn = headRight.createEl("button", { cls: "fp-btn-icon fp-btn-ghost" });
		icon(refreshBtn, "refresh-cw");
		refreshBtn.setAttr("aria-label", "Refresh");
		refreshBtn.addEventListener("click", () => render());
		headRight.createDiv({ cls: "fp-card-head-label", text: `${flags.length} FOUND` });
		card.createEl("p", {
			cls: "fp-flags-desc",
			text: "These counterparties are mostly tagged one way, but a few transactions ended up in a different category — worth a quick check.",
		});

		const list = card.createDiv({ cls: "fp-flags-list" });
		flags.slice(0, 8).forEach((flag) => renderFlagRow(list, flag));
	}

	render();
}

function renderFlagRow(parent: HTMLElement, flag: CategorizationFlag): void {
	const row = parent.createDiv({ cls: "fp-flag-row" });
	const top = row.createDiv({ cls: "fp-flag-row-top" });
	top.createSpan({ cls: "fp-flag-row-name" + (looksLikeIban(flag.key) ? " fp-iban" : ""), text: flag.key });
	top.createSpan({
		cls: "fp-flag-row-meta",
		text: `${flag.majorityCount}/${flag.totalCount} tagged "${flag.majorityCategoryName}"`,
	});

	const outliersLine = row.createDiv({ cls: "fp-flag-row-outliers" });
	const shown = flag.outliers.slice(0, 3);
	shown.forEach((o) => {
		const chip = outliersLine.createSpan({ cls: "fp-flag-outlier" });
		chip.createSpan({ text: `${o.transaction.date} · ` });
		chip.createSpan({ cls: "fp-money", text: formatEUR(o.transaction.amount) });
		chip.createSpan({ text: ` → "${o.categoryName}"` });
	});
	if (flag.outliers.length > shown.length) {
		outliersLine.createSpan({ cls: "fp-flag-outlier-more", text: `+${flag.outliers.length - shown.length} more` });
	}
}

/**
 * Every account side by side — net worth, this year's net, savings rate, transaction count.
 * Clicking a row switches into that account's own page.
 */
function renderAccountsOverview(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;
	const card = container.createDiv({ cls: "fp-card" });
	card.createEl("h3", { text: "Accounts overview" });

	const positive = store.accounts.map((acc) => ({ acc, worth: netWorth(store, acc.id) })).filter((a) => a.worth > 0);
	if (positive.length > 0) {
		stackedShareBar(
			card,
			positive.map(({ acc, worth }, i) => ({ label: acc.name, value: worth, color: CAT_COLORS[i % CAT_COLORS.length] })),
			{ formatValue: formatEUR }
		);
	}

	const table = card.createEl("table", { cls: "fp-table" });
	const thead = table.createEl("thead").createEl("tr");
	thead.createEl("th", { text: "Account" });
	["Net worth", "This year net", "Transactions"].forEach((h) => thead.createEl("th", { text: h, cls: "fp-table-num" }));
	const tbody = table.createEl("tbody");

	store.accounts.forEach((acc) => {
		const accYears = summarizeByYear(store, acc.id);
		const accCurrent = yearSummaryFor(accYears);
		const accWorth = netWorth(store, acc.id);
		const accCount = store.transactions.filter((t) => t.accountId === acc.id).length;

		const tr = tbody.createEl("tr", { cls: "fp-table-row-clickable" });
		tr.addEventListener("click", () => void switchToAccount(plugin, acc.id));

		const nameCell = tr.createEl("td").createDiv({ cls: "fp-accounts-overview-name" });
		icon(nameCell, ACCOUNT_TYPE_META[acc.type].icon, "fp-accounts-overview-icon");
		nameCell.createSpan({ text: acc.name });

		tr.createEl("td", { text: formatEUR(accWorth), cls: "fp-table-num fp-money" });
		tr.createEl("td", { text: accCurrent ? formatEUR(accCurrent.net) : "—", cls: "fp-table-num fp-money" });
		tr.createEl("td", { text: String(accCount), cls: "fp-table-num" });
	});
}

function renderHistoryTable(panel: HTMLElement, plugin: FinancePlugin, years: YearSummary[], fiMultiplier: number): void {
	const table = panel.createEl("table", { cls: "fp-table fp-table-metrics" });
	yearHeaderRow(table, years.map((y) => y.year), {
		onClick: (year) => new MonthDrilldownModal(plugin.app, plugin, year).open(),
	});
	const tbody = table.createEl("tbody");

	metricRow(tbody, "Total income", years.map((y) => y.income), formatEUR, { heat: "normal" });
	deltaRow(tbody, years.map((y) => y.income));

	metricRow(tbody, "Total expenses", years.map((y) => y.expenses), formatEUR, { heat: "invert" });
	deltaRow(tbody, years.map((y) => y.expenses), { invert: true });

	deltaRow(tbody, years.map((y) => y.expenses), { invert: true, label: "Personal inflation rate" });

	metricRow(tbody, "Net savings", years.map((y) => y.net), formatEUR, { emphasize: true, heat: "normal" });
	metricRow(tbody, "Savings rate", years.map((y) => y.savingsRate), (n) => formatPct(n), { heat: "normal" });

	metricRow(tbody, "Net worth (EOY)", years.map((y) => y.netWorthEOY), formatEUR, { emphasize: true, heat: "normal" });
	deltaRow(tbody, years.map((y) => y.netWorthEOY));

	metricRow(
		tbody,
		`FI number (${fiMultiplier}× expenses)`,
		years.map((y) => y.expenses * fiMultiplier),
		formatEUR
	);
	metricRow(
		tbody,
		"FI ratio",
		years.map((y) => (y.expenses > 0 ? y.netWorthEOY / (y.expenses * fiMultiplier) : 0)),
		(n) => formatPct(n),
		{ heat: "normal" }
	);
	metricRow(tbody, "Passive income", years.map((y) => y.passiveIncome), formatEUR, { heat: "normal" });
}

/**
 * Every metric from the table as lines, split across two charts since they don't share a scale:
 * EUR amounts (income/expenses/net worth/...) on one, rate-based indicators (%) on the other.
 */
function renderHistoryChart(panel: HTMLElement, years: YearSummary[], fiMultiplier: number): void {
	const categories = years.map((y) => y.year);

	panel.createEl("h4", { text: "Amounts" });
	lineChart(panel, categories, [
		{ label: "Total income", color: "var(--fp-chart-income)", values: years.map((y) => y.income) },
		{ label: "Total expenses", color: "var(--fp-chart-expenses)", values: years.map((y) => y.expenses) },
		{ label: "Net savings", color: "var(--fp-chart-net)", values: years.map((y) => y.net) },
		{ label: "Net worth (EOY)", color: "var(--fp-neutral)", values: years.map((y) => y.netWorthEOY) },
		{ label: "Passive income", color: "var(--fp-good)", values: years.map((y) => y.passiveIncome) },
	]);

	panel.createEl("h4", { text: "Rates" });
	lineChart(
		panel,
		categories,
		[
			{ label: "Savings rate", color: "var(--fp-chart-net)", values: years.map((y) => y.savingsRate * 100) },
			{
				label: "FI ratio",
				color: "var(--fp-neutral)",
				values: years.map((y) => (y.expenses > 0 ? (y.netWorthEOY / (y.expenses * fiMultiplier)) * 100 : 0)),
			},
			{
				label: "Personal inflation rate",
				color: "var(--fp-chart-expenses)",
				values: years.map((y, i) => (i === 0 || years[i - 1].expenses === 0 ? 0 : ((y.expenses - years[i - 1].expenses) / years[i - 1].expenses) * 100)),
			},
		],
		{ formatValue: (n) => `${n.toFixed(1)}%`, money: false }
	);
}

/** The "All Accounts" master view: hero KPIs, an FI-progress meter, and a per-account breakdown. */
export function renderAllAccountsDashboard(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;

	const years = summarizeByYear(store);
	const currentYear = yearSummaryFor(years);
	const previousYear = yearSummaryFor(years, String(new Date().getFullYear() - 1));
	const worth = netWorth(store);

	const fiNumber = currentYear ? currentYear.expenses * plugin.settings.fiMultiplier : 0;
	const fiRatio = fiNumber > 0 ? worth / fiNumber : 0;
	const monthlyNet = currentYear ? currentYear.net / 12 : 0;
	const yearsToFi = fiNumber > 0 ? fiProjection(worth, monthlyNet, plugin.settings.expectedReturn, fiNumber) : undefined;

	const netWorthDelta = currentYear && previousYear ? yoy(currentYear.netWorthEOY, previousYear.netWorthEOY) : undefined;
	const incomeDelta = currentYear && previousYear ? yoy(currentYear.income, previousYear.income) : undefined;
	const expensesDelta = currentYear && previousYear ? yoy(currentYear.expenses, previousYear.expenses) : undefined;

	const kpis = container.createDiv({ cls: "fp-kpi-grid" });
	renderKpiCard(kpis, {
		label: "Net worth",
		value: formatEUR(worth),
		hero: true,
		delta: netWorthDelta === undefined ? undefined : { value: netWorthDelta },
		sparklineValues: years.map((y) => y.netWorthEOY),
		sparklineColor: "var(--fp-neutral)",
		sub: currentYear ? `Savings rate this year: ${formatPct(currentYear.savingsRate)}` : undefined,
	});
	renderKpiCard(kpis, {
		label: "Income this year",
		value: currentYear ? formatEUR(currentYear.income) : "—",
		hero: true,
		delta: incomeDelta === undefined ? undefined : { value: incomeDelta },
		sparklineValues: years.map((y) => y.income),
		sparklineColor: "var(--fp-chart-income)",
	});
	renderKpiCard(kpis, {
		label: "Expenses this year",
		value: currentYear ? formatEUR(currentYear.expenses) : "—",
		hero: true,
		delta: expensesDelta === undefined ? undefined : { value: expensesDelta, goodIfUp: false },
		sparklineValues: years.map((y) => y.expenses),
		sparklineColor: "var(--fp-chart-expenses)",
	});

	renderCategorizationFlags(container, plugin);

	const fiTail =
		yearsToFi === undefined ? "" : ` · ${yearsToFi.toFixed(1)} years at current pace (${(plugin.settings.expectedReturn * 100).toFixed(0)}% return)`;
	renderMeter(container, {
		label: "Progress to financial independence",
		value: fiRatio,
		valueLabel: formatPct(fiRatio),
		sub: fiNumber > 0 ? undefined : "Import transactions to calculate your FI number.",
		renderSub:
			fiNumber > 0
				? (el) => {
						el.createSpan({ cls: "fp-money", text: formatEUR(worth) });
						el.createSpan({ text: " of " });
						el.createSpan({ cls: "fp-money", text: formatEUR(fiNumber) });
						el.createSpan({ text: ` FI number${fiTail}` });
				  }
				: undefined,
	});

	renderAccountsOverview(container, plugin);

	if (years.length === 0) return;

	const fiMultiplier = plugin.settings.fiMultiplier;
	const historyCard = container.createDiv({ cls: "fp-card" });
	historyCard.createEl("h3", { text: "Historical performance" });
	tabSwitcher(historyCard, [
		{ label: "Table", render: (panel) => renderHistoryTable(panel, plugin, years, fiMultiplier) },
		{ label: "Chart", render: (panel) => renderHistoryChart(panel, years, fiMultiplier) },
	]);
}
