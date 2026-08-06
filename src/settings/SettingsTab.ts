import { App, PluginSettingTab, Setting } from "obsidian";
import type FinancePlugin from "../main";
import { openImportWizard } from "../wizards/ImportWizard";
import { openOnboardingWizard } from "../wizards/OnboardingWizard";

export class FinanceSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: FinancePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("fp-workspace");

		new Setting(containerEl).setName("Setup wizard").setDesc("Re-run the guided setup for accounts and categories.").addButton((b) =>
			b.setButtonText("Run setup wizard").onClick(() => openOnboardingWizard(this.plugin))
		);

		new Setting(containerEl).setName("Import transactions").setDesc("Bring in a bank or broker CSV export.").addButton((b) =>
			b.setButtonText("Import").onClick(() => openImportWizard(this.plugin))
		);

		new Setting(containerEl)
			.setName("Data folder")
			.setDesc("Where Finance stores its ledger, categories, and rules — relative to your vault root.")
			.addText((t) =>
				t.setValue(this.plugin.settings.dataFolder).onChange(async (v) => {
					this.plugin.settings.dataFolder = v || "Finance";
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("FI expense multiplier")
			.setDesc("Annual expenses × this multiplier = your FI number (25 ≈ a 4% withdrawal rate).")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.fiMultiplier)).onChange(async (v) => {
					const n = parseFloat(v);
					if (!isNaN(n) && n > 0) {
						this.plugin.settings.fiMultiplier = n;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					}
				})
			);

		new Setting(containerEl)
			.setName("Expected annual return")
			.setDesc("Used to project years-to-FI, as a fraction (e.g. 0.07 for 7%).")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.expectedReturn)).onChange(async (v) => {
					const n = parseFloat(v);
					if (!isNaN(n) && n >= 0) {
						this.plugin.settings.expectedReturn = n;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					}
				})
			);

		containerEl.createEl("h3", { text: "Accounts" });
		if (this.plugin.store.accounts.length === 0) {
			containerEl.createEl("p", { cls: "fp-step-desc", text: "No accounts yet — run the setup wizard to add some." });
		} else {
			this.plugin.store.accounts.forEach((acc) => {
				containerEl.createEl("p", { cls: "fp-step-desc", text: `${acc.name} — ${acc.type}, ${acc.currency}` });
			});
		}

		containerEl.createEl("h3", { text: "Categories" });
		const grid = containerEl.createDiv({ cls: "fp-category-grid" });
		this.plugin.store.categories.forEach((cat) => {
			grid.createDiv({ cls: "fp-badge fp-tone-neutral", text: cat.name });
		});
	}
}
