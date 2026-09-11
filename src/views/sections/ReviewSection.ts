import { Notice } from "obsidian";
import { accountReviewProgress, reviewCounts } from "../../review";
import { categoryChain, primaryCategories, resolvePrimaryId, secondaryCategoriesOf } from "../../categories";
import { merchantKey, merchantLabel } from "../../import/merchantKey";
import { dismissSuggestion, unknownMerchants } from "../../import/merchantMemory";
import type FinancePlugin from "../../main";
import { formatMoney } from "../../money";
import { BulkMatchModal } from "../../modals/BulkMatchModal";
import { buildRecheckTargets } from "../../ai/recheck";
import { RecheckModal } from "../../modals/RecheckModal";
import { TransactionDetailModal } from "../../modals/TransactionDetailModal";
import type { ReviewStatus, Transaction } from "../../types";
import { badge, categoryChainChip, emptyState, icon, moneyInput, renderCategoryPicker, searchInput, statTile } from "../../ui/dom";

type StatusFilter = "all" | ReviewStatus | "uncategorized";

interface ReviewFilterState {
	search: string;
	status: StatusFilter;
	accountId: string;
	/** Scopes the queue to one merchant key — see the "By merchant" panel. "" for all. */
	merchantKey: string;
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
	merchantKey: "",
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
	/**
	 * Rows edited in place that no longer match the filters, kept where they sat.
	 *
	 * Filing a row while filtered to "no category" made it stop matching, so the re-render dropped it
	 * out of the list and everything below shifted up — the row you had just decided vanished, and the
	 * next thing you clicked was not the row you had aimed at. Working down a filtered queue is the
	 * whole job of this page, so a filter must not eat the rows you act on while you are still in it.
	 */
	const stickyIds = new Set<string>();
	/** Which of them are on screen only because of that — the bulk bar has to keep its count honest. */
	let keptIds = new Set<string>();
	/** The filters those sticky rows were kept under. Move any filter and they stop being kept: at that
	 *  point you have asked a new question, and the answer should not carry the old one's leftovers. */
	let stickyUnder = "";
	/** The page of rows currently rendered, so an inline edit can tell which of them it changed. */
	let visibleRows: Transaction[] = [];

	function statusOf(tx: Transaction): ReviewStatus {
		return tx.review ?? "new";
	}

	function filterSignature(): string {
		return [
			reviewState.search,
			reviewState.status,
			reviewState.accountId,
			reviewState.merchantKey,
			reviewState.categoryPrimaryId,
			reviewState.categorySecondaryId,
			reviewState.dateFrom,
			reviewState.dateTo,
		].join("\u0000");
	}

	/** Rows matching every active filter, newest first — the "shown" cap is applied after this.
	 *  Plus any row edited in place since the filters last moved, held in its old position. */
	function filtered(): Transaction[] {
		// One check rather than a stickyIds.clear() in every filter handler: there are a dozen of them
		// across the controls, the two panels and the empty state, and the next one added would forget.
		const signature = filterSignature();
		if (signature !== stickyUnder) {
			stickyIds.clear();
			stickyUnder = signature;
		}

		const matched = applyFilters();
		keptIds = new Set();
		if (stickyIds.size === 0) return matched;

		const present = new Set(matched.map((t) => t.id));
		const kept = store.transactions.filter((t) => stickyIds.has(t.id) && !present.has(t.id));
		if (kept.length === 0) return matched;

		keptIds = new Set(kept.map((t) => t.id));
		return [...matched, ...kept].sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
	}

	/**
	 * The same rows the merchant filter is not applied to.
	 *
	 * The "By merchant" panel groups these, so that choosing a merchant narrows the list below without
	 * reducing the panel to the single merchant you just chose from — which would leave nowhere to go
	 * next but back.
	 */
	function filteredIgnoringMerchant(): Transaction[] {
		return applyFilters({ merchant: false });
	}

	/** The same, for the "By category" panel — see filteredIgnoringMerchant for why. */
	function filteredIgnoringCategory(): Transaction[] {
		return applyFilters({ category: false });
	}

