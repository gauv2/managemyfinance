import { allYearsBetween, buildComparison, missingYears, topCategories, type CategoryMeta, type Comparison } from "../../compare";
import { isTransfer, primaryCategoryTotals } from "../../kpi";
import type FinancePlugin from "../../main";
import { CategoryDrilldownModal } from "../../modals/CategoryDrilldownModal";
import { transactionYears } from "../../period";
import { merchantDisplayName } from "../../import/merchantKey";
import { buildStats, type LedgerStats } from "../../stats";
import { lineChart, type ChartSeries } from "../../ui/charts";
import { icon } from "../../ui/dom";
import { formatEUR, formatPct, heatColor } from "../../ui/metricsTable";

/**
 * The Compare page: one category, several years, side by side.
 *
 * Every other page answers a question about a single window — this month, this year, this account.
 * That is the wrong instrument for "is this getting worse", which needs the same category measured
 * repeatedly and the differences made explicit. So the axis here is years rather than a period, and
 * the arithmetic anyone would otherwise do in their head (against last year, across the span, per
 * year compounded, as a share of the bill) is done in src/compare.ts and shown rather than implied.
 *
 * Two display choices earn their keep. Indexing rebases every line to 100 at the first selected
 * year, which is the only way a €200 category and a €20,000 one can be compared for *rate* of change
 * on the same axis. And the chart plots a handful of categories while the table holds all of them:
 * thirty lines is a picture of nothing, but thirty rows is a perfectly good table.
 */

const DEFAULT_YEARS = 3;
const DEFAULT_PLOTTED = 6;

interface CompareState {
	/** Selected years, ascending. Empty until the first render picks defaults from the data. */
	years: string[];
	/** Category ids drawn on the chart. Everything else still appears in the table. */
	plotted: string[];
	/** Undefined means every account combined. */
	accountId?: string;
	mode: "amount" | "index";
	initialised: boolean;
}

const state: CompareState = { years: [], plotted: [], mode: "amount", initialised: false };

export function renderCompareSection(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;
	const draw = (): void => {
		container.empty();
		renderCompareSection(container, plugin);
	};

	const scopedDates = store.transactions
		.filter((t) => !state.accountId || t.accountId === state.accountId)
		.map((t) => t.date);
	const availableYears = transactionYears(scopedDates);

	container.addClass("fp-section");
	const header = container.createDiv({ cls: "fp-section-header" });
	const headText = header.createDiv({ cls: "fp-section-header-text" });
	const titleRow = headText.createDiv({ cls: "fp-section-title-row" });
	icon(titleRow.createDiv({ cls: "fp-section-icon-badge" }), "trending-up");
	titleRow.createEl("h2", { text: "Compare" });
	headText.createDiv({
		cls: "fp-section-subtitle",
		text: "The same categories across several years, with the differences worked out — what grew, what shrank, by how much, and how fast.",
	});

	if (availableYears.length === 0) {
		container.createEl("p", { cls: "fp-step-desc", text: "No transactions yet — import some and this page fills in." });
		return;
	}

	// Defaults are chosen once per session, from whatever the ledger actually holds: the most recent
	// few years, which is the comparison nearly everyone wants before they touch a control.
	//
	// transactionYears hands back newest-first, which suits a dropdown and is exactly wrong here —
	// every reading of this page assumes time runs left to right, and so do the deltas, which compare
	// each year against the one before it. Sorted ascending on the way in, at every entry point.
	const recentFirst = availableYears.slice(0, DEFAULT_YEARS);
	if (!state.initialised) {
		state.years = [...recentFirst].sort();
		state.initialised = true;
	}
	// A remembered year can vanish when the account scope changes — drop anything this scope lacks.
	state.years = state.years.filter((y) => availableYears.includes(y)).sort();
	if (state.years.length === 0) state.years = [...recentFirst].sort();

	const comparison = buildComparison(
		state.years,
		state.years.map((y) => primaryCategoryTotals(store, y, state.accountId)),
		categoryMeta(plugin)
	);

	if (state.plotted.length === 0) state.plotted = topCategories(comparison, DEFAULT_PLOTTED);
	// Keep the plotted set honest: a category can disappear when years or accounts change.
	const known = new Set(comparison.rows.map((r) => r.categoryId));
	state.plotted = state.plotted.filter((id) => known.has(id));
	if (state.plotted.length === 0) state.plotted = topCategories(comparison, DEFAULT_PLOTTED);

	renderControls(container, plugin, availableYears, comparison, draw);
	renderChart(container, comparison);
	renderMovers(container, comparison);
	renderTable(container, plugin, comparison);
	renderRecords(container, plugin);
}

