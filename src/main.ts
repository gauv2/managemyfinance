import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { defaultCategories, VIEW_TYPE_FINANCE } from "./constants";
import { aiCategorize, describeAiResult } from "./ai/categorizer";
import { budgetAlerts, currentMonth } from "./budgets";
import { autoCategorize, buildDefaultRules, effectiveRules } from "./import/autoCategorize";
import { merchantKey } from "./import/merchantKey";
import { applyMemory, applyPendingSuggestions, learnFromHistory, markReviewed, pruneMemory, remember, siblingsOf } from "./import/merchantMemory";
import { BalanceSnapshotModal } from "./modals/BalanceSnapshotModal";
import { RecheckModal } from "./modals/RecheckModal";
import { DetectedSubscriptionsModal, dueSoon } from "./modals/SubscriptionLinkModal";
import { TransactionEditModal } from "./modals/TransactionEditModal";
import { TransferMatchModal } from "./modals/TransferMatchModal";
import { formatMoney, setNumberFormatPreference } from "./money";
import { reviewMilestone } from "./review";
import { celebrate } from "./ui/celebrate";
import { registerFinanceCodeBlock } from "./reports/codeblock";
import { buildMonthlyReport, buildNetWorthReport, buildYearlyReport, type ReportContext } from "./reports/markdown";
import { runDueSchedules } from "./reports/scheduleRunner";
import { openNote, writeReportNote } from "./reports/write";
import { FinanceSettingTab } from "./settings/SettingsTab";
import { DEFAULT_SETTINGS, FinanceSettings, FinanceStore } from "./store";
import type { Portfolio, Transaction } from "./types";
import { FinanceView } from "./views/FinanceView";
import { openImportWizard } from "./wizards/ImportWizard";

function sanitizeFolderName(name: string): string {
	return name.trim().replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "Portfolio";
}

export default class FinancePlugin extends Plugin {
	settings: FinanceSettings = DEFAULT_SETTINGS;
	store!: FinanceStore;
	private settingTab?: FinanceSettingTab;

	/**
	 * Wall-clock time this build was loaded. Shown next to the version wherever the version is,
	 * because the version alone can't answer the question you actually have while testing: Obsidian
	 * re-reads a plugin only when it's toggled or the app restarts, so a rebuilt main.js can sit on
	 * disk while the old one is still running — and the version number would look correct throughout.
	 * A load time that hasn't moved is the tell.
	 */
	loadedAt = "";

	async onload(): Promise<void> {
		// hourCycle h23 rather than toLocaleTimeString(): the default follows the system locale and
		// renders "2:17:07 PM", which is harder to compare against a build time at a glance.
		this.loadedAt = new Intl.DateTimeFormat(undefined, {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		}).format(new Date());
		await this.loadSettings();
		await this.ensureDefaultPortfolio();
		this.store = new FinanceStore(this.app, this.settings);
		await this.store.load();
		this.watchReviewMilestones();

		this.registerView(VIEW_TYPE_FINANCE, (leaf: WorkspaceLeaf) => new FinanceView(leaf, this));
		this.settingTab = new FinanceSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.addRibbonIcon("wallet", "Open Finance", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-finance-workspace",
			name: "Open Finance workspace",
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: "import-transactions",
			name: "Import transactions",
			callback: () => openImportWizard(this),
		});

		this.addCommand({
			id: "ai-categorize-transactions",
			name: "Categorize remaining transactions with Claude",
			callback: () => void this.aiCategorizeExisting(),
		});

		this.addCommand({
			id: "recheck-categories",
			name: "Recheck existing categories with Claude",
			callback: () => new RecheckModal(this.app, this).open(),
		});

		this.addCommand({
			id: "auto-categorize-transactions",
			name: "Auto-categorize uncategorized transactions",
			callback: () => void this.autoCategorizeExisting(),
		});

		this.addCommand({
			id: "install-default-categories",
			name: "Install default categories & auto-categorize transactions",
			callback: () => void this.installDefaultCategoriesAndCategorize(),
		});

		this.addCommand({
			id: "add-transaction",
			name: "Add a transaction",
			callback: () => new TransactionEditModal(this.app, this, {}).open(),
		});

		this.addCommand({
			id: "find-transfers",
			name: "Find transfers between your accounts",
			callback: () => new TransferMatchModal(this.app, this).open(),
		});

		this.addCommand({
			id: "record-balance",
			name: "Record an account balance",
			callback: () => new BalanceSnapshotModal(this.app, this).open(),
		});

