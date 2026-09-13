import { App } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { categoryChain, descendantIds, secondaryCategoriesOf } from "../categories";
import { convert } from "../currency";
import type FinancePlugin from "../main";
import { formatMoney } from "../money";
import { inRange, type DateRange } from "../period";
import type { Category, Transaction } from "../types";
import { barChart } from "../ui/charts";
import { categoryChainChip, icon } from "../ui/dom";
import { TransactionDetailModal } from "./TransactionDetailModal";

/**
 * Category → subcategory → the actual transactions, without leaving the dashboard you started on.
 *
 * A spending chart answers "how much" and immediately raises "on what?", and until now the only way
 * to find out was to go to the ledger and rebuild the same filters by hand. Every step of the path is
 * here instead: the primary's total, how it splits across its subcategories, and every row behind it —
 * each of which opens its own detail view. The scope you drilled from (a year, one account, or all of
 * them) is carried through, so the numbers here always add up to the bar you clicked.
 */
export class CategoryDrilldownModal extends FinanceModal {
	/** Set when a subcategory is chosen, narrowing the transaction list below. */
	private secondaryId?: string;

	constructor(
		app: App,
		private plugin: FinancePlugin,
		private opts: {
			categoryId: string;
			/** "YYYY" or "YYYY-MM" — matched as a date prefix, so either granularity works. */
			period?: string;
			/** The page period filter's window, for the callers that have one — takes over from `period`. */
			range?: DateRange;
			/** How that window reads in the header; defaults to `period`. */
			periodLabel?: string;
			accountId?: string;
			/** Shown in the header so it's obvious what the figures are scoped to. */
			scopeLabel?: string;
		}
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		this.modalEl.addClass("fp-drilldown-modal");
		this.contentEl.addClass("fp-account-modal");
		this.render();
	}

	private category(): Category | undefined {
		return this.plugin.store.categories.find((c) => c.id === this.opts.categoryId);
	}

	/** Expenses in scope: this category (or one chosen subcategory), the period, and the account. */
	private transactions(): Transaction[] {
		const store = this.plugin.store;
		const ids = new Set(this.secondaryId ? [this.secondaryId] : descendantIds(store.categories, this.opts.categoryId));
		const uncategorized = this.opts.categoryId === "uncategorized";

		return store.transactions
			.filter((tx) => {
				if (tx.amount >= 0) return false;
				if (this.opts.range ? !inRange(tx.date, this.opts.range) : this.opts.period && !tx.date?.startsWith(this.opts.period)) return false;
				if (this.opts.accountId && tx.accountId !== this.opts.accountId) return false;
				if (uncategorized) return !tx.categoryId;
				return !!tx.categoryId && ids.has(tx.categoryId);
			})
			// `|| ""` rather than a bare compare: a row whose date never parsed is still counted in the
			// bar this drilled from, so it has to survive to the list, and an undated row sorts last.
			.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
	}