/** Primary categories only — the rows the totals are keyed by — plus the bucket for uncategorized spend. */
function categoryMeta(plugin: FinancePlugin): Map<string, CategoryMeta> {
	const meta = new Map<string, CategoryMeta>();
	plugin.store.categories
		.filter((c) => !c.parentId)
		.forEach((c) => meta.set(c.id, { id: c.id, label: c.name, color: c.color, icon: c.icon }));
	meta.set("uncategorized", { id: "uncategorized", label: "Uncategorized", color: "#6b7280", icon: "circle-help" });
	return meta;
}

function renderControls(
	container: HTMLElement,
	plugin: FinancePlugin,
	availableYears: string[],
	comparison: Comparison,
	draw: () => void
): void {
	const card = container.createDiv({ cls: "fp-card fp-compare-controls" });

	const yearRow = card.createDiv({ cls: "fp-compare-row" });
	yearRow.createSpan({ cls: "fp-filter-label", text: "Years" });
	const yearChips = yearRow.createDiv({ cls: "fp-compare-chips" });
	availableYears.forEach((y) => {
		const on = state.years.includes(y);
		const chip = yearChips.createEl("button", { cls: "fp-compare-chip" + (on ? " is-on" : ""), text: y });
		chip.addEventListener("click", () => {
			// Never let the last year be switched off: a comparison of nothing has no meaning, and an
			// empty chart is a worse answer than the single year the click was trying to leave.
			if (on && state.years.length === 1) return;
			state.years = on ? state.years.filter((v) => v !== y) : [...state.years, y].sort();
			draw();
		});
	});

	const scopeRow = card.createDiv({ cls: "fp-compare-row" });
	scopeRow.createSpan({ cls: "fp-filter-label", text: "Accounts" });
	const scopeSelect = scopeRow.createEl("select", { cls: "fp-filter-select" });
	scopeSelect.createEl("option", { text: "All accounts", value: "" });
	plugin.store.accounts.forEach((a) => scopeSelect.createEl("option", { text: a.name, value: a.id }));
	scopeSelect.value = state.accountId ?? "";
	scopeSelect.addEventListener("change", () => {
		state.accountId = scopeSelect.value || undefined;
		state.plotted = [];
		draw();
	});

	scopeRow.createSpan({ cls: "fp-filter-label", text: "Scale" });
	const modeSelect = scopeRow.createEl("select", { cls: "fp-filter-select" });
	modeSelect.createEl("option", { text: "Amount", value: "amount" });
	modeSelect.createEl("option", { text: `Indexed (${state.years[0] ?? "first"} = 100)`, value: "index" });
	modeSelect.value = state.mode;
	modeSelect.addEventListener("change", () => {
		state.mode = modeSelect.value === "index" ? "index" : "amount";
		draw();
	});

	const catRow = card.createDiv({ cls: "fp-compare-row" });
	catRow.createSpan({ cls: "fp-filter-label", text: "On the chart" });
	const catChips = catRow.createDiv({ cls: "fp-compare-chips" });
	comparison.rows.forEach((row) => {
		const on = state.plotted.includes(row.categoryId);
		const chip = catChips.createEl("button", { cls: "fp-compare-chip fp-compare-chip-cat" + (on ? " is-on" : "") });
		const dot = chip.createSpan({ cls: "fp-compare-chip-dot" });
		dot.style.setProperty("--fp-chip-dot", row.color);
		chip.createSpan({ text: row.label });
		chip.addEventListener("click", () => {
			state.plotted = on ? state.plotted.filter((id) => id !== row.categoryId) : [...state.plotted, row.categoryId];
			draw();
		});
	});
}

