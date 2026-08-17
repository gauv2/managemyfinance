import { primaryCategoryTotals } from "../../kpi";
import type FinancePlugin from "../../main";
import { CategoryDrilldownModal } from "../../modals/CategoryDrilldownModal";
import { formatMoney } from "../../money";
import { emptyPeriodSelection, resolvePeriodRange, type PeriodSelection } from "../../period";
import { barChart } from "../../ui/charts";
import { icon } from "../../ui/dom";
import { renderPeriodFilter } from "../../ui/periodFilter";

/**
 * Where the money went, as a page rather than a card on someone else's page.
 *
 * The drill-down from a primary category to its subcategories to the transactions behind them already
 * existed, but the only ways in were a card on the dashboard and the Compare page — so the question
 * "what did I actually spend on?" had to start somewhere that wasn't about categories. This gives it
 * its own place in the nav, reusing CategoryDrilldownModal rather than reimplementing the path.
 *
 * Deliberately thin: the totals come from primaryCategoryTotals (the same function the dashboard card
 * reads, so the two can never disagree), the period control is the shared one every other page mounts,
 * and every row hands off to the same modal. Nothing about how a category is totalled lives here.
 */

/** Module scope so switching pages and coming back doesn't silently reset the period. */
const period: PeriodSelection = emptyPeriodSelection();

export function renderCategoriesSection(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;

	function render(): void {
		container.empty();

		const header = container.createDiv({ cls: "fp-section-header" });
		const headText = header.createDiv({ cls: "fp-section-header-text" });
		const titleRow = headText.createDiv({ cls: "fp-section-title-row" });
		icon(titleRow.createDiv({ cls: "fp-section-icon-badge" }), "shapes");
		titleRow.createEl("h2", { text: "Categories" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: "Every primary category, largest first. Open one to see its subcategories and the transactions behind them.",
		});

		const filterBar = container.createDiv({ cls: "fp-page-filter" });
		renderPeriodFilter(filterBar, {
			dates: store.transactions.map((t) => t.date),
			selection: period,
			onChange: render,
		});

		const range = resolvePeriodRange(period);
		const periodLabel = range ? `${range.from} → ${range.to}` : "All time";
		const totals = primaryCategoryTotals(store, range);

		const card = container.createDiv({ cls: "fp-card" });
		if (totals.size === 0) {
			card.createEl("p", { cls: "fp-step-desc", text: `Nothing spent in ${periodLabel.toLowerCase()}.` });
			return;
		}

		const categoryById = new Map(store.categories.map((c) => [c.id, c]));
		const rows = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
		const grandTotal = rows.reduce((sum, [, amount]) => sum + amount, 0);

		const headRow = card.createDiv({ cls: "fp-card-head-row" });
		headRow.createEl("h3", { text: `${rows.length} categor${rows.length === 1 ? "y" : "ies"}` });
		headRow.createSpan({ cls: "fp-card-head-note", text: `${periodLabel} · ${formatMoney(grandTotal)}` });

		barChart(
			card,
			rows.map(([catId, amount]) => {
				const cat = categoryById.get(catId);
				return {
					label: cat?.name ?? "Uncategorized",
					value: amount,
					color: cat?.color ?? "#6b7280",
					iconName: cat?.icon ?? "help-circle",
					// Same modal the dashboard card opens, scoped to the same period, so the figure that
					// opens always matches the bar that was clicked.
					onClick: () =>
						new CategoryDrilldownModal(plugin.app, plugin, {
							categoryId: catId,
							range,
							periodLabel,
							scopeLabel: "All accounts",
						}).open(),
				};
			})
		);
	}

	render();
}
