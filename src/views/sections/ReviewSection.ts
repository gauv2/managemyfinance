import { Notice } from "obsidian";
import { categoryChain, primaryCategories, resolvePrimaryId, secondaryCategoriesOf } from "../../categories";
import { merchantKey, merchantLabel } from "../../import/merchantKey";
import { dismissSuggestion, siblingsOf, unknownMerchants } from "../../import/merchantMemory";
import type FinancePlugin from "../../main";
import { formatMoney } from "../../money";
import { BulkMatchModal } from "../../modals/BulkMatchModal";
import { RecheckModal } from "../../modals/RecheckModal";
import { TransactionDetailModal } from "../../modals/TransactionDetailModal";
import type { ReviewStatus, Transaction } from "../../types";
import { badge, categoryChainChip, emptyState, icon, moneyInput, renderCategoryPicker, statTile } from "../../ui/dom";

type StatusFilter = "all" | ReviewStatus | "uncategorized";

interface ReviewFilterState {
	search: string;
	status: StatusFilter;
	accountId: string;
	/** A primary category id, "__uncategorized", or "" for all. */
	categoryPrimaryId: string;
	categorySecondaryId: string;
	dateFrom: string;
	dateTo: string;
	/** How many rows are currently rendered — grows via "Show more" rather than paginating. */
	shown: number;
}

const PAGE_SIZE = 100;

/**
 * Filter state at module scope, same reasoning as LedgerSection's: a full re-render triggered from
 * elsewhere (refreshViews after any edit) must not silently reset what the user had filtered to,
 * which in a review pass would mean losing your place every time you approved something.
 */
const reviewState: ReviewFilterState = {
	search: "",
	status: "new",
	accountId: "",
	categoryPrimaryId: "",
	categorySecondaryId: "",
	dateFrom: "",
	dateTo: "",
	shown: PAGE_SIZE,
};

const STATUS_META: Record<ReviewStatus, { label: string; tone: "good" | "warn" | "neutral" }> = {
	new: { label: "New", tone: "neutral" },
	approved: { label: "Approved", tone: "good" },
	flagged: { label: "Flagged", tone: "warn" },
};

/**
 * The bulk-categorization and sign-off page: everything imported, in one list, with the category
 * editable inline and a three-state review flag per row.
 *
 * The point of the third state is that a review pass stalls the moment a single row can't be decided
 * — you either guess a category to clear it, or the queue never empties and stops meaning anything.
 * "Flagged" is the parking space that keeps the queue honest: it's off the "new" pile without
 * pretending it's settled, and it has its own filter to come back to.
 */