function renderChart(container: HTMLElement, comparison: Comparison): void {
	const card = container.createDiv({ cls: "fp-card" });
	const head = card.createDiv({ cls: "fp-card-head-row" });
	head.createEl("h3", { text: "Spend per year" });
	head.createSpan({
		cls: "fp-card-head-note",
		text: state.mode === "index" ? `Indexed — ${comparison.years[0]} = 100` : "Per category, per year",
	});

	if (state.plotted.length === 0 || comparison.years.length === 0) {
		card.createEl("p", { cls: "fp-step-desc", text: "Pick a category above to plot it." });
		return;
	}
	if (comparison.years.length === 1) {
		card.createEl("p", {
			cls: "fp-step-desc",
			text: "One year selected — add another to see a trend. The table below still holds the numbers.",
		});
		return;
	}

	// Card padding is 18px 20px in styles.css — the same inset the chart should sit at on every side.
	const chartWidth = card.clientWidth > 0 ? card.clientWidth - 40 : 640;
	// The axis is the whole calendar span, not just the ticked years.
	//
	// Plotting only the selection spaced it evenly, so 2023 and 2026 sat side by side as though one
	// followed the other — a three-year jump drawn as a single step, which is a straightforwardly false
	// picture. The unticked years keep their place on the axis and carry no reading, so the line breaks
	// across them rather than running through a period nothing was asked about.
	const gaps = missingYears(comparison.years);
	const axis = gaps.length === 0 ? comparison.years : allYearsBetween(comparison.years);
	const slotOf = new Map(axis.map((y, i) => [y, i]));

	const plotted = comparison.rows.filter((r) => state.plotted.includes(r.categoryId));
	const series: ChartSeries[] = plotted.map((row) => {
		const values = state.mode === "index" ? indexed(row.values) : row.values;
		const byYear = new Map(comparison.years.map((y, i) => [y, values[i]]));
		return {
			label: row.label,
			color: row.color,
			values: axis.map((y) => (byYear.has(y) ? byYear.get(y)! : null)),
		};
	});

	if (gaps.length > 0) {
		card.createDiv({
			cls: "fp-step-desc",
			text: `${gaps.join(", ")} ${gaps.length === 1 ? "is" : "are"} not selected, so the line breaks there. Percentages and the per-year rate use the real distance.`,
		});
	}

	lineChart(card, axis, series, {
		height: 260,
		width: chartWidth,
		money: state.mode === "amount",
		...(state.mode === "index" ? { formatValue: (n: number) => `${Math.round(n)}` } : {}),
	});
}

/**
 * Rebases a series so the first year is 100. A category that starts at zero has no base to rebase
 * against, so it stays at zero rather than becoming an infinite spike that flattens every other line.
 */
function indexed(values: number[]): number[] {
	const base = values[0];
	if (!base) return values.map(() => 0);
	return values.map((v) => (v / base) * 100);
}

function renderMovers(container: HTMLElement, comparison: Comparison): void {
	if (comparison.years.length < 2) return;
	const first = comparison.years[0];
	const last = comparison.years[comparison.years.length - 1];
	const prev = comparison.years[comparison.years.length - 2];

	const card = container.createDiv({ cls: "fp-card" });
	const head = card.createDiv({ cls: "fp-card-head-row" });
	head.createEl("h3", { text: "What moved" });
	head.createSpan({ cls: "fp-card-head-note", text: comparison.moversSpanned ? `${first} → ${last}` : `${prev} → ${last}` });

	const totalNote = card.createDiv({ cls: "fp-compare-total-note" });
	const totalLast = comparison.totals[comparison.totals.length - 1] ?? 0;
	totalNote.createSpan({ cls: "fp-money", text: formatEUR(totalLast) });
	totalNote.createSpan({ text: ` total in ${last}` });
	if (comparison.totalChangePct !== undefined) {
		const up = comparison.totalChangePct >= 0;
		totalNote.createSpan({
			cls: "fp-compare-delta " + (up ? "is-up" : "is-down"),
			text: `${up ? "▲" : "▼"} ${formatPctSize(comparison.totalChangePct, 1)} vs ${prev}`,
		});
	}
	if (comparison.totalSpanChangePct !== undefined && comparison.years.length > 2) {
		const up = comparison.totalSpanChangePct >= 0;
		totalNote.createSpan({
			cls: "fp-compare-delta " + (up ? "is-up" : "is-down"),
			text: `${up ? "▲" : "▼"} ${formatPctSize(comparison.totalSpanChangePct, 1)} since ${first}`,
		});
	}

	const cols = card.createDiv({ cls: "fp-compare-movers" });
	const spanned = comparison.moversSpanned;
	moverList(cols, "Grew the most", comparison.risers.slice(0, 5), true, spanned, comparison.years);
	moverList(cols, "Shrank the most", comparison.fallers.slice(0, 5), false, spanned, comparison.years);
}

