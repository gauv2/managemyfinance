import { Notice } from "obsidian";
import { ACCOUNT_TYPE_META } from "../constants";
import type FinancePlugin from "../main";
import type { AccountType, Portfolio } from "../types";
import { icon } from "../ui/dom";
import { openCardWizard } from "./CardWizard";
import { WizardModal, WizardStep } from "./WizardModal";

/** Creates (and switches into) a brand-new, fully separate portfolio — its own accounts, ledger, categories, subscriptions. */
export function openCreatePortfolioWizard(plugin: FinancePlugin, onCreated?: (portfolio: Portfolio) => void): void {
	let name = "";
	const selectedTypes = new Set<AccountType>();

	const steps: WizardStep[] = [
		{
			id: "name",
			title: "Name",
			icon: "briefcase",
			render: (c) => {
				c.createEl("h3", { text: "Create a new portfolio" });
				c.createEl("p", {
					cls: "fp-step-desc",
					text: "A portfolio is a fully separate set of accounts, transactions, categories, and subscriptions — use one per person or entity you manage, e.g. a parent or a client.",
				});
				const form = c.createDiv({ cls: "fp-form" });
				const row = form.createDiv({ cls: "fp-form-row" });
				row.createEl("label", { text: "Portfolio name" });
				const input = row.createEl("input", { type: "text", attr: { placeholder: "e.g. Mom & Dad" } });
				input.value = name;
				input.addEventListener("input", () => (name = input.value));
				setTimeout(() => input.focus(), 0);

				const typesRow = form.createDiv({ cls: "fp-form-row" });
				typesRow.createEl("label", { text: "Account types to include (optional)" });
				const typeList = typesRow.createDiv({ cls: "fp-type-checkbox-list" });
				(Object.keys(ACCOUNT_TYPE_META) as AccountType[]).forEach((type) => {
					const optRow = typeList.createDiv({ cls: "fp-type-checkbox-row" });
					const inputId = `fp-portfolio-type-${type}`;
					const checkbox = optRow.createEl("input", { type: "checkbox", attr: { id: inputId } });
					checkbox.checked = selectedTypes.has(type);
					checkbox.addEventListener("change", () => {
						if (checkbox.checked) selectedTypes.add(type);
						else selectedTypes.delete(type);
					});
					const label = optRow.createEl("label", { attr: { for: inputId } });
					icon(label, ACCOUNT_TYPE_META[type].icon, "fp-type-checkbox-icon");
					label.createSpan({ text: ACCOUNT_TYPE_META[type].label });
				});
				typesRow.createEl("p", {
					cls: "fp-step-desc",
					text: "We'll create one empty starter account per type you pick — rename them or add more later from \"Manage accounts…\".",
				});
			},
			canGoNext: () => name.trim().length > 0,
		},
		{
			id: "confirm",
			title: "Confirm",
			icon: "check-circle-2",
			render: (c) => {
				c.createEl("h3", { text: "Ready to create" });
				const typesText =
					selectedTypes.size > 0
						? ` It'll start with ${selectedTypes.size} account${selectedTypes.size === 1 ? "" : "s"}: ${Array.from(selectedTypes)
								.map((t) => ACCOUNT_TYPE_META[t].label)
								.join(", ")}.`
						: " It'll start empty — add accounts from the sidebar whenever you're ready.";
				c.createEl("p", {
					cls: "fp-step-desc",
					text: `"${name.trim()}" gets its own accounts, ledger, categories, and subscriptions — nothing here is shared with your other portfolios, and none of your existing data moves or changes.${typesText}`,
				});
			},
			nextLabel: "Create portfolio",
			onNext: async () => {
				const portfolio = await plugin.createPortfolio(name.trim());

				if (selectedTypes.size > 0) {
					const store = plugin.store;
					selectedTypes.forEach((type) => {
						store.accounts.push({
							id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
							name: ACCOUNT_TYPE_META[type].label,
							type,
							currency: "EUR",
							openingBalance: 0,
						});
					});
					await store.saveAccounts();
					plugin.refreshViews();
				}

				new Notice(
					`Created portfolio "${portfolio.name}"${selectedTypes.size > 0 ? ` with ${selectedTypes.size} starter account${selectedTypes.size === 1 ? "" : "s"}` : ""}`
				);

				// Only worth offering if there's at least one starter account for a card to link to.
				if (selectedTypes.size > 0) {
					openCardWizard(plugin, {
						skippable: true,
						skipLabel: "Skip for now",
						onSkip: () => onCreated?.(portfolio),
						onSaved: () => onCreated?.(portfolio),
					});
				} else {
					onCreated?.(portfolio);
				}
			},
		},
	];

	new WizardModal(plugin.app, {
		title: "New portfolio",
		subtitle: "A separate space for another person's or entity's finances.",
		icon: "briefcase",
		steps,
	}).open();
}
