import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { defaultCategories, VIEW_TYPE_FINANCE } from "./constants";
import { aiCategorize, describeAiResult } from "./ai/categorizer";
import { autoCategorize, buildDefaultRules, effectiveRules } from "./import/autoCategorize";
import { merchantKey } from "./import/merchantKey";
import { applyMemory, applyPendingSuggestions, learnFromHistory, pruneMemory, remember, siblingsOf } from "./import/merchantMemory";
import { setNumberFormatPreference } from "./money";
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
			id: "auto-categorize-transactions",
			name: "Auto-categorize uncategorized transactions",
			callback: () => void this.autoCategorizeExisting(),
		});

		this.addCommand({
			id: "install-default-categories",
			name: "Install default categories & auto-categorize transactions",
			callback: () => void this.installDefaultCategoriesAndCategorize(),
		});
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

		store.merchants = remember(store.merchants, key, categoryId, "user");
		await store.saveMerchants();

		const siblings = siblingsOf(store.transactions, tx).filter((t) => !t.categoryId);
		if (siblings.length === 0) return 0;
		const patches = new Map(siblings.map((t) => [t.id, { categoryId }] as const));
		return store.updateTransactions(new Map(patches));
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