/**
 * The movers as a table, one column per selected year.
 *
 * A single net figure — "+€23,417 since 2023" — cannot say whether that arrived steadily or landed in
 * one year, which is the first thing anyone asks of a mover. Laid out in columns the shape of the
 * change is readable at a glance, and the numbers line up with the chart above and the full table
 * below rather than being a third, differently-shaped summary.
 */
function moverList(
	parent: HTMLElement,
	title: string,
	rows: Comparison["risers"],
	up: boolean,
	spanned: boolean,
	years: string[]
): void {
	const col = parent.createDiv({ cls: "fp-compare-mover-col" });
	col.createEl("h4", { text: title });
	if (rows.length === 0) {
		col.createEl("p", { cls: "fp-step-desc", text: up ? "Nothing grew." : "Nothing shrank." });
		return;
	}

	const wrap = col.createDiv({ cls: "fp-table-scroll" });
	const table = wrap.createEl("table", { cls: "fp-table fp-compare-mover-table" });
	const head = table.createEl("thead").createEl("tr");
	head.createEl("th", { text: "Category" });
	years.forEach((y) => head.createEl("th", { text: y, cls: "fp-table-num" }));
	head.createEl("th", { text: "Change", cls: "fp-table-num" });
	head.createEl("th", { text: "%", cls: "fp-table-num" });

	const body = table.createEl("tbody");
	rows.forEach((row) => {
		const tr = body.createEl("tr");
		const label = tr.createEl("td");
		const dot = label.createSpan({ cls: "fp-compare-chip-dot" });
		dot.style.setProperty("--fp-chip-dot", row.color);
		label.createSpan({ text: row.label });

		row.values.forEach((v) => tr.createEl("td", { cls: "fp-table-num fp-money", text: formatEUR(v) }));

		const abs = spanned ? (row.spanChangeAbs ?? 0) : (row.changeAbs ?? 0);
		const pct = spanned ? row.spanChangePct : row.changePct;
		tr.createEl("td", {
			cls: "fp-table-num fp-money " + (up ? "fp-compare-up" : "fp-compare-down"),
			text: `${up ? "+" : ""}${formatEUR(abs)}`,
		});
		tr.createEl("td", {
			cls: "fp-table-num " + (up ? "fp-compare-up" : "fp-compare-down"),
			text: pct === undefined ? "new" : formatPctSize(pct, 0),
		});
	});
}

