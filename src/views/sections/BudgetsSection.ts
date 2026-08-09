import { Notice } from "obsidian";
import { budgetStatuses, currentMonth, suggestedBudget } from "../../budgets";
import type FinancePlugin from "../../main";
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
 * Simple monthly budgets, one limit per category, no rollover — each month is scored purely on its
 * own spend against its own limit. Budgets live on `Category.budget` (persisted via the same
 * `store.saveCategories()` every other category edit already uses), edited inline here since there's
 * no separate category-management UI in the app to route through instead.
 */
export function renderBudgetsSection(container: HTMLElement, plugin: FinancePlugin): void {
	container.addClass("fp-section");
	const month = currentMonth();
	const store = plugin.store;

	function render(): void {
		container.empty();
		const categories = store.categories.filter((c) => !c.archived);
		const statuses = budgetStatuses(store, categories, month);
		const statusByCategory = new Map(statuses.map((s) => [s.categoryId, s]));

		const header = container.createDiv({ cls: "fp-section-header" });
		const headText = header.createDiv();
		headText.createEl("h2", { text: "Budgets" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: `Simple monthly limits per category for ${monthLabel(month)} — resets each month, no rollover.`,
		});

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

		// Budgeted categories first (most at-risk first), then everything else — sorted by the
		// suggested amount so the categories most worth budgeting float to the top.
		const sorted = [...categories].sort((a, b) => {
			const sa = statusByCategory.get(a.id);
			const sb = statusByCategory.get(b.id);
			if (sa && sb) return sb.pct - sa.pct;
			if (sa) return -1;
			if (sb) return 1;
			const suggA = suggestedBudget(store, a.id, month) ?? 0;
			const suggB = suggestedBudget(store, b.id, month) ?? 0;
			return suggB - suggA;
		});

		const grid = container.createDiv({ cls: "fp-budget-grid" });
		sorted.forEach((c) => renderBudgetCard(grid, c, statusByCategory.get(c.id)));
	}

	function renderBudgetCard(parent: HTMLElement, category: Category, status: ReturnType<typeof budgetStatuses>[number] | undefined): void {
		const card = parent.createDiv({ cls: "fp-budget-card" + (status ? ` fp-tone-${status.tone}` : "") });

		const top = card.createDiv({ cls: "fp-budget-card-top" });
		categoryChip(top, category.name, category.color, category.icon);

		const inputWrap = top.createDiv({ cls: "fp-budget-input-wrap" });
		inputWrap.createSpan({ cls: "fp-budget-input-prefix", text: "€" });
		const input = inputWrap.createEl("input", {
			type: "number",
			cls: "fp-budget-input",
			attr: { min: "0", step: "1", placeholder: "0" },
		});
		input.value = category.budget ? String(category.budget) : "";
		const commit = () => void saveBudget(category, input.value);
		input.addEventListener("blur", commit);
		input.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") input.blur();
		});

		if (status) {
			const track = card.createDiv({ cls: "fp-budget-track" });
			const fill = track.createDiv({ cls: "fp-budget-fill" });
			fill.style.width = `${Math.max(0, Math.min(100, status.pct * 100))}%`;

			const sub = card.createDiv({ cls: "fp-budget-card-sub" });
			sub.createSpan({ cls: "fp-money", text: `${formatEUR(status.spent)} / ${formatEUR(status.budget)}` });
			sub.createSpan({
				cls: "fp-budget-remaining",
				text: status.remaining >= 0 ? `${formatEUR(status.remaining)} left` : `${formatEUR(-status.remaining)} over`,
			});
		} else {
			const suggestion = suggestedBudget(store, category.id, month);
			const hint = card.createDiv({ cls: "fp-budget-hint" });
			if (suggestion) {
				const btn = hint.createEl("button", { cls: "fp-btn fp-btn-ghost fp-budget-suggest-btn" });
				icon(btn, "wand-2");
				btn.createSpan({ text: `Suggest ${formatEUR(suggestion)}/mo` });
				btn.addEventListener("click", () => {
					input.value = String(suggestion);
					void saveBudget(category, input.value);
				});
			} else {
				hint.createSpan({ cls: "fp-budget-hint-text", text: "No budget set" });
			}
		}
	}

	async function saveBudget(category: Category, rawValue: string): Promise<void> {
		const parsed = parseFloat(rawValue);
		const amount = isFinite(parsed) && parsed > 0 ? parsed : undefined;
		if (category.budget === amount) return;
		const target = store.categories.find((c) => c.id === category.id);
		if (!target) return;
		target.budget = amount;
		await store.saveCategories();
		new Notice(amount ? `Budget for "${category.name}" set to ${formatEUR(amount)}/mo` : `Budget removed for "${category.name}"`);
		render();
	}

	render();
}
