import { ACCOUNT_TYPE_META } from "../../constants";
import type FinancePlugin from "../../main";
import { EditAccountModal } from "../../modals/EditAccountModal";
import { ManageRulesModal } from "../../modals/ManageRulesModal";
import type { Account } from "../../types";
import { emptyState, icon } from "../../ui/dom";
import { openImportWizard } from "../../wizards/ImportWizard";
import { renderBalanceDashboard } from "./dashboards/BalanceDashboard";
import { renderCashDashboard } from "./dashboards/CashDashboard";
import { renderCheckingDashboard } from "./dashboards/CheckingDashboard";
import { renderCreditDashboard } from "./dashboards/CreditDashboard";
import { renderCryptoDashboard } from "./dashboards/CryptoDashboard";
import { renderInvestingDashboard } from "./dashboards/InvestingDashboard";
import { renderSavingsDashboard } from "./dashboards/SavingsDashboard";
import { renderAllAccountsDashboard } from "./DashboardSection";
import { renderLedger } from "./LedgerSection";

function renderAccountDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account): void {
	switch (account.type) {
		case "debit":
			renderCheckingDashboard(container, plugin, account);
			break;
		case "credit":
			renderCreditDashboard(container, plugin, account);
			break;
		case "saving":
			renderSavingsDashboard(container, plugin, account);
			break;
		case "investing":
			renderInvestingDashboard(container, plugin, account);
			break;
		case "crypto":
			renderCryptoDashboard(container, plugin, account);
			break;
		case "cash":
			renderCashDashboard(container, plugin, account);
			break;
		// Everything with a balance but no transaction feed — a house, a pension, a mortgage, a loan.
		case "property":
		case "pension":
		case "loan":
		case "mortgage":
			renderBalanceDashboard(container, plugin, account);
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
		const addBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(addBtn, "plus");
		addBtn.createSpan({ text: "Add transaction" });
		addBtn.setAttribute("title", "Record something by hand — cash spending, or anything no export carries");
		addBtn.addEventListener("click", () => plugin.openTransactionEditor(account.id));

		const importBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-secondary", text: "Import" });
		importBtn.addEventListener("click", () => openImportWizard(plugin));
	}

	if (account) renderAccountDashboard(container, plugin, account);
	else renderAllAccountsDashboard(container, plugin);

	// "All Accounts" is a whole-of-finances overview, not a place to browse every transaction —
	// each account's own page is where its ledger lives.
	if (account) {
		container.createDiv({ cls: "fp-account-page-divider" });
		// Rules belong to the ledger, so they sit on its heading rather than up in the page header a
		// dashboard's worth of scrolling away — or in among the filters, which they are not one of.
		const ledgerHead = container.createDiv({ cls: "fp-account-page-ledger-head" });
		ledgerHead.createEl("h3", { cls: "fp-account-page-ledger-title", text: "Transactions" });
		const rulesBtn = ledgerHead.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(rulesBtn, "list-filter");
		rulesBtn.createSpan({ text: "Rules" });
		rulesBtn.setAttribute("title", "Rules that categorize transactions automatically");
		rulesBtn.addEventListener("click", () => new ManageRulesModal(plugin.app, plugin, () => plugin.refreshViews()).open());
		renderLedger(container, plugin);
	}
}
