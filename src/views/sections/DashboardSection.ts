import { ACCOUNT_TYPE_META } from "../../constants";
import { unconvertibleCurrencies } from "../../currency";
import { fiExpenseBase, fiProjection, netWorth, netWorthAsOf, summarizeByYear, summarizeTotal, yearSummaryFor, YearSummary } from "../../kpi";
import type FinancePlugin from "../../main";
import { MonthDrilldownModal } from "../../modals/MonthDrilldownModal";
import { inRange, type DateRange } from "../../period";
import { lineChart, stackedShareBar } from "../../ui/charts";
import { icon, tabSwitcher } from "../../ui/dom";
import { renderKpiCard, renderMeter } from "../../ui/kpiCard";
import { deltaRow, formatEUR, formatPct, metricRow, metricsTable, partialYearsNote, yearHeaderRow, yearLabeller, yoy } from "../../ui/metricsTable";
import { renderSpendingByCategoryCard } from "./dashboards/SpendingByCategoryCard";

const CAT_COLORS = ["var(--fp-cat-1)", "var(--fp-cat-2)", "var(--fp-cat-3)", "var(--fp-cat-4)", "var(--fp-cat-5)"];

async function switchToAccount(plugin: FinancePlugin, accountId: string): Promise<void> {
	plugin.settings.activeAccountId = accountId;
	await plugin.saveSettings();
	plugin.refreshViews();
}

/**
 * Every account side by side — net worth, its net over the period, transaction count.
 * Clicking a row switches into that account's own page.
 */
