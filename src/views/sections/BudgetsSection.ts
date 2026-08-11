import { Notice } from "obsidian";
import { budgetForMonth, budgetStatuses, currentMonth, shiftMonth, suggestedBudget } from "../../budgets";
import { categoryTotals } from "../../kpi";
import type FinancePlugin from "../../main";
import { CategoryExpensesModal } from "../../modals/CategoryExpensesModal";
import type { Category } from "../../types";
import { categoryChip, emptyState, icon, statTile } from "../../ui/dom";

function formatEUR(n: number): string {
	return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(n);
}

function monthLabel(month: string): string {
	const d = new Date(`${month}-01T00:00:00`);
	if (isNaN(d.getTime())) return month;
	return new Intl.DateTimeFormat("en-IE", { month: "long", year: "numeric" }).format(d);
}

/**
 * Simple monthly budgets, one limit per category — plans are kept per month in `Category.budgetHistory`
 * (not overwritten as the calendar rolls forward), so browsing back through past months for year-end
 * budget planning shows exactly what was actually planned at the time, next to what was actually spent.
 */
export function renderBudgetsSection(container: HTMLElement, plugin: FinancePlugin): void {
	container.addClass("fp-section");
	const store = plugin.store;
	let month = currentMonth();

	function render(): void {
		container.empty();
		const categories = store.categories.filter((c) => !c.archived);
		const statuses = budgetStatuses(store, categories, month);
		const statusByCategory = new Map(statuses.map((s) => [s.categoryId, s]));
		const spendByCategory = categoryTotals(store, month);

		const header = container.createDiv({ cls: "fp-section-header" });
		const headText = header.createDiv();
		headText.createEl("h2", { text: "Budgets" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: "Simple monthly limits per category — resets each month, no rollover. Plans and actuals are kept for every month, so you can look back at year-end.",
		});

		const headerActions = header.createDiv({ cls: "fp-section-header-actions" });

		const monthNav = headerActions.createDiv({ cls: "fp-month-nav" });
		const prevBtn = monthNav.createEl("button", { cls: "fp-btn-icon fp-btn-ghost" });
		icon(prevBtn, "chevron-left");
		prevBtn.setAttr("aria-label", "Previous month");
		prevBtn.addEventListener("click", () => {
			month = shiftMonth(month, -1);
			render();
		});
		monthNav.createSpan({ cls: "fp-month-nav-label", text: monthLabel(month) });
		const nextBtn = monthNav.createEl("button", { cls: "fp-btn-icon fp-btn-ghost" });
		icon(nextBtn, "chevron-right");
		nextBtn.setAttr("aria-label", "Next month");
		nextBtn.addEventListener("click", () => {
			month = shiftMonth(month, 1);
			render();
		});
		if (month !== currentMonth()) {
			const todayBtn = monthNav.createEl("button", { cls: "fp-btn fp-btn-ghost fp-month-nav-today" });
			todayBtn.setText("This month");
			todayBtn.addEventListener("click", () => {
				month = currentMonth();
				render();
			});
		}

		if (categories.length > 0) {
			const suggestBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-secondary" });
			icon(suggestBtn, "wand-2");
			suggestBtn.createSpan({ text: "Suggest budget" });
			suggestBtn.addEventListener("click", () => void applyAllSuggestions(categories));
		}

		const totalBudget = statuses.reduce((s, b) => s + b.budget, 0);
		const totalSpent = statuses.reduce((s, b) => s + b.spent, 0);
		const kpis = container.createDiv({ cls: "fp-stat-grid" });
		statTile(kpis, { label: "Budgeted", value: formatEUR(totalBudget), iconName: "target" });
		statTile(kpis, { label: "Spent so far", value: formatEUR(totalSpent), iconName: "trending-down" });
		statTile(kpis, {
			label: "Remaining",
			value: formatEUR(totalBudget - totalSpent),
			iconName: "wallet",
			tone: statuses.length === 0 ? "neutral" : totalBudget - totalSpent < 0 ? "bad" : "good",
		});

		if (categories.length === 0) {
			emptyState(container, {
				iconName: "piggy-bank",
				title: "No categories yet",
				description: "Categories are created as you import and tag transactions — come back once you have some.",
			});
			return;
		}

		// Budgeted categories first (most at-risk first), then everything else — sorted by actual
		// spend so the categories most worth budgeting float to the top.
		const sorted = [...categories].sort((a, b) => {
			const sa = statusByCategory.get(a.id);
			const sb = statusByCategory.get(b.id);
			if (sa && sb) return sb.pct - sa.pct;
			if (sa) return -1;
			if (sb) return 1;
			return (spendByCategory.get(b.id) ?? 0) - (spendByCategory.get(a.id) ?? 0);
		});

		const card = container.createDiv({ cls: "fp-card" });
		const table = card.createEl("table", { cls: "fp-table fp-budget-table" });
		const thead = table.createEl("thead");
		const headRow = thead.createEl("tr");
		headRow.createEl("th", { text: "Category" });
		headRow.createEl("th", { text: "Planned budget", cls: "fp-table-num" });
		headRow.createEl("th", { text: "Actual spend", cls: "fp-table-num" });
		headRow.createEl("th", { text: "Remaining", cls: "fp-table-num" });
		headRow.createEl("th", { text: "% met", cls: "fp-table-num fp-budget-pct-col" });
		const tbody = table.createEl("tbody");
		sorted.forEach((c) => renderBudgetRow(tbody, c, statusByCategory.get(c.id), spendByCategory.get(c.id) ?? 0));
	}

	function renderBudgetRow(
		parent: HTMLElement,
		category: Category,
		status: ReturnType<typeof budgetStatuses>[number] | undefined,
		spent: number
	): void {
		const row = parent.createEl("tr");

		const catCell = row.createEl("td");
		categoryChip(catCell, category.name, category.color, category.icon);

		const planned = budgetForMonth(category, month);
		const plannedCell = row.createEl("td", { cls: "fp-table-num" });
		const input = plannedCell.createEl("input", {
			type: "number",
			cls: "fp-budget-input-plain",
			attr: { min: "0", step: "1", placeholder: "0" },
		});
		input.value = planned ? String(planned) : "";
		input.addEventListener("blur", () => void saveBudget(category, input.value));
		input.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") input.blur();
		});

		const spentCell = row.createEl("td", { cls: "fp-table-num fp-money" });
		if (spent > 0) {
			spentCell.addClass("fp-table-value-clickable");
			spentCell.setText(formatEUR(spent));
			spentCell.addEventListener("click", () => new CategoryExpensesModal(plugin.app, plugin, category, month).open());
		} else {
			spentCell.setText(formatEUR(spent));
		}

		const remainingCell = row.createEl("td", { cls: "fp-table-num fp-money" });
		if (planned) {
			const remaining = planned - spent;
			remainingCell.addClass(remaining < 0 ? "fp-budget-remaining-over" : "fp-budget-remaining-under");
			remainingCell.setText(remaining >= 0 ? formatEUR(remaining) : `-${formatEUR(-remaining)}`);
		} else {
			remainingCell.createSpan({ cls: "fp-budget-hint-text", text: "—" });
		}

		const pctCell = row.createEl("td", { cls: "fp-table-num fp-budget-pct-col" });
		if (status) {
			const wrap = pctCell.createDiv({ cls: "fp-budget-pct-wrap" });
			const track = wrap.createDiv({ cls: `fp-budget-pct-track fp-tone-${status.tone}` });
			track.createDiv({ cls: "fp-budget-pct-fill" }).style.width = `${Math.max(0, Math.min(100, status.pct * 100))}%`;
			wrap.createSpan({ cls: `fp-badge fp-tone-${status.tone}`, text: `${Math.round(status.pct * 100)}%` });
		} else {
			pctCell.createSpan({ cls: "fp-budget-hint-text", text: "—" });
		}
	}

	async function saveBudget(category: Category, rawValue: string): Promise<void> {
		const parsed = parseFloat(rawValue);
		const amount = isFinite(parsed) && parsed > 0 ? parsed : undefined;
		const current = budgetForMonth(category, month);
		if (current === amount) return;
		const target = store.categories.find((c) => c.id === category.id);
		if (!target) return;
		target.budgetHistory = { ...target.budgetHistory };
		if (amount === undefined) delete target.budgetHistory[month];
		else target.budgetHistory[month] = amount;
		await store.saveCategories();
		new Notice(
			amount
				? `Budget for "${category.name}" set to ${formatEUR(amount)} for ${monthLabel(month)}`
				: `Budget removed for "${category.name}" for ${monthLabel(month)}`
		);
		render();
	}

	async function applyAllSuggestions(categories: Category[]): Promise<void> {
		const candidates = categories.filter((c) => !(budgetForMonth(c, month) ?? 0));
		let applied = 0;
		for (const c of candidates) {
			const suggestion = suggestedBudget(store, c.id, month);
			if (suggestion) {
				c.budgetHistory = { ...c.budgetHistory, [month]: suggestion };
				applied++;
			}
		}
		if (applied === 0) {
			new Notice("No suggestions available yet — categories need a bit of spending history first.");
			return;
		}
		await store.saveCategories();
		new Notice(`Applied a suggested budget to ${applied} categor${applied === 1 ? "y" : "ies"} for ${monthLabel(month)}.`);
		render();
	}

	render();
}
