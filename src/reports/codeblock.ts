import type { MarkdownPostProcessorContext } from "obsidian";
import { budgetStatuses, currentMonth, oneOffBudgetStatus } from "../budgets";
import { netWorth, primaryCategoryTotals, summarizeByYear, yearSummaryFor } from "../kpi";
import type FinancePlugin from "../main";
import { formatMoney } from "../money";
import { monthlyCostInBase, isActive, upcomingPayments } from "../subscriptions";
import { barChart } from "../ui/charts";
import { icon } from "../ui/dom";
import { renderKpiCard, renderMeter } from "../ui/kpiCard";

/**
 * A ```finance codeblock, so figures can live *inside* your notes.
 *
 * This is the difference between a plugin that happens to run in Obsidian and one that belongs there:
 * a monthly review note can carry its own live budget meter, a project note can show what the project
 * has actually cost, and neither goes stale, because both are rendered from the ledger every time the
 * note is opened rather than pasted in once.
 *
 * The block body is deliberately a few `key: value` lines rather than a query language — this is
 * something you should be able to write from memory:
 *
 *   ```finance
 *   view: budget
 *   month: 2026-08
 *   ```
 */

type FinanceBlockView = "budget" | "spending" | "networth" | "summary" | "subscriptions" | "goal";

interface BlockOptions {
	view: FinanceBlockView;
	/** "YYYY-MM", or "current" (the default) for whichever month it is when the note is opened. */
	month: string;
	year?: string;
	/** Caps how many rows a list-shaped view renders. */
	limit: number;
	title?: string;
	/** For `view: goal` — which one-off budget to show, by name. */
	name?: string;
}

function parseOptions(source: string): BlockOptions {
	const opts: Record<string, string> = {};
	for (const line of source.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const idx = trimmed.indexOf(":");
		if (idx === -1) continue;
		opts[trimmed.slice(0, idx).trim().toLowerCase()] = trimmed.slice(idx + 1).trim();
	}

	const rawMonth = (opts.month ?? "current").toLowerCase();
	const month = rawMonth === "current" || rawMonth === "" ? currentMonth() : rawMonth;
	const limit = parseInt(opts.limit ?? "", 10);

	return {
		view: (opts.view as FinanceBlockView) || "summary",
		month,
		year: opts.year || month.slice(0, 4),
		limit: isNaN(limit) ? 8 : Math.max(1, limit),
		title: opts.title,
		name: opts.name,
	};
}

function blockShell(el: HTMLElement, title: string, subtitle?: string): HTMLElement {
	const wrap = el.createDiv({ cls: "fp-block" });
	const head = wrap.createDiv({ cls: "fp-block-head" });
	icon(head, "wallet", "fp-block-icon");
	head.createSpan({ cls: "fp-block-title", text: title });
	if (subtitle) head.createSpan({ cls: "fp-block-sub", text: subtitle });
	return wrap.createDiv({ cls: "fp-block-body" });
}

function errorBlock(el: HTMLElement, message: string): void {
	const body = blockShell(el, "Finance", "couldn't render");
	body.createDiv({ cls: "fp-block-error", text: message });
}

function renderBudget(body: HTMLElement, plugin: FinancePlugin, opts: BlockOptions): void {
	const store = plugin.store;
	const statuses = budgetStatuses(store, store.categories, opts.month);
	if (statuses.length === 0) {
		body.createDiv({ cls: "fp-block-empty", text: `No budgets planned for ${opts.month}.` });
		return;
	}
	const byId = new Map(store.categories.map((c) => [c.id, c]));
	statuses.slice(0, opts.limit).forEach((status) => {
		renderMeter(body, {
			label: byId.get(status.categoryId)?.name ?? status.categoryId,
			value: Math.min(1, status.pct),
			valueLabel: `${Math.round(status.pct * 100)}%`,
			sub: `${formatMoney(status.spent)} of ${formatMoney(status.available)} · ${formatMoney(status.remaining)} left`,
		});
	});
}

function renderSpending(body: HTMLElement, plugin: FinancePlugin, opts: BlockOptions): void {
	const store = plugin.store;
	const totals = primaryCategoryTotals(store, opts.month);
	if (totals.size === 0) {
		body.createDiv({ cls: "fp-block-empty", text: `No spending recorded in ${opts.month}.` });
		return;
	}
	const byId = new Map(store.categories.map((c) => [c.id, c]));
	barChart(
		body,
		Array.from(totals.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, opts.limit)
			.map(([id, value]) => {
				const cat = byId.get(id);
				return { label: cat?.name ?? "Uncategorized", value, color: cat?.color ?? "#6b7280", iconName: cat?.icon };
			})
	);
}

