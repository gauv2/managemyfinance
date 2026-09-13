import { Menu, Notice } from "obsidian";
import { categoryChain, primaryCategories, resolvePrimaryId, secondaryCategoriesOf } from "../../categories";
import { CreateCategoryRuleModal } from "../../modals/CreateCategoryRuleModal";
import { TransactionEditModal } from "../../modals/TransactionEditModal";
import { TransactionDetailModal } from "../../modals/TransactionDetailModal";
import { formatMoney } from "../../money";
import type { PeriodSelection } from "../../period";
import type FinancePlugin from "../../main";
import type { ReviewStatus, Transaction } from "../../types";
import { describeRuleScope } from "../../rules";
import { renderAttachmentControl } from "../../ui/attachment";
import { categoryChainChip, emptyState, icon, renderCategoryPicker, searchInput, type CategoryPickerValue } from "../../ui/dom";
import { openImportWizard } from "../../wizards/ImportWizard";
import { openInvoiceMatchWizard } from "../../wizards/InvoiceMatchWizard";

type LedgerSortColumn = "date" | "description" | "account" | "category" | "amount";
type LedgerSortDirection = "asc" | "desc";

interface LedgerFilterState {
	search: string;
	accountId: string;
	/** A primary category id, "__uncategorized", or "" for all. */
	categoryPrimaryId: string;
	/** A secondary category id nested under `categoryPrimaryId`, or "" for all of that primary's transactions. */
	categorySecondaryId: string;
	/** Review state to show: "" for all, otherwise a ReviewStatus. Mirrors the Review page's filter. */
	reviewStatus: "" | ReviewStatus;
	/** "" for all, "yes" for only transactions with a file attached, "no" for only those without. */
	hasAttachment: "" | "yes" | "no";
}

export interface LedgerOptions {
	/** The page's period filter — the ledger has none of its own, so the dashboard above it and the
	 *  table below it can never end up showing two different windows onto the same account. */
	period: PeriodSelection;
	/** Puts that page-level filter back to "All time" and redraws what it feeds, this table included.
	 *  Called from "Clear filters", which would otherwise leave a range in force that nothing on
	 *  screen still claims to be applying. */
	onResetPeriod: () => void;
}

interface LedgerSortState {
	column: LedgerSortColumn;
	direction: LedgerSortDirection;
}

/**
 * Filter + sort state lives at module scope — outside renderLedger's own function scope — so that a
 * full re-render (e.g. the one FinanceView.refresh() triggers after a category edit) doesn't wipe
 * out whatever the user had selected. renderLedger reads from these on every call and writes back
 * to them whenever a control changes.
 */
const filterState: LedgerFilterState = {
	search: "",
	accountId: "",
	categoryPrimaryId: "",
	categorySecondaryId: "",
	reviewStatus: "",
	hasAttachment: "",
};

const sortState: LedgerSortState = {
	column: "date",
	direction: "desc",
};

/** Checked transaction ids for bulk actions (currently just bulk categorize) — module scope for the
 *  same reason as filterState/sortState, and also so it survives the re-render a bulk apply itself
 *  triggers (cleared explicitly after a successful apply instead). */
const selectedIds: Set<string> = new Set();

/**
 * Which page of results is on screen. Module scope like the filters, so the re-render that follows
 * approving a row doesn't throw you back to page one of a list you were halfway down.
 *
 * This replaces a `slice(0, 200)` that capped the table silently: the summary said "685
 * transactions" while the table held 200, and the only way to discover the other 485 was to notice
 * that scrolling stopped. A cap the interface doesn't mention is worse than no cap at all.
 */
const pageState = { page: 1 };

/** 0 means "all on one page" — kept as an option because it's what printing and Ctrl-F want. */
const PAGE_SIZE_OPTIONS = [50, 100, 250, 500, 0];
const DEFAULT_PAGE_SIZE = 100;

/** First click on a text column reads A→Z; first click on date/amount reads newest/largest first. */
const DEFAULT_SORT_DIRECTION: Record<LedgerSortColumn, LedgerSortDirection> = {
	date: "desc",
	description: "asc",
	account: "asc",
	category: "asc",
	amount: "desc",
};