function renderTable(container: HTMLElement, plugin: FinancePlugin, comparison: Comparison): void {
	const card = container.createDiv({ cls: "fp-card" });
	const head = card.createDiv({ cls: "fp-card-head-row" });
	head.createEl("h3", { text: "Every category" });
	head.createSpan({ cls: "fp-card-head-note", text: "Click a category to see the transactions behind it" });

	const multi = comparison.years.length > 1;
	const wrap = card.createDiv({ cls: "fp-table-scroll" });
	const table = wrap.createEl("table", { cls: "fp-table fp-compare-table" });

	const thead = table.createEl("thead").createEl("tr");
	thead.createEl("th", { text: "Category" });
	comparison.years.forEach((y) => thead.createEl("th", { text: y, cls: "fp-table-num" }));
	if (multi) {
		thead.createEl("th", { text: "Δ", cls: "fp-table-num" });
		thead.createEl("th", { text: "vs prev", cls: "fp-table-num" });
		thead.createEl("th", { text: "span", cls: "fp-table-num" });
		thead.createEl("th", { text: "per yr", cls: "fp-table-num" });
	}
	thead.createEl("th", { text: "share", cls: "fp-table-num" });

	const tbody = table.createEl("tbody");
	comparison.rows.forEach((row) => {
		const tr = tbody.createEl("tr", { cls: "fp-compare-row-clickable" });
		const labelCell = tr.createEl("td");
		const dot = labelCell.createSpan({ cls: "fp-compare-chip-dot" });
		dot.style.setProperty("--fp-chip-dot", row.color);
		if (row.icon) icon(labelCell, row.icon, "fp-compare-row-icon");
		labelCell.createSpan({ text: row.label });
		tr.setAttribute("role", "button");
		tr.setAttribute("tabindex", "0");
		const open = (): void => {
			new CategoryDrilldownModal(plugin.app, plugin, {
				categoryId: row.categoryId,
				scopeLabel: state.accountId ? (plugin.store.accounts.find((a) => a.id === state.accountId)?.name ?? "Account") : "All accounts",
				periodLabel: comparison.years.join(", "),
			}).open();
		};
		tr.addEventListener("click", open);
		tr.addEventListener("keydown", (ev: KeyboardEvent) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				open();
			}
		});

		// Heat runs across the row, so the worst year for a category is obvious without reading digits.
		const min = Math.min(...row.values);
		const max = Math.max(...row.values);
		row.values.forEach((v) => {
			const cell = tr.createEl("td", { cls: "fp-table-num fp-money", text: formatEUR(v) });
			if (max > min && v !== 0) cell.style.background = heatColor((v - min) / (max - min), true);
		});

		if (multi) {
			numCell(tr, row.changeAbs === undefined ? "—" : formatEUR(row.changeAbs), row.changeAbs);
			numCell(tr, row.changePct === undefined ? "—" : formatPct(row.changePct, 0), row.changePct);
			numCell(tr, row.spanChangePct === undefined ? "—" : formatPct(row.spanChangePct, 0), row.spanChangePct);
			numCell(tr, row.cagr === undefined ? "—" : formatPct(row.cagr, 1), row.cagr);
		}
		tr.createEl("td", { cls: "fp-table-num", text: formatPct(row.shareOfLast, 0) });
	});

	const totalRow = tbody.createEl("tr", { cls: "fp-table-row-emphasis" });
	totalRow.createEl("td", { text: "Total" });
	comparison.totals.forEach((t) => totalRow.createEl("td", { cls: "fp-table-num fp-money", text: formatEUR(t) }));
	if (multi) {
		const lastTotal = comparison.totals[comparison.totals.length - 1] ?? 0;
		const prevTotal = comparison.totals[comparison.totals.length - 2] ?? 0;
		numCell(totalRow, formatEUR(lastTotal - prevTotal), lastTotal - prevTotal);
		numCell(totalRow, comparison.totalChangePct === undefined ? "—" : formatPct(comparison.totalChangePct, 0), comparison.totalChangePct);
		numCell(totalRow, comparison.totalSpanChangePct === undefined ? "—" : formatPct(comparison.totalSpanChangePct, 0), comparison.totalSpanChangePct);
		totalRow.createEl("td", { cls: "fp-table-num", text: "—" });
	}
	totalRow.createEl("td", { cls: "fp-table-num", text: "100%" });
}

/**
 * Magnitude only, no sign. formatPct always prefixes a "+" for non-negative input, so handing it an
 * absolute value produced "▼ +35.8%" — an arrow and a sign pointing opposite ways. Where direction is
 * already carried by an arrow and a colour, the number should be the size of the move and nothing more.
 */
function formatPctSize(n: number, digits = 0): string {
	return `${(Math.abs(n) * 100).toFixed(digits)}%`;
}