function renderAccountsOverview(container: HTMLElement, plugin: FinancePlugin, range: DateRange | undefined, periodLabel: string): void {
	const store = plugin.store;
	const card = container.createDiv({ cls: "fp-card" });
	card.createEl("h3", { text: "Accounts overview" });

	const worthOf = (accountId?: string): number => (range?.to ? netWorthAsOf(store, range.to, accountId) : netWorth(store, accountId));

	const positive = store.accounts.map((acc) => ({ acc, worth: worthOf(acc.id) })).filter((a) => a.worth > 0);
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
	[range ? "Net worth (period end)" : "Net worth", `Net · ${periodLabel}`, "Transactions"].forEach((h) =>
		thead.createEl("th", { text: h, cls: "fp-table-num" })
	);
	const tbody = table.createEl("tbody");

	store.accounts.forEach((acc) => {
		const accYears = summarizeByYear(store, acc.id, range);
		const accCurrent = summarizeTotal(accYears);
		const accWorth = worthOf(acc.id);
		const accCount = store.transactions.filter((t) => t.accountId === acc.id && inRange(t.date, range)).length;

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

function renderHistoryTable(panel: HTMLElement, plugin: FinancePlugin, years: YearSummary[], fiMultiplier: number, periodLabel: string): void {
	const table = metricsTable(panel);
	yearHeaderRow(table, years.map((y) => y.year), {
		onClick: (year) => new MonthDrilldownModal(plugin.app, plugin, year).open(),
		labelFor: yearLabeller(years),
	});
	const tbody = table.createEl("tbody");

	metricRow(tbody, "Total income", years.map((y) => y.income), formatEUR, { heat: "normal" });
	deltaRow(tbody, years.map((y) => y.income));

	metricRow(tbody, "Total expenses", years.map((y) => y.expenses), formatEUR, { heat: "invert" });
	deltaRow(tbody, years.map((y) => y.expenses), { invert: true });

	// Named for what it actually is — the plain year-over-year change in your own recorded spending, not
	// a real inflation measure (no basket of goods, no price-level tracking, nothing "personal" about a
	// CPI-style index). "Personal inflation rate" claimed a rigor this number never had (FIN-013).
	deltaRow(tbody, years.map((y) => y.expenses), { invert: true, label: "Spending change" });

	metricRow(tbody, "Net savings", years.map((y) => y.net), formatEUR, { emphasize: true, heat: "normal" });
	metricRow(tbody, "Savings rate", years.map((y) => y.savingsRate), (n) => formatPct(n), { heat: "normal" });

	metricRow(tbody, "Net worth (EOY)", years.map((y) => y.netWorthEOY), formatEUR, { emphasize: true, heat: "normal" });
	deltaRow(tbody, years.map((y) => y.netWorthEOY));

	// Months that year's liquid (debit/savings/cash) balance would have covered at that year's own
	// spend, if income stopped entirely — a personal runway, not the multi-year FI horizon below it.
	metricRow(tbody, "Runway", years.map((y) => y.runwayMonths), (n) => `${n.toFixed(1)} mo`, { heat: "normal" });

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

	partialYearsNote(panel, years, periodLabel);
}

/**
 * Every metric from the table as lines, split across two charts since they don't share a scale:
 * EUR amounts (income/expenses/net worth/...) on one, rate-based indicators (%) on the other.
 */
function renderHistoryChart(
	panel: HTMLElement,
	years: YearSummary[],
	fiMultiplier: number,
	periodLabel: string,
	chartWidth: number
): void {
	// A line drawn through one point says nothing, and a chart that looks like a trend when it isn't
	// one is worse than no chart. The table beside this tab still shows the period's own figures.
	if (years.length < 2) {
		panel.createEl("p", {
			cls: "fp-step-desc",
			text:
				years.length === 0
					? `Nothing happened in ${periodLabel}, so there is nothing to plot.`
					: `${periodLabel} covers a single year (${years[0].year}) — these charts compare years against each other, so widen the period to see a trend.`,
		});
		return;
	}

	const categories = years.map((y) => (y.partial ? `${y.year}*` : y.year));

	panel.createEl("h4", { text: "Amounts" });
	lineChart(
		panel,
		categories,
		[
			{ label: "Total income", color: "var(--fp-chart-income)", values: years.map((y) => y.income) },
			{ label: "Total expenses", color: "var(--fp-chart-expenses)", values: years.map((y) => y.expenses) },
			{ label: "Net savings", color: "var(--fp-chart-net)", values: years.map((y) => y.net) },
			{ label: "Net worth (EOY)", color: "var(--fp-neutral)", values: years.map((y) => y.netWorthEOY) },
			{ label: "Passive income", color: "var(--fp-good)", values: years.map((y) => y.passiveIncome) },
		],
		{ width: chartWidth }
	);

	panel.createEl("h4", { text: "Rates" });
	lineChart(
		panel,
		categories,
		[
			{
				label: "Savings rate",
				color: "var(--fp-chart-net)",
				values: years.map((y) => (y.savingsRate === undefined ? null : y.savingsRate * 100)),
			},
			{
				label: "FI ratio",
				color: "var(--fp-neutral)",
				values: years.map((y) => (y.expenses > 0 ? (y.netWorthEOY / (y.expenses * fiMultiplier)) * 100 : 0)),
			},
			{
				label: "Spending change",
				color: "var(--fp-chart-expenses)",
				values: years.map((y, i) => (i === 0 || years[i - 1].expenses === 0 ? 0 : ((y.expenses - years[i - 1].expenses) / years[i - 1].expenses) * 100)),
			},
		],
		{ formatValue: (n) => `${n.toFixed(1)}%`, money: false, width: chartWidth }
	);

	partialYearsNote(panel, years, periodLabel);
}

/**
 * The "All Accounts" master view: hero KPIs, an FI-progress meter, and a per-account breakdown.
 *
 * Everything here reads the page's period filter, `range` — including the year-by-year history and
 * its charts. The one thing that deliberately doesn't is the FI number, which is an annual figure by
 * definition: see the meter below.
 */
export function renderAllAccountsDashboard(
	container: HTMLElement,
	plugin: FinancePlugin,
	range?: DateRange,
	periodLabel = "All time"
): void {
	const store = plugin.store;

	const years = summarizeByYear(store, undefined, range);
	/** The unfiltered run of years, for the two figures that can only be read against whole ones. */
	const allYears = range ? summarizeByYear(store) : years;
	// Every year the range touches, rolled into one total — for "All time" (range undefined, so `years`
	// is every year on record) that's a genuine all-time figure, not just whatever the current calendar
	// year happens to hold. A range that resolves to a single year reduces to that year's own totals.
	const current = summarizeTotal(years);
	const worth = range?.to ? netWorthAsOf(store, range.to) : netWorth(store);

	// A period that lands on exactly one whole calendar year still has a "versus the year before" that
	// means something. Five days in March does not, so the deltas simply drop out rather than compare
	// against a stretch of time of a different size.
	const wholeYear = range && range.from.endsWith("-01-01") && range.to.endsWith("-12-31") && range.from.slice(0, 4) === range.to.slice(0, 4);
	const comparedTo = wholeYear ? String(Number(range.from.slice(0, 4)) - 1) : range ? undefined : String(new Date().getFullYear() - 1);
	const previous = comparedTo ? yearSummaryFor(allYears, comparedTo) : undefined;

	// The FI number is 25× (or whatever multiple) a *year* of expenses. A week of spending × 25 is a
	// number too, just not one worth showing, so this is always built from a genuine annual figure.
	// A past, closed calendar year already has a complete total to use directly; the still-in-progress
	// current year does not, so that case falls back to the trailing 12 complete months annualized
	// instead (FIN-011) — using that year's partial total as if it were the whole year silently
	// understated the FI number (and, the same way, the monthly contribution rate below) every single
	// day of the year except December 31st.
	const todayYear = String(new Date().getFullYear());
	const explicitYear = (range?.to || "").slice(0, 4) || todayYear;
	const usingTrailing12 = explicitYear === todayYear;
	const fiYear = usingTrailing12 ? undefined : yearSummaryFor(allYears, explicitYear);
	const trailingBase = usingTrailing12 ? fiExpenseBase(store) : undefined;
	const fiExpensesAnnual = usingTrailing12 ? (trailingBase?.annual ?? 0) : (fiYear?.expenses ?? 0);
	const fiNumber = fiExpensesAnnual > 0 ? fiExpensesAnnual * plugin.settings.fiMultiplier : 0;
	const fiRatio = fiNumber > 0 ? worth / fiNumber : 0;
	// The monthly contribution rate feeding the countdown, on the *same* window as the expense base
	// above — a genuinely closed year divides its own net by 12; the trailing-12 case reuses
	// trailingBase.netAnnual rather than a separately-windowed "this year so far" figure, so the two
	// halves of the projection (target and pace) are never built from different observation periods.
	const monthlyNet = usingTrailing12 ? (trailingBase?.netAnnual ?? 0) / 12 : (fiYear?.net ?? 0) / 12;
	const yearsToFi = fiNumber > 0 ? fiProjection(worth, monthlyNet, plugin.settings.expectedReturn, fiNumber) : undefined;

	// Net worth is a point-in-time figure regardless of the period filter, so "vs a year ago" still
	// means something even in All time. Income/expenses no longer do: `current` is now this period's own
	// total (all of history, for All time), and diffing an all-time sum against one calendar year's
	// worth would produce a delta with no sensible meaning — so those two only compare when a specific
	// period (a whole year, in practice) was actually chosen.
	const netWorthDelta = current && previous ? yoy(current.netWorthEOY, previous.netWorthEOY) : undefined;
	const incomeDelta = range && current && previous ? yoy(current.income, previous.income) : undefined;
	const expensesDelta = range && current && previous ? yoy(current.expenses, previous.expenses) : undefined;

	const inPeriod = ` · ${periodLabel}`;
	const savingsRateLabel = `Savings rate · ${periodLabel}`;

	// Every figure below adds transactions across currencies at the store's configured rates; a
	// currency with no rate at all — current or historical — makes convert() return NaN rather than a
	// plausible-looking number (see currency.ts's convert(), v1.2.7 Phase 3), which renders as
	// "Incomplete" wherever it lands (formatMoney/formatPct) instead of a total that's silently wrong.
	// Surfaced here too, up front, rather than left for the reader to notice a stray "Incomplete" tile:
	// net worth, income, expenses and the FI meter are the highest-traffic totals a missing rate reaches.
	const mixedCurrencies = unconvertibleCurrencies(store.transactions, store.fx);
	if (mixedCurrencies.length > 0) {
		container.createDiv({
			cls: "fp-report-warning",
			text: `Totals below may read "Incomplete" — no exchange rate is set for ${mixedCurrencies.join(", ")}. Set one in Settings → Currency to fix them.`,
		});
	}

	const kpis = container.createDiv({ cls: "fp-kpi-grid" });
	renderKpiCard(kpis, {
		label: "Net worth",
		value: formatEUR(worth),
		hero: true,
		delta: netWorthDelta === undefined ? undefined : { value: netWorthDelta },
		sparklineValues: years.map((y) => y.netWorthEOY),
		sparklineColor: "var(--fp-neutral)",
		sub: current ? `${savingsRateLabel}: ${formatPct(current.savingsRate)}` : undefined,
	});
	renderKpiCard(kpis, {
		label: `Income${inPeriod}`,
		value: current ? formatEUR(current.income) : "—",
		hero: true,
		delta: incomeDelta === undefined ? undefined : { value: incomeDelta },
		sparklineValues: years.map((y) => y.income),
		sparklineColor: "var(--fp-chart-income)",
	});
	renderKpiCard(kpis, {
		label: `Expenses${inPeriod}`,
		value: current ? formatEUR(current.expenses) : "—",
		hero: true,
		delta: expensesDelta === undefined ? undefined : { value: expensesDelta, goodIfUp: false },
		sparklineValues: years.map((y) => y.expenses),
		sparklineColor: "var(--fp-chart-expenses)",
	});

	renderSpendingByCategoryCard(container, plugin, { scopeLabel: "All accounts", range, periodLabel });

	const fiTail =
		yearsToFi === undefined
			? ""
			: ` · ${yearsToFi.toFixed(1)} years at current pace (${(plugin.settings.expectedReturn * 100).toFixed(0)}% real return)`;
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
						if (fiYear) {
							el.createSpan({ cls: "fp-table-note", text: ` — based on ${fiYear.year}'s full year of expenses` });
						} else if (trailingBase) {
							const basis = trailingBase.complete
								? "the trailing 12 months"
								: `the trailing ${trailingBase.monthsCovered} month${trailingBase.monthsCovered === 1 ? "" : "s"} (estimate — under a year of history)`;
							el.createSpan({ cls: "fp-table-note", text: ` — based on ${basis} of expenses` });
						}
				  }
				: undefined,
	});

	renderAccountsOverview(container, plugin, range, periodLabel);

	// Nothing anywhere in the ledger: the empty states elsewhere on the page say so already.
	if (years.length === 0 && !range) return;

	const fiMultiplier = plugin.settings.fiMultiplier;
	const historyCard = container.createDiv({ cls: "fp-card" });
	historyCard.createEl("h3", { text: "Historical performance" });
	// Kept on screen when the period turns up nothing, so a narrow filter doesn't look like the
	// section quietly disappeared.
	if (years.length === 0) {
		historyCard.createEl("p", { cls: "fp-step-desc", text: `Nothing happened in ${periodLabel} — widen the period to see the years around it.` });
		return;
	}
	// The Chart tab panel starts display:none (only "Table" is active), so it can't be measured
	// directly — its clientWidth would read 0. Measure the card itself instead, whose padding
	// (18px 20px in styles.css) is the same inset the chart should sit at on every side.
	const chartWidth = historyCard.clientWidth > 0 ? historyCard.clientWidth - 40 : 640;
	tabSwitcher(historyCard, [
		{ label: "Table", render: (panel) => renderHistoryTable(panel, plugin, years, fiMultiplier, periodLabel) },
		{ label: "Chart", render: (panel) => renderHistoryChart(panel, years, fiMultiplier, periodLabel, chartWidth) },
	]);
}
