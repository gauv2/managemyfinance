import { Notice, Setting } from "obsidian";
import { ACCOUNT_TYPE_META } from "../constants";
import type FinancePlugin from "../main";
import type { Account, AccountType } from "../types";
import { categoryChip, icon } from "../ui/dom";
import { WizardModal, WizardStep } from "./WizardModal";

/** First-run (or re-run from settings) setup: data folder, accounts, category palette. */
export function openOnboardingWizard(plugin: FinancePlugin): void {
	const store = plugin.store;
	const draftAccounts: Account[] = store.accounts.map((a) => ({ ...a }));

	const steps: WizardStep[] = [
		{
			id: "welcome",
			title: "Welcome",
			icon: "sparkles",
			render: (c) => {
				c.addClass("fp-step-welcome");
				icon(c, "wallet", "fp-welcome-icon");
				c.createEl("h2", { text: "Set up your Finance workspace" });
				c.createEl("p", {
					text:
						"A few quick steps: where your data lives, which accounts to track, and which categories to use. Everything here can be changed later in settings.",
				});
			},
		},
		{
			id: "folder",
			title: "Data folder",
			icon: "folder",
			render: (c) => {
				c.createEl("h3", { text: "Where should Finance store its data?" });
				c.createEl("p", {
					cls: "fp-step-desc",
					text: "Ledgers, categories, and rules live here as plain CSV/JSON, relative to your vault root.",
				});
				new Setting(c).setName("Folder").addText((t) =>
					t.setValue(plugin.settings.dataFolder).onChange((v) => {
						plugin.settings.dataFolder = v || "Finance";
					})
				);
			},
			onNext: async () => {
				await plugin.saveSettings();
			},
		},
		{
			id: "accounts",
			title: "Accounts",
			icon: "landmark",
			render: (c) => {
				c.createEl("h3", { text: "Which accounts do you want to track?" });
				c.createEl("p", { cls: "fp-step-desc", text: "Add one row per account — you can add more any time." });
				const list = c.createDiv({ cls: "fp-account-list" });

				const redraw = () => {
					list.empty();
					draftAccounts.forEach((acc, idx) => {
						const row = list.createDiv({ cls: "fp-account-row" });
						icon(row, ACCOUNT_TYPE_META[acc.type].icon, "fp-account-row-icon");
						const nameInput = row.createEl("input", { type: "text", value: acc.name, placeholder: "Account name" });
						nameInput.addEventListener("input", () => (acc.name = nameInput.value));

						const typeSelect = row.createEl("select");
						(Object.keys(ACCOUNT_TYPE_META) as AccountType[]).forEach((t) => {
							const opt = typeSelect.createEl("option", { text: ACCOUNT_TYPE_META[t].label, value: t });
							if (t === acc.type) opt.selected = true;
						});
						typeSelect.addEventListener("change", () => {
							acc.type = typeSelect.value as AccountType;
							redraw();
						});

						const removeBtn = row.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
						icon(removeBtn, "x");
						removeBtn.addEventListener("click", () => {
							draftAccounts.splice(idx, 1);
							redraw();
						});
					});
					if (draftAccounts.length === 0) {
						list.createDiv({ cls: "fp-step-desc", text: "No accounts yet — add one below." });
					}
				};
				redraw();

				const addRow = c.createDiv({ cls: "fp-account-add-row" });
				(Object.keys(ACCOUNT_TYPE_META) as AccountType[]).forEach((type) => {
					const meta = ACCOUNT_TYPE_META[type];
					const chip = addRow.createEl("button", { cls: "fp-btn fp-btn-chip" });
					icon(chip, meta.icon);
					chip.createSpan({ text: `Add ${meta.label}` });
					chip.addEventListener("click", () => {
						draftAccounts.push({
							id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
							name: meta.label,
							type,
							currency: "EUR",
							openingBalance: 0,
						});
						redraw();
					});
				});
			},
			onNext: async () => {
				store.accounts = draftAccounts;
				await store.saveAccounts();
			},
		},
		{
			id: "categories",
			title: "Categories",
			icon: "shapes",
			render: (c) => {
				c.createEl("h3", { text: "Your category palette" });
				c.createEl("p", {
					cls: "fp-step-desc",
					text: "A sensible color-coded default set. Turn any off — old spreadsheet category names still get mapped onto the ones you keep, automatically, on import.",
				});
				const grid = c.createDiv({ cls: "fp-category-grid" });
				store.categories.forEach((cat) => {
					const item = grid.createDiv({ cls: "fp-category-item" + (cat.archived ? " is-archived" : "") });
					categoryChip(item, cat.name, cat.color, cat.icon);
					const toggle = item.createEl("input", { type: "checkbox" });
					toggle.checked = !cat.archived;
					toggle.addEventListener("change", () => {
						cat.archived = !toggle.checked;
						item.toggleClass("is-archived", !!cat.archived);
					});
				});
			},
			onNext: async () => {
				await store.saveCategories();
			},
		},
		{
			id: "done",
			title: "Done",
			icon: "check-circle-2",
			render: (c) => {
				c.addClass("fp-step-welcome");
				icon(c, "check-circle-2", "fp-welcome-icon fp-tone-good");
				c.createEl("h2", { text: "You're set up" });
				c.createEl("p", {
					text: "Open the Finance workspace to see your dashboard, or import your first CSV export whenever you're ready.",
				});
			},
			nextLabel: "Open Finance",
			onNext: async () => {
				plugin.settings.onboarded = true;
				await plugin.saveSettings();
				await plugin.activateView();
				new Notice("Finance workspace ready");
			},
		},
	];

	new WizardModal(plugin.app, {
		title: "Finance setup",
		subtitle: "A few steps and you're tracking.",
		icon: "wallet",
		steps,
	}).open();
}