	/**
	 * `ignoreStatus` and `ignoreSearch` exist for the empty state, which has to answer "where did they
	 * go" — a question you can only answer by running the same filters with one of them lifted.
	 */
	function applyFilters(
		opts: { merchant?: boolean; category?: boolean; ignoreStatus?: boolean; ignoreSearch?: boolean } = {}
	): Transaction[] {
		const withMerchant = opts.merchant !== false;
		const withCategory = opts.category !== false;
		const needle = opts.ignoreSearch ? "" : reviewState.search.trim().toLowerCase();
		// The "hide approved" preference only applies to the broad filters. Asking explicitly for
		// approved rows always shows them — a setting that could make a filter return nothing it names
		// would just read as a bug.
		const hideApproved = plugin.settings.reviewHideApproved !== false;
		return store.transactions
			.filter((t) => {
				if (opts.ignoreStatus) return true;
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
			.filter((t) => !withMerchant || !reviewState.merchantKey || merchantKey(t) === reviewState.merchantKey)
			.filter((t) => {
				const primary = withCategory ? reviewState.categoryPrimaryId : "";
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
		// Signing off the last row of a shop is the judgement that the shop is filed right, so record it
		// as such. Without this, approving the whole queue left every merchant still "unconfirmed" and
		// the recheck dialog kept offering to re-examine work that had just been done by hand.
		if (status === "approved") await plugin.confirmFullyApprovedMerchants(ids);
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
		await plugin.confirmFullyApprovedMerchants(ids);
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

		// The queue's own AI action. "Auto-categorize" and "Ask Claude" above both only ever look at rows
		// with NO category, so once an import has filed everything they disappear — leaving a review
		// queue full of machine guesses and no way to ask for a second opinion on precisely those. This
		// asks the recheck question of the rows still waiting on you, and nothing else.
		const queue = store.transactions.filter((t) => (t.review ?? "new") !== "approved" && t.categoryId);
		if (queue.length > 0) {
			const queueBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-primary" });
			icon(queueBtn, "sparkles");
			queueBtn.createSpan({ text: "Ask Claude about the queue" });
			if (ai?.enabled) {
				queueBtn.setAttribute(
					"title",
					`Have Claude re-classify the merchants behind the ${queue.length} transaction${
						queue.length === 1 ? "" : "s"
					} still waiting for review, and propose fixes. Nothing changes until you accept them.`
				);
				queueBtn.addEventListener("click", () =>
					new RecheckModal(plugin.app, plugin, {
						scope: { transactions: queue, label: "the review queue" },
						onDone: () => render(),
					}).open()
				);
			} else {
				queueBtn.setAttribute("title", "AI categorization is switched off — click to turn it on.");
				queueBtn.addClass("is-muted");
				queueBtn.addEventListener("click", () => plugin.openVaultSettings("ai"));
			}
		}

		// Offered whenever there is anything already categorized to have a second look at — which is the
		// blind spot every other action here leaves: they all only ever touch rows with no category.
		//
		// Disabled, not hidden, when there is nothing left to re-examine. The button opening a dialog
		// whose entire content is "there is nothing to do" is a wasted click every time, and hiding it
		// outright would make the feature vanish from the one page anyone would look for it on. The
		// same count the dialog would compute decides it, so the two can never disagree.
		if (store.transactions.some((t) => t.categoryId)) {
			const pending = buildRecheckTargets(store.transactions, store.merchants, { includeReviewed: false });
			const recheckBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-secondary" });
			icon(recheckBtn, "refresh-cw");
			recheckBtn.createSpan({ text: "Recheck categories" });
			if (pending.targets.length === 0) {
				recheckBtn.disabled = true;
				recheckBtn.addClass("is-muted");
				recheckBtn.setAttribute(
					"title",
					"Nothing left to re-examine — every categorized merchant is confirmed or deliberately split across categories. Open it again after your next import."
				);
			} else {
				recheckBtn.setAttribute(
					"title",
					`Have Claude re-classify the ${pending.targets.length} merchant${
						pending.targets.length === 1 ? "" : "s"
					} not yet confirmed and propose fixes. Nothing changes until you accept them.`
				);
				recheckBtn.addEventListener("click", () => new RecheckModal(plugin.app, plugin, { onDone: () => render() }).open());
			}
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
		renderCategoryPanel();
		renderMerchantPanel();
		renderBulkBar(rows);
		renderTable(rows);
	}

	function renderCounters(): void {
		countersEl?.remove();
		countersEl = container.createDiv();
		// createDiv appends, which is right on the first pass and wrong on every later one: redrawing
		// the counters after an account change left the stat tiles sitting *below* the filter row they
		// belong above, and nothing put them back.
		if (controlsEl?.parentElement === container) container.insertBefore(countersEl, controlsEl);
		const host = countersEl;

		// Scoped to the account being reviewed, not the whole ledger. Reading every account at once
		// made "3,950 approved, 0 to review" the answer whichever account was selected, so the page
		// reported the work finished while a freshly imported account sat untouched inside that number.
		const scoped = reviewState.accountId
			? store.transactions.filter((t) => t.accountId === reviewState.accountId)
			: store.transactions;
		const account = store.accounts.find((a) => a.id === reviewState.accountId);
		const all = scoped;
		const c = reviewCounts(scoped);
		const counts = { new: c.toReview, approved: c.approved, flagged: c.flagged };
		const uncategorized = c.uncategorized;
		const done = all.length === 0 ? 0 : counts.approved / all.length;

		if (account) {
			host.createDiv({
				cls: "fp-review-scope",
				text: `Showing ${account.name} only — the figures below are this account's.`,
			});
		}

		const kpis = host.createDiv({ cls: "fp-stat-grid" });
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

		renderAccountProgress(host);
	}

	/**
	 * Per-account progress, so several accounts can be read at once rather than by cycling the filter.
	 *
	 * Only worth showing when there is more than one account: with a single one it would restate the
	 * cards immediately above it.
	 */
	function renderAccountProgress(host: HTMLElement): void {
		if (store.accounts.length < 2) return;
		const progress = accountReviewProgress(store.transactions, store.accounts);

		const wrap = host.createDiv({ cls: "fp-review-accounts" });
		wrap.createDiv({ cls: "fp-form-section-label", text: "By account" });
		const table = wrap.createEl("table", { cls: "fp-table" });
		const headRow = table.createEl("thead").createEl("tr");
		["Account", "To review", "Flagged", "Approved", "Uncategorized"].forEach((h, i) =>
			headRow.createEl("th", { text: h, cls: i > 0 ? "fp-table-num" : "" })
		);

		const tbody = table.createEl("tbody");
		for (const { account, counts } of progress) {
			const outstanding = counts.toReview + counts.flagged;
			const tr = tbody.createEl("tr", {
				cls: "fp-table-row-clickable" + (account.id === reviewState.accountId ? " is-selected" : ""),
			});
			// Clicking sets the filter, which is the action the row makes you want to take.
			tr.addEventListener("click", () => {
				reviewState.accountId = reviewState.accountId === account.id ? "" : account.id;
				reviewState.shown = PAGE_SIZE;
				render();
			});

			const nameCell = tr.createEl("td");
			nameCell.createSpan({ text: account.name });
			if (counts.total === 0) badge(nameCell, "no transactions", "neutral");
			else if (outstanding === 0) badge(nameCell, "done", "good");

			tr.createEl("td", { cls: "fp-table-num", text: counts.toReview > 0 ? String(counts.toReview) : "—" });
			tr.createEl("td", { cls: "fp-table-num", text: counts.flagged > 0 ? String(counts.flagged) : "—" });
			tr.createEl("td", { cls: "fp-table-num", text: String(counts.approved) });
			tr.createEl("td", { cls: "fp-table-num", text: counts.uncategorized > 0 ? String(counts.uncategorized) : "—" });
		}
	}

	/** No category at all — its own group, because "what has nothing on it" is the other half of the
	 *  question this panel answers. */
	const NO_CATEGORY = "__none";

	/**
	 * The queue grouped by what it has already been filed as, with sign-off per group.
	 *
	 * Nothing in the review queue has been agreed to by a person — a category on an unapproved row was
	 * put there by the import rules, by merchant memory, or by Claude. So the queue is mostly not a
	 * list of decisions to make, it is a list of guesses to confirm, and confirming them one row at a
	 * time is the slowest possible way to do it. Grouped, "everything the importer called Groceries"
	 * is one look and one click.
	 *
	 * By leaf category, not by primary: "Entertainment" spanning concerts, subscriptions and cinema is
	 * three different judgements wearing one name, and approving them together is exactly the mistake
	 * this is meant to save you from.
	 */
	function renderCategoryPanel(): void {
		// Grouped from the rows matching every filter *except* the category one, so picking a category
		// narrows the list below without reducing the panel to the single row you picked from.
		const scope = reviewState.categoryPrimaryId ? filteredIgnoringCategory() : filtered();
		const groups = new Map<string, { count: number; merchants: Set<string>; ruled: number }>();
		for (const tx of scope) {
			const key = tx.categoryId || NO_CATEGORY;
			let entry = groups.get(key);
			if (!entry) {
				entry = { count: 0, merchants: new Set<string>(), ruled: 0 };
				groups.set(key, entry);
			}
			entry.count++;
			const mk = merchantKey(tx);
			if (mk) entry.merchants.add(mk);
			if (tx.categoryRuleId) entry.ruled++;
		}

		const ranked = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
		categoryPanelEl = undefined;
		// One group is the whole queue restated; there is nothing to compare and nothing to choose.
		if (ranked.length < 2) return;

		const filed = ranked.filter(([id]) => id !== NO_CATEGORY);
		const filedRows = filed.reduce((n, [, g]) => n + g.count, 0);
		const collapsed = plugin.settings.reviewCategoryPanelCollapsed === true;
		const card = container.createDiv({ cls: "fp-card fp-merchant-panel" + (collapsed ? " is-collapsed" : "") });
		categoryPanelEl = card;
		const head = card.createDiv({ cls: "fp-section-header" });

		// A div with a role, not a button — see renderMerchantPanel.
		const headText = head.createDiv({
			cls: "fp-merchant-panel-toggle",
			attr: { role: "button", tabindex: "0", "aria-expanded": String(!collapsed) },
		});
		const titleRow = headText.createDiv({ cls: "fp-merchant-panel-title" });
		icon(titleRow, "chevron-right", "fp-merchant-panel-chevron");
		titleRow.createEl("h3", { text: "By category" });
		titleRow.createSpan({
			cls: "fp-merchant-panel-summary",
			text: `${filed.length} categor${filed.length === 1 ? "y" : "ies"} · ${filedRows} row${filedRows === 1 ? "" : "s"}`,
		});
		const toggle = (): void => {
			plugin.settings.reviewCategoryPanelCollapsed = !collapsed;
			void plugin.saveSettings();
			render();
		};
		headText.addEventListener("click", toggle);
		headText.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				toggle();
			}
		});

		if (collapsed) return;

		const uncategorized = groups.get(NO_CATEGORY)?.count ?? 0;
		headText.createDiv({
			cls: "fp-section-subtitle",
			text:
				`Where the ${filedRows} already-filed row${filedRows === 1 ? "" : "s"} here ended up — none of it agreed to by you yet, so this is the guesswork waiting to be confirmed.` +
				(uncategorized > 0 ? ` ${uncategorized} more still ${uncategorized === 1 ? "has" : "have"} no category at all.` : ""),
		});

		if (reviewState.categoryPrimaryId) {
			const clear = head.createEl("button", { cls: "fp-btn fp-btn-ghost" });
			icon(clear, "x");
			clear.createSpan({ text: "Show all categories" });
			clear.addEventListener("click", () => {
				reviewState.categoryPrimaryId = "";
				reviewState.categorySecondaryId = "";
				reviewState.shown = PAGE_SIZE;
				render();
			});
		}

		const shown = categoryPanelExpanded ? ranked : ranked.slice(0, MERCHANT_PANEL_LIMIT);
		const list = card.createDiv({ cls: "fp-merchant-list" });
		for (const [id, group] of shown) {
			renderCategoryRow(list, id, group);
		}

		if (ranked.length > shown.length || categoryPanelExpanded) {
			const more = card.createEl("button", { cls: "fp-btn fp-btn-ghost fp-merchant-more" });
			more.createSpan({ text: categoryPanelExpanded ? "Show fewer" : `Show all ${ranked.length} groups` });
			more.addEventListener("click", () => {
				categoryPanelExpanded = !categoryPanelExpanded;
				render();
			});
		}
	}

	function renderCategoryRow(list: HTMLElement, id: string, group: { count: number; merchants: Set<string>; ruled: number }): void {
		const { count } = group;
		const chain = id === NO_CATEGORY ? undefined : categoryChain(store.categories, id);
		const isActive = reviewState.categorySecondaryId === id || (reviewState.categoryPrimaryId === "__uncategorized" && id === NO_CATEGORY);
		const isOpen = expandedCategories.has(id);
		const row = list.createDiv({ cls: "fp-merchant-row" + (isActive ? " is-active" : "") });

		const expand = row.createDiv({
			cls: "fp-merchant-expand" + (isOpen ? " is-open" : ""),
			attr: { role: "button", tabindex: "0", "aria-expanded": String(isOpen), title: isOpen ? "Hide these rows" : `Show the ${count} rows` },
		});
		icon(expand, "chevron-right");
		const toggleOpen = (): void => {
			if (isOpen) expandedCategories.delete(id);
			else expandedCategories.add(id);
			render();
		};
		expand.addEventListener("click", toggleOpen);
		expand.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				toggleOpen();
			}
		});

