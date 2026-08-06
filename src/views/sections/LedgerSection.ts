import type FinancePlugin from "../../main";
import type { Transaction } from "../../types";
import { badge, categoryChip, emptyState } from "../../ui/dom";
import { openImportWizard } from "../../wizards/ImportWizard";

export function renderLedger(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;
	container.addClass("fp-section");

	const header = container.createDiv({ cls: "fp-section-header" });
	header.createEl("h2", { text: "Ledger" });
	const importBtn = header.createEl("button", { cls: "fp-btn fp-btn-secondary", text: "Import" });
	importBtn.addEventListener("click", () => openImportWizard(plugin));

	if (store.transactions.length === 0) {
		emptyState(container, {
			iconName: "inbox",
			title: "No transactions yet",
			description: "Import a bank or broker CSV export to populate the ledger.",
			actionLabel: "Import transactions",
			onAction: () => openImportWizard(plugin),
		});
		return;
	}

	const controls = container.createDiv({ cls: "fp-ledger-controls" });
	const search = controls.createEl("input", {
		type: "text",
		placeholder: "Search description or counterparty…",
		cls: "fp-search",
	});

	const tableWrap = container.createDiv({ cls: "fp-card fp-ledger-table-wrap" });
	const table = tableWrap.createEl("table", { cls: "fp-table fp-ledger-table" });
	const thead = table.createEl("thead").createEl("tr");
	["Date", "Description", "Account", "Category", "Amount"].forEach((h) => thead.createEl("th", { text: h }));
	const tbody = table.createEl("tbody");

	const categoryById = new Map(store.categories.map((c) => [c.id, c]));
	const accountById = new Map(store.accounts.map((a) => [a.id, a]));

	function appendRow(t: Transaction): void {
		const tr = tbody.createEl("tr");
		tr.createEl("td", { text: t.date, cls: "fp-cell-date" });
		tr.createEl("td", { text: t.description });
		tr.createEl("td", { text: accountById.get(t.accountId)?.name ?? "—" });
		const catCell = tr.createEl("td");
		const cat = t.categoryId ? categoryById.get(t.categoryId) : undefined;
		if (cat) categoryChip(catCell, cat.name, cat.color, cat.icon);
		else badge(catCell, "Uncategorized", "warn");
		const amtCell = tr.createEl("td", { cls: "fp-cell-amount " + (t.amount < 0 ? "is-negative" : "is-positive") });
		amtCell.setText(new Intl.NumberFormat("en-IE", { style: "currency", currency: t.currency || "EUR" }).format(t.amount));
	}

	function draw(filter: string): void {
		tbody.empty();
		const needle = filter.toLowerCase();
		const rows = [...store.transactions]
			.filter((t) => !needle || `${t.description} ${t.counterparty ?? ""}`.toLowerCase().includes(needle))
			.sort((a, b) => (a.date < b.date ? 1 : -1))
			.slice(0, 200);
		if (rows.length === 0) {
			const tr = tbody.createEl("tr");
			tr.createEl("td", { attr: { colspan: "5" }, text: "No matching transactions." });
			return;
		}
		rows.forEach(appendRow);
	}

	draw("");
	search.addEventListener("input", () => draw(search.value));
}