export function renderReviewSection(container: HTMLElement, plugin: FinancePlugin): void {
	container.addClass("fp-section");
	const store = plugin.store;
	/** Selection is intentionally *not* module-scope: a stale selection surviving a data change could
	 *  apply a bulk action to rows the user can no longer see. It resets on every mount. */
	const selected = new Set<string>();

	function statusOf(tx: Transaction): ReviewStatus {
		return tx.review ?? "new";
	}

	/** Rows matching every active filter, newest first — the "shown" cap is applied after this. */
	function filtered(): Transaction[] {
		const needle = reviewState.search.trim().toLowerCase();
		// The "hide approved" preference only applies to the broad filters. Asking explicitly for
		// approved rows always shows them — a setting that could make a filter return nothing it names
		// would just read as a bug.
		const hideApproved = plugin.settings.reviewHideApproved !== false;
		return store.transactions
			.filter((t) => {
				switch (reviewState.status) {
					case "all":
						return !hideApproved || statusOf(t) !== "approved";
					case "uncategorized":
						return !t.categoryId && (!hideApproved || statusOf(t) !== "approved");
					default:
						return statusOf(t) === reviewState.status;
				}
			})
			.filter((t) => !needle || `${t.description} ${t.counterparty ?? ""} ${t.notes ?? ""}`.toLowerCase().includes(needle))
			.filter((t) => !reviewState.accountId || t.accountId === reviewState.accountId)
			.filter((t) => {
				const primary = reviewState.categoryPrimaryId;
				if (!primary) return true;
				if (primary === "__uncategorized") return !t.categoryId;
				if (resolvePrimaryId(store.categories, t.categoryId) !== primary) return false;
				return !reviewState.categorySecondaryId || t.categoryId === reviewState.categorySecondaryId;
			})
			.filter((t) => !reviewState.dateFrom || t.date >= reviewState.dateFrom)
			.filter((t) => !reviewState.dateTo || t.date <= reviewState.dateTo)
			.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
	}

	/**
	 * `subject` is set only when the decision came from a single row's own button. That's what makes
	 * the match sheet appear there and not after a bulk action: someone who ticked twelve rows and
	 * pressed Approve has already chosen their set, and asking "and these others?" would be arguing
	 * with a decision they just made explicitly.
	 */
	async function setStatus(ids: string[], status: ReviewStatus, opts: { subject?: Transaction } = {}): Promise<void> {
		if (ids.length === 0) return;
		const patches = new Map<string, Partial<Transaction>>();
		// "new" is stored as an absent value, so un-approving genuinely clears the field rather than
		// leaving the literal string "new" behind in the CSV.
		for (const id of ids) patches.set(id, { review: status === "new" ? undefined : status });
		const changed = await store.updateTransactions(patches);
		if (changed > 0) {
			const verb = status === "new" ? "Reset" : status === "approved" ? "Approved" : "Flagged";
			new Notice(`${verb} ${changed} transaction${changed === 1 ? "" : "s"}`);
		}
		selected.clear();
		plugin.refreshViews();
		render();

		// Never after clearing a decision: "this needs reviewing again" is a statement about one row,
		// not something to offer to fan out across a merchant.
		if (opts.subject && status !== "new" && plugin.settings.reviewMatchPrompt !== false) {
			offerMatches(opts.subject, status, { justActed: true });
		}
	}

	/**
	 * Builds the match sheet and opens it.
	 *
	 * `force` is the difference between the two ways in. The automatic offer after an approval only
	 * appears when the text tiers already found something — interrupting every single approval to say
	 * "nothing matched, but you could ask Claude" would make the prompt a nuisance within a minute. The
	 * button on the row is an explicit request, so it opens regardless: with nothing found locally, the
	 * sheet's whole content is the Ask Claude offer, which is exactly what was asked for.
	 */
	function offerMatches(subject: Transaction, status: ReviewStatus, opts: { force?: boolean; justActed?: boolean } = {}): boolean {
		const modal = new BulkMatchModal(plugin.app, plugin, subject, { status, justActed: opts.justActed, onDone: () => render() });
		if (!modal.hasAnything && !opts.force) return false;
		modal.open();
		return true;
	}

	async function setCategory(ids: string[], categoryId: string): Promise<void> {
		if (ids.length === 0) return;
		const patches = new Map<string, Partial<Transaction>>();
		for (const id of ids) patches.set(id, { categoryId });
		const changed = await store.updateTransactions(patches);
		// Every bulk assignment is also a lesson: the merchants involved are now known for good.
		await plugin.rememberMerchantsFor(ids, categoryId);
		const name = store.categories.find((c) => c.id === categoryId)?.name ?? "category";
		new Notice(`Set ${changed} transaction${changed === 1 ? "" : "s"} to "${name}"`);
		plugin.refreshViews();
		render();
	}

	/** Category + approval in one action — the common case when working down the queue. */
	async function categorizeAndApprove(ids: string[], categoryId: string): Promise<void> {
		if (ids.length === 0) return;
		const patches = new Map<string, Partial<Transaction>>();
		for (const id of ids) patches.set(id, { categoryId, review: "approved" });
		const changed = await store.updateTransactions(patches);
		await plugin.rememberMerchantsFor(ids, categoryId);
		const name = store.categories.find((c) => c.id === categoryId)?.name ?? "category";
		new Notice(`Categorized and approved ${changed} transaction${changed === 1 ? "" : "s"} as "${name}"`);
		selected.clear();
		plugin.refreshViews();
		render();
	}

	function render(): void {
		container.empty();

		const header = container.createDiv({ cls: "fp-section-header" });
		const headText = header.createDiv({ cls: "fp-section-header-text" });
		const titleRow = headText.createDiv({ cls: "fp-section-title-row" });
		const headIcon = titleRow.createDiv({ cls: "fp-section-icon-badge" });
		icon(headIcon, "check-check");
		titleRow.createEl("h2", { text: "Review" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: "Work through imported transactions: fix the category, then approve. Anything you can't decide on can be flagged and come back to later.",
		});

		const headerActions = header.createDiv({ cls: "fp-section-header-actions" });

		const uncategorizedNow = store.transactions.filter((t) => !t.categoryId).length;
		if (uncategorizedNow > 0) {
			const autoBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-primary" });
			icon(autoBtn, "wand-2");
			autoBtn.createSpan({ text: "Auto-categorize" });
			autoBtn.setAttribute(
				"title",
				`Run the built-in merchant rules, and your own, over the ${uncategorizedNow} transaction${
					uncategorizedNow === 1 ? "" : "s"
				} that still have no category. Nothing already categorized is touched.`
			);
			autoBtn.addEventListener("click", async () => {
				autoBtn.disabled = true;
				await plugin.autoCategorizeExisting();
				render();
			});
		}

		// Shown whenever there is anything to ask about — switched off just disables it and points at
		// the setting. Hiding it made the feature undiscoverable from the one page you'd look on.
		const ai = plugin.settings.ai;
		const pendingMerchants = unknownMerchants(store.transactions, store.merchants).length;
		if (pendingMerchants > 0) {
			const aiBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-primary" });
			icon(aiBtn, "sparkles");
			aiBtn.createSpan({ text: "Ask Claude" });
			if (ai?.enabled) {
				aiBtn.setAttribute(
					"title",
					`Classify the ${pendingMerchants} merchant${pendingMerchants === 1 ? "" : "s"} neither your history nor the built-in rules could identify. Only merchant names are sent.`
				);
				aiBtn.addEventListener("click", async () => {
					aiBtn.disabled = true;
					await plugin.aiCategorizeExisting();
					render();
				});
			} else {
				aiBtn.setAttribute("title", "AI categorization is switched off — click to turn it on.");
				aiBtn.addClass("is-muted");
				aiBtn.addEventListener("click", () => plugin.openVaultSettings("ai"));
			}
		}

		// Offered whenever there is anything already categorized to have a second look at — which is the
		// blind spot every other action here leaves: they all only ever touch rows with no category.
		if (store.transactions.some((t) => t.categoryId)) {
			const recheckBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-secondary" });
			icon(recheckBtn, "refresh-cw");
			recheckBtn.createSpan({ text: "Recheck categories" });
			recheckBtn.setAttribute(
				"title",
				"Have Claude re-classify merchants you've already categorized and propose fixes. Nothing changes until you accept them."
			);
			recheckBtn.addEventListener("click", () => new RecheckModal(plugin.app, plugin, { onDone: () => render() }).open());
		}

		const manageBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(manageBtn, "tag");
		manageBtn.createSpan({ text: "Manage categories" });
		manageBtn.setAttribute("title", "Add, rename, recolour, move or delete categories");
		manageBtn.addEventListener("click", () => plugin.openVaultSettings("categories"));

		if (store.transactions.length === 0) {
			emptyState(container, {
				iconName: "inbox",
				title: "Nothing to review yet",
				description: "Import a bank or broker export first — everything that arrives lands here as unreviewed.",
			});
			return;
		}

		renderCounters();
		renderControls();
		const rows = filtered();
		renderBulkBar(rows);
		renderTable(rows);
	}

	function renderCounters(): void {
		const all = store.transactions;
		const counts = { new: 0, approved: 0, flagged: 0 };
		let uncategorized = 0;
		for (const tx of all) {
			counts[statusOf(tx)]++;
			if (!tx.categoryId) uncategorized++;
		}
		const done = all.length === 0 ? 0 : counts.approved / all.length;

		const kpis = container.createDiv({ cls: "fp-stat-grid" });
		statTile(kpis, {
			label: "To review",
			value: String(counts.new),
			iconName: "circle-dashed",
			tone: counts.new > 0 ? "warn" : "good",
			money: false,
			sub: `${Math.round(done * 100)}% of ${all.length} approved`,
		});
		statTile(kpis, {
			label: "Flagged",
			value: String(counts.flagged),
			iconName: "flag",
			tone: counts.flagged > 0 ? "bad" : "neutral",
			money: false,
			sub: "parked for a decision",
		});
		statTile(kpis, { label: "Approved", value: String(counts.approved), iconName: "check-circle-2", tone: "good", money: false });
		statTile(kpis, {
			label: "Uncategorized",
			value: String(uncategorized),
			iconName: "tag",
			tone: uncategorized > 0 ? "warn" : "good",
			money: false,
			sub: "regardless of review state",
		});
	}

	function renderControls(): void {
		const controls = container.createDiv({ cls: "fp-ledger-controls" });
		const search = controls.createEl("input", {
			type: "text",
			cls: "fp-search",
			placeholder: "Search description, counterparty or notes…",
		});
		search.value = reviewState.search;
		search.addEventListener("input", () => {
			reviewState.search = search.value;
			reviewState.shown = PAGE_SIZE;
			redrawList();
		});

		const filterRow = container.createDiv({ cls: "fp-ledger-filters" });

		const statusSelect = filterRow.createEl("select", { cls: "fp-filter-select" });
		const hidingApproved = plugin.settings.reviewHideApproved !== false;
		(
			[
				["new", "Needs review"],
				["flagged", "Flagged"],
				["approved", "Approved"],
				["uncategorized", hidingApproved ? "Uncategorized (unapproved)" : "Uncategorized"],
				["all", hidingApproved ? "Everything except approved" : "Everything"],
			] as [StatusFilter, string][]
		).forEach(([value, label]) => statusSelect.createEl("option", { text: label, value }));
		statusSelect.value = reviewState.status;
		statusSelect.addEventListener("change", () => {
			reviewState.status = statusSelect.value as StatusFilter;
			reviewState.shown = PAGE_SIZE;
			selected.clear();
			render();
		});

		const accountSelect = filterRow.createEl("select", { cls: "fp-filter-select" });
		accountSelect.createEl("option", { text: "All accounts", value: "" });
		store.accounts.forEach((a) => accountSelect.createEl("option", { text: a.name, value: a.id }));
		accountSelect.value = store.accounts.some((a) => a.id === reviewState.accountId) ? reviewState.accountId : "";
		accountSelect.addEventListener("change", () => {
			reviewState.accountId = accountSelect.value;
			reviewState.shown = PAGE_SIZE;
			redrawList();
		});

		const catGroup = filterRow.createDiv({ cls: "fp-ledger-category-filter" });
		const primaries = primaryCategories(store.categories);
		const primarySelect = catGroup.createEl("select", { cls: "fp-filter-select" });
		primarySelect.createEl("option", { text: "All categories", value: "" });
		primarySelect.createEl("option", { text: "Uncategorized", value: "__uncategorized" });
		primaries.forEach((c) => primarySelect.createEl("option", { text: c.name, value: c.id }));
		primarySelect.value =
			reviewState.categoryPrimaryId === "__uncategorized" || primaries.some((c) => c.id === reviewState.categoryPrimaryId)
				? reviewState.categoryPrimaryId
				: "";

		const secondarySelect = catGroup.createEl("select", { cls: "fp-filter-select" });
		function populateSecondary(primaryId: string, selectedId: string): void {
			secondarySelect.empty();
			const primary = primaries.find((c) => c.id === primaryId);
			const secondaries = primary ? secondaryCategoriesOf(store.categories, primary.id) : [];
			secondarySelect.disabled = secondaries.length === 0;
			secondarySelect.createEl("option", { text: primary ? `All ${primary.name}` : "All subcategories", value: "" });
			secondaries.forEach((c) => {
				const opt = secondarySelect.createEl("option", { text: c.name, value: c.id });
				if (c.id === selectedId) opt.selected = true;
			});
		}
		populateSecondary(primarySelect.value, reviewState.categorySecondaryId);
		primarySelect.addEventListener("change", () => {
			reviewState.categoryPrimaryId = primarySelect.value;
			reviewState.categorySecondaryId = "";
			populateSecondary(primarySelect.value, "");
			reviewState.shown = PAGE_SIZE;
			redrawList();
		});
		secondarySelect.addEventListener("change", () => {
			reviewState.categorySecondaryId = secondarySelect.value;
			reviewState.shown = PAGE_SIZE;
			redrawList();
		});

		const dateFrom = filterRow.createEl("input", { type: "date", cls: "fp-filter-date" });
		dateFrom.value = reviewState.dateFrom;
		dateFrom.addEventListener("change", () => {
			reviewState.dateFrom = dateFrom.value;
			redrawList();
		});
		filterRow.createSpan({ cls: "fp-filter-date-sep", text: "–" });
		const dateTo = filterRow.createEl("input", { type: "date", cls: "fp-filter-date" });
		dateTo.value = reviewState.dateTo;
		dateTo.addEventListener("change", () => {
			reviewState.dateTo = dateTo.value;
			redrawList();
		});

		const clearBtn = filterRow.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Clear filters" });
		clearBtn.addEventListener("click", () => {
			reviewState.search = "";
			reviewState.accountId = "";
			reviewState.categoryPrimaryId = "";
			reviewState.categorySecondaryId = "";
			reviewState.dateFrom = "";
			reviewState.dateTo = "";
			reviewState.shown = PAGE_SIZE;
			selected.clear();
			render();
		});
	}

	/** Re-runs the filter and redraws only the list + bulk bar, so typing in the search box doesn't
	 *  rebuild (and steal focus from) the controls above it. */
	function redrawList(): void {
		const rows = filtered();
		bulkBarEl?.remove();
		tableEl?.remove();
		renderBulkBar(rows);
		renderTable(rows);
	}

	let bulkBarEl: HTMLElement | undefined;
	let tableEl: HTMLElement | undefined;

	function renderBulkBar(rows: Transaction[]): void {
		const visible = rows.slice(0, reviewState.shown);
		const bar = container.createDiv({ cls: "fp-review-bulk-bar" + (selected.size > 0 ? " is-active" : "") });
		bulkBarEl = bar;

		const left = bar.createDiv({ cls: "fp-review-bulk-left" });
		const selectAll = left.createEl("input", { type: "checkbox", cls: "fp-review-check" });
		selectAll.checked = visible.length > 0 && visible.every((t) => selected.has(t.id));
		selectAll.indeterminate = !selectAll.checked && visible.some((t) => selected.has(t.id));
		selectAll.setAttribute("aria-label", "Select every transaction shown");
		selectAll.addEventListener("change", () => {
			if (selectAll.checked) visible.forEach((t) => selected.add(t.id));
			else visible.forEach((t) => selected.delete(t.id));
			redrawList();
		});
		left.createSpan({
			cls: "fp-review-bulk-count",
			text:
				selected.size > 0
					? `${selected.size} selected`
					: `${rows.length} transaction${rows.length === 1 ? "" : "s"} match${rows.length === 1 ? "es" : ""} these filters`,
		});

		if (selected.size === 0) {
			bar.createSpan({ cls: "fp-review-bulk-hint", text: "Tick rows to categorize or approve them in bulk." });
			return;
		}

		const ids = Array.from(selected);
		const actions = bar.createDiv({ cls: "fp-review-bulk-actions" });

		const pickerWrap = actions.createDiv({ cls: "fp-review-bulk-picker" });
		let pendingCategoryId: string | undefined;
		renderCategoryPicker(pickerWrap, {
			categories: store.categories,
			primaryPlaceholder: "Set category…",
			onChange: ({ primaryId, secondaryId }) => {
				pendingCategoryId = secondaryId ?? primaryId;
				applyBtn.disabled = !pendingCategoryId;
				applyApproveBtn.disabled = !pendingCategoryId;
			},
		});

		const applyBtn = actions.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(applyBtn, "tag");
		applyBtn.createSpan({ text: "Apply" });
		applyBtn.disabled = true;
		applyBtn.addEventListener("click", () => {
			if (pendingCategoryId) void setCategory(ids, pendingCategoryId);
		});

		const applyApproveBtn = actions.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(applyApproveBtn, "check-check");
		applyApproveBtn.createSpan({ text: "Apply & approve" });
		applyApproveBtn.disabled = true;
		applyApproveBtn.addEventListener("click", () => {
			if (pendingCategoryId) void categorizeAndApprove(ids, pendingCategoryId);
		});

		const approveBtn = actions.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(approveBtn, "check");
		approveBtn.createSpan({ text: "Approve" });
		approveBtn.addEventListener("click", () => void setStatus(ids, "approved"));

		const flagBtn = actions.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(flagBtn, "flag");
		flagBtn.createSpan({ text: "Flag" });
		flagBtn.addEventListener("click", () => void setStatus(ids, "flagged"));

		const resetBtn = actions.createEl("button", { cls: "fp-btn fp-btn-ghost" });
		icon(resetBtn, "rotate-ccw");
		resetBtn.createSpan({ text: "Mark new" });
		resetBtn.addEventListener("click", () => void setStatus(ids, "new"));

		const clearSelBtn = actions.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Clear selection" });
		clearSelBtn.addEventListener("click", () => {
			selected.clear();
			redrawList();
		});
	}

	function renderTable(rows: Transaction[]): void {
		// Its own class as well, so the column rules can key off the *pane's* width via a container
		// query. A viewport media query is the wrong measure here: this view lives in a split pane, so
		// a narrow pane in a wide window would keep every column and crush the description.
		const card = container.createDiv({ cls: "fp-card fp-ledger-table-wrap fp-review-table-wrap" });
		tableEl = card;

		if (rows.length === 0) {
			card.createEl("p", {
				cls: "fp-step-desc",
				text:
					reviewState.status === "new"
						? "Nothing left to review with these filters — everything here has been approved or flagged."
						: "No transactions match these filters.",
			});
			return;
		}

		const table = card.createEl("table", { cls: "fp-table fp-review-table" });
		const thead = table.createEl("thead").createEl("tr");
		// Column classes rather than positional selectors: the widths live in CSS under table-layout
		// fixed, and a header that drifts out of step with the body is exactly what this replaces.
		(
			[
				["", "col-check"],
				["Date", "col-date"],
				["Description", "col-desc"],
				["Account", "col-account"],
				["Amount", "col-amount"],
				["Category", "col-category"],
				["Status", "col-status"],
				["", "col-actions"],
			] as [string, string][]
		).forEach(([label, cls]) => thead.createEl("th", { text: label, cls }));
		const tbody = table.createEl("tbody");

		const visible = rows.slice(0, reviewState.shown);
		visible.forEach((tx) => renderRow(tbody, tx));

		if (rows.length > visible.length) {
			const moreWrap = card.createDiv({ cls: "fp-review-more" });
			const moreBtn = moreWrap.createEl("button", { cls: "fp-btn fp-btn-secondary" });
			icon(moreBtn, "chevron-down");
			moreBtn.createSpan({ text: `Show ${Math.min(PAGE_SIZE, rows.length - visible.length)} more (${rows.length - visible.length} left)` });
			moreBtn.addEventListener("click", () => {
				reviewState.shown += PAGE_SIZE;
				redrawList();
			});
		}
	}

	/**
	 * The amount, plus a pencil to correct it in place.
	 *
	 * A wrong amount is the one import error you can't fix from this page: a wrong category has a
	 * picker right there in the row, but a mistyped OCR figure or a bank that exported gross instead
	 * of net meant opening the detail modal — or, before that existed, editing the CSV in the vault.
	 * Since reviewing is precisely the pass where you're comparing rows against a statement, the fix
	 * belongs in the row you spotted it on.
	 */
	function renderAmount(cell: HTMLElement, tx: Transaction): void {
		cell.empty();
		cell.removeClass("is-editing");
		cell.createSpan({ cls: "fp-review-amount-value fp-money", text: formatMoney(tx.amount, { currency: tx.currency || "EUR" }) });

		const edit = cell.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon fp-review-amount-edit" });
		icon(edit, "pencil");
		edit.setAttribute("aria-label", `Edit the amount of ${tx.description || "this transaction"}`);
		edit.setAttribute("title", "Correct this amount");
		edit.addEventListener("click", () => editAmount(cell, tx));
	}

	function editAmount(cell: HTMLElement, tx: Transaction): void {
		cell.empty();
		cell.addClass("is-editing");
		const editor = cell.createDiv({ cls: "fp-review-amount-editor" });

		// Magnitude plus a direction, never a signed figure — the same convention as the transaction
		// form. Asking someone to type "-12.50" is asking them to remember an internal convention, and
		// getting it wrong here silently turns an expense into income.
		let direction: "out" | "in" = tx.amount < 0 ? "out" : "in";
		const group = editor.createDiv({ cls: "fp-segmented fp-segmented-tiny" });
		(
			[
				["out", "−", "Money out"],
				["in", "+", "Money in"],
			] as const
		).forEach(([value, label, title]) => {
			const btn = group.createEl("button", { cls: "fp-segmented-btn" + (direction === value ? " is-active" : ""), text: label });
			btn.setAttribute("title", title);
			btn.setAttribute("aria-label", title);
			btn.addEventListener("click", () => {
				direction = value;
				group.querySelectorAll(".fp-segmented-btn").forEach((el) => el.removeClass("is-active"));
				btn.addClass("is-active");
			});
		});

		const field = moneyInput(editor, {
			value: Math.abs(tx.amount),
			currency: tx.currency || "EUR",
			allowNegative: false,
			cls: "fp-review-amount-input",
		});

		const actions = editor.createDiv({ cls: "fp-review-amount-actions" });
		const save = actions.createEl("button", { cls: "fp-btn fp-btn-primary fp-btn-icon" });
		icon(save, "check");
		save.setAttribute("aria-label", "Save this amount");
		save.setAttribute("title", "Save (Enter)");
		const cancel = actions.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
		icon(cancel, "x");
		cancel.setAttribute("aria-label", "Cancel");
		cancel.setAttribute("title", "Cancel (Escape)");

		const commit = async (): Promise<void> => {
			if (!field.isValid()) {
				new Notice("That doesn't read as an amount.");
				return;
			}
			const magnitude = field.value();
			if (magnitude === undefined || magnitude === 0) {
				new Notice("Enter an amount.");
				return;
			}
			const next = direction === "out" ? -Math.abs(magnitude) : Math.abs(magnitude);
			if (next === tx.amount) {
				renderAmount(cell, tx);
				return;
			}
			// editTransaction, not updateTransaction: it rewrites both ends if the row ever moves files,
			// and it is the method that owns "an edit to a saved transaction".
			await store.editTransaction(tx.id, { amount: next });
			new Notice(`Amount changed to ${formatMoney(next, { currency: tx.currency || "EUR" })}`);
			plugin.refreshViews();
			render();
		};

		save.addEventListener("click", () => void commit());
		cancel.addEventListener("click", () => renderAmount(cell, tx));
		field.input.addEventListener("keydown", (ev: KeyboardEvent) => {
			if (ev.key === "Enter") {
				ev.preventDefault();
				void commit();
			} else if (ev.key === "Escape") {
				ev.preventDefault();
				renderAmount(cell, tx);
			}
		});

		field.input.focus();
		field.input.select();
	}

	function renderRow(tbody: HTMLElement, tx: Transaction): void {
		const status = statusOf(tx);
		const tr = tbody.createEl("tr", { cls: `fp-review-row is-${status}` + (selected.has(tx.id) ? " is-selected" : "") });

		const checkCell = tr.createEl("td", { cls: "fp-review-check-cell col-check" });
		const check = checkCell.createEl("input", { type: "checkbox", cls: "fp-review-check" });
		check.checked = selected.has(tx.id);
		check.setAttribute("aria-label", `Select ${tx.description}`);
		check.addEventListener("change", () => {
			if (check.checked) selected.add(tx.id);
			else selected.delete(tx.id);
			tr.toggleClass("is-selected", check.checked);
			// Only the bulk bar depends on the selection, so the table itself is left alone — redrawing
			// it here would drop focus and make ticking a run of rows unusable.
			bulkBarEl?.remove();
			renderBulkBar(filtered());
			container.insertBefore(bulkBarEl!, tableEl!);
		});

		tr.createEl("td", { text: tx.date, cls: "fp-cell-date col-date" });

		const descCell = tr.createEl("td", { cls: "fp-review-desc-cell col-desc" });
		const descLine = descCell.createDiv({ cls: "fp-sensitive fp-review-desc-text" });
		descLine.setText(tx.description || "(no description)");
		if (tx.counterparty) descCell.createDiv({ cls: "fp-review-desc-sub fp-sensitive", text: tx.counterparty });

		// How many other rows a decision here will settle — the reason one click is worth making.
		const key = merchantKey(tx);
		if (key) {
			const others = siblingsOf(store.transactions, tx).filter((t) => !t.categoryId).length;
			if (others > 0) {
				descCell.createDiv({
					cls: "fp-review-merchant-hint",
					text: `${merchantLabel(key)} · ${others} more uncategorized`,
				});
			}
		}

		tr.createEl("td", { text: store.accounts.find((a) => a.id === tx.accountId)?.name ?? "—", cls: "col-account" });

		// fp-money sits on the value span rather than the cell: privacy mode blurs whatever carries it,
		// and a CSS filter can't be undone by a child — so blurring the cell would blur the pencil, and
		// blur the field you were typing an amount into.
		const amtCell = tr.createEl("td", { cls: "fp-cell-amount col-amount " + (tx.amount < 0 ? "is-negative" : "is-positive") });
		renderAmount(amtCell, tx);

		const catCell = tr.createEl("td", { cls: "fp-review-cat-cell col-category" });
		const chain = categoryChain(store.categories, tx.categoryId);
		const chipHolder = catCell.createDiv({ cls: "fp-review-cat-chip" });
		categoryChainChip(chipHolder, chain.primary, chain.secondary);
		renderCategoryPicker(catCell, {
			categories: store.categories,
			value: { primaryId: chain.primary?.id, secondaryId: chain.secondary?.id },
			primaryPlaceholder: chain.primary ? "Change…" : "Set category…",
			onChange: async ({ primaryId, secondaryId }) => {
				if (!primaryId) return;
				const categoryId = secondaryId ?? primaryId;
				// Teaches merchant memory and fans the decision out to every other row from this shop,
				// which is the whole point: categorize once, not once per occurrence.
				const alsoTagged = await plugin.assignCategory(tx, categoryId);
				const newChain = categoryChain(store.categories, categoryId);
				chipHolder.empty();
				categoryChainChip(chipHolder, newChain.primary, newChain.secondary);
				if (alsoTagged > 0) {
					new Notice(`Also applied to ${alsoTagged} other transaction${alsoTagged === 1 ? "" : "s"} from this merchant.`);
				}
				plugin.refreshViews();
				render();
			},
		});

		// A parked AI answer lives on the merchant, not the transaction — so accepting it here settles
		// every row from that shop at once, and rejecting it stops it being offered again.
		const suggestion = key ? store.merchants[key]?.suggestion : undefined;
		if (suggestion && !tx.categoryId) {
			const suggested = store.categories.find((c) => c.id === suggestion.categoryId);
			if (suggested) {
				const box = catCell.createDiv({ cls: "fp-review-suggestion" });
				icon(box, "sparkles", "fp-review-suggestion-icon");
				const chain = categoryChain(store.categories, suggestion.categoryId);
				const text = box.createSpan({ cls: "fp-review-suggestion-text" });
				text.createSpan({ text: "Claude suggests " });
				text.createSpan({ cls: "fp-review-suggestion-name", text: chain.secondary ? `${chain.primary?.name} › ${chain.secondary.name}` : suggested.name });
				text.createSpan({ cls: "fp-review-suggestion-conf", text: ` ${Math.round(suggestion.confidence * 100)}%` });

				const accept = box.createEl("button", { cls: "fp-btn fp-btn-secondary fp-btn-tiny", text: "Accept" });
				accept.addEventListener("click", async () => {
					const alsoTagged = await plugin.assignCategory(tx, suggestion.categoryId);
					new Notice(
						alsoTagged > 0
							? `Accepted — applied to this and ${alsoTagged} other transaction${alsoTagged === 1 ? "" : "s"}.`
							: "Accepted."
					);
					plugin.refreshViews();
					render();
				});

				const reject = box.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-tiny", text: "Dismiss" });
				reject.setAttribute("title", "Drop this suggestion. The merchant stays uncategorized and won't be asked about again.");
				reject.addEventListener("click", async () => {
					store.merchants = dismissSuggestion(store.merchants, key!);
					await store.saveMerchants();
					render();
				});
			}
		}

		const statusCell = tr.createEl("td", { cls: "col-status" });
		const meta = STATUS_META[status];
		badge(statusCell, meta.label, meta.tone);

		const actionCell = tr.createEl("td", { cls: "fp-review-actions col-actions" });
		const approveBtn = actionCell.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" + (status === "approved" ? " is-active" : "") });
		icon(approveBtn, "check");
		approveBtn.setAttribute("aria-label", status === "approved" ? "Mark as needing review again" : "Approve");
		approveBtn.setAttribute("title", status === "approved" ? "Mark as needing review again" : "Approve");
		approveBtn.addEventListener("click", () =>
			void setStatus([tx.id], status === "approved" ? "new" : "approved", { subject: tx })
		);

		const flagBtn = actionCell.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" + (status === "flagged" ? " is-active" : "") });
		icon(flagBtn, "flag");
		flagBtn.setAttribute("aria-label", status === "flagged" ? "Remove flag" : "Flag for a decision later");
		flagBtn.setAttribute("title", status === "flagged" ? "Remove flag" : "Flag for a decision later");
		flagBtn.addEventListener("click", () => void setStatus([tx.id], status === "flagged" ? "new" : "flagged", { subject: tx }));

		// The same sheet the approve button offers, on demand — so it's still reachable after someone
		// has turned the automatic prompt off, and for a row they want to fan out without deciding yet.
		const matchBtn = actionCell.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
		icon(matchBtn, "copy");
		matchBtn.setAttribute("aria-label", "Find matching transactions");
		matchBtn.setAttribute("title", "Find other transactions that look like this one — or ask Claude — and settle them together");
		matchBtn.addEventListener("click", () => {
			// An unreviewed row has no decision to spread yet, so the useful offer there is "approve
			// these together"; a row already flagged or approved spreads whatever it already is.
			const target: ReviewStatus = status === "new" ? "approved" : status;
			offerMatches(tx, target, { force: true });
		});

		const detailBtn = actionCell.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
		icon(detailBtn, "maximize-2");
		detailBtn.setAttribute("aria-label", "Open full details");
		detailBtn.setAttribute("title", "Open full details");
		detailBtn.addEventListener("click", () => new TransactionDetailModal(plugin.app, plugin, tx).open());
	}

	render();
}
