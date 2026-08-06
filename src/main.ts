import { Plugin, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_FINANCE } from "./constants";
import { FinanceSettingTab } from "./settings/SettingsTab";
import { DEFAULT_SETTINGS, FinanceSettings, FinanceStore } from "./store";
import { FinanceView } from "./views/FinanceView";
import { openImportWizard } from "./wizards/ImportWizard";

export default class FinancePlugin extends Plugin {
	settings: FinanceSettings = DEFAULT_SETTINGS;
	store!: FinanceStore;

	async onload(): Promise<void> {
		await this.loadSettings();
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
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_FINANCE);
		if (existing.length > 0) {
			await this.app.workspace.revealLeaf(existing[0]);
			return;
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
}