/** The transactions table for the current scope (one account, or all) — no page header and no period
 *  filter of its own; the caller supplies both. */
export function renderLedger(container: HTMLElement, plugin: FinancePlugin, opts: LedgerOptions): void {
	const store = plugin.store;

	const activeAccountId = plugin.settings.activeAccountId;
	const activeAccount = activeAccountId ? store.accounts.find((a) => a.id === activeAccountId) : undefined;

	const scopedTransactions = activeAccountId ? store.transactions.filter((t) => t.accountId === activeAccountId) : store.transactions;
	if (scopedTransactions.length === 0) {
		const empty = emptyState(container, {
			iconName: "inbox",
			title: activeAccount ? `No transactions yet for ${activeAccount.name}` : "No transactions yet",
			description:
				activeAccount?.type === "cash"
					? "Nothing exports your wallet — add cash spending by hand as it happens."
					: "Import a bank or broker export (CSV, Excel, CAMT.053, MT940, OFX or QIF), or add a transaction by hand.",
			actionLabel: "Import transactions",
			onAction: () => openImportWizard(plugin),
		});
		// A second way out of the empty state, because for a cash account the first one is useless.
		const addBtn = empty.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(addBtn, "plus");
		addBtn.createSpan({ text: "Add a transaction" });
		addBtn.addEventListener("click", () =>
			new TransactionEditModal(plugin.app, plugin, { defaultAccountId: activeAccountId, onSaved: () => plugin.refreshViews() }).open()
		);
		return;
	}

	const categoryById = new Map(store.categories.map((c) => [c.id, c]));
	const accountById = new Map(store.accounts.map((a) => [a.id, a]));
	const showAccountColumn = !activeAccountId;

	// Search leads the filter row rather than holding a row of its own: it narrows the same set every
	// control beside it narrows. Adding a transaction and editing rules are page-level actions and live
	// in the page's own headers — repeating them here only made two places to look.
	const filterRow = container.createDiv({ cls: "fp-ledger-filters" });
	// The element is still returned and read by `draw()`, which reads every control's value in one
	// place rather than tracking each one's changes separately.
	const search = searchInput(filterRow, {
		placeholder: "Search description or counterparty…",
		value: filterState.search,
		onChange: () => redrawFromFirstPage(),
	});

	let accountSelect: HTMLSelectElement | undefined;
	if (showAccountColumn) {
		accountSelect = filterRow.createEl("select", { cls: "fp-filter-select" });
		accountSelect.createEl("option", { text: "All accounts", value: "" });
		store.accounts.forEach((a) => accountSelect!.createEl("option", { text: a.name, value: a.id }));
		accountSelect.value = accountById.has(filterState.accountId) ? filterState.accountId : "";
	}

	const categoryFilterGroup = filterRow.createDiv({ cls: "fp-ledger-category-filter" });
	const primaries = primaryCategories(store.categories);
	const primarySelect = categoryFilterGroup.createEl("select", { cls: "fp-filter-select" });
	primarySelect.createEl("option", { text: "All categories", value: "" });
	primarySelect.createEl("option", { text: "Uncategorized", value: "__uncategorized" });
	primaries.forEach((c) => primarySelect.createEl("option", { text: c.name, value: c.id }));
	primarySelect.value =
		filterState.categoryPrimaryId === "__uncategorized" || primaries.some((c) => c.id === filterState.categoryPrimaryId)
			? filterState.categoryPrimaryId
			: "";

	const secondarySelect = categoryFilterGroup.createEl("select", { cls: "fp-filter-select" });
	function populateSecondaryFilter(primaryId: string, selectedSecondaryId: string): void {
		secondarySelect.empty();
		const primary = primaries.find((c) => c.id === primaryId);
		const secondaries = primary ? secondaryCategoriesOf(store.categories, primary.id) : [];
		secondarySelect.disabled = secondaries.length === 0;
		secondarySelect.createEl("option", { text: primary ? `All ${primary.name}` : "All subcategories", value: "" });
		secondaries.forEach((c) => {
			const opt = secondarySelect.createEl("option", { text: c.name, value: c.id });
			if (c.id === selectedSecondaryId) opt.selected = true;
		});
	}
	populateSecondaryFilter(primarySelect.value, filterState.categorySecondaryId);

	const reviewSelect = filterRow.createEl("select", { cls: "fp-filter-select" });
	(
		[
			["", "Any review state"],
			["new", "Needs review"],
			["flagged", "Flagged"],
			["approved", "Approved"],
		] as ["" | ReviewStatus, string][]
	).forEach(([value, label]) => reviewSelect.createEl("option", { text: label, value }));
	reviewSelect.value = filterState.reviewStatus;

	const attachmentSelect = filterRow.createEl("select", { cls: "fp-filter-select" });
	(
		[
			["", "Any attachment"],
			["yes", "Has file"],
			["no", "No file"],
		] as ["" | "yes" | "no", string][]
	).forEach(([value, label]) => attachmentSelect.createEl("option", { text: label, value }));
	attachmentSelect.value = filterState.hasAttachment;

	// Sits with the attachment filter rather than in the page header, because it belongs to the same
	// thought: "Has file"/"No file" is how you find the rows still missing a receipt, and this is what
	// you press once you have found them.
	const matchInvoicesBtn = filterRow.createEl("button", { cls: "fp-btn fp-btn-secondary" });
	icon(matchInvoicesBtn, "receipt");
	matchInvoicesBtn.createSpan({ text: "Match invoices & receipts" });
	matchInvoicesBtn.setAttribute("title", "Drop up to 10 invoices or receipts and match them against a month, quarter or year");
	matchInvoicesBtn.addEventListener("click", () => openInvoiceMatchWizard(plugin));

	const clearBtn = filterRow.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Clear filters" });

	const bulkBar = container.createDiv({ cls: "fp-ledger-bulk-bar" });
	const bulkCount = bulkBar.createSpan({ cls: "fp-ledger-bulk-count" });
	const selectAllMatchingBtn = bulkBar.createSpan({ cls: "fp-ledger-bulk-selectall" });
	const bulkPickerWrap = bulkBar.createDiv({ cls: "fp-ledger-bulk-picker" });
	let bulkPickerValue: CategoryPickerValue = {};
	renderCategoryPicker(bulkPickerWrap, {
		categories: store.categories,
		primaryPlaceholder: "Choose category…",
		onChange: (value) => {
			bulkPickerValue = value;
		},
	});
	const bulkApplyBtn = bulkBar.createEl("button", { cls: "fp-btn fp-btn-primary", text: "Apply to selected" });
	bulkApplyBtn.addEventListener("click", () => void applyBulkCategory());
	const bulkClearBtn = bulkBar.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Clear selection" });
	bulkClearBtn.addEventListener("click", () => {
		selectedIds.clear();
		draw();
	});

	async function applyBulkCategory(): Promise<void> {
		const categoryId = bulkPickerValue.secondaryId ?? bulkPickerValue.primaryId;
		if (!categoryId) {
			new Notice("Choose a category first");
			return;
		}
		const patches = new Map<string, string>();
		selectedIds.forEach((id) => patches.set(id, categoryId));
		const count = await store.recategorize(patches);
		// Taught to merchant memory like every other categorize path. This one is the most debatable —
		// a sweep-up across a dozen unrelated merchants stamps all of them — but the alternative was
		// worse: the same gesture teaching or not teaching depending on which screen you did it from.
		await plugin.rememberMerchantsFor(selectedIds, categoryId);
		new Notice(`Categorized ${count} transaction${count === 1 ? "" : "s"}. Future imports from these merchants will follow it.`);
		selectedIds.clear();
		plugin.refreshViews();
	}

	const summary = container.createDiv({ cls: "fp-ledger-summary" });
	const summaryCountItem = summary.createDiv({ cls: "fp-ledger-summary-item" });
	const summaryCountVal = summaryCountItem.createSpan({ cls: "fp-ledger-summary-value" });
	summaryCountItem.createSpan({ cls: "fp-ledger-summary-label", text: "transactions" });
	const summaryTotalItem = summary.createDiv({ cls: "fp-ledger-summary-item" });
	const summaryTotalVal = summaryTotalItem.createSpan({ cls: "fp-ledger-summary-value" });
	summaryTotalItem.createSpan({ cls: "fp-ledger-summary-label", text: "total" });

	const tableWrap = container.createDiv({ cls: "fp-card fp-ledger-table-wrap" });
	const table = tableWrap.createEl("table", { cls: "fp-table fp-ledger-table" });
	const thead = table.createEl("thead").createEl("tr");

	const selectAllTh = thead.createEl("th", { cls: "fp-ledger-th-select" });
	const selectAllCheckbox = selectAllTh.createEl("input", { type: "checkbox" });
	// Ticks the page, not the whole filtered set. With everything on one list those were the same
	// thing; with pages they are not, and a checkbox that silently selects 600 rows you can't see is
	// how a bulk categorize goes somewhere you didn't intend. Selecting everything is still one click
	// away — see the "select all N" link the bulk bar offers once a full page is ticked.
	selectAllCheckbox.addEventListener("change", () => {
		if (selectAllCheckbox.checked) currentPage.forEach((t) => selectedIds.add(t.id));
		else currentPage.forEach((t) => selectedIds.delete(t.id));
		draw();
	});

	const columns: { id: LedgerSortColumn; label: string }[] = [
		{ id: "date", label: "Date" },
		{ id: "description", label: "Description" },
		...(showAccountColumn ? ([{ id: "account", label: "Account" }] as { id: LedgerSortColumn; label: string }[]) : []),
		{ id: "category", label: "Category" },
		{ id: "amount", label: "Amount" },
	];

	const sortIndicators = new Map<LedgerSortColumn, HTMLElement>();
	const headerCells = new Map<LedgerSortColumn, HTMLElement>();
	function updateSortIndicators(): void {
		columns.forEach((col) => {
			headerCells.get(col.id)?.toggleClass("is-sorted", sortState.column === col.id);
			const indicator = sortIndicators.get(col.id);
			if (!indicator) return;
			indicator.empty();
			if (sortState.column === col.id) {
				icon(indicator, sortState.direction === "asc" ? "chevron-up" : "chevron-down", "fp-ledger-sort-icon");
			}
		});
	}
	columns.forEach((col) => {
		const th = thead.createEl("th", { cls: "fp-ledger-th-sortable" });
		th.createSpan({ text: col.label });
		const indicator = th.createSpan({ cls: "fp-ledger-sort-indicator" });
		headerCells.set(col.id, th);
		sortIndicators.set(col.id, indicator);
		th.addEventListener("click", () => {
			if (sortState.column === col.id) {
				sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
			} else {
				sortState.column = col.id;
				sortState.direction = DEFAULT_SORT_DIRECTION[col.id];
			}
			updateSortIndicators();
			// Re-sorting reshuffles which rows land on which page, so "page 3" no longer refers to
			// anything the reader was looking at.
			pageState.page = 1;
			draw();
		});
	});
	updateSortIndicators();
	thead.createEl("th", { cls: "fp-ledger-th-files", text: "File(s)" });

	const tbody = table.createEl("tbody");
	const pager = container.createDiv({ cls: "fp-ledger-pager" });
	/** Every transaction matching the filters, across all pages. */
	let currentFiltered: Transaction[] = [];
	/** Just the rows currently rendered — what the header checkbox ticks. */
	let currentPage: Transaction[] = [];

	function updateBulkBar(): void {
		bulkBar.toggleClass("is-visible", selectedIds.size > 0);
		bulkCount.setText(`${selectedIds.size} selected`);

		// The Gmail move: once the page is fully ticked and more rows match than are on it, offer the
		// bigger selection explicitly rather than making the header checkbox mean two different things.
		selectAllMatchingBtn.empty();
		const pageAllSelected = currentPage.length > 0 && currentPage.every((t) => selectedIds.has(t.id));
		const beyondPage = currentFiltered.length > currentPage.length;
		if (!pageAllSelected || !beyondPage) return;

		const allSelected = currentFiltered.every((t) => selectedIds.has(t.id));
		const link = selectAllMatchingBtn.createEl("button", {
			cls: "fp-btn fp-btn-ghost fp-btn-tiny",
			text: allSelected ? `Clear — back to this page only` : `Select all ${currentFiltered.length} matching these filters`,
		});
		link.addEventListener("click", () => {
			if (allSelected) {
				currentFiltered.forEach((t) => selectedIds.delete(t.id));
				currentPage.forEach((t) => selectedIds.add(t.id));
			} else {
				currentFiltered.forEach((t) => selectedIds.add(t.id));
			}
			draw();
		});
	}

	function updateSelectAllState(): void {
		const selectableCount = currentPage.length;
		const selectedCount = currentPage.filter((t) => selectedIds.has(t.id)).length;
		selectAllCheckbox.checked = selectableCount > 0 && selectedCount === selectableCount;
		selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < selectableCount;
	}

	function compareTransactions(a: Transaction, b: Transaction): number {
		const dir = sortState.direction === "asc" ? 1 : -1;
		switch (sortState.column) {
			case "description":
				return dir * a.description.localeCompare(b.description);
			case "account":
				return dir * (accountById.get(a.accountId)?.name ?? "").localeCompare(accountById.get(b.accountId)?.name ?? "");
			case "category": {
				const an = a.categoryId ? categoryById.get(a.categoryId)?.name ?? "" : "";
				const bn = b.categoryId ? categoryById.get(b.categoryId)?.name ?? "" : "";
				return dir * an.localeCompare(bn);
			}
			case "amount":
				return dir * (a.amount - b.amount);
			case "date":
			default:
				return dir * (a.date > b.date ? 1 : a.date < b.date ? -1 : 0);
		}
	}

	/**
	 * Why this row is filed where it is, when a rule decided it. The rule is looked up rather than
	 * trusted: delete a rule and its rows keep their category but stop claiming to be governed, which
	 * is the truth — nothing is enforcing them any more.
	 */
	/** Rule conditions are stored per-amount without a currency; the ledger's own base is the only
	 *  sensible way to read them back. */
	const ruleMoney = (v: number): string => formatMoney(v, { currency: "EUR" });

	function renderRuleBadge(parent: HTMLElement, t: Transaction): void {
		if (!t.categoryRuleId) return;
		const rule = store.rules.find((r) => r.id === t.categoryRuleId);
		if (!rule) return;
		// A word rather than a lone icon: a wand at 13px is unreadable, and the one thing worse than a
		// marker nobody understands is one that gets misread as a question mark.
		const mark = parent.createEl("button", { cls: "fp-rule-mark" });
		icon(mark, "wand-2");
		mark.createSpan({ text: "RULE" });
		mark.setAttribute("title", `Filed by the rule "${rule.pattern}" (${describeRuleScope(rule, ruleMoney)}). Click to edit it.`);
		mark.setAttribute("aria-label", `Edit the rule that filed this transaction`);
		mark.addEventListener("click", (ev) => {
			// Without this the click reaches the row underneath and opens the transaction instead — which
			// is exactly what a marker with no handler of its own used to do.
			ev.stopPropagation();
			new CreateCategoryRuleModal(plugin.app, plugin, { rule, onDone: () => draw() }).open();
		});
	}

	function openRowMenu(ev: MouseEvent, t: Transaction): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Create category rule from this merchant…")
				.setIcon("wand-2")
				.onClick(() => new CreateCategoryRuleModal(plugin.app, plugin, { tx: t, onDone: () => draw() }).open())
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Open details")
				.setIcon("receipt")
				.onClick(() => new TransactionDetailModal(plugin.app, plugin, t).open())
		);
		menu.addItem((item) =>
			item
				.setTitle("Edit transaction…")
				.setIcon("pencil")
				.onClick(() => new TransactionEditModal(plugin.app, plugin, { transaction: t, onSaved: () => draw() }).open())
		);
		menu.showAtMouseEvent(ev);
	}

	function appendRow(t: Transaction): void {
		const status = t.review ?? "new";
		const tr = tbody.createEl("tr", { cls: `fp-ledger-row fp-review-${status}` + (selectedIds.has(t.id) ? " is-selected" : "") });
		tr.addEventListener("click", () => new TransactionDetailModal(plugin.app, plugin, t).open());
		tr.addEventListener("contextmenu", (ev) => {
			ev.preventDefault();
			openRowMenu(ev, t);
		});

		const selectCell = tr.createEl("td", { cls: "fp-ledger-td-select" });
		const checkbox = selectCell.createEl("input", { type: "checkbox" });
		checkbox.checked = selectedIds.has(t.id);
		checkbox.addEventListener("click", (ev) => ev.stopPropagation());
		checkbox.addEventListener("change", () => {
			if (checkbox.checked) selectedIds.add(t.id);
			else selectedIds.delete(t.id);
			tr.toggleClass("is-selected", checkbox.checked);
			updateBulkBar();
			updateSelectAllState();
		});

		tr.createEl("td", { text: t.date, cls: "fp-cell-date" });
		const descCell = tr.createEl("td", { cls: "fp-sensitive" });
		descCell.setText(t.description);
		if (status !== "new") {
			const mark = descCell.createSpan({ cls: `fp-review-mark is-${status}` });
			icon(mark, status === "approved" ? "check" : "flag");
			mark.setAttribute("title", status === "approved" ? "Reviewed and approved" : "Flagged during review");
		}
		if (showAccountColumn) tr.createEl("td", { text: accountById.get(t.accountId)?.name ?? "—" });
		const catCell = tr.createEl("td");
		const chain = categoryChain(store.categories, t.categoryId);
		categoryChainChip(catCell, chain.primary, chain.secondary);
		renderRuleBadge(catCell, t);
		const amtCell = tr.createEl("td", { cls: "fp-cell-amount fp-money " + (t.amount < 0 ? "is-negative" : "is-positive") });
		amtCell.setText(formatMoney(t.amount, { currency: t.currency || "EUR" }));

		// Compact, self-contained: opening or attaching a receipt here never needs the full detail
		// modal, and its buttons stop their own clicks so they don't also open the row underneath them.
		const filesCell = tr.createEl("td", { cls: "fp-ledger-td-files" });
		renderAttachmentControl(filesCell, plugin.app, plugin, t, { compact: true });
	}

	function draw(): void {
		tbody.empty();
		filterState.search = search.value;
		filterState.accountId = accountSelect ? accountSelect.value : "";
		filterState.categoryPrimaryId = primarySelect.value;
		filterState.categorySecondaryId = secondarySelect.value;
		filterState.reviewStatus = reviewSelect.value as "" | ReviewStatus;
		filterState.hasAttachment = attachmentSelect.value as "" | "yes" | "no";

		const needle = filterState.search.toLowerCase();
		const accountFilter = filterState.accountId;
		const primaryFilter = filterState.categoryPrimaryId;
		const secondaryFilter = filterState.categorySecondaryId;
		// The window comes from the page's own period filter — see LedgerOptions.
		const from = opts.period.from;
		const to = opts.period.to;

		const filtered = [...scopedTransactions]
			.filter((t) => !needle || `${t.description} ${t.counterparty ?? ""}`.toLowerCase().includes(needle))
			.filter((t) => !accountFilter || t.accountId === accountFilter)
			.filter((t) => {
				if (!primaryFilter) return true;
				if (primaryFilter === "__uncategorized") return !t.categoryId;
				if (resolvePrimaryId(store.categories, t.categoryId) !== primaryFilter) return false;
				return !secondaryFilter || t.categoryId === secondaryFilter;
			})
			.filter((t) => !filterState.reviewStatus || (t.review ?? "new") === filterState.reviewStatus)
			.filter((t) => {
				if (!filterState.hasAttachment) return true;
				return filterState.hasAttachment === "yes" ? !!t.attachmentPath : !t.attachmentPath;
			})
			.filter((t) => !from || t.date >= from)
			.filter((t) => !to || t.date <= to)
			.sort(compareTransactions);
		currentFiltered = filtered;
		updateBulkBar();
		updateSelectAllState();

		const total = filtered.reduce((sum, t) => sum + t.amount, 0);
		summaryCountVal.setText(String(filtered.length));
		summaryTotalVal.setText(formatMoney(total));
		summaryTotalVal.addClass("fp-money");
		summaryTotalVal.removeClass("is-negative", "is-positive");
		summaryTotalVal.addClass(total < 0 ? "is-negative" : "is-positive");

		if (filtered.length === 0) {
			pager.empty();
			const tr = tbody.createEl("tr");
			tr.createEl("td", { attr: { colspan: String(columns.length + 2) }, text: "No matching transactions." });
			return;
		}

		const size = pageSize();
		const pages = size === 0 ? 1 : Math.max(1, Math.ceil(filtered.length / size));
		// Clamped rather than reset: narrowing a filter while on page 7 should land on the last page
		// that still exists, not silently throw you back to the top of the list.
		if (pageState.page > pages) pageState.page = pages;
		if (pageState.page < 1) pageState.page = 1;

		const start = size === 0 ? 0 : (pageState.page - 1) * size;
		const end = size === 0 ? filtered.length : Math.min(start + size, filtered.length);
		currentPage = filtered.slice(start, end);
		currentPage.forEach(appendRow);
		renderPager(filtered.length, pages, start, end);
		updateSelectAllState();
	}

	function pageSize(): number {
		const stored = plugin.settings.ledgerPageSize;
		return PAGE_SIZE_OPTIONS.includes(stored as number) ? (stored as number) : DEFAULT_PAGE_SIZE;
	}

	function renderPager(total: number, pages: number, start: number, end: number): void {
		pager.empty();

		// Always states the range against the total, so the table and the "685 transactions" summary
		// above it can never appear to disagree.
		pager.createSpan({ cls: "fp-ledger-pager-range", text: `Showing ${start + 1}–${end} of ${total}` });

		const sizeWrap = pager.createDiv({ cls: "fp-ledger-pager-size" });
		sizeWrap.createSpan({ text: "Per page" });
		const sizeSelect = sizeWrap.createEl("select", { cls: "fp-filter-select" });
		PAGE_SIZE_OPTIONS.forEach((n) => sizeSelect.createEl("option", { text: n === 0 ? "All" : String(n), value: String(n) }));
		sizeSelect.value = String(pageSize());
		sizeSelect.addEventListener("change", async () => {
			plugin.settings.ledgerPageSize = Number(sizeSelect.value);
			pageState.page = 1;
			await plugin.saveSettings();
			draw();
		});

		if (pages <= 1) return;

		const nav = pager.createDiv({ cls: "fp-ledger-pager-nav" });
		const step = (to: number): void => {
			pageState.page = Math.min(pages, Math.max(1, to));
			draw();
			// The rows change under the cursor, so put the reader back at the top of the new page
			// rather than wherever the old one's scroll position happened to leave them.
			tableWrap.scrollIntoView({ block: "nearest" });
		};
		const navBtn = (label: string, iconName: string, to: number, disabled: boolean): void => {
			const btn = nav.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
			icon(btn, iconName);
			btn.setAttribute("aria-label", label);
			btn.setAttribute("title", label);
			btn.disabled = disabled;
			btn.addEventListener("click", () => step(to));
		};

		navBtn("First page", "chevrons-left", 1, pageState.page === 1);
		navBtn("Previous page", "chevron-left", pageState.page - 1, pageState.page === 1);
		nav.createSpan({ cls: "fp-ledger-pager-count", text: `Page ${pageState.page} of ${pages}` });
		navBtn("Next page", "chevron-right", pageState.page + 1, pageState.page === pages);
		navBtn("Last page", "chevrons-right", pages, pageState.page === pages);
	}

	/** Any filter change narrows or widens the set, so the page number has to start over. */
	function redrawFromFirstPage(): void {
		pageState.page = 1;
		draw();
	}

	draw();
	accountSelect?.addEventListener("change", redrawFromFirstPage);
	primarySelect.addEventListener("change", () => {
		populateSecondaryFilter(primarySelect.value, "");
		redrawFromFirstPage();
	});
	secondarySelect.addEventListener("change", redrawFromFirstPage);
	reviewSelect.addEventListener("change", redrawFromFirstPage);
	attachmentSelect.addEventListener("change", redrawFromFirstPage);
	clearBtn.addEventListener("click", () => {
		filterState.search = "";
		filterState.accountId = "";
		filterState.categoryPrimaryId = "";
		filterState.categorySecondaryId = "";
		filterState.reviewStatus = "";
		filterState.hasAttachment = "";
		pageState.page = 1;
		// The period is the page's, not this row's, so clearing hands back to the page — which redraws
		// this whole section from the state just cleared.
		opts.onResetPeriod();
	});
}
