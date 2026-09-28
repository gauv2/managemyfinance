import { buildCashFlow, layoutSankey, type CashFlow, type FlowItem, type SankeyDetail } from "../../cashFlow";
import type FinancePlugin from "../../main";
import { CategoryDrilldownModal } from "../../modals/CategoryDrilldownModal";
import { formatMoney } from "../../money";
import { emptyPeriodSelection, resolvePeriodRange, type DateRange, type PeriodSelection } from "../../period";
import { icon } from "../../ui/dom";
import { renderPeriodFilter } from "../../ui/periodFilter";

/**
 * Where the money came from and where it went, for a period: a Sankey from income sources through one
 * income bar out to savings and each expense group, or the same numbers as a profit & loss statement,
 * with an income and an expense breakdown underneath.
 *
 * All the arithmetic lives in cashFlow.ts (which reads the same classifier as the dashboard, so the
 * figures agree); this file only draws it.
 */

type FlowView = "sankey" | "pnl";
type IncomeBreakdown = "group" | "category" | "merchant";
type ExpenseBreakdown = "group" | "category" | "merchant";

/** Module scope so leaving the page and coming back keeps what you were looking at. */
const period: PeriodSelection = emptyPeriodSelection();
const state = {
	view: "sankey" as FlowView,
	detail: "groups" as SankeyDetail,
	income: "group" as IncomeBreakdown,
	expenses: "group" as ExpenseBreakdown,
	/** Groups unfolded in the profit & loss table; the income block starts open. */
	expanded: new Set<string>(["income"]),
};

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
	parent.appendChild(el);
	return el;
}

function segmented<T extends string>(parent: HTMLElement, options: [T, string][], active: T, onPick: (value: T) => void): void {
	const group = parent.createDiv({ cls: "fp-segmented" });
	for (const [value, label] of options) {
		const btn = group.createEl("button", { cls: "fp-segmented-btn" + (value === active ? " is-active" : ""), text: label });
		btn.addEventListener("click", () => {
			if (value !== active) onPick(value);
		});
	}
}

function pct(share: number): string {
	return `${(share * 100).toFixed(1)}%`;
}

