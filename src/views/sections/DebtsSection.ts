import { debtTotals, isOverdue, isSettled, outstanding, sortDebts } from "../../debts";
import type FinancePlugin from "../../main";
import { DebtModal } from "../../modals/DebtModal";
import { formatMoney } from "../../money";
import type { Debt } from "../../types";
import { badge, emptyState, icon } from "../../ui/dom";

const KIND_ICON: Record<string, string> = {
	person: "user",
	company: "building-2",
	bank: "landmark",
	other: "circle-dot",
};

/**
 * The debts register: who owes what, since when, and what is overdue.
 *
 * Deliberately its own island. Nothing on this page reaches net worth, a budget or a report, and
 * nothing there reaches back — which is what makes it usable for the debts people actually have. A
 * €20 IOU and a €15,000 family loan can both be written down here in ten seconds, without either
 * being asked to reconcile against anything.
 */
export function renderDebtsSection(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;
	const today = new Date().toISOString().slice(0, 10);
	container.empty();

	const header = container.createDiv({ cls: "fp-section-header" });
	const headText = header.createDiv();
	headText.createEl("h2", { text: "Debts" });
	headText.createDiv({
		cls: "fp-section-subtitle",
		text: "Money you owe and money owed to you. A register on its own — no figure here moves net worth, budgets or any report.",
	});
	const addBtn = header.createEl("button", { cls: "fp-btn fp-btn-primary" });
	icon(addBtn, "plus");
	addBtn.createSpan({ text: "Add debt" });
	addBtn.addEventListener("click", () => new DebtModal(plugin.app, plugin, undefined, () => plugin.refreshViews()).open());

	if (store.debts.length === 0) {
		emptyState(container, {
			iconName: "handshake",
			title: "No debts recorded",
			description:
				"Track what you owe a bank, a company or a person — and what they owe you. Nothing you add here changes any other number in the plugin.",
			actionLabel: "Add debt",
			onAction: () => new DebtModal(plugin.app, plugin, undefined, () => plugin.refreshViews()).open(),
		});
		return;
	}

	const totals = debtTotals(store.debts, today);
	const summary = container.createDiv({ cls: "fp-debt-summary" });

	const totalCard = (label: string, byCurrency: Record<string, number>, tone: string): void => {
		const card = summary.createDiv({ cls: `fp-debt-card is-${tone}` });
		card.createDiv({ cls: "fp-debt-card-label", text: label });
		const entries = Object.entries(byCurrency);
		if (entries.length === 0) {
			card.createDiv({ cls: "fp-debt-card-value", text: formatMoney(0) });
			return;
		}
		// One line per currency rather than a converted total: no rate is honest about a personal IOU,
		// and a made-up one would be the only invented number on the page.
		for (const [currency, amount] of entries) {
			card.createDiv({ cls: "fp-debt-card-value", text: formatMoney(amount, { currency }) });
		}
	};

	totalCard("You owe", totals.owe, "owe");
	totalCard("Owed to you", totals.owed, "owed");

	const counts = summary.createDiv({ cls: "fp-debt-card" });
	counts.createDiv({ cls: "fp-debt-card-label", text: "Open" });
	counts.createDiv({ cls: "fp-debt-card-value", text: String(totals.openCount) });
	if (totals.overdueCount > 0) {
		counts.createDiv({ cls: "fp-debt-card-note", text: `${totals.overdueCount} overdue` });
	} else if (totals.settledCount > 0) {
		counts.createDiv({ cls: "fp-debt-card-note", text: `${totals.settledCount} settled` });
	}

	const wrap = container.createDiv({ cls: "fp-table-scroll" });
	const table = wrap.createEl("table", { cls: "fp-table" });
	const headRow = table.createEl("thead").createEl("tr");
	["With", "Direction", "Since", "Due", "Outstanding", "Status"].forEach((h, i) =>
		headRow.createEl("th", { text: h, cls: i === 4 ? "fp-table-num" : "" })
	);

	const tbody = table.createEl("tbody");
	for (const debt of sortDebts(store.debts, today)) {
		renderRow(tbody, debt);
	}

	function renderRow(parent: HTMLElement, debt: Debt): void {
		const settled = isSettled(debt);
		const overdue = isOverdue(debt, today);
		const tr = parent.createEl("tr", {
			cls: "fp-table-row-clickable" + (settled ? " is-settled" : "") + (overdue ? " is-overdue" : ""),
		});
		tr.addEventListener("click", () => new DebtModal(plugin.app, plugin, debt, () => plugin.refreshViews()).open());

		const who = tr.createEl("td");
		icon(who, KIND_ICON[debt.kind ?? "other"] ?? "circle-dot", "fp-debt-kind-icon");
		who.createSpan({ text: debt.counterparty });
		if (debt.notes) who.createDiv({ cls: "fp-debt-note", text: debt.notes });

		tr.createEl("td", { text: debt.direction === "owe" ? "You owe" : "Owed to you" });
		tr.createEl("td", { text: debt.date || "—", cls: "fp-cell-date" });
		tr.createEl("td", { text: debt.dueDate || "—", cls: "fp-cell-date" });

		const amountCell = tr.createEl("td", { cls: "fp-table-num fp-money" });
		amountCell.setText(formatMoney(outstanding(debt), { currency: debt.currency || "EUR" }));
		// Only worth saying when the two differ — otherwise it repeats the number beside it.
		if (debt.paid && debt.paid > 0 && !settled) {
			amountCell.createDiv({
				cls: "fp-debt-note",
				text: `of ${formatMoney(debt.amount, { currency: debt.currency || "EUR" })}`,
			});
		}

		const status = tr.createEl("td");
		if (settled) badge(status, debt.settledDate ? `Settled ${debt.settledDate}` : "Repaid in full", "good");
		else if (overdue) badge(status, "Overdue", "bad");
		else badge(status, "Open", "neutral");
	}
}
