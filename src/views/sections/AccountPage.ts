import { ACCOUNT_TYPE_META } from "../../constants";
import type FinancePlugin from "../../main";
import { EditAccountModal } from "../../modals/EditAccountModal";
import { ManageRulesModal } from "../../modals/ManageRulesModal";
import { describeRange, emptyPeriodSelection, selectionRange, type DateRange } from "../../period";
import type { Account } from "../../types";
import { emptyState, icon } from "../../ui/dom";
import { renderPeriodFilter } from "../../ui/periodFilter";
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

/**
 * The page's period, shared by the dashboard cards and the ledger under them. Module scope like the
 * ledger's other filters, so the re-render that follows editing a category doesn't silently widen
 * the window you were reading.
 */
const periodState = emptyPeriodSelection();

function renderAccountDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account, range?: DateRange): void {
	switch (account.type) {
		case "debit":
			renderCheckingDashboard(container, plugin, account, range);
			break;
		case "credit":
			renderCreditDashboard(container, plugin, account, range);
			break;
		case "saving":
			renderSavingsDashboard(container, plugin, account, range);
			break;
		case "investing":
			renderInvestingDashboard(container, plugin, account);
			break;
		case "crypto":
			renderCryptoDashboard(container, plugin, account);
			break;
		case "cash":
			renderCashDashboard(container, plugin, account, range);
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

	// One period control per page, sitting above everything it drives: the dashboard cards read the
	// same window as the ledger below them, so the two can never disagree about what you're looking at.
	const scopedTransactions = activeAccountId ? store.transactions.filter((t) => t.accountId === activeAccountId) : store.transactions;
	// Nothing in scope means nothing to filter — the empty states below say so better than a row of
	// dropdowns offering windows onto no data at all.
	const filterBar = scopedTransactions.length > 0 ? container.createDiv({ cls: "fp-page-filter" }) : undefined;
	// …and no window left over from the account you were just on, which nothing on this page would
	// admit to applying.
	if (!filterBar) Object.assign(periodState, emptyPeriodSelection());
	const body = container.createDiv();
	const periodFilter = filterBar
		? renderPeriodFilter(filterBar, {
				dates: scopedTransactions.map((t) => t.date),
				selection: periodState,
				onChange: renderBody,
		  })
		: undefined;

	function renderBody(): void {
		body.empty();
		const range = selectionRange(periodState);
		const periodLabel = describeRange(range);

		if (account) renderAccountDashboard(body, plugin, account, range);
		else renderAllAccountsDashboard(body, plugin, range, periodLabel);

		// "All Accounts" is a whole-of-finances overview, not a place to browse every transaction —
		// each account's own page is where its ledger lives.
		if (!account) return;
		body.createDiv({ cls: "fp-account-page-divider" });
		// Rules belong to the ledger, so they sit on its heading rather than up in the page header a
		// dashboard's worth of scrolling away — or in among the filters, which they are not one of.
		const ledgerHead = body.createDiv({ cls: "fp-account-page-ledger-head" });
		ledgerHead.createEl("h3", { cls: "fp-account-page-ledger-title", text: "Transactions" });
		const rulesBtn = ledgerHead.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(rulesBtn, "list-filter");
		rulesBtn.createSpan({ text: "Rules" });
		rulesBtn.setAttribute("title", "Rules that categorize transactions automatically");
		rulesBtn.addEventListener("click", () => new ManageRulesModal(plugin.app, plugin, () => plugin.refreshViews()).open());
		renderLedger(body, plugin, {
			period: periodState,
			onResetPeriod: () => {
				periodFilter?.reset();
				renderBody();
			},
		});
	}

	renderBody();
}
