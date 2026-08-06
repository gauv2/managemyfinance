import { App, PluginSettingTab, Setting } from "obsidian";
import { ACCOUNT_TYPE_META } from "../constants";
import type FinancePlugin from "../main";
import type { AccountType } from "../types";
import { openImportWizard } from "../wizards/ImportWizard";

export class FinanceSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: FinancePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("fp-workspace");

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
		const store = this.plugin.store;
		if (store.accounts.length === 0) {
			containerEl.createEl("p", { cls: "fp-step-desc", text: "No accounts yet — add one below." });
		} else {
			store.accounts.forEach((acc) => {
				new Setting(containerEl).setName(acc.name).setDesc(`${ACCOUNT_TYPE_META[acc.type].label} · ${acc.currency}`).addButton((b) =>
					b.setIcon("x").setTooltip("Remove").onClick(async () => {
						store.accounts = store.accounts.filter((a) => a.id !== acc.id);
						await store.saveAccounts();
						this.display();
					})
				);
			});
		}

		let newAccountName = "";
		let newAccountType: AccountType = "debit";
		new Setting(containerEl)
			.setName("Add account")
			.addText((t) => t.setPlaceholder("Account name").onChange((v) => (newAccountName = v)))
			.addDropdown((d) => {
				(Object.keys(ACCOUNT_TYPE_META) as AccountType[]).forEach((type) => d.addOption(type, ACCOUNT_TYPE_META[type].label));
				d.onChange((v) => (newAccountType = v as AccountType));
			})
			.addButton((b) =>
				b.setButtonText("Add").onClick(async () => {
					if (!newAccountName.trim()) return;
					store.accounts.push({
						id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
						name: newAccountName.trim(),
						type: newAccountType,
						currency: "EUR",
						openingBalance: 0,
					});
					await store.saveAccounts();
					this.display();
				})
			);

		containerEl.createEl("h3", { text: "Categories" });
		const grid = containerEl.createDiv({ cls: "fp-category-grid" });
		store.categories.forEach((cat) => {
			grid.createDiv({ cls: "fp-badge fp-tone-neutral", text: cat.name });
		});
	}
}
