import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { defaultCategories, VIEW_TYPE_FINANCE } from "./constants";
import { autoCategorize, buildDefaultRules } from "./import/autoCategorize";
import { FinanceSettingTab } from "./settings/SettingsTab";
import { DEFAULT_SETTINGS, FinanceSettings, FinanceStore } from "./store";
import type { Portfolio } from "./types";
import { FinanceView } from "./views/FinanceView";
import { openImportWizard } from "./wizards/ImportWizard";

function sanitizeFolderName(name: string): string {
	return name.trim().replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "Portfolio";
}

export default class FinancePlugin extends Plugin {
	settings: FinanceSettings = DEFAULT_SETTINGS;
	store!: FinanceStore;

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.ensureDefaultPortfolio();
		this.store = new FinanceStore(this.app, this.settings);
		await this.store.load();

		this.registerView(VIEW_TYPE_FINANCE, (leaf: WorkspaceLeaf) => new FinanceView(leaf, this));
		this.addSettingTab(new FinanceSettingTab(this.app, this));

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
			id: "install-emoney-categories",
			name: "Install eMoney categories & auto-categorize transactions",
			callback: () => void this.installEmoneyCategoriesAndCategorize(),
		});
	}

	onunload(): void {
		// Views are torn down by Obsidian; nothing to clean up manually.
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
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

	get activePortfolio(): Portfolio | undefined {
		return this.settings.portfolios?.find((p) => p.id === this.settings.activePortfolioId);
	}

	/**
	 * One-shot, safe to re-run: adds any eMoney categories this portfolio doesn't already have (by
	 * name — never touches or removes existing ones), adds the default keyword rules it doesn't
	 * already have, then categorizes every currently-uncategorized transaction it can match.
	 */
	async installEmoneyCategoriesAndCategorize(): Promise<void> {
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

		const { patches, categorized } = autoCategorize(store.transactions, store.categories, store.rules);
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