		row.createDiv({ cls: "fp-merchant-count", text: String(count) });

		const nameEl = row.createDiv({
			cls: "fp-merchant-name",
			attr: { role: "button", tabindex: "0", title: isActive ? "Showing only this category — click to show all" : "Show only this category" },
		});
		if (chain?.primary) categoryChainChip(nameEl, chain.primary, chain.secondary);
		else nameEl.createSpan({ cls: "fp-budget-hint-text", text: "No category" });
		// How many different shops are inside the number. One merchant filed 47 times is a safe
		// approval; 40 merchants sharing a category is the case where the group is worth opening first.
		const merchants = group.merchants.size;
		if (merchants > 0) {
			nameEl.createSpan({
				cls: "fp-merchant-cat-meta",
				text: `${merchants} merchant${merchants === 1 ? "" : "s"}` + (group.ruled > 0 ? ` · ${group.ruled} by a rule you wrote` : ""),
			});
		}
		const toggleFilter = (): void => {
			if (isActive) {
				reviewState.categoryPrimaryId = "";
				reviewState.categorySecondaryId = "";
			} else if (id === NO_CATEGORY) {
				reviewState.categoryPrimaryId = "__uncategorized";
				reviewState.categorySecondaryId = "";
			} else {
				// The exact leaf, always — including when the leaf *is* the primary. Filtering to the
				// primary alone would pull in its subcategories, and the queue would then disagree with
				// the count on the row you just clicked.
				reviewState.categoryPrimaryId = resolvePrimaryId(store.categories, id) ?? "";
				reviewState.categorySecondaryId = id;
			}
			reviewState.shown = PAGE_SIZE;
			render();
		};
		nameEl.addEventListener("click", toggleFilter);
		nameEl.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				toggleFilter();
			}
		});

		const actions = row.createDiv({ cls: "fp-merchant-actions" });

		// Re-filing the whole group is the other half of reading it: a category that turns out to be
		// wrong is wrong for every row under it, and fixing that one row at a time is the same trap
		// approving one row at a time is.
		let pending: string | undefined;
		renderCategoryPicker(actions.createDiv({ cls: "fp-merchant-picker" }), {
			categories: store.categories,
			primaryPlaceholder: "Move to…",
			onChange: ({ primaryId, secondaryId }) => {
				pending = secondaryId ?? primaryId;
				moveBtn.disabled = !pending;
			},
		});

		const moveBtn = actions.createEl("button", { cls: "fp-btn fp-btn-secondary fp-merchant-apply" });
		icon(moveBtn, "tag");
		moveBtn.createSpan({ text: `Move ${count}` });
		moveBtn.disabled = true;
		moveBtn.addEventListener("click", () => {
			if (!pending) return;
			void categorizeAndApprove(categoryRows(id).map((t) => t.id), pending);
		});

		// The point of the panel. Disabled rather than absent for the uncategorized group: signing off a
		// row while it still has no category files nothing, and would quietly empty the queue of the
		// rows that most need a decision — but dropping the button also shortened that row's action
		// block, which made every row's actions start 128px right of the one above it. Saying why it
		// can't be clicked is better than a gap that says nothing.
		const okBtn = actions.createEl("button", { cls: "fp-btn fp-btn-primary fp-merchant-apply" });
		icon(okBtn, "check-check");
		okBtn.createSpan({ text: `Approve ${count}` });
		if (id === NO_CATEGORY) {
			okBtn.disabled = true;
			okBtn.addClass("is-muted");
			okBtn.setAttribute("title", "These rows have no category yet — filing them is the decision, not approving them.");
		} else {
			okBtn.setAttribute("title", `Approve all ${count} rows as they are filed now`);
			okBtn.addEventListener("click", () => void setStatus(categoryRows(id).map((t) => t.id), "approved"));
		}

		if (isOpen) renderCategoryRows(list, id);
	}

	/** Every row in this group in the current scope — not only the page on screen. */
	function categoryRows(id: string): Transaction[] {
		return filteredIgnoringCategory().filter((t) => (t.categoryId || NO_CATEGORY) === id);
	}

	/** The transactions behind a group's count — same reasoning as the merchant panel's. */
	function renderCategoryRows(list: HTMLElement, id: string): void {
		const rows = categoryRows(id);
		const panel = list.createDiv({ cls: "fp-merchant-detail" });
		const wrap = panel.createDiv({ cls: "fp-table-scroll" });
		const table = wrap.createEl("table", { cls: "fp-table" });
		const headRow = table.createEl("thead").createEl("tr");
		["Date", "Description", "Account", "Amount"].forEach((h, i) => headRow.createEl("th", { text: h, cls: i === 3 ? "fp-table-num" : "" }));
		const tbody = table.createEl("tbody");
		for (const tx of rows.slice(0, MERCHANT_DETAIL_LIMIT)) {
			const tr = tbody.createEl("tr", { cls: "fp-table-row-clickable" });
			tr.addEventListener("click", () => new TransactionDetailModal(plugin.app, plugin, tx).open());
			tr.createEl("td", { text: tx.date || "No date", cls: "fp-cell-date" });
			const desc = tr.createEl("td", { cls: "fp-sensitive" });
			desc.createDiv({ text: tx.description || "(no description)" });
			if (tx.counterparty && tx.counterparty !== tx.description) {
				desc.createDiv({ cls: "fp-merchant-detail-sub fp-sensitive", text: tx.counterparty });
			}
			tr.createEl("td", { text: store.accounts.find((a) => a.id === tx.accountId)?.name ?? "—" });
			tr.createEl("td", {
				cls: "fp-table-num fp-money " + (tx.amount < 0 ? "is-negative" : "is-positive"),
				text: formatMoney(tx.amount, { currency: tx.currency || "EUR" }),
			});
		}
		if (rows.length > MERCHANT_DETAIL_LIMIT) {
			panel.createDiv({ cls: "fp-field-hint", text: `Showing ${MERCHANT_DETAIL_LIMIT} of ${rows.length}. Click the category to filter the queue to it and see them all.` });
		}
	}

	/** How many merchants the panel lists before "show all" — enough to cover the bulk of a queue
	 *  without becoming a second list to scroll past. */
	const MERCHANT_PANEL_LIMIT = 12;

	/** Enough rows to judge what a merchant is without turning the panel into the list below it. */
	const MERCHANT_DETAIL_LIMIT = 12;

	/**
	 * The queue grouped by who was paid, with a category picker per merchant.
	 *
	 * A review queue is not a list of decisions, it is a list of *rows* — and the same decision is
	 * spread across all of them. On this ledger 1,076 rows needing attention are 608 merchants, and
	 * the twenty biggest account for 310 of those rows: VMware alone is 75, Hoofdweg 47, PayPal 41.
	 * Filing those one row at a time is 310 identical judgements. Here it is twenty.
	 *
	 * It deliberately does not replace the row list. 468 of those merchants have a single row, and
	 * nothing about grouping helps them — the panel takes the head of the distribution and leaves the
	 * tail to the list below, which is what the list is good at.
	 */
	function renderMerchantPanel(): void {
		// Grouped from the rows matching every filter *except* the merchant one, so picking a merchant
		// narrows the list below without emptying the panel you picked it from.
		const scope = reviewState.merchantKey ? filteredIgnoringMerchant() : filtered();
		const groups = new Map<string, { count: number; name: string }>();
		for (const tx of scope) {
			const key = merchantKey(tx);
			if (!key) continue;
			const entry = groups.get(key) ?? { count: 0, name: merchantLabel(key) };
			entry.count++;
			groups.set(key, entry);
		}
		// One row per merchant is what the list below already does well; a panel of them is just the
		// same list with fewer columns.
		const ranked = [...groups.entries()].filter(([, g]) => g.count > 1).sort((a, b) => b[1].count - a[1].count);
		merchantPanelEl = undefined;
		if (ranked.length === 0) return;

		const covered = ranked.reduce((n, [, g]) => n + g.count, 0);
		const collapsed = plugin.settings.reviewMerchantPanelCollapsed === true;
		const card = container.createDiv({ cls: "fp-card fp-merchant-panel" + (collapsed ? " is-collapsed" : "") });
		merchantPanelEl = card;
		const head = card.createDiv({ cls: "fp-section-header" });

		// A div with a role, not a button: a theme that styles `button` wins over a plain class, which
		// has already turned two headings in this branch into grey pills with centred text.
		const headText = head.createDiv({
			cls: "fp-merchant-panel-toggle",
			attr: { role: "button", tabindex: "0", "aria-expanded": String(!collapsed) },
		});
		const titleRow = headText.createDiv({ cls: "fp-merchant-panel-title" });
		icon(titleRow, "chevron-right", "fp-merchant-panel-chevron");
		titleRow.createEl("h3", { text: "By merchant" });
		// Collapsed, the header still has to say what is in there, or folding it away turns it into a
		// heading with no reason to open it.
		titleRow.createSpan({
			cls: "fp-merchant-panel-summary",
			text: `${ranked.length} merchant${ranked.length === 1 ? "" : "s"} · ${covered} row${covered === 1 ? "" : "s"}`,
		});
		const toggle = (): void => {
			plugin.settings.reviewMerchantPanelCollapsed = !collapsed;
			void plugin.saveSettings();
			render();
		};
		headText.addEventListener("click", toggle);
		headText.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				toggle();
			}
		});

		// Collapsed is the title row and its counts, nothing else — the paragraph explaining the
		// remainder is worth reading once, not every time the panel is folded away.
		if (collapsed) return;
		// The gap between `covered` and the queue is the whole reason this panel does not cover
		// everything, so it says what the difference is made of rather than leaving the two numbers
		// side by side inviting the question.
		const singles = [...groups.values()].filter((g) => g.count === 1).length;
		const unnamed = scope.length - covered - singles;
		const remainder: string[] = [];
		if (singles > 0) remainder.push(`${singles} merchant${singles === 1 ? "" : "s"} appearing once each`);
		if (unnamed > 0) remainder.push(`${unnamed} with no merchant name`);
		headText.createDiv({
			cls: "fp-section-subtitle",
			text:
				`${ranked.length} merchant${ranked.length === 1 ? "" : "s"} with more than one row, covering ${covered} of the ${scope.length} here — filing one files all of them.` +
				(remainder.length > 0
					? ` The other ${scope.length - covered} are ${remainder.join(" and ")} — nothing to group, so they are in the list below.`
					: ""),
		});
		if (reviewState.merchantKey) {
			const clear = head.createEl("button", { cls: "fp-btn fp-btn-ghost" });
			icon(clear, "x");
			clear.createSpan({ text: "Show all merchants" });
			clear.addEventListener("click", () => {
				reviewState.merchantKey = "";
				reviewState.shown = PAGE_SIZE;
				render();
			});
		}

		const shown = merchantPanelExpanded ? ranked : ranked.slice(0, MERCHANT_PANEL_LIMIT);
		const list = card.createDiv({ cls: "fp-merchant-list" });
		for (const [key, group] of shown) {
			renderMerchantRow(list, key, group.name, group.count);
		}

		if (ranked.length > shown.length || merchantPanelExpanded) {
			const more = card.createEl("button", { cls: "fp-btn fp-btn-ghost fp-merchant-more" });
			more.createSpan({
				text: merchantPanelExpanded ? "Show fewer" : `Show all ${ranked.length} merchants`,
			});
			more.addEventListener("click", () => {
				merchantPanelExpanded = !merchantPanelExpanded;
				render();
			});
		}
	}

	function renderMerchantRow(list: HTMLElement, key: string, name: string, count: number): void {
		const isActive = reviewState.merchantKey === key;
		const isOpen = expandedMerchants.has(key);
		const row = list.createDiv({ cls: "fp-merchant-row" + (isActive ? " is-active" : "") });

		// A div, not a button. A theme that styles `button` at all beats a plain class selector, and
		// this row came out as a 693px grey pill with its text centred — the same way the sidebar's
		// "Closed" heading did. Nothing here needs to be a button except the click.
		const expand = row.createDiv({
			cls: "fp-merchant-expand" + (isOpen ? " is-open" : ""),
			attr: { role: "button", tabindex: "0", "aria-expanded": String(isOpen), title: isOpen ? "Hide these rows" : `Show the ${count} rows` },
		});
		icon(expand, "chevron-right");
		const toggleOpen = (): void => {
			if (isOpen) expandedMerchants.delete(key);
			else expandedMerchants.add(key);
			render();
		};
		expand.addEventListener("click", toggleOpen);
		expand.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				toggleOpen();
			}
		});

		row.createDiv({ cls: "fp-merchant-count", text: String(count) });

		const nameEl = row.createDiv({
			cls: "fp-merchant-name",
			text: name,
			attr: { role: "button", tabindex: "0", title: isActive ? "Showing only this merchant — click to show all" : `Show only ${name}` },
		});
		const toggleFilter = (): void => {
			reviewState.merchantKey = isActive ? "" : key;
			reviewState.shown = PAGE_SIZE;
			render();
		};
		nameEl.addEventListener("click", toggleFilter);
		nameEl.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				toggleFilter();
			}
		});

		const actions = row.createDiv({ cls: "fp-merchant-actions" });
		// Its own picker per row rather than one shared control: the whole point is deciding several
		// merchants in a row without a selection step between each.
		let pending: string | undefined;
		renderCategoryPicker(actions.createDiv({ cls: "fp-merchant-picker" }), {
			categories: store.categories,
			primaryPlaceholder: "Set category…",
			onChange: ({ primaryId, secondaryId }) => {
				pending = secondaryId ?? primaryId;
				applyBtn.disabled = !pending;
			},
		});

		const applyBtn = actions.createEl("button", { cls: "fp-btn fp-btn-primary fp-merchant-apply" });
		icon(applyBtn, "check-check");
		applyBtn.createSpan({ text: `File ${count}` });
		applyBtn.disabled = true;
		applyBtn.addEventListener("click", () => {
			if (!pending) return;
			void categorizeAndApprove(merchantRows(key).map((t) => t.id), pending);
		});

		if (isOpen) renderMerchantRows(list, key);
	}

	/** Every row of this merchant in the current scope — not only the page on screen. */
	function merchantRows(key: string): Transaction[] {
		return filteredIgnoringMerchant().filter((t) => merchantKey(t) === key);
	}

	/**
	 * The transactions behind a merchant's count.
	 *
	 * "File 75" is a large claim to accept on a name alone — especially where the name came from a
	 * counterparty the ledger only half-recognises. This is the cheap way to check what is actually in
	 * there before agreeing to it.
	 */
	function renderMerchantRows(list: HTMLElement, key: string): void {
		const rows = merchantRows(key);
		const panel = list.createDiv({ cls: "fp-merchant-detail" });
		const wrap = panel.createDiv({ cls: "fp-table-scroll" });
		const table = wrap.createEl("table", { cls: "fp-table" });
		const headRow = table.createEl("thead").createEl("tr");
		["Date", "Description", "Account", "Category", "Amount"].forEach((h, i) =>
			headRow.createEl("th", { text: h, cls: i === 4 ? "fp-table-num" : "" })
		);
		const tbody = table.createEl("tbody");
		for (const tx of rows.slice(0, MERCHANT_DETAIL_LIMIT)) {
			const tr = tbody.createEl("tr", { cls: "fp-table-row-clickable" });
			tr.addEventListener("click", () => new TransactionDetailModal(plugin.app, plugin, tx).open());
			tr.createEl("td", { text: tx.date || "No date", cls: "fp-cell-date" });
			const desc = tr.createEl("td", { cls: "fp-sensitive" });
			desc.createDiv({ text: tx.description || "(no description)" });
			if (tx.counterparty && tx.counterparty !== tx.description) {
				desc.createDiv({ cls: "fp-merchant-detail-sub fp-sensitive", text: tx.counterparty });
			}
			tr.createEl("td", { text: store.accounts.find((a) => a.id === tx.accountId)?.name ?? "—" });
			const catCell = tr.createEl("td");
			const chain = categoryChain(store.categories, tx.categoryId);
			if (chain.primary) categoryChainChip(catCell, chain.primary, chain.secondary);
			else catCell.createSpan({ cls: "fp-budget-hint-text", text: "Uncategorized" });
			tr.createEl("td", {
				cls: "fp-table-num fp-money " + (tx.amount < 0 ? "is-negative" : "is-positive"),
				text: formatMoney(tx.amount, { currency: tx.currency || "EUR" }),
			});
		}
		if (rows.length > MERCHANT_DETAIL_LIMIT) {
			panel.createDiv({
				cls: "fp-field-hint",
				text: `Showing ${MERCHANT_DETAIL_LIMIT} of ${rows.length}. Click the name to filter the queue to this merchant and see them all.`,
			});
		}
	}

	function renderControls(): void {
		const controls = container.createDiv({ cls: "fp-ledger-controls" });
		controlsEl = controls;
		searchInput(controls, {
			placeholder: "Search description, counterparty or notes…",
			value: reviewState.search,
			onChange: (value) => {
				reviewState.search = value;
				reviewState.shown = PAGE_SIZE;
				redrawList();
			},
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
			// The counters are scoped to the account too, so they have to follow the filter rather than
			// keep reporting whatever was true when the page was first drawn.
			renderCounters();
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
			// A row can be filed at the primary itself rather than in any of its subcategories, and until
			// now there was no way to ask for exactly those: "All Travel & Vacation" swept in every
			// subcategory too, so the "By category" panel could say 22 and the queue answer 28. Offered
			// only when such rows actually exist, and judged against the whole ledger so the option
			// doesn't flicker in and out as the other filters move.
			if (primary && secondaries.length > 0 && store.transactions.some((t) => t.categoryId === primary.id)) {
				const opt = secondarySelect.createEl("option", { text: `Directly in ${primary.name}`, value: primary.id });
				if (primary.id === selectedId) opt.selected = true;
			}
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

		// The merchant filter's only control used to live inside the "By merchant" panel — which hides
		// itself the moment nothing in scope has more than one row. Approving a merchant's last rows
		// therefore left the filter switched on, invisible, and clearable only by wiping every other
		// filter with it. It belongs in the row with the filters it behaves like.
		if (reviewState.merchantKey) {
			const chip = filterRow.createDiv({
				cls: "fp-filter-chip",
				attr: { role: "button", tabindex: "0", title: "Stop filtering by this merchant" },
			});
			chip.createSpan({ cls: "fp-filter-chip-label", text: merchantLabel(reviewState.merchantKey) });
			icon(chip, "x", "fp-filter-chip-x");
			const drop = (): void => {
				reviewState.merchantKey = "";
				reviewState.shown = PAGE_SIZE;
				render();
			};
			chip.addEventListener("click", drop);
			chip.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter" || ev.key === " ") {
					ev.preventDefault();
					drop();
				}
			});
		}

		const clearBtn = filterRow.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Clear filters" });
		clearBtn.addEventListener("click", () => {
			reviewState.search = "";
			reviewState.accountId = "";
			reviewState.merchantKey = "";
			reviewState.categoryPrimaryId = "";
			reviewState.categorySecondaryId = "";
			reviewState.dateFrom = "";
			reviewState.dateTo = "";
			reviewState.shown = PAGE_SIZE;
			selected.clear();
			render();
		});
	}

	/** Re-runs the filter and redraws the merchant panel, list and bulk bar, so typing in the search
	 *  box doesn't rebuild (and steal focus from) the controls above it.
	 *
	 *  The panel used to be left standing here, which put two contradictory answers on one screen: a
	 *  search that emptied the queue left "39 merchants · 142 rows" sitting above "0 transactions match
	 *  these filters". Worse, the merchants it still listed were the pre-search ones, so clicking one
	 *  set a merchant filter that could not intersect the search — silently, since the merchant filter
	 *  has no control of its own in the filter row. */
	function redrawList(): void {
		const rows = filtered();
		categoryPanelEl?.remove();
		merchantPanelEl?.remove();
		bulkBarEl?.remove();
		tableEl?.remove();
		renderCategoryPanel();
		renderMerchantPanel();
		renderBulkBar(rows);
		renderTable(rows);
	}

	/** Rebuilt once per redraw — see uncategorizedByMerchant. */
	let siblingCounts = new Map<string, number>();
	let merchantPanelExpanded = false;
	const expandedMerchants = new Set<string>();
	let categoryPanelExpanded = false;
	const expandedCategories = new Set<string>();
	let countersEl: HTMLElement | undefined;
	/** Anchor for the counters, which have to sit above the filters — see renderCounters. */
	let controlsEl: HTMLElement | undefined;
	/** One <tr> per rendered transaction, so a single row can be refreshed without rebuilding the table. */
	let rowEls = new Map<string, HTMLElement>();
	let categoryPanelEl: HTMLElement | undefined;
	let merchantPanelEl: HTMLElement | undefined;
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
		// Counted without the kept rows: they are on screen because you just edited them, not because
		// they match, and a count that included them would be wrong about the thing it names.
		const matching = rows.length - keptIds.size;
		left.createSpan({
			cls: "fp-review-bulk-count",
			text:
				selected.size > 0
					? `${selected.size} selected`
					: `${matching} transaction${matching === 1 ? "" : "s"} match${matching === 1 ? "es" : ""} these filters`,
		});
		if (selected.size === 0 && keptIds.size > 0) {
			left.createSpan({
				cls: "fp-review-kept-note",
				text: `· ${keptIds.size} just edited, held in place`,
			});
		}

		if (selected.size === 0) {
			bar.createSpan({ cls: "fp-review-bulk-hint", text: "Tick rows to categorize or approve them in bulk." });
			return;
		}

		// Scoped to what the filters are actually showing. The selection set is not cleared by the
		// account, search, category or date filters, so a tick made before narrowing survived into a
		// bulk action that then wrote to rows no longer on screen — and the select-all checkbox could
		// not undo it, because it only ever adds and removes the visible ones. Deriving the ids from
		// `rows` makes "apply to the selection" mean "apply to the selection you can see", which is the
		// only reading anyone has when they press the button.
		const ids = rows.filter((t) => selected.has(t.id)).map((t) => t.id);
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

	/**
	 * How many *other* uncategorized rows each merchant still has, counted once per redraw.
	 *
	 * The hint under each description used to call `siblingsOf(store.transactions, tx)`, which scans
	 * the whole ledger and derives a merchant key for every row it passes. Called once per rendered
	 * row that is 100 x 7,153 = 715,300 key derivations for a single keystroke in the search box, and
	 * it cost 2.8 seconds each time. The counts are the same for every row in the batch, so they are
	 * built in one pass and read as a lookup.
	 */
	function uncategorizedByMerchant(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const tx of store.transactions) {
			if (tx.categoryId) continue;
			const key = merchantKey(tx);
			if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return counts;
	}

	/**
	 * Why the queue is empty, and the way back out of it.
	 *
	 * "Nothing left to review with these filters" is true and useless. Approving the last rows of a
	 * search empties the list the instant you do it, and the page then looks identical to one where the
	 * search never matched anything — so finishing a merchant reads as the review having vanished. The
	 * two cases are only distinguishable by re-running the same filters with one lifted, which is
	 * exactly what this does: it says which filter is holding the rows back, and offers to lift that
	 * one rather than making "Clear filters" the only exit.
	 */
	function renderEmptyQueue(card: HTMLElement): void {
		const searching = reviewState.search.trim();
		const inScope = applyFilters({ ignoreStatus: true });
		const reviewed = inScope.filter((t) => statusOf(t) !== "new");
		const elsewhere = searching ? applyFilters({ ignoreSearch: true }).length : 0;

		const lines: string[] = [];
		if (reviewState.status === "new" && reviewed.length > 0 && reviewed.length === inScope.length) {
			const approved = reviewed.filter((t) => statusOf(t) === "approved").length;
			const flagged = reviewed.length - approved;
			const parts = [approved > 0 ? `${approved} approved` : "", flagged > 0 ? `${flagged} flagged` : ""].filter(Boolean);
			lines.push(
				`Done here — all ${reviewed.length} transaction${reviewed.length === 1 ? "" : "s"} matching these filters ${
					reviewed.length === 1 ? "has" : "have"
				} been reviewed (${parts.join(", ")}). Nothing was lost.`
			);
		} else if (reviewState.status === "new") {
			lines.push("Nothing left to review with these filters — everything here has been approved or flagged.");
		} else {
			lines.push("No transactions match these filters.");
		}
		if (searching && elsewhere > 0) {
			lines.push(`${elsewhere} more still ${elsewhere === 1 ? "needs" : "need"} attention outside the search for "${searching}".`);
		}
		card.createEl("p", { cls: "fp-step-desc", text: lines.join(" ") });

		const outs = card.createDiv({ cls: "fp-empty-actions" });
		const escape = (label: string, iconName: string, act: () => void): void => {
			const btn = outs.createEl("button", { cls: "fp-btn fp-btn-secondary" });
			icon(btn, iconName);
			btn.createSpan({ text: label });
			btn.addEventListener("click", act);
		};

		if (searching && elsewhere > 0) {
			escape("Clear the search", "x", () => {
				reviewState.search = "";
				reviewState.shown = PAGE_SIZE;
				render();
			});
		}
		if (reviewState.merchantKey) {
			escape(`Stop filtering by ${merchantLabel(reviewState.merchantKey)}`, "users", () => {
				reviewState.merchantKey = "";
				reviewState.shown = PAGE_SIZE;
				render();
			});
		}
		// Named after the bucket it actually switches to, not "show the reviewed": the "everything except
		// approved" filter would hide the approved ones again, so a button promising them would open on
		// an empty list — the exact failure this whole block exists to undo.
		if (reviewState.status === "new" && reviewed.length > 0) {
			const approved = reviewed.filter((t) => statusOf(t) === "approved").length;
			const flagged = reviewed.length - approved;
			const target: StatusFilter = approved >= flagged ? "approved" : "flagged";
			const n = approved >= flagged ? approved : flagged;
			escape(`Show the ${n} ${target}`, target === "approved" ? "check-check" : "flag", () => {
				reviewState.status = target;
				reviewState.shown = PAGE_SIZE;
				selected.clear();
				render();
			});
		}
	}

	function renderTable(rows: Transaction[]): void {
		siblingCounts = uncategorizedByMerchant();
		// Its own class as well, so the column rules can key off the *pane's* width via a container
		// query. A viewport media query is the wrong measure here: this view lives in a split pane, so
		// a narrow pane in a wide window would keep every column and crush the description.
		const card = container.createDiv({ cls: "fp-card fp-ledger-table-wrap fp-review-table-wrap" });
		tableEl = card;

		if (rows.length === 0) {
			renderEmptyQueue(card);
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
		visibleRows = visible;
		rowEls = new Map();
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

	/** Rebuilds one row in place, leaving every other row — and anything focused in them — untouched. */
	function refreshRow(tx: Transaction): void {
		const existing = rowEls.get(tx.id);
		if (!existing?.parentElement) return;
		const scratch = document.createElement("tbody");
		renderRow(scratch, tx);
		const fresh = scratch.lastElementChild;
		if (fresh instanceof HTMLElement) {
			existing.replaceWith(fresh);
			rowEls.set(tx.id, fresh);
		}
	}

	/**
	 * Everything the section shows except the table.
	 *
	 * Setting a category from a row used to call render(), which rebuilds the whole section — including
	 * the <select> your pointer is already on its way to. A full render is 52ms and replaces that node
	 * outright, so choosing a primary category and then reaching for the subcategory beside it landed on
	 * a dead element: the dropdown either refused to open or shut the instant the ledger write returned.
	 *
	 * The counters, panels and bulk bar all still have to move, so they are redrawn and put back in
	 * front of the table rather than appended after it.
	 */
	function refreshKeepingTable(): void {
		if (!tableEl?.parentElement) {
			render();
			return;
		}
		renderCounters();
		categoryPanelEl?.remove();
		merchantPanelEl?.remove();
		bulkBarEl?.remove();
		renderCategoryPanel();
		renderMerchantPanel();
		renderBulkBar(filtered());
		for (const el of [categoryPanelEl, merchantPanelEl, bulkBarEl]) {
			if (el) container.insertBefore(el, tableEl);
		}
	}

	function renderRow(tbody: HTMLElement, tx: Transaction): void {
		const status = statusOf(tx);
		const tr = tbody.createEl("tr", { cls: `fp-review-row is-${status}` + (selected.has(tx.id) ? " is-selected" : "") });
		rowEls.set(tx.id, tr);

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
			// This row's own uncategorized state is already counted in the map, so subtract it to keep
			// the wording true: "more uncategorized" means besides this one.
			const others = (siblingCounts.get(key) ?? 0) - (tx.categoryId ? 0 : 1);
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

		// Marked, not silently different: a row that no longer matches the filter it is sitting in has
		// to say so, or the list quietly stops meaning what its heading claims.
		if (keptIds.has(tx.id)) {
			tr.addClass("is-kept");
			tr.setAttribute("title", "Kept in place after you edited it — it no longer matches these filters, and will go when you next change them.");
		}

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
				// Snapshotted against the live objects the store mutates in place, so this reads which
				// rows on screen the edit actually touched rather than re-deriving the fan-out rules.
				const before = visibleRows.map((row) => [row, row.categoryId] as const);
				// Teaches merchant memory and fans the decision out to every other row from this shop,
				// which is the whole point: categorize once, not once per occurrence.
				const alsoTagged = await plugin.assignCategory(tx, categoryId);
				// The edited row and every sibling the fan-out reached stay put. Without the siblings a
				// single click could still empty half the visible list, which is the same surprise.
				stickyIds.add(tx.id);
				for (const [row, previous] of before) if (row.categoryId !== previous) stickyIds.add(row.id);
				const newChain = categoryChain(store.categories, categoryId);
				chipHolder.empty();
				categoryChainChip(chipHolder, newChain.primary, newChain.secondary);
				if (alsoTagged > 0) {
					new Notice(`Also applied to ${alsoTagged} other transaction${alsoTagged === 1 ? "" : "s"} from this merchant.`);
				}
				// This row is left exactly as it is — replacing it is what broke the subcategory dropdown,
				// and its chip has already been updated above. Every other row the fan-out reached is
				// rebuilt on its own so its category can't go stale, and refreshViews is deliberately not
				// called: it re-renders this view too, which is the same sledgehammer by another name.
				for (const [row, previous] of before) {
					if (row.id !== tx.id && row.categoryId !== previous) refreshRow(row);
				}
				refreshKeepingTable();
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
