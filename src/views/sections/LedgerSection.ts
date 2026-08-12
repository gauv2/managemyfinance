import { Notice } from "obsidian";
import { categoryChain, primaryCategories, resolvePrimaryId, secondaryCategoriesOf } from "../../categories";
import { ManageRulesModal } from "../../modals/ManageRulesModal";
import { TransactionEditModal } from "../../modals/TransactionEditModal";
import { TransactionDetailModal } from "../../modals/TransactionDetailModal";
import { formatMoney } from "../../money";
import type FinancePlugin from "../../main";
import type { ReviewStatus, Transaction } from "../../types";
import { categoryChainChip, emptyState, icon, renderCategoryPicker, type CategoryPickerValue } from "../../ui/dom";
import { openImportWizard } from "../../wizards/ImportWizard";

type LedgerSortColumn = "date" | "description" | "account" | "category" | "amount";
type LedgerSortDirection = "asc" | "desc";

interface LedgerFilterState {
	search: string;
	accountId: string;
	/** A primary category id, "__uncategorized", or "" for all. */
	categoryPrimaryId: string;
	/** A secondary category id nested under `categoryPrimaryId`, or "" for all of that primary's transactions. */
	categorySecondaryId: string;
	dateFrom: string;
	dateTo: string;
	/** Review state to show: "" for all, otherwise a ReviewStatus. Mirrors the Review page's filter. */
	reviewStatus: "" | ReviewStatus;
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
	dateFrom: "",
	dateTo: "",
	reviewStatus: "",
};

const sortState: LedgerSortState = {
	column: "date",
	direction: "desc",
};

/** Checked transaction ids for bulk actions (currently just bulk categorize) — module scope for the
 *  same reason as filterState/sortState, and also so it survives the re-render a bulk apply itself
 *  triggers (cleared explicitly after a successful apply instead). */
const selectedIds: Set<string> = new Set();

/** First click on a text column reads A→Z; first click on date/amount reads newest/largest first. */
const DEFAULT_SORT_DIRECTION: Record<LedgerSortColumn, LedgerSortDirection> = {
	date: "desc",
	description: "asc",
	account: "asc",
	category: "asc",
	amount: "desc",
};

/** The transactions table for the current scope (one account, or all) — no page header of its own; the caller supplies that. */
export function renderLedger(container: HTMLElement, plugin: FinancePlugin): void {
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

	const controls = container.createDiv({ cls: "fp-ledger-controls" });
	const search = controls.createEl("input", {
		type: "text",
		placeholder: "Search description or counterparty…",
		cls: "fp-search",
	});
	search.value = filterState.search;

	const addBtn = controls.createEl("button", { cls: "fp-btn fp-btn-secondary" });
	icon(addBtn, "plus");
	addBtn.createSpan({ text: "Add" });
	addBtn.setAttribute("title", "Add a transaction by hand");
	addBtn.addEventListener("click", () =>
		new TransactionEditModal(plugin.app, plugin, { defaultAccountId: activeAccountId, onSaved: () => plugin.refreshViews() }).open()
	);

	const rulesBtn = controls.createEl("button", { cls: "fp-btn fp-btn-secondary fp-ledger-rules-btn" });
	icon(rulesBtn, "list-filter");
	rulesBtn.createSpan({ text: "Rules" });
	rulesBtn.addEventListener("click", () => {
		new ManageRulesModal(plugin.app, plugin, () => draw()).open();
	});

	const filterRow = container.createDiv({ cls: "fp-ledger-filters" });

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

	const dateFrom = filterRow.createEl("input", { type: "date", cls: "fp-filter-date" });
	dateFrom.value = filterState.dateFrom;
	filterRow.createSpan({ cls: "fp-filter-date-sep", text: "–" });
	const dateTo = filterRow.createEl("input", { type: "date", cls: "fp-filter-date" });
	dateTo.value = filterState.dateTo;

	const clearBtn = filterRow.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Clear filters" });

	const bulkBar = container.createDiv({ cls: "fp-ledger-bulk-bar" });
	const bulkCount = bulkBar.createSpan({ cls: "fp-ledger-bulk-count" });
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
		new Notice(`Categorized ${count} transaction${count === 1 ? "" : "s"}`);
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
	selectAllCheckbox.addEventListener("change", () => {
		if (selectAllCheckbox.checked) currentFiltered.forEach((t) => selectedIds.add(t.id));
		else currentFiltered.forEach((t) => selectedIds.delete(t.id));
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
			draw();
		});
	});
	updateSortIndicators();

	const tbody = table.createEl("tbody");
	/** Every currently filtered transaction (not just the 200 rendered) — what "select all" selects,
	 *  and what the header checkbox's checked/indeterminate state is judged against. */
	let currentFiltered: Transaction[] = [];

	function updateBulkBar(): void {
		bulkBar.toggleClass("is-visible", selectedIds.size > 0);
		bulkCount.setText(`${selectedIds.size} selected`);
	}

	function updateSelectAllState(): void {
		const selectableCount = currentFiltered.length;
		const selectedCount = currentFiltered.filter((t) => selectedIds.has(t.id)).length;
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

	function appendRow(t: Transaction): void {
		const status = t.review ?? "new";
		const tr = tbody.createEl("tr", { cls: `fp-ledger-row fp-review-${status}` + (selectedIds.has(t.id) ? " is-selected" : "") });
		tr.addEventListener("click", () => new TransactionDetailModal(plugin.app, plugin, t).open());

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
		const amtCell = tr.createEl("td", { cls: "fp-cell-amount fp-money " + (t.amount < 0 ? "is-negative" : "is-positive") });
		amtCell.setText(formatMoney(t.amount, { currency: t.currency || "EUR" }));
	}

	function draw(): void {
		tbody.empty();
		filterState.search = search.value;
		filterState.accountId = accountSelect ? accountSelect.value : "";
		filterState.categoryPrimaryId = primarySelect.value;
		filterState.categorySecondaryId = secondarySelect.value;
		filterState.reviewStatus = reviewSelect.value as "" | ReviewStatus;
		filterState.dateFrom = dateFrom.value;
		filterState.dateTo = dateTo.value;

		const needle = filterState.search.toLowerCase();
		const accountFilter = filterState.accountId;
		const primaryFilter = filterState.categoryPrimaryId;
		const secondaryFilter = filterState.categorySecondaryId;
		const from = filterState.dateFrom;
		const to = filterState.dateTo;

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

		const rows = filtered.slice(0, 200);
		if (rows.length === 0) {
			const tr = tbody.createEl("tr");
			tr.createEl("td", { attr: { colspan: String(columns.length) }, text: "No matching transactions." });
			return;
		}
		rows.forEach(appendRow);
	}

	draw();
	search.addEventListener("input", draw);
	accountSelect?.addEventListener("change", draw);
	primarySelect.addEventListener("change", () => {
		populateSecondaryFilter(primarySelect.value, "");
		draw();
	});
	secondarySelect.addEventListener("change", draw);
	reviewSelect.addEventListener("change", draw);
	dateFrom.addEventListener("change", draw);
	dateTo.addEventListener("change", draw);
	clearBtn.addEventListener("click", () => {
		search.value = "";
		if (accountSelect) accountSelect.value = "";
		primarySelect.value = "";
		populateSecondaryFilter("", "");
		reviewSelect.value = "";
		dateFrom.value = "";
		dateTo.value = "";
		draw();
	});
}
