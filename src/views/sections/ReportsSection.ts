import { Notice } from "obsidian";
import { categoryChain, primaryCategories, secondaryCategoriesOf } from "../../categories";
import { writeExport } from "../../data/backup";
import type FinancePlugin from "../../main";
import { formatMoney } from "../../money";
import { TransactionDetailModal } from "../../modals/TransactionDetailModal";
import { emptyPeriodSelection, periodRange } from "../../period";
import {
	buildReportCsv,
	buildReportHtml,
	buildReportMarkdown,
	buildReportXml,
	type ExportContext,
} from "../../reports/export";
import { canExportPdf, exportHtmlToPdf } from "../../reports/pdf";
import {
	describePeriod,
	describeQuery,
	reportSlug,
	runReport,
	UNCATEGORIZED,
	type ReportGroup,
	type ReportQuery,
	type ReportResult,
	type ReportSource,
} from "../../reports/query";
import { openNote, writeReportNote } from "../../reports/write";
import { badge, categoryChip, emptyState, icon, statTile } from "../../ui/dom";
import { renderPeriodFilter } from "../../ui/periodFilter";

type Grouping = "category" | "month" | "merchant" | "account";

/** Everything about the report except its window, which lives in `period` below. */
interface ReportState extends Omit<ReportQuery, "from" | "to"> {
	/** Which breakdown the summary table shows. Purely presentational — every breakdown is computed. */
	grouping: Grouping;
	/** Rows currently drawn in the preview; grows via "Show more" rather than paginating. */
	shown: number;
}

const PAGE_SIZE = 50;

/**
 * Module scope, same reasoning as the ledger's and the review queue's: a full re-render triggered
 * from elsewhere must not silently throw away a report you spent a minute assembling.
 */
const state: ReportState = {
	categoryIds: [],
	accountIds: [],
	search: "",
	direction: "out",
	includeTransfers: false,
	grouping: "category",
	shown: PAGE_SIZE,
};

/**
 * The report's window, held in the same shape every other period filter in the plugin uses — see
 * src/ui/periodFilter.ts. This page used to carry its own row of preset buttons, which had already
 * drifted from the ledger's ("2026 (this year)" against "This month", no month or week drill-down at
 * all) and computed the same month boundaries a second time.
 */
const period = emptyPeriodSelection();

/** Whether the default period has been applied yet this session — see the note where it's used. */
let initialized = false;

const GROUPING_LABEL: Record<Grouping, string> = {
	category: "Category",
	month: "Month",
	merchant: "Merchant",
	account: "Account",
};

/** Selects the whole of this calendar year — the report the page opens on, and what Reset returns to. */
function selectThisYear(): void {
	const year = String(new Date().getFullYear());
	const bounds = periodRange(year)!;
	period.period = year;
	period.month = "";
	period.week = "";
	period.from = bounds.from;
	period.to = bounds.to;
}

/**
 * Ad-hoc reporting: pick a period, pick some categories, get an answer — then take it out of Obsidian
 * as a PDF, a spreadsheet, or a note in the vault.
 *
 * The plugin could already write a report for *this month* and *this year*, which covers the
 * recurring snapshot and none of the questions people actually ask their own finances: what did
 * eating out cost me last year, what has this car cost since I bought it, what did those two things
 * come to together. Those are one-off questions with a different shape every time, so this page is a
 * query builder rather than another fixed report — and every export runs through the same
 * runReport() the screen does, so a file can never disagree with the preview it came from.
 */