export function renderCashFlowSection(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;
	const currency = store.fx.baseCurrency;
	const money = (amount: number) => formatMoney(amount, { currency });

	function render(): void {
		container.empty();

		const header = container.createDiv({ cls: "fp-section-header" });
		const headText = header.createDiv({ cls: "fp-section-header-text" });
		const titleRow = headText.createDiv({ cls: "fp-section-title-row" });
		icon(titleRow.createDiv({ cls: "fp-section-icon-badge" }), "arrow-down-up");
		titleRow.createEl("h2", { text: "Cash flow" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: "Where the money came from and where it went. Transfers between your own accounts, trades and debt principal are left out, exactly as on the dashboard.",
		});

		const filterBar = container.createDiv({ cls: "fp-page-filter" });
		renderPeriodFilter(filterBar, {
			dates: store.transactions.map((t) => t.date),
			selection: period,
			onChange: render,
		});

		const range = resolvePeriodRange(period);
		const periodLabel = range ? `${range.from} → ${range.to}` : "All time";
		const flow = buildCashFlow(store, range);

		if (flow.income.total === 0 && flow.expenses.total === 0) {
			const card = container.createDiv({ cls: "fp-card" });
			card.createEl("p", { cls: "fp-step-desc", text: `No income or spending in ${periodLabel.toLowerCase()}.` });
			return;
		}

		renderFlowCard(flow);
		const grid = container.createDiv({ cls: "fp-cashflow-grid" });
		renderIncomeCard(grid, flow);
		renderExpenseCard(grid, flow, range, periodLabel);
	}

	// ─── Where the money went ──────────────────────────────────────────────────────────────────

	function renderFlowCard(flow: CashFlow): void {
		const card = container.createDiv({ cls: "fp-card fp-cashflow-card" });
		const head = card.createDiv({ cls: "fp-card-head-row fp-cashflow-head" });
		head.createEl("h3", { text: "Where the money went" });
		const controls = head.createDiv({ cls: "fp-cashflow-controls" });
		if (state.view === "sankey") {
			segmented(
				controls,
				[
					["groups", "Groups"],
					["categories", "Categories"],
					["both", "Both"],
				],
				state.detail,
				(v) => {
					state.detail = v;
					render();
				}
			);
		}
		segmented(
			controls,
			[
				["sankey", "Sankey"],
				["pnl", "Profit & loss"],
			],
			state.view,
			(v) => {
				state.view = v;
				render();
			}
		);

		renderSummary(card, flow);
		if (state.view === "sankey") renderSankey(card, flow);
		else renderProfitAndLoss(card, flow);
	}

	function renderSummary(card: HTMLElement, flow: CashFlow): void {
		const row = card.createDiv({ cls: "fp-cashflow-summary" });
		const stat = (label: string, value: string, tone?: "good" | "bad") => {
			const cell = row.createDiv({ cls: "fp-cashflow-stat" + (tone ? ` is-${tone}` : "") });
			cell.createDiv({ cls: "fp-cashflow-stat-label", text: label });
			cell.createDiv({ cls: "fp-cashflow-stat-value fp-money", text: value });
		};
		stat("Income", money(flow.income.total));
		stat("Expenses", money(flow.expenses.total));
		const kept = flow.net >= 0;
		stat(kept ? "Saved" : "Overspent", money(Math.abs(flow.net)), kept ? "good" : "bad");
		if (flow.income.total > 0) stat("Savings rate", pct(flow.net / flow.income.total), kept ? "good" : "bad");
	}

	function renderSankey(card: HTMLElement, flow: CashFlow): void {
		const style = getComputedStyle(container);
		const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
		// Laid out at the card's real width rather than scaled into it: scaling a fixed viewBox up to a
		// wide pane blows the text and the height up with it.
		const minWidth = state.detail === "both" ? 760 : 620;
		const layout = layoutSankey(flow, state.detail, {
			width: Math.max(card.clientWidth - 40, minWidth),
			incomeColor: token("--fp-chart-income", "#008300"),
			savingsColor: token("--fp-cat-3", "#1baf7a"),
			shortfallColor: token("--fp-chart-expenses", "#e34948"),
		});
		if (layout.nodes.length === 0) {
			card.createEl("p", { cls: "fp-step-desc", text: "Nothing positive to draw — refunds outweigh the spending in this period." });
			return;
		}

		const wrap = card.createDiv({ cls: "fp-chart fp-chart-money fp-sankey-wrap" });
		const svg = svgEl(wrap, "svg", { viewBox: `0 0 ${layout.width} ${layout.height}`, class: "fp-sankey" });
		svg.style.width = `${layout.width}px`;

		const linkLayer = svgEl(svg, "g", { class: "fp-sankey-links" });
		const linkEls: { el: SVGPathElement; source: string; target: string }[] = [];
		for (const link of layout.links) {
			const path = svgEl(linkLayer, "path", { d: link.path, class: "fp-sankey-link" });
			path.style.fill = link.color;
			const source = layout.nodes.find((n) => n.id === link.source)!;
			const target = layout.nodes.find((n) => n.id === link.target)!;
			svgEl(path, "title", {}).textContent = `${source.label} → ${target.label}: ${money(link.value)}`;
			linkEls.push({ el: path, source: link.source, target: link.target });
		}

		const nodeLayer = svgEl(svg, "g", { class: "fp-sankey-nodes" });
		for (const node of layout.nodes) {
			const g = svgEl(nodeLayer, "g", { class: "fp-sankey-node" });
			const rect = svgEl(g, "rect", { x: node.x, y: node.y, width: 10, height: node.height, rx: 2 });
			rect.style.fill = node.color;
			svgEl(rect, "title", {}).textContent = `${node.label}: ${money(node.value)}`;

			// Hovering a bar lights up every ribbon touching it and dims the rest.
			g.addEventListener("mouseenter", () => {
				svg.addClass("is-focused");
				for (const l of linkEls) l.el.toggleClass("is-lit", l.source === node.id || l.target === node.id);
			});
			g.addEventListener("mouseleave", () => {
				svg.removeClass("is-focused");
				for (const l of linkEls) l.el.removeClass("is-lit");
			});

			const isHub = node.id === "hub";
			const left = node.labelSide === "left";
			const tx = isHub ? node.x + 5 : left ? node.x - 6 : node.x + 16;
			const anchor = isHub ? "middle" : left ? "end" : "start";
			// The hub's label goes above it — ribbons cover both of its sides. Every other label is centred on its bar.
			const ty = isHub ? node.y - 22 : node.y + node.height / 2 - 6;
			const name = svgEl(g, "text", { x: tx, y: ty, "text-anchor": anchor, class: "fp-sankey-label" });
			// Long names are cut short rather than run off the edge or into the next column; the bar's
			// tooltip still has the whole thing.
			name.textContent = node.label.length > 26 ? `${node.label.slice(0, 25).trimEnd()}…` : node.label;
			const detail = svgEl(g, "text", { x: tx, y: ty + 14, "text-anchor": anchor, class: "fp-sankey-value" });
			detail.textContent = node.share === undefined ? money(node.value) : `${money(node.value)} (${pct(node.share)})`;
		}
	}

	function renderProfitAndLoss(card: HTMLElement, flow: CashFlow): void {
		const table = card.createEl("table", { cls: "fp-table fp-pnl" });
		const head = table.createEl("thead").createEl("tr");
		head.createEl("th", { text: "Category" });
		head.createEl("th", { cls: "fp-table-num", text: "% of income" });
		head.createEl("th", { cls: "fp-table-num", text: "Amount" });
		const body = table.createEl("tbody");
		const share = (amount: number) => (flow.income.total > 0 ? pct(amount / flow.income.total) : "—");

		const toggle = (key: string) => {
			if (state.expanded.has(key)) state.expanded.delete(key);
			else state.expanded.add(key);
			render();
		};

		const line = (opts: {
			label: string;
			amount: number;
			cls: string;
			color?: string;
			expandKey?: string;
			showShare?: boolean;
		}) => {
			const tr = body.createEl("tr", { cls: opts.cls });
			const nameCell = tr.createEl("td");
			const inner = nameCell.createDiv({ cls: "fp-pnl-name" });
			if (opts.expandKey) {
				const open = state.expanded.has(opts.expandKey);
				icon(inner, open ? "chevron-down" : "chevron-right", "fp-pnl-chevron");
				tr.addClass("is-expandable");
				tr.addEventListener("click", () => toggle(opts.expandKey!));
			} else {
				inner.createSpan({ cls: "fp-pnl-chevron-spacer" });
			}
			if (opts.color) inner.createSpan({ cls: "fp-pnl-dot" }).style.background = opts.color;
			inner.createSpan({ text: opts.label });
			tr.createEl("td", { cls: "fp-table-num fp-pnl-share", text: opts.showShare === false ? "" : share(Math.abs(opts.amount)) });
			tr.createEl("td", { cls: "fp-table-num fp-money", text: money(opts.amount) });
		};

		line({ label: "Income", amount: flow.income.total, cls: "fp-pnl-section", expandKey: "income", showShare: false });
		if (state.expanded.has("income")) {
			for (const g of flow.income.groups) line({ label: g.name, amount: g.amount, cls: "fp-pnl-child", color: g.color });
		}

		line({ label: "Expenses", amount: -flow.expenses.total, cls: "fp-pnl-section" });
		for (const g of flow.expenses.groups) {
			const key = `exp:${g.id}`;
			// Nothing to unfold when the group only has itself in it.
			const foldable = g.categories.length > 1 || (g.categories.length === 1 && g.categories[0].id !== g.id);
			line({ label: g.name, amount: -g.amount, cls: "fp-pnl-group", color: g.color, expandKey: foldable ? key : undefined });
			if (foldable && state.expanded.has(key)) {
				for (const c of g.categories) line({ label: c.name, amount: -c.amount, cls: "fp-pnl-child fp-pnl-grandchild" });
			}
		}

		const kept = flow.net >= 0;
		line({ label: kept ? "Saved" : "Overspent", amount: flow.net, cls: "fp-pnl-total" + (kept ? " is-good" : " is-bad") });
	}

	// ─── Breakdowns ────────────────────────────────────────────────────────────────────────────

	function breakdownList(card: HTMLElement, items: FlowItem[], total: number, onOpen?: (item: FlowItem) => void): void {
		const list = card.createDiv({ cls: "fp-cashflow-list" });
		if (items.length === 0) {
			list.createEl("p", { cls: "fp-step-desc", text: "Nothing in this period." });
			return;
		}
		const peak = Math.max(...items.map((i) => Math.abs(i.amount)));
		for (const item of items) {
			const row = list.createDiv({ cls: "fp-cashflow-row" + (onOpen ? " is-clickable" : "") });
			if (onOpen) row.addEventListener("click", () => onOpen(item));
			const top = row.createDiv({ cls: "fp-cashflow-row-top" });
			top.createSpan({ cls: "fp-pnl-dot" }).style.background = item.color;
			top.createSpan({ cls: "fp-cashflow-row-name", text: item.name });
			top.createSpan({ cls: "fp-cashflow-row-amount fp-money", text: money(item.amount) });
			top.createSpan({ cls: "fp-cashflow-row-share", text: total > 0 ? pct(item.amount / total) : "" });
			const track = row.createDiv({ cls: "fp-cashflow-bar" });
			const fill = track.createDiv({ cls: "fp-cashflow-bar-fill" });
			fill.style.width = `${peak > 0 ? (Math.max(item.amount, 0) / peak) * 100 : 0}%`;
			fill.style.background = item.color;
		}
	}

	function renderIncomeCard(grid: HTMLElement, flow: CashFlow): void {
		const card = grid.createDiv({ cls: "fp-card fp-cashflow-side" });
		const head = card.createDiv({ cls: "fp-card-head-row" });
		head.createEl("h3", { text: "Income" });
		segmented(
			head,
			[
				["group", "Group"],
				["category", "Category"],
				["merchant", "Merchant"],
			],
			state.income,
			(v) => {
				state.income = v;
				render();
			}
		);
		const items = state.income === "group" ? flow.income.groups : state.income === "category" ? flow.income.categories : flow.income.merchants;
		breakdownList(card, items, flow.income.total);
	}

	function renderExpenseCard(grid: HTMLElement, flow: CashFlow, range: DateRange | undefined, periodLabel: string): void {
		const card = grid.createDiv({ cls: "fp-card fp-cashflow-side" });
		const head = card.createDiv({ cls: "fp-card-head-row" });
		head.createEl("h3", { text: "Expenses" });
		segmented(
			head,
			[
				["group", "Group"],
				["category", "Category"],
				["merchant", "Merchant"],
			],
			state.expenses,
			(v) => {
				state.expenses = v;
				render();
			}
		);
		const items =
			state.expenses === "group" ? flow.expenses.groups : state.expenses === "category" ? flow.expenses.categories : flow.expenses.merchants;
		// Groups open the same drill-down the Categories page does, scoped to the same period, so the
		// figure it opens on always matches the row that was clicked.
		const open =
			state.expenses === "group"
				? (item: FlowItem) =>
						new CategoryDrilldownModal(plugin.app, plugin, {
							categoryId: item.id,
							range,
							periodLabel,
							scopeLabel: "All accounts",
						}).open()
				: undefined;
		breakdownList(card, items, flow.income.total > 0 ? flow.income.total : flow.expenses.total, open);
	}

	render();
}