function renderNetWorth(body: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;
	const years = summarizeByYear(store);
	renderKpiCard(body, {
		label: "Net worth",
		value: formatMoney(netWorth(store)),
		hero: true,
		sparklineValues: years.map((y) => y.netWorthEOY),
		sparklineColor: "var(--fp-neutral)",
	});
}

function renderSummary(body: HTMLElement, plugin: FinancePlugin, opts: BlockOptions): void {
	const store = plugin.store;
	const years = summarizeByYear(store);
	const summary = yearSummaryFor(years, opts.year);
	const grid = body.createDiv({ cls: "fp-block-grid" });
	renderKpiCard(grid, { label: "Net worth", value: formatMoney(netWorth(store)) });
	renderKpiCard(grid, { label: `Income ${opts.year}`, value: summary ? formatMoney(summary.income) : "—" });
	renderKpiCard(grid, { label: `Expenses ${opts.year}`, value: summary ? formatMoney(summary.expenses) : "—" });
	renderKpiCard(grid, {
		label: "Savings rate",
		value: summary ? `${Math.round(summary.savingsRate * 100)}%` : "—",
		money: false,
	});
}

function renderSubscriptions(body: HTMLElement, plugin: FinancePlugin, opts: BlockOptions): void {
	const store = plugin.store;
	const active = store.subscriptions.filter((s) => isActive(s));
	if (active.length === 0) {
		body.createDiv({ cls: "fp-block-empty", text: "No active subscriptions." });
		return;
	}
	const rates = plugin.settings.exchangeRates;
	const monthly = active.reduce((sum, s) => sum + monthlyCostInBase(s, rates), 0);
	renderKpiCard(body, { label: "Subscriptions", value: `${formatMoney(monthly)}/mo`, sub: `${active.length} active` });

	const list = body.createDiv({ cls: "fp-block-list" });
	upcomingPayments(active)
		.slice(0, opts.limit)
		.forEach(({ sub, date, daysUntil: days }) => {
			const row = list.createDiv({ cls: "fp-block-list-row" });
			row.createSpan({ cls: "fp-block-list-name", text: sub.name });
			row.createSpan({ cls: "fp-block-list-meta", text: days <= 0 ? "due today" : `in ${days}d · ${date}` });
		});
}

function renderGoal(body: HTMLElement, plugin: FinancePlugin, opts: BlockOptions): void {
	const store = plugin.store;
	const wanted = (opts.name ?? "").toLowerCase();
	const budgets = store.oneOffBudgets.filter((b) => !b.archived && (!wanted || b.name.toLowerCase().includes(wanted)));
	if (budgets.length === 0) {
		body.createDiv({ cls: "fp-block-empty", text: wanted ? `No one-off budget matching "${opts.name}".` : "No one-off budgets yet." });
		return;
	}
	budgets.slice(0, opts.limit).forEach((budget) => {
		const status = oneOffBudgetStatus(store, budget);
		renderMeter(body, {
			label: budget.name,
			value: Math.min(1, status.pct),
			valueLabel: `${Math.round(status.pct * 100)}%`,
			sub: `${formatMoney(status.spent)} of ${formatMoney(status.budget)} · ${
				status.daysLeft >= 0 ? `${status.daysLeft} days left` : "window closed"
			}`,
		});
	});
}

const VIEW_TITLE: Record<FinanceBlockView, string> = {
	budget: "Budget",
	spending: "Spending",
	networth: "Net worth",
	summary: "Finance summary",
	subscriptions: "Subscriptions",
	goal: "Savings goal",
};

/**
 * Registers the processor. Called once at plugin load; every rendered block reads live from the store,
 * so a note showing August's budget is correct on every open rather than as of whenever it was written.
 */
export function registerFinanceCodeBlock(plugin: FinancePlugin): void {
	plugin.registerMarkdownCodeBlockProcessor("finance", (source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext) => {
		try {
			const opts = parseOptions(source);
			if (!VIEW_TITLE[opts.view]) {
				errorBlock(el, `Unknown view "${opts.view}". Try one of: ${Object.keys(VIEW_TITLE).join(", ")}.`);
				return;
			}
			const subtitle = opts.view === "budget" || opts.view === "spending" ? opts.month : opts.view === "summary" ? opts.year : undefined;
			const body = blockShell(el, opts.title ?? VIEW_TITLE[opts.view], subtitle);

			switch (opts.view) {
				case "budget":
					renderBudget(body, plugin, opts);
					break;
				case "spending":
					renderSpending(body, plugin, opts);
					break;
				case "networth":
					renderNetWorth(body, plugin);
					break;
				case "subscriptions":
					renderSubscriptions(body, plugin, opts);
					break;
				case "goal":
					renderGoal(body, plugin, opts);
					break;
				default:
					renderSummary(body, plugin, opts);
			}
		} catch (err) {
			// A broken block must never take the note down with it.
			errorBlock(el, err instanceof Error ? err.message : String(err));
		}
	});
}
