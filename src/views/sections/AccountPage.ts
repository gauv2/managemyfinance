import { ACCOUNT_TYPE_META } from "../../constants";
import type FinancePlugin from "../../main";
import { EditAccountModal } from "../../modals/EditAccountModal";
import type { Account } from "../../types";
import { emptyState, icon } from "../../ui/dom";
import { openImportWizard } from "../../wizards/ImportWizard";
import { renderCashDashboard } from "./dashboards/CashDashboard";
import { renderCheckingDashboard } from "./dashboards/CheckingDashboard";
import { renderInvestingDashboard } from "./dashboards/InvestingDashboard";
import { renderSavingsDashboard } from "./dashboards/SavingsDashboard";
import { renderAllAccountsDashboard } from "./DashboardSection";
import { renderLedger } from "./LedgerSection";

function renderAccountDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account): void {
	switch (account.type) {
		case "debit":
		case "credit":
			renderCheckingDashboard(container, plugin, account);
			break;
		case "saving":
			renderSavingsDashboard(container, plugin, account);
			break;
		case "investing":
		case "crypto":
			renderInvestingDashboard(container, plugin, account);
			break;
		case "cash":
			renderCashDashboard(container, plugin, account);
			break;
	}
}

/** One page per account (or "All Accounts"): a type-appropriate dashboard, a divider, then its ledger. */
export function renderAccountPage(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;
	container.addClass("fp-section");

	if (store.accounts.length === 0) {
		emptyState(container, {
			iconName: "wallet",
			title: "Let's set up your accounts",
			description: "Add your first account from the sidebar to get started.",
		});
		return;
	}

	const activeAccountId = plugin.settings.activeAccountId;
	const account = activeAccountId ? store.accounts.find((a) => a.id === activeAccountId) : undefined;

	const header = container.createDiv({ cls: "fp-section-header" });
	const headText = header.createDiv({ cls: "fp-section-header-text" });
	const titleRow = headText.createDiv({ cls: "fp-section-title-row" });
	const headIcon = titleRow.createDiv({ cls: "fp-section-icon-badge" });
	icon(headIcon, account ? ACCOUNT_TYPE_META[account.type].icon : "layers");
	titleRow.createEl("h2", { text: account ? account.name : "All Accounts" });
	if (account) {
		const headerActions = header.createDiv({ cls: "fp-section-header-actions" });
		const editBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-ghost" });
		icon(editBtn, "pencil");
		editBtn.createSpan({ text: "Edit account" });
		editBtn.addEventListener("click", () => new EditAccountModal(plugin.app, plugin, account, () => plugin.refreshViews()).open());
		const importBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-secondary", text: "Import" });
		importBtn.addEventListener("click", () => openImportWizard(plugin));
	}

	if (account) renderAccountDashboard(container, plugin, account);
	else renderAllAccountsDashboard(container, plugin);

	// "All Accounts" is a whole-of-finances overview, not a place to browse every transaction —
	// each account's own page is where its ledger lives.
	if (account) {
		container.createDiv({ cls: "fp-account-page-divider" });
		container.createEl("h3", { cls: "fp-account-page-ledger-title", text: "Transactions" });
		renderLedger(container, plugin);
	}
}
