import { primaryCategoryTotals } from "../../../kpi";
import type FinancePlugin from "../../../main";
import { CategoryDrilldownModal } from "../../../modals/CategoryDrilldownModal";
import type { DateRange } from "../../../period";
import { barChart } from "../../../ui/charts";

export interface SpendingByCategoryOptions {
	/** Left out for the all-accounts view, which combines every account. */
	accountId?: string;
	/** What the drill-down calls this scope, so the modal's total is never ambiguous about what it covers. */
	scopeLabel: string;
	/** The page's period filter. Absent means all time. */
	range?: DateRange;
	/** That period in words, for the heading and the drill-down. */
	periodLabel: string;
}

/**
 * Where spending actually went over the page's period, as a bar per primary category.
 *
 * The card used to carry a year picker of its own, which meant a page could show this card on one
 * year while the ledger under it showed another — two controls, one page, no way to tell which one
 * the number in front of you came from. The page period filter is now the only period control there
 * is, and this card simply reads it.
 */
export function renderSpendingByCategoryCard(container: HTMLElement, plugin: FinancePlugin, opts: SpendingByCategoryOptions): void {
	const store = plugin.store;
	const totals = primaryCategoryTotals(store, opts.range, opts.accountId);

	const card = container.createDiv({ cls: "fp-card" });
	const head = card.createDiv({ cls: "fp-card-head-row" });
	head.createEl("h3", { text: "Spending by category" });
	head.createSpan({ cls: "fp-card-head-note", text: opts.periodLabel });

	const body = card.createDiv({ cls: "fp-spending-by-category-body" });
	if (totals.size === 0) {
		body.createEl("p", { cls: "fp-step-desc", text: opts.range ? `Nothing spent in ${opts.periodLabel}.` : "Nothing spent yet." });
		return;
	}

	const categoryById = new Map(store.categories.map((c) => [c.id, c]));
	barChart(
		body,
		Array.from(totals.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([catId, amount]) => {
				const cat = categoryById.get(catId);
				return {
					label: cat?.name ?? "Uncategorized",
					value: amount,
					color: cat?.color ?? "#6b7280",
					iconName: cat?.icon ?? "help-circle",
					// Every bar is a way into the transactions behind it, scoped exactly as the bar is,
					// so the drill-down's total always matches what was clicked.
					onClick: () =>
						new CategoryDrilldownModal(plugin.app, plugin, {
							categoryId: catId,
							range: opts.range,
							periodLabel: opts.periodLabel,
							accountId: opts.accountId,
							scopeLabel: opts.scopeLabel,
						}).open(),
				};
			})
	);
}