export function renderReportsSection(container: HTMLElement, plugin: FinancePlugin): void {
	container.addClass("fp-section");
	const store = plugin.store;

	function source(): ReportSource {
		return { transactions: store.transactions, categories: store.categories, accounts: store.accounts, fx: store.fx };
	}

	function query(): ReportQuery {
		return {
			from: period.from || undefined,
			to: period.to || undefined,
			categoryIds: state.categoryIds,
			accountIds: state.accountIds,
			search: state.search,
			direction: state.direction,
			includeTransfers: state.includeTransfers,
		};
	}

	/** The filter chips reprinted as words, so a PDF read months later says what it was asking. */
	function filterSummary(result: ReportResult): string[] {
		const out: string[] = [describePeriod(period.from || undefined, period.to || undefined)];
		for (const id of state.categoryIds ?? []) {
			if (id === UNCATEGORIZED) {
				out.push("Uncategorized");
				continue;
			}
			const chain = categoryChain(store.categories, id);
			if (chain.primary) out.push(chain.secondary ? `${chain.primary.name} › ${chain.secondary.name}` : chain.primary.name);
		}
		for (const id of state.accountIds ?? []) {
			const account = store.accounts.find((a) => a.id === id);
			if (account) out.push(account.name);
		}
		if (state.search?.trim()) out.push(`Text: "${state.search.trim()}"`);
		out.push(state.direction === "in" ? "Money in" : state.direction === "out" ? "Money out" : "Money in and out");
		if (state.includeTransfers) out.push("Transfers included");
		if (result.mixedCurrencies.length > 0) out.push(`Unconverted: ${result.mixedCurrencies.join(", ")}`);
		return out;
	}

	function exportContext(result: ReportResult): ExportContext {
		return {
			title: describeQuery(source(), query()),
			period: describePeriod(period.from || undefined, period.to || undefined),
			categories: store.categories,
			accounts: store.accounts,
			generatedAt: new Date().toISOString(),
			pluginVersion: plugin.manifest.version,
			portfolioName: plugin.activePortfolio?.name,
			filterSummary: filterSummary(result),
		};
	}

	function render(): void {
		container.empty();
		renderHeader();

		if (store.transactions.length === 0) {
			emptyState(container, {
				iconName: "file-bar-chart",
				title: "Nothing to report on yet",
				description: "Import a bank or broker export first — reports are built from whatever is in your ledger.",
			});
			return;
		}

		renderQueryCard();
		const result = runReport(source(), query());
		renderTotals(result);
		renderExportBar(result);
		renderBreakdown(result);
		renderTransactions(result);
	}

	function renderHeader(): void {
		const header = container.createDiv({ cls: "fp-section-header" });
		const headText = header.createDiv({ cls: "fp-section-header-text" });
		const titleRow = headText.createDiv({ cls: "fp-section-title-row" });
		icon(titleRow.createDiv({ cls: "fp-section-icon-badge" }), "file-bar-chart");
		titleRow.createEl("h2", { text: "Reports" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: "Ask a question of your ledger — what restaurants cost last year, what the car has cost, or both at once — then take the answer out as a PDF, a spreadsheet, or a note in your vault.",
		});
	}

	// ─── The query builder ──────────────────────────────────────────────────────────────────────

	function renderQueryCard(): void {
		const card = container.createDiv({ cls: "fp-card fp-report-builder" });

		renderPeriodRow(card);
		renderCategoryRow(card);
		renderScopeRow(card);
	}

	function fieldRow(parent: HTMLElement, label: string, hint?: string): HTMLElement {
		const row = parent.createDiv({ cls: "fp-report-row" });
		const labelCol = row.createDiv({ cls: "fp-report-row-label" });
		labelCol.createDiv({ text: label });
		if (hint) labelCol.createDiv({ cls: "fp-report-row-hint", text: hint });
		return row.createDiv({ cls: "fp-report-row-control" });
	}

	function renderPeriodRow(card: HTMLElement): void {
		const control = fieldRow(card, "Period", "The window the report covers");
		// The same control the ledger and the dashboards use — year, then month, then week, with the
		// raw from/to behind "Custom range…" for the arbitrary windows a report legitimately needs.
		renderPeriodFilter(control, {
			dates: store.transactions.map((t) => t.date),
			selection: period,
			label: "",
			onChange: () => {
				state.shown = PAGE_SIZE;
				render();
			},
		});
	}

	function renderCategoryRow(card: HTMLElement): void {
		const control = fieldRow(card, "Categories", "Leave empty for everything. A primary includes its subcategories.");

		const chips = control.createDiv({ cls: "fp-report-chips" });
		const chosen = state.categoryIds ?? [];
		if (chosen.length === 0) {
			chips.createSpan({ cls: "fp-report-chips-empty", text: "All categories" });
		}
		for (const id of chosen) {
			const chip = chips.createDiv({ cls: "fp-report-chip" });
			if (id === UNCATEGORIZED) {
				badge(chip, "Uncategorized", "warn");
			} else {
				const chain = categoryChain(store.categories, id);
				const cat = chain.secondary ?? chain.primary;
				if (cat) categoryChip(chip, chain.secondary ? `${chain.primary?.name} › ${cat.name}` : cat.name, cat.color, cat.icon);
				else chip.createSpan({ text: id });
			}
			const remove = chip.createEl("button", { cls: "fp-report-chip-x" });
			icon(remove, "x");
			remove.setAttribute("aria-label", "Remove this category from the report");
			remove.addEventListener("click", () => {
				state.categoryIds = chosen.filter((c) => c !== id);
				state.shown = PAGE_SIZE;
				render();
			});
		}

		// Two selects that *add* rather than replace, because a report over "Restaurants and Fuel" is
		// the whole point — a single-value picker would make the combined question unaskable.
		const adder = control.createDiv({ cls: "fp-report-adder" });
		const primarySelect = adder.createEl("select", { cls: "fp-filter-select" });
		primarySelect.createEl("option", { text: "Add a category…", value: "" });
		primarySelect.createEl("option", { text: "Uncategorized", value: UNCATEGORIZED });
		const primaries = primaryCategories(store.categories);
		primaries.forEach((c) => primarySelect.createEl("option", { text: c.name, value: c.id }));

		const secondarySelect = adder.createEl("select", { cls: "fp-filter-select" });
		secondarySelect.disabled = true;
		secondarySelect.createEl("option", { text: "All subcategories", value: "" });

		function add(id: string): void {
			if (!id || chosen.includes(id)) return;
			state.categoryIds = [...chosen, id];
			state.shown = PAGE_SIZE;
			render();
		}

		primarySelect.addEventListener("change", () => {
			const value = primarySelect.value;
			if (!value) return;
			if (value === UNCATEGORIZED) {
				add(value);
				return;
			}
			const secondaries = secondaryCategoriesOf(store.categories, value);
			if (secondaries.length === 0) {
				add(value);
				return;
			}
			// A primary with children gets a second beat: "all of Transport" and "just Fuel" are
			// different questions and the picker shouldn't guess which one was meant.
			secondarySelect.empty();
			secondarySelect.disabled = false;
			secondarySelect.createEl("option", { text: `All of ${primaries.find((c) => c.id === value)?.name ?? "it"}`, value });
			secondaries.forEach((c) => secondarySelect.createEl("option", { text: c.name, value: c.id }));
			secondarySelect.focus();
		});
		secondarySelect.addEventListener("change", () => add(secondarySelect.value));
	}

	function renderScopeRow(card: HTMLElement): void {
		const control = fieldRow(card, "Scope", "Accounts, direction and free text");
		const line = control.createDiv({ cls: "fp-report-scope" });

		const accountSelect = line.createEl("select", { cls: "fp-filter-select" });
		accountSelect.createEl("option", { text: "All accounts", value: "" });
		store.accounts.forEach((a) => accountSelect.createEl("option", { text: a.name, value: a.id }));
		accountSelect.value = (state.accountIds ?? [])[0] ?? "";
		accountSelect.addEventListener("change", () => {
			state.accountIds = accountSelect.value ? [accountSelect.value] : [];
			state.shown = PAGE_SIZE;
			render();
		});

		const directions: [NonNullable<ReportQuery["direction"]>, string][] = [
			["out", "Money out"],
			["in", "Money in"],
			["all", "Both"],
		];
		const group = line.createDiv({ cls: "fp-segmented" });
		directions.forEach(([value, label]) => {
			const btn = group.createEl("button", {
				cls: "fp-segmented-btn" + (state.direction === value ? " is-active" : ""),
				text: label,
			});
			btn.addEventListener("click", () => {
				state.direction = value;
				state.shown = PAGE_SIZE;
				render();
			});
		});

		const search = line.createEl("input", { type: "text", cls: "fp-search", placeholder: "Text in description, counterparty or notes…" });
		search.value = state.search ?? "";
		search.addEventListener("change", () => {
			state.search = search.value;
			state.shown = PAGE_SIZE;
			render();
		});

		const transfersWrap = line.createDiv({ cls: "fp-report-toggle" });
		const transfers = transfersWrap.createEl("input", { type: "checkbox", cls: "fp-review-check" });
		transfers.checked = !!state.includeTransfers;
		transfers.id = "fp-report-transfers";
		const transfersLabel = transfersWrap.createEl("label", { text: "Include transfers", attr: { for: "fp-report-transfers" } });
		transfersLabel.setAttribute("title", "Transfers between your own accounts are the same money twice — normally left out of spending totals.");
		transfers.addEventListener("change", () => {
			state.includeTransfers = transfers.checked;
			state.shown = PAGE_SIZE;
			render();
		});

		const reset = line.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Reset" });
		reset.addEventListener("click", () => {
			selectThisYear();
			state.categoryIds = [];
			state.accountIds = [];
			state.search = "";
			state.direction = "out";
			state.includeTransfers = false;
			state.shown = PAGE_SIZE;
			render();
		});
	}

	// ─── Results ────────────────────────────────────────────────────────────────────────────────

	function money(amount: number, result: ReportResult): string {
		return formatMoney(amount, { currency: result.baseCurrency });
	}

	function renderTotals(result: ReportResult): void {
		const title = container.createDiv({ cls: "fp-report-title" });
		title.createEl("h3", { text: describeQuery(source(), query()) });

		const tiles = container.createDiv({ cls: "fp-stat-grid" });
		statTile(tiles, {
			label: "Transactions",
			value: String(result.count),
			iconName: "list",
			money: false,
			tone: result.count > 0 ? "neutral" : "warn",
			sub: describePeriod(period.from || undefined, period.to || undefined),
		});
		statTile(tiles, { label: "Total out", value: money(result.spent, result), iconName: "arrow-down-left", tone: "bad" });
		statTile(tiles, { label: "Total in", value: money(result.received, result), iconName: "arrow-up-right", tone: "good" });
		statTile(tiles, {
			label: "Net",
			value: money(result.net, result),
			iconName: "scale",
			tone: result.net >= 0 ? "good" : "warn",
		});
		if (result.months > 1) {
			statTile(tiles, {
				label: "Average / month",
				value: money(result.spent / result.months, result),
				iconName: "calendar",
				sub: `over ${result.months} months`,
			});
		}

		if (result.mixedCurrencies.length > 0) {
			container.createDiv({
				cls: "fp-report-warning",
				text: `Totals include ${result.mixedCurrencies.join(", ")} at 1:1 — no exchange rate is set. Set one in Vault settings → Currency.`,
			});
		}
	}

	function renderExportBar(result: ReportResult): void {
		const bar = container.createDiv({ cls: "fp-report-export-bar" });
		const disabled = result.count === 0;
		bar.createSpan({
			cls: "fp-report-export-hint",
			text: disabled ? "Nothing matches — adjust the filters above to export something." : "Take this report out of Obsidian:",
		});

		const actions = bar.createDiv({ cls: "fp-report-export-actions" });

		function action(label: string, iconName: string, primary: boolean, run: () => void | Promise<void>): void {
			const btn = actions.createEl("button", { cls: `fp-btn ${primary ? "fp-btn-primary" : "fp-btn-secondary"}` });
			icon(btn, iconName);
			btn.createSpan({ text: label });
			btn.disabled = disabled;
			btn.addEventListener("click", () => void run());
		}

		if (canExportPdf()) {
			action("Save as PDF", "download", true, async () => {
				const ctx = exportContext(result);
				await exportHtmlToPdf(buildReportHtml(result, ctx), `${reportSlug(ctx.title)}.pdf`);
			});
		}
		action("CSV", "file-spreadsheet", false, () => exportFile(result, "csv"));
		action("Excel", "table", false, () => exportFile(result, "xls"));
		action("Write note", "file-text", false, () => writeNote(result));
	}

	async function exportFile(result: ReportResult, kind: "csv" | "xls"): Promise<void> {
		const ctx = exportContext(result);
		const content =
			kind === "csv"
				? buildReportCsv(result, ctx, { delimiter: plugin.settings.reportCsvDelimiter ?? "," })
				: buildReportXml(result, ctx);
		try {
			const path = await writeExport(plugin.app, plugin.settings.dataFolder, reportSlug(ctx.title), kind, content);
			new Notice(`Saved to ${path}`);
		} catch (e) {
			new Notice(`Couldn't write the export: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	async function writeNote(result: ReportResult): Promise<void> {
		const ctx = exportContext(result);
		try {
			const path = await writeReportNote(plugin.app, plugin.settings.dataFolder, reportSlug(ctx.title), buildReportMarkdown(result, ctx));
			new Notice(`Report written to ${path}`);
			await openNote(plugin.app, path);
		} catch (e) {
			new Notice(`Couldn't write the report: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	function groupsFor(result: ReportResult): ReportGroup[] {
		switch (state.grouping) {
			case "month":
				return result.byMonth;
			case "merchant":
				return result.byMerchant;
			case "account":
				return result.byAccount;
			default:
				return result.byCategory;
		}
	}

	function renderBreakdown(result: ReportResult): void {
		if (result.count === 0) return;
		const card = container.createDiv({ cls: "fp-card fp-report-breakdown" });

		const head = card.createDiv({ cls: "fp-report-breakdown-head" });
		head.createEl("h4", { text: "Breakdown" });
		const switcher = head.createDiv({ cls: "fp-segmented" });
		(["category", "month", "merchant", "account"] as Grouping[]).forEach((value) => {
			const btn = switcher.createEl("button", {
				cls: "fp-segmented-btn" + (state.grouping === value ? " is-active" : ""),
				text: GROUPING_LABEL[value],
			});
			btn.addEventListener("click", () => {
				state.grouping = value;
				render();
			});
		});

		const groups = groupsFor(result);
		// Shares of the biggest line, so the bars are comparable within the table rather than against
		// an absolute the reader can't see.
		const peak = groups.reduce((max, g) => Math.max(max, Math.abs(g.total)), 0) || 1;

		const table = card.createEl("table", { cls: "fp-table fp-report-table" });
		const thead = table.createEl("thead").createEl("tr");
		[GROUPING_LABEL[state.grouping], "Rows", "Share", "Total"].forEach((label) => thead.createEl("th", { text: label }));
		const tbody = table.createEl("tbody");

		for (const group of groups) {
			const tr = tbody.createEl("tr");
			tr.createEl("td", { text: group.label, cls: "fp-report-group-label" });
			tr.createEl("td", { text: String(group.count), cls: "fp-cell-muted" });
			const barCell = tr.createEl("td", { cls: "fp-report-bar-cell" });
			const bar = barCell.createDiv({ cls: "fp-report-bar" });
			bar.createDiv({ cls: "fp-report-bar-fill" }).style.width = `${(Math.abs(group.total) / peak) * 100}%`;
			tr.createEl("td", {
				text: money(group.total, result),
				cls: "fp-cell-amount fp-money " + (group.total < 0 ? "is-negative" : "is-positive"),
			});
		}
	}

	function renderTransactions(result: ReportResult): void {
		const card = container.createDiv({ cls: "fp-card fp-ledger-table-wrap" });
		if (result.count === 0) {
			card.createEl("p", { cls: "fp-step-desc", text: "No transactions match this report." });
			return;
		}

		const table = card.createEl("table", { cls: "fp-table" });
		const thead = table.createEl("thead").createEl("tr");
		["Date", "Description", "Account", "Category", "Amount"].forEach((label) => thead.createEl("th", { text: label }));
		const tbody = table.createEl("tbody");

		const visible = result.rows.slice(0, state.shown);
		for (const tx of visible) {
			const tr = tbody.createEl("tr");
			tr.createEl("td", { text: tx.date, cls: "fp-cell-date" });
			const desc = tr.createEl("td", { cls: "fp-sensitive" });
			desc.setText(tx.description || "(no description)");
			tr.createEl("td", { text: store.accounts.find((a) => a.id === tx.accountId)?.name ?? "—" });
			const chain = categoryChain(store.categories, tx.categoryId);
			const catCell = tr.createEl("td");
			if (chain.primary) {
				const cat = chain.secondary ?? chain.primary;
				categoryChip(catCell, chain.secondary ? `${chain.primary.name} › ${cat.name}` : cat.name, cat.color, cat.icon);
			} else {
				badge(catCell, "Uncategorized", "warn");
			}
			tr.createEl("td", {
				text: formatMoney(tx.amount, { currency: tx.currency || result.baseCurrency }),
				cls: "fp-cell-amount fp-money " + (tx.amount < 0 ? "is-negative" : "is-positive"),
			});
			tr.addEventListener("click", () => new TransactionDetailModal(plugin.app, plugin, tx).open());
		}

		if (result.rows.length > visible.length) {
			const moreWrap = card.createDiv({ cls: "fp-review-more" });
			const remaining = result.rows.length - visible.length;
			const btn = moreWrap.createEl("button", { cls: "fp-btn fp-btn-secondary" });
			icon(btn, "chevron-down");
			btn.createSpan({ text: `Show ${Math.min(PAGE_SIZE, remaining)} more (${remaining} left)` });
			btn.addEventListener("click", () => {
				state.shown += PAGE_SIZE;
				render();
			});
			moreWrap.createSpan({
				cls: "fp-report-export-hint",
				text: "Exports always contain every matching row, not just the ones shown.",
			});
		}
	}

	// First visit of the session lands on this year rather than the whole ledger: an unbounded report
	// over years of data is slow to read and almost never the question being asked. Guarded by a flag
	// rather than by "are the dates empty?", because empty dates are also what "All time" means — and
	// inferring intent from them would silently undo that choice every time the page re-mounted.
	if (!initialized) {
		initialized = true;
		selectThisYear();
	}

	render();
}
