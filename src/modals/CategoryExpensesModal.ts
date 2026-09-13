import { App } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { categoryChain, secondaryCategoriesOf } from "../categories";
import { categoryTransactions } from "../kpi";
import type FinancePlugin from "../main";
import type { DateRange } from "../period";
import type { Category, Transaction } from "../types";
import { categoryChainChip, icon } from "../ui/dom";
import { TransactionDetailModal } from "./TransactionDetailModal";
import { formatMoney } from "../money";

function formatEUR(n: number): string {
	return formatMoney(n);
}

/** The expense transactions behind one category's "actual spend" figure for a given period —
 *  opened by clicking that figure on the Budgets table, so a total is never just a number to trust
 *  blindly. `period` is whatever the Budgets page is currently keyed by (a calendar "YYYY-MM" or a
 *  pay-cycle's own DateRange — see payCycle.ts); `periodLabel` is how that reads to a person, decided
 *  by the caller rather than derived here, since a pay-cycle key isn't a month name to parse. */
export class CategoryExpensesModal extends FinanceModal {
	constructor(
		app: App,
		private plugin: FinancePlugin,
		private category: Category,
		private period: string | DateRange,
		private periodLabel: string
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		const c = this.contentEl;
		c.addClass("fp-account-modal");

		const store = this.plugin.store;
		const txs = categoryTransactions(store, this.category.id, this.period);
		const total = txs.reduce((s, t) => s + -t.amount, 0);
		const showSecondary = secondaryCategoriesOf(store.categories, this.category.id).length > 0;

		c.createEl("h3", { text: `${this.category.name} — ${this.periodLabel}` });
		c.createDiv({
			cls: "fp-step-desc",
			text: `${txs.length} transaction${txs.length === 1 ? "" : "s"} · ${formatEUR(total)} total`,
		});

		if (txs.length === 0) {
			c.createEl("p", { cls: "fp-step-desc", text: "No expenses in this category in this period." });
		} else {
			const wrap = c.createDiv({ cls: "fp-table-scroll" });
			const table = wrap.createEl("table", { cls: "fp-table" });
			const headRow = table.createEl("thead").createEl("tr");
			headRow.createEl("th", { text: "Date" });
			headRow.createEl("th", { text: "Description" });
			if (showSecondary) headRow.createEl("th", { text: "Subcategory" });
			headRow.createEl("th", { text: "Amount", cls: "fp-table-num" });
			const tbody = table.createEl("tbody");
			txs.forEach((t) => this.renderRow(tbody, t, showSecondary));
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const closeBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(closeBtn, "check");
		closeBtn.createSpan({ text: "Close" });
		closeBtn.addEventListener("click", () => this.close());
	}

	private renderRow(tbody: HTMLElement, t: Transaction, showSecondary: boolean): void {
		const row = tbody.createEl("tr", { cls: "fp-table-row-clickable" });
		row.createEl("td", { text: t.date });
		row.createEl("td", { text: t.counterparty?.trim() || t.description || "—" });
		if (showSecondary) {
			const cell = row.createEl("td");
			const chain = categoryChain(this.plugin.store.categories, t.categoryId);
			if (chain.secondary) categoryChainChip(cell, chain.secondary);
			else cell.createSpan({ cls: "fp-budget-hint-text", text: "—" });
		}
		row.createEl("td", { cls: "fp-table-num fp-money", text: formatEUR(-t.amount) });
		row.addEventListener("click", () => {
			this.close();
			new TransactionDetailModal(this.app, this.plugin, t).open();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
