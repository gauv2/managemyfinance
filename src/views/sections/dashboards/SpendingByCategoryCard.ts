import { primaryCategoryTotals, spendingYears } from "../../../kpi";
import type FinancePlugin from "../../../main";
import { CategoryDrilldownModal } from "../../../modals/CategoryDrilldownModal";
import { barChart } from "../../../ui/charts";

export interface SpendingByCategoryOptions {
	/** Left out for the all-accounts view, which combines every account. */
	accountId?: string;
	/** What the drill-down calls this scope, so the modal's total is never ambiguous about what it covers. */
	scopeLabel: string;
}

/**
 * Where a year's spending actually went, as a bar per primary category.
 *
 * The year is a per-card choice rather than a page-wide one: two of these can sit on screen showing
 * different years, and neither is tied to whatever the ledger's own period filter is set to. The
 * picker only offers years that have spending in this scope, so it can never select an empty card.
 */
export function renderSpendingByCategoryCard(container: HTMLElement, plugin: FinancePlugin, opts: SpendingByCategoryOptions): void {
	const store = plugin.store;
	const years = spendingYears(store, opts.accountId);
	if (years.length === 0) return;

	// Opens on the current year when there is something to show for it, otherwise on the most recent
	// year that has spending — the card used to vanish outright between New Year's Day and the first
	// import of the new year.
	const currentYear = String(new Date().getFullYear());
	let selectedYear = years.includes(currentYear) ? currentYear : years[0];

	const card = container.createDiv({ cls: "fp-card" });
	const head = card.createDiv({ cls: "fp-card-head-row" });
	head.createEl("h3", { text: "Spending by category" });
	const yearSelect = head.createEl("select", { cls: "fp-filter-select" });
	years.forEach((y) => yearSelect.createEl("option", { text: y, value: y }));
	yearSelect.value = selectedYear;
	yearSelect.setAttribute("aria-label", "Year");
	yearSelect.addEventListener("change", () => {
		selectedYear = yearSelect.value;
		renderBars();
	});

	// Only the chart is redrawn on a year change, so the picker keeps focus and the card doesn't jump.
	const body = card.createDiv({ cls: "fp-spending-by-category-body" });
	renderBars();

	function renderBars(): void {
		body.empty();
		const totals = primaryCategoryTotals(store, selectedYear, opts.accountId);
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
								period: selectedYear,
								accountId: opts.accountId,
								scopeLabel: opts.scopeLabel,
							}).open(),
					};
				})
		);
	}
}