		this.addCommand({
			id: "detect-subscriptions",
			name: "Find recurring payments not tracked as subscriptions",
			callback: () => new DetectedSubscriptionsModal(this.app, this).open(),
		});

		this.addCommand({
			id: "report-month",
			name: "Write this month's report into the vault",
			callback: () => void this.writeMonthlyReport(),
		});

		this.addCommand({
			id: "report-year",
			name: "Write this year's report into the vault",
			callback: () => void this.writeYearlyReport(),
		});

		this.addCommand({
			id: "report-networth",
			name: "Write a net worth report into the vault",
			callback: () => void this.writeNetWorthReport(),
		});

		this.addCommand({
			id: "open-reports",
			name: "Build a report (categories, period, PDF/CSV/Excel)",
			callback: () => void this.openView("reports"),
		});

		// Figures can be embedded in any note via a ```finance block — see reports/codeblock.ts.
		registerFinanceCodeBlock(this);

		// Deferred until the workspace is ready so a notice can't fire into a half-built UI, and so
		// opening Obsidian isn't held up by work nobody is waiting on.
		this.app.workspace.onLayoutReady(() => {
			this.notifyBudgetAlerts();
			this.notifyUpcomingRenewals();
			// Scheduled reports are checked here rather than on a timer: a plugin has no background
			// process, so "every Monday" can only mean "on the first launch on or after Monday". A
			// failure is reported and leaves the period due, so the next launch retries it.
			void runDueSchedules(this).catch((e) => {
				new Notice(`Couldn't check scheduled reports: ${e instanceof Error ? e.message : String(e)}`);
			});
		});
	}

	/** The context every report builder needs — one place, so all three agree on currency and version. */
	private reportContext(): ReportContext {
		return {
			store: this.store,
			categories: this.store.categories,
			baseCurrency: this.settings.baseCurrency,
			generatedAt: new Date().toISOString(),
			pluginVersion: this.manifest.version,
			portfolioName: this.activePortfolio?.name,
			rolloverMode: this.store.budgeting.rolloverMode ?? "off",
		};
	}

	async writeMonthlyReport(month = currentMonth()): Promise<void> {
		const path = await writeReportNote(this.app, this.settings.dataFolder, month, buildMonthlyReport(this.reportContext(), month));
		new Notice(`Report written to ${path}`);
		await openNote(this.app, path);
	}

	async writeYearlyReport(year = String(new Date().getFullYear())): Promise<void> {
		const path = await writeReportNote(this.app, this.settings.dataFolder, year, buildYearlyReport(this.reportContext(), year));
		new Notice(`Report written to ${path}`);
		await openNote(this.app, path);
	}

	async writeNetWorthReport(): Promise<void> {
		const path = await writeReportNote(this.app, this.settings.dataFolder, "Net worth", buildNetWorthReport(this.reportContext()));
		new Notice(`Report written to ${path}`);
		await openNote(this.app, path);
	}

	/**
	 * Warns about budgets that are close to (or past) their limit this month.
	 *
	 * One notice, listing the worst few, rather than one per category: a budget you have blown is
	 * worth an interruption, six separate interruptions about it are not.
	 */
	private notifyBudgetAlerts(): void {
		if (this.settings.budgetAlerts === false) return;
		const alerts = budgetAlerts(
			this.store,
			this.store.categories,
			currentMonth(),
			this.settings.budgetAlertThreshold ?? 0.9,
			this.store.budgeting.rolloverMode ?? "off"
		);
		if (alerts.length === 0) return;

		const over = alerts.filter((a) => a.severity === "over");
		const lines = alerts
			.slice(0, 4)
			.map((a) => `${a.categoryName}: ${formatMoney(a.spent)} of ${formatMoney(a.available)} (${Math.round(a.pct * 100)}%)`);
		const more = alerts.length > lines.length ? `\n+${alerts.length - lines.length} more` : "";
		new Notice(`${over.length > 0 ? `${over.length} budget${over.length === 1 ? "" : "s"} blown` : "Budgets running close"}\n${lines.join("\n")}${more}`, 12000);
	}

	/** Reminds about subscriptions renewing in the next few days — the point of tracking a due date. */
	private notifyUpcomingRenewals(): void {
		if (this.settings.subscriptionReminders === false) return;
		const days = this.settings.subscriptionReminderDays ?? 3;
		const due = dueSoon(this.store.subscriptions, days);
		if (due.length === 0) return;
		const lines = due.slice(0, 4).map((d) => `${d.sub.name} — ${d.daysUntil === 0 ? "today" : `in ${d.daysUntil} day${d.daysUntil === 1 ? "" : "s"}`}`);
		new Notice(`Subscriptions renewing soon\n${lines.join("\n")}`, 10000);
	}

	onunload(): void {
		// Views are torn down by Obsidian; nothing to clean up manually.
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		setNumberFormatPreference(this.settings.numberFormat);
	}

	async saveSettings(): Promise<void> {
		// Applied here rather than only where the setting is edited, so every path that writes settings
		// (including a restored backup) leaves the formatter agreeing with what was just saved.
		setNumberFormatPreference(this.settings.numberFormat);
		await this.saveData(this.settings);
	}

	async activateView(): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FINANCE)) {
			if (leaf.getRoot() === this.app.workspace.rootSplit) {
				await this.app.workspace.revealLeaf(leaf);
				return;
			}
			// Leftover from an older layout (e.g. a sidebar) — drop it so we open fresh in the main area.
			leaf.detach();
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_FINANCE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Confetti when a write finishes off the review queue or the flagged pile.
	 *
	 * Installed on the store rather than on the review page, because the page is only two of the
	 * fifteen places in this app that write a transaction — clearing your last flagged rows through
	 * the "approve the rest of these too?" sheet finished the whole review and threw nothing. What
	 * counts as a milestone is decided by reviewMilestone(), from the tallies alone.
	 */
	private watchReviewMilestones(): void {
		this.store.onReviewChange = (before, after) => {
			const milestone = reviewMilestone(before, after);
			if (milestone) celebrate(milestone);
		};
	}

	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FINANCE)) {
			const view = leaf.view;
			if (view instanceof FinanceView) view.refresh();
		}
	}

	/**
	 * Opens Obsidian's own settings modal on this plugin's tab — the "vault settings" half of the two
	 * settings surfaces. `group` deep-links to one section of it (e.g. "categories"), so a button in the
	 * workspace can land somewhere useful rather than wherever the tab was last left.
	 */
	openVaultSettings(group?: string): void {
		if (group) this.settingTab?.selectGroup(group);
		const appWithSetting = this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } };
		appWithSetting.setting.open();
		appWithSetting.setting.openTabById(this.manifest.id);
	}

	get activePortfolio(): Portfolio | undefined {
		return this.settings.portfolios?.find((p) => p.id === this.settings.activePortfolioId);
	}

	// The sidebar tips (src/ui/tips.ts) act on the app rather than merely describing it, and they're
	// declared as data, not as UI. These are the verbs they call — also useful anywhere else that
	// wants to open one of these without importing the modal itself.

	/** Switches the workspace to one of its non-account pages, opening it first if it isn't already
	 *  on screen — a command that names a page is otherwise silent when the workspace is closed. */
	async openView(view: NonNullable<FinanceSettings["activeView"]>): Promise<void> {
		this.settings.activeView = view;
		await this.saveSettings();
		await this.activateView();
		this.refreshViews();
	}

	openTransactionEditor(defaultAccountId?: string): void {
		new TransactionEditModal(this.app, this, { defaultAccountId }).open();
	}

	openTransferMatcher(): void {
		new TransferMatchModal(this.app, this).open();
	}

	openBalanceSnapshot(accountId?: string): void {
		new BalanceSnapshotModal(this.app, this, { accountId }).open();
	}

	openSubscriptionDetector(): void {
		new DetectedSubscriptionsModal(this.app, this).open();
	}

	/** Flips privacy mode (the eye button) and repaints everything showing an amount. */
	async togglePrivacyMode(): Promise<void> {
		this.settings.privacyMode = !this.settings.privacyMode;
		await this.saveSettings();
		this.refreshViews();
	}

	/**
	 * Rebuilds merchant memory from everything already categorized, then fills in every uncategorized
	 * transaction whose merchant is now known.
	 *
	 * This is the deterministic half of categorization and by far the most valuable: your own past
	 * decisions are better evidence than any rule or model guess, they're free, and replaying them is
	 * exactly consistent rather than approximately right.
	 */
	async applyMerchantMemory(): Promise<number> {
		const store = this.store;
		store.merchants = pruneMemory(learnFromHistory(store.transactions, store.merchants), store.categories);

		// Answers already given but held back for approval. Free to apply — no request involved.
		let flaggedKeys = new Set<string>();
		if (this.settings.ai?.applyLowConfidence !== false) {
			const pending = applyPendingSuggestions(store.merchants);
			store.merchants = pending.map;
			flaggedKeys = pending.keys;
		}

		const { patches } = applyMemory(store.transactions, store.merchants, store.categories);
		if (patches.size > 0) {
			const rich = new Map<string, Partial<Transaction>>();
			for (const [txId, categoryId] of patches) {
				const tx = store.transactions.find((t) => t.id === txId);
				const key = tx ? merchantKey(tx) : undefined;
				// An answer that was below the bar stays visible as flagged, rather than passing as
				// something the app was sure about.
				rich.set(txId, key && flaggedKeys.has(key) ? { categoryId, review: "flagged" } : { categoryId });
			}
			await store.updateTransactions(rich);
		}
		await store.saveMerchants();
		return patches.size;
	}

	/**
	 * Records that a merchant belongs to a category and applies that to every other transaction from
	 * the same merchant that doesn't have one yet.
	 *
	 * This is what makes one decision stick: categorize a row once and every other occurrence of that
	 * shop follows, backwards through the ledger and forwards through future imports.
	 */
	async assignCategory(tx: Transaction, categoryId: string): Promise<number> {
		const store = this.store;
		await store.updateTransaction(tx.id, { categoryId });

		const key = merchantKey(tx);
		if (!key) return 0;

		// What this merchant was filed as a moment ago, captured before `remember` overwrites it.
		const previousCategoryId = store.merchants[key]?.categoryId;

		store.merchants = remember(store.merchants, key, categoryId, "user");
		await store.saveMerchants();

		// Siblings that are blank, or that still carry the category this merchant is moving away from.
		//
		// Filling blanks alone was not enough, and produced the "sometimes it fans out, sometimes I
		// have to click every row" behaviour. Picking a two-level category is two changes, not one:
		// the picker fires as soon as the primary is chosen, so "Groceries" propagates to every blank
		// sibling, and the follow-up "Groceries > Supermarket" then finds nothing blank left to touch.
		// The clicked row ended up on the subcategory and its dozen siblings stayed on the parent.
		//
		// Matching the previous category as well makes that second change land, and makes the fan-out
		// able to correct a mistake rather than only fill a gap. A sibling deliberately filed somewhere
		// else matches neither test, so a hand-made exception is still left alone.
		const siblings = siblingsOf(store.transactions, tx).filter(
			(t) => !t.categoryId || (previousCategoryId !== undefined && t.categoryId === previousCategoryId)
		);
		if (siblings.length === 0) return 0;
		const patches = new Map(siblings.map((t) => [t.id, { categoryId }] as const));
		return store.updateTransactions(new Map(patches));
	}

	/**
	 * Teaches merchant memory from a set of rows that were just given a category by hand.
	 *
	 * Every bulk assignment is also a lesson: whatever shops those rows belong to are now known for
	 * good, so the next import of them lands categorized rather than back in the review queue. Called
	 * by every path that sets a category on more than one row at a time.
	 */
	/**
	 * Credits a merchant as confirmed once every one of its rows has been approved.
	 *
	 * Approving a row and confirming a merchant were tracked separately, and only the second one was
	 * ever set deliberately — so a vault could sit at 3,950 of 3,950 approved while the recheck dialog
	 * still offered to re-examine hundreds of shops, as though the work had never happened. Signing off
	 * the last transaction of a shop IS the judgement that shop is filed correctly; recording it here
	 * means the count of "already confirmed" reflects what was actually reviewed.
	 *
	 * Deliberately conservative: a merchant whose rows are split across categories is left alone, since
	 * there is no single category to confirm, and a merchant with any row still unapproved is not
	 * credited yet.
	 */
	async confirmFullyApprovedMerchants(ids: Iterable<string>): Promise<number> {
		const store = this.store;
		const chosen = new Set(ids);

		const keys = new Set<string>();
		for (const tx of store.transactions) {
			if (!chosen.has(tx.id)) continue;
			const key = merchantKey(tx);
			if (key) keys.add(key);
		}
		if (keys.size === 0) return 0;

		// One pass over the ledger for all of them, rather than a scan per merchant.
		const state = new Map<string, { allApproved: boolean; categories: Set<string> }>();
		for (const tx of store.transactions) {
			const key = merchantKey(tx);
			if (!key || !keys.has(key)) continue;
			const entry = state.get(key) ?? { allApproved: true, categories: new Set<string>() };
			if ((tx.review ?? "new") !== "approved") entry.allApproved = false;
			if (tx.categoryId) entry.categories.add(tx.categoryId);
			state.set(key, entry);
		}

		let confirmed = 0;
		for (const [key, entry] of state) {
			if (!entry.allApproved || entry.categories.size !== 1) continue;
			if (store.merchants[key]?.reviewedAt) continue;
			store.merchants = markReviewed(store.merchants, key, Array.from(entry.categories)[0]);
			confirmed++;
		}
		if (confirmed > 0) await store.saveMerchants();
		return confirmed;
	}

	/**
	 * Teaches merchant memory from a batch where each row has its own category — the shape a rules
	 * re-file produces, unlike `rememberMerchantsFor` which applies one category to every id.
	 */
	async rememberMerchantsForRules(patches: Map<string, string>): Promise<void> {
		const store = this.store;
		let touched = false;
		for (const tx of store.transactions) {
			const categoryId = patches.get(tx.id);
			if (!categoryId) continue;
			const key = merchantKey(tx);
			if (!key) continue;
			// "rule" rather than "user": a rule wrote this, and a later hand-made decision should outrank it.
			store.merchants = remember(store.merchants, key, categoryId, "rule");
			touched = true;
		}
		if (touched) await store.saveMerchants();
	}

	async rememberMerchantsFor(ids: Iterable<string>, categoryId: string): Promise<void> {
		const store = this.store;
		const chosen = new Set(ids);
		let touched = false;
		for (const tx of store.transactions) {
			if (!chosen.has(tx.id)) continue;
			const key = merchantKey(tx);
			if (!key) continue;
			store.merchants = remember(store.merchants, key, categoryId, "user");
			touched = true;
		}
		if (touched) await store.saveMerchants();
	}

	/**
	 * Runs merchant memory first, then the shipped rules (plus your own) over whatever is still
	 * uncategorized. Nothing already categorized is touched, and the shipped rules are never written
	 * into your rules.json.
	 *
	 * Needed as its own action because categorization happens at import time, so transactions imported
	 * before a rule or a merchant was known stay uncategorized forever otherwise.
	 */
	async autoCategorizeExisting(): Promise<number> {
		const store = this.store;
		const fromMemory = await this.applyMerchantMemory();

		const rules = effectiveRules(store.categories, store.rules);
		const { patches, categorized } = autoCategorize(store.transactions, store.categories, rules);
		if (patches.size > 0) await store.recategorize(patches);

		// A rule match teaches merchant memory too, so the next import matches without re-running rules.
		for (const [txId, categoryId] of patches) {
			const tx = store.transactions.find((t) => t.id === txId);
			const key = tx ? merchantKey(tx) : undefined;
			if (key) store.merchants = remember(store.merchants, key, categoryId, "rule");
		}
		if (patches.size > 0) await store.saveMerchants();

		const total = fromMemory + categorized;
		const remaining = store.transactions.filter((t) => !t.categoryId).length;
		new Notice(
			total === 0
				? `Nothing new matched — ${remaining} still uncategorized.`
				: `Categorized ${total} transaction${total === 1 ? "" : "s"} (${fromMemory} from merchants you've already filed, ${categorized} from rules) — ${remaining} left.`
		);
		this.refreshViews();
		return total;
	}

	/**
	 * Asks Claude about the merchants nothing else could identify, then applies the confident answers.
	 *
	 * Deliberately last in the pipeline: it only ever sees merchants that your own history and the
	 * shipped rules both failed on, which is what keeps a full pass to a few thousand tokens instead
	 * of one request per transaction.
	 */
	async aiCategorizeExisting(): Promise<number> {
		const store = this.store;
		const ai = this.settings.ai;
		if (!ai?.enabled) {
			new Notice("AI categorization is off. Turn it on in Settings → AI.");
			return 0;
		}

		const notice = new Notice("Asking Claude about unrecognized merchants…", 0);
		try {
			const result = await aiCategorize(store.transactions, store.categories, store.merchants, ai, (done, total) =>
				notice.setMessage(`Asking Claude… ${done}/${total} merchants`)
			);
			store.merchants = result.memory;
			await store.saveMerchants();
			if (result.patches.size > 0) await store.updateTransactions(result.patches);

			notice.hide();
			new Notice(describeAiResult(result, result.patches.size), 10000);
			this.refreshViews();
			return result.patches.size;
		} catch (err) {
			notice.hide();
			new Notice(`AI categorization failed: ${err instanceof Error ? err.message : String(err)}`, 12000);
			return 0;
		}
	}

	/**
	 * One-shot, safe to re-run: adds any of the plugin's default categories this portfolio doesn't
	 * already have (by name — never touches or removes existing ones), adds the default keyword rules
	 * it doesn't already have, then categorizes every currently-uncategorized transaction it can match.
	 */
	async installDefaultCategoriesAndCategorize(): Promise<void> {
		const store = this.store;

		const missing = defaultCategories().filter((seed) => !store.categories.some((c) => c.name === seed.name));
		if (missing.length > 0) {
			store.categories.push(...missing);
			await store.saveCategories();
		}
		await store.seedDefaultSecondaryCategories();

		const newRules = buildDefaultRules(store.categories).filter(
			(rule) => !store.rules.some((existing) => existing.pattern === rule.pattern && existing.categoryId === rule.categoryId)
		);
		if (newRules.length > 0) {
			store.rules.push(...newRules);
			await store.saveRules();
		}

		const { patches, categorized } = autoCategorize(store.transactions, store.categories, effectiveRules(store.categories, store.rules));
		if (patches.size > 0) await store.recategorize(patches);

		new Notice(`Added ${missing.length} categories, ${newRules.length} rules — categorized ${categorized} transaction${categorized === 1 ? "" : "s"}`);
		this.refreshViews();
	}

	/** Migrates pre-portfolio installs: whatever dataFolder already pointed at becomes portfolio #1, untouched — no files move. */
	private async ensureDefaultPortfolio(): Promise<void> {
		if (this.settings.portfolios && this.settings.portfolios.length > 0) return;
		const portfolio: Portfolio = { id: `pf-${Date.now()}`, name: "Gaurav", folder: this.settings.dataFolder };
		this.settings.portfolios = [portfolio];
		this.settings.activePortfolioId = portfolio.id;
		await this.saveSettings();
	}

	/** New portfolios get their own sibling top-level vault folder ("Finance - <name>") so they never nest inside another portfolio's data. */
	async createPortfolio(name: string): Promise<Portfolio> {
		const clean = name.trim();
		const base = `Finance - ${sanitizeFolderName(clean)}`;
		const used = new Set((this.settings.portfolios ?? []).map((p) => p.folder));
		let folder = base;
		let n = 2;
		while (used.has(folder)) folder = `${base} ${n++}`;

		const portfolio: Portfolio = { id: `pf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: clean, folder };
		this.settings.portfolios = [...(this.settings.portfolios ?? []), portfolio];
		await this.saveSettings();
		await this.switchPortfolio(portfolio.id);
		return portfolio;
	}

	/** Account/view selection is portfolio-scoped, so switching always clears it rather than risk pointing at another portfolio's account id. */
	async switchPortfolio(id: string): Promise<void> {
		const portfolio = this.settings.portfolios?.find((p) => p.id === id);
		if (!portfolio || id === this.settings.activePortfolioId) return;
		this.settings.activePortfolioId = id;
		this.settings.dataFolder = portfolio.folder;
		this.settings.activeAccountId = undefined;
		this.settings.activeView = undefined;
		await this.saveSettings();
		await this.store.load();
		this.refreshViews();
	}

	async renamePortfolio(id: string, name: string): Promise<void> {
		const portfolio = this.settings.portfolios?.find((p) => p.id === id);
		if (!portfolio || !name.trim()) return;
		portfolio.name = name.trim();
		await this.saveSettings();
		this.refreshViews();
	}

	/**
	 * Removes the portfolio from the roster. With `deleteData`, its vault folder is also moved to
	 * trash (system trash, falling back to the vault's local .trash) — recoverable, not a hard delete.
	 * Without it, the folder and files are left exactly as they were.
	 */
	async deletePortfolio(id: string, opts?: { deleteData?: boolean }): Promise<void> {
		const portfolios = this.settings.portfolios ?? [];
		if (portfolios.length <= 1) {
			new Notice("You need at least one portfolio.");
			return;
		}
		const portfolio = portfolios.find((p) => p.id === id);
		this.settings.portfolios = portfolios.filter((p) => p.id !== id);
		if (this.settings.activePortfolioId === id) {
			this.settings.activePortfolioId = undefined;
			await this.switchPortfolio(this.settings.portfolios[0].id);
		} else {
			await this.saveSettings();
			this.refreshViews();
		}

		if (opts?.deleteData && portfolio) {
			const folder = this.app.vault.getAbstractFileByPath(portfolio.folder);
			if (folder) {
				try {
					await this.app.vault.trash(folder, true);
				} catch (err) {
					new Notice(`Removed "${portfolio.name}" but couldn't delete its folder: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}
	}
}