	/** Amounts are summed in base currency, exactly as the chart that led here did — at each
	 *  transaction's own date (v1.2.7 Phase 3), not today's rate. */
	private inBase(tx: Transaction): number {
		return Math.abs(convert(tx.amount, tx.currency, this.plugin.store.fx, tx.date));
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();
		const store = this.plugin.store;
		const category = this.category();
		const transactions = this.transactions();
		const total = transactions.reduce((sum, tx) => sum + this.inBase(tx), 0);

		const head = c.createDiv({ cls: "fp-detail-header" });
		const headText = head.createDiv();
		const titleRow = headText.createDiv({ cls: "fp-section-title-row" });
		if (category) categoryChainChip(titleRow, category);
		else titleRow.createEl("h3", { text: "Uncategorized" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: [this.opts.scopeLabel, this.opts.periodLabel ?? this.opts.period].filter(Boolean).join(" · ") || "All time",
		});
		head.createDiv({ cls: "fp-detail-amount fp-money", text: formatMoney(total) });

		c.createDiv({
			cls: "fp-step-desc",
			text: `${transactions.length} transaction${transactions.length === 1 ? "" : "s"}${
				this.secondaryId ? " in this subcategory" : ""
			}.`,
		});

		// --- Subcategory split -------------------------------------------------
		const secondaries = category ? secondaryCategoriesOf(store.categories, category.id) : [];
		if (secondaries.length > 0 && !this.secondaryId) {
			const byCategory = new Map<string, number>();
			for (const tx of this.transactions()) {
				const key = tx.categoryId ?? "";
				byCategory.set(key, (byCategory.get(key) ?? 0) + this.inBase(tx));
			}

			const rows = secondaries
				.map((sub) => ({ sub, value: byCategory.get(sub.id) ?? 0 }))
				.filter((row) => row.value > 0)
				.sort((a, b) => b.value - a.value);
			// Transactions tagged with the primary itself rather than any subcategory — otherwise the
			// split silently fails to add up to the total above it.
			const direct = byCategory.get(category!.id) ?? 0;

			if (rows.length > 0) {
				c.createEl("h4", { text: "By subcategory" });
				const chartRows = rows.map(({ sub, value }) => ({
					label: sub.name,
					value,
					color: sub.color,
					iconName: sub.icon,
					onClick: () => {
						this.secondaryId = sub.id;
						this.render();
					},
				}));
				if (direct > 0) {
					chartRows.push({
						// Not "<Name> (not subcategorized)": the header already says which category this
						// is, so repeating it only made the longest label in the chart longer still.
						label: "Not subcategorized",
						value: direct,
						color: category!.color,
						iconName: category!.icon,
						onClick: () => {
							this.secondaryId = category!.id;
							this.render();
						},
					});
				}
				barChart(c, chartRows);
			}
		}

		if (this.secondaryId) {
			const backBtn = c.createEl("button", { cls: "fp-btn fp-btn-ghost" });
			icon(backBtn, "arrow-left");
			backBtn.createSpan({ text: `Back to all of ${category?.name ?? "this category"}` });
			backBtn.addEventListener("click", () => {
				this.secondaryId = undefined;
				this.render();
			});
		}

		// --- The transactions themselves ---------------------------------------
		c.createEl("h4", { text: "Transactions" });
		if (transactions.length === 0) {
			c.createEl("p", { cls: "fp-step-desc", text: "Nothing spent here in this period." });
		} else {
			const accountById = new Map(store.accounts.map((a) => [a.id, a.name]));
			const showAccount = !this.opts.accountId;
			const wrap = c.createDiv({ cls: "fp-table-scroll" });
			const table = wrap.createEl("table", { cls: "fp-table" });
			const headRow = table.createEl("thead").createEl("tr");
			headRow.createEl("th", { text: "Date" });
			headRow.createEl("th", { text: "Description" });
			if (showAccount) headRow.createEl("th", { text: "Account" });
			if (!this.secondaryId && secondaries.length > 0) headRow.createEl("th", { text: "Subcategory" });
			headRow.createEl("th", { text: "Amount", cls: "fp-table-num" });

			const tbody = table.createEl("tbody");
			transactions.slice(0, 200).forEach((tx) => {
				const tr = tbody.createEl("tr", { cls: "fp-table-row-clickable" });
				// An undated row counts toward the total above, so say the date is missing rather than
				// leaving a blank cell that reads like a rendering fault.
				tr.createEl("td", { text: tx.date || "No date" });
				tr.createEl("td", { text: tx.counterparty?.trim() || tx.description || "—" });
				if (showAccount) tr.createEl("td", { text: accountById.get(tx.accountId) ?? "—" });
				if (!this.secondaryId && secondaries.length > 0) {
					const cell = tr.createEl("td");
					const chain = categoryChain(store.categories, tx.categoryId);
					if (chain.secondary) categoryChainChip(cell, chain.secondary);
					else cell.createSpan({ cls: "fp-budget-hint-text", text: "—" });
				}
				tr.createEl("td", {
					cls: "fp-table-num fp-money",
					text: formatMoney(Math.abs(tx.amount), { currency: tx.currency || "EUR" }),
				});
				tr.addEventListener("click", () => {
					this.close();
					new TransactionDetailModal(this.app, this.plugin, tx).open();
				});
			});

			if (transactions.length > 200) {
				c.createEl("p", {
					cls: "fp-step-desc",
					text: `Showing the 200 most recent of ${transactions.length}. The ledger's own filters will take you to the rest.`,
				});
			}
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const closeBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(closeBtn, "check");
		closeBtn.createSpan({ text: "Close" });
		closeBtn.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