/** A number cell tinted by direction. Spending up is bad, so the sign is read the other way round. */
function numCell(tr: HTMLTableRowElement, text: string, value: number | undefined): void {
	const cls = value === undefined || value === 0 ? "" : value > 0 ? " fp-compare-up" : " fp-compare-down";
	tr.createEl("td", { cls: "fp-table-num" + cls, text });
}

/**
 * The records card: the firsts and the biggests.
 *
 * Deliberately whole-ledger rather than following the year selection above it. "The first thing in
 * here" and "the most that ever left in one go" are facts about the ledger, and narrowing them to a
 * two-year window turns them into something much less interesting that reads the same.
 */
function renderRecords(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;
	const stats = buildStats(
		store.transactions,
		(tx) => merchantDisplayName(tx.description || tx.counterparty || ""),
		(tx) => isTransfer(store, tx)
	);
	if (stats.counted === 0) return;

	const card = container.createDiv({ cls: "fp-card" });
	const head = card.createDiv({ cls: "fp-card-head-row" });
	head.createEl("h3", { text: "Records" });
	head.createSpan({
		cls: "fp-card-head-note",
		text: stats.spanDays
			? `${stats.counted.toLocaleString()} transactions over ${Math.floor(stats.spanDays / 365)} years`
			: `${stats.counted.toLocaleString()} transactions`,
	});

	const grid = card.createDiv({ cls: "fp-records-grid" });

	const record = (label: string, value: string, sub?: string, tone?: "good" | "bad"): void => {
		const box = grid.createDiv({ cls: "fp-record" });
		box.createDiv({ cls: "fp-record-label", text: label });
		box.createDiv({ cls: "fp-record-value fp-money" + (tone ? ` is-${tone}` : ""), text: value });
		if (sub) box.createDiv({ cls: "fp-record-sub fp-sensitive", text: sub });
	};

	const describe = (tx: { description?: string; counterparty?: string } | undefined): string =>
		(tx?.description || tx?.counterparty || "—").slice(0, 46);

	if (stats.first) record("First record", stats.first.date ?? "—", describe(stats.first));
	if (stats.latest) record("Most recent", stats.latest.date ?? "—", describe(stats.latest));

	if (stats.biggestExpense) {
		record("Biggest single spend", formatEUR(stats.biggestExpense.amount), `${stats.biggestExpense.transaction.date} · ${describe(stats.biggestExpense.transaction)}`, "bad");
	}
	if (stats.biggestIncome) {
		record("Biggest single receipt", formatEUR(stats.biggestIncome.amount), `${stats.biggestIncome.transaction.date} · ${describe(stats.biggestIncome.transaction)}`, "good");
	}
	if (stats.heaviestDay) record("Heaviest day", formatEUR(stats.heaviestDay.total), stats.heaviestDay.date, "bad");
	if (stats.busiestDay) record("Busiest day", `${stats.busiestDay.count} transactions`, stats.busiestDay.date);
	if (stats.costliestMonth) record("Costliest month", formatEUR(stats.costliestMonth.total), stats.costliestMonth.month, "bad");
	if (stats.topMerchantBySpend) {
		record("Most spent at", formatEUR(stats.topMerchantBySpend.total), `${stats.topMerchantBySpend.name} · ${stats.topMerchantBySpend.count} visits`);
	}
	if (stats.topMerchantByVisits) {
		record("Most visited", `${stats.topMerchantByVisits.count} times`, `${stats.topMerchantByVisits.name} · ${formatEUR(stats.topMerchantByVisits.total)}`);
	}
	record("Typical spend", formatEUR(stats.averageExpense), "per transaction");
	if (stats.longestQuietStreakDays > 0) {
		record("Longest quiet run", `${stats.longestQuietStreakDays} days`, "with nothing going out");
	}
	record("Shops on record", String(stats.distinctMerchants), "distinct payees");

	if (stats.undated > 0) {
		card.createDiv({
			cls: "fp-step-desc",
			text: `${stats.undated} transaction${stats.undated === 1 ? " has" : "s have"} no usable date and sit outside every figure here.`,
		});
	}
}
