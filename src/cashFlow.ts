import { categoryChain } from "./categories";
import { classifyTransaction } from "./finance/semantics";
import { merchantDisplayName, merchantKey, merchantSourceText } from "./import/merchantKey";
import { amountIn, scaledEconomicAmount, type KpiStore } from "./kpi";
import { inRange, type DateRange } from "./period";

/**
 * Where the money came from and where it went, for the Cash flow page — one pass over the ledger that
 * yields both sides at every depth the page can show: primary category ("group"), the category a row is
 * actually tagged with, and the merchant.
 *
 * Every figure goes through the same classifier and the same scaling as kpi.ts's income/expense totals
 * (classifyTransaction + scaledEconomicAmount), so a group here always equals the matching row of
 * primaryCategoryTotals / primaryCategoryIncomeTotals and the page can never disagree with the
 * dashboard. Transfers, trades and debt principal fall out for the same reason they do there.
 */

export const UNCATEGORIZED_ID = "uncategorized";
const UNCATEGORIZED_COLOR = "#9ca3af";

export interface FlowItem {
	id: string;
	name: string;
	color: string;
	icon: string;
	/** Base currency, positive. An expense line can go negative when refunds outweigh spend in the period. */
	amount: number;
}

export interface FlowGroup extends FlowItem {
	/** The categories rows were tagged with. A row tagged with the primary itself shows up as the
	 *  primary's own line, named after it — the same way the drill-down modal lists it. */
	categories: FlowItem[];
	merchants: FlowItem[];
}

export interface CashFlowSide {
	total: number;
	groups: FlowGroup[];
	/** Every category across every group, largest first — what the "Category" switch lists. */
	categories: FlowItem[];
	merchants: FlowItem[];
}

export interface CashFlow {
	income: CashFlowSide;
	expenses: CashFlowSide;
	/** Income minus expenses: positive is what was kept, negative is what the period ran short. */
	net: number;
}

interface GroupAcc {
	item: FlowItem;
	categories: Map<string, FlowItem>;
	merchants: Map<string, FlowItem>;
}

function bump(map: Map<string, FlowItem>, id: string, make: () => Omit<FlowItem, "amount">, amount: number): void {
	const hit = map.get(id);
	if (hit) hit.amount += amount;
	else map.set(id, { ...make(), amount });
}

/** Largest first, and nothing that nets to zero — a category that was spent in and fully refunded
 *  has nothing to say about where the money went. */
function ranked(items: Iterable<FlowItem>): FlowItem[] {
	return Array.from(items)
		.filter((item) => Math.abs(item.amount) >= 0.005)
		.sort((a, b) => b.amount - a.amount);
}

export function buildCashFlow(store: KpiStore, range?: DateRange): CashFlow {
	const sides = { income: new Map<string, GroupAcc>(), expenses: new Map<string, GroupAcc>() };

	for (const tx of store.transactions) {
		if (range && !inRange(tx.date, range)) continue;
		const classified = classifyTransaction(store, tx);
		const chain = categoryChain(store.categories, tx.categoryId);
		const primary = chain.primary;
		const leaf = chain.secondary ?? chain.primary;
		const groupId = primary?.id ?? UNCATEGORIZED_ID;

		const record = (side: Map<string, GroupAcc>, amount: number) => {
			let group = side.get(groupId);
			if (!group) {
				group = {
					item: {
						id: groupId,
						name: primary?.name ?? "Uncategorized",
						color: primary?.color ?? UNCATEGORIZED_COLOR,
						icon: primary?.icon ?? "help-circle",
						amount: 0,
					},
					categories: new Map(),
					merchants: new Map(),
				};
				side.set(groupId, group);
			}
			group.item.amount += amount;
			bump(
				group.categories,
				leaf?.id ?? UNCATEGORIZED_ID,
				() => ({
					id: leaf?.id ?? UNCATEGORIZED_ID,
					name: leaf?.name ?? "Uncategorized",
					color: leaf?.color ?? group!.item.color,
					icon: leaf?.icon ?? group!.item.icon,
				}),
				amount
			);
			// Rows with no recognizable merchant are pooled rather than each becoming a line of their own.
			const key = merchantKey(tx) ?? "";
			bump(
				group.merchants,
				key,
				() => ({
					id: `merchant:${key}`,
					name: (key && merchantDisplayName(merchantSourceText(tx))) || "Unknown merchant",
					color: group!.item.color,
					icon: "store",
				}),
				amount
			);
		};

		if (classified.affectsIncome !== 0) record(sides.income, scaledEconomicAmount(tx, classified.affectsIncome, amountIn(store, tx)));
		if (classified.affectsExpense !== 0) record(sides.expenses, scaledEconomicAmount(tx, classified.affectsExpense, amountIn(store, tx)));
	}

	const finish = (side: Map<string, GroupAcc>): CashFlowSide => {
		const groups: FlowGroup[] = ranked(Array.from(side.values(), (g) => g.item)).map((item) => {
			const acc = side.get(item.id)!;
			return { ...item, categories: ranked(acc.categories.values()), merchants: ranked(acc.merchants.values()) };
		});
		const merchants = new Map<string, FlowItem>();
		for (const group of groups) {
			for (const m of group.merchants) bump(merchants, m.id, () => ({ ...m }), m.amount);
		}
		return {
			total: groups.reduce((sum, g) => sum + g.amount, 0),
			groups,
			categories: ranked(groups.flatMap((g) => g.categories)),
			merchants: ranked(merchants.values()),
		};
	};

	const income = finish(sides.income);
	const expenses = finish(sides.expenses);
	return { income, expenses, net: income.total - expenses.total };
}

// ─── Sankey layout ─────────────────────────────────────────────────────────────────────────────

export type SankeyDetail = "groups" | "categories" | "both";

export interface SankeyNode {
	id: string;
	label: string;
	value: number;
	color: string;
	column: number;
	x: number;
	y: number;
	height: number;
	/** Which side of the bar its label sits on. */
	labelSide: "left" | "right";
	/** Share of the period's income, for the label — undefined on the income node itself. */
	share?: number;
}

export interface SankeyLink {
	source: string;
	target: string;
	value: number;
	color: string;
	/** A filled ribbon, ready for an SVG <path d>. */
	path: string;
}

export interface SankeyLayout {
	width: number;
	height: number;
	nodes: SankeyNode[];
	links: SankeyLink[];
}

export interface SankeyOptions {
	width?: number;
	nodeWidth?: number;
	/** Vertical room a node needs for its two-line label, even when its bar is a hairline. */
	labelHeight?: number;
	/** How many pixels the biggest column's flow gets — the rest of the height is gaps and labels. */
	flowHeight?: number;
	incomeColor?: string;
	savingsColor?: string;
	shortfallColor?: string;
}

interface ColumnEntry {
	id: string;
	label: string;
	value: number;
	color: string;
}

/**
 * Lays out the flow as columns of bars joined by ribbons: income sources → one "Income" bar →
 * savings and each expense group (→ each group's categories, in "both").
 *
 * Every column uses the same pixels-per-euro, so a ribbon is exactly as thick at both ends. Bars only
 * get spread apart when their labels would otherwise collide, which is why the height is an output
 * rather than an input: a year with fifteen small categories needs a taller chart than one with four.
 *
 * Only positive amounts can be drawn. A line that refunds pushed below zero stays in the tables, but
 * a ribbon can't have negative thickness, so it's left out here.
 */
export function layoutSankey(flow: CashFlow, detail: SankeyDetail, opts: SankeyOptions = {}): SankeyLayout {
	const width = opts.width ?? 900;
	const nodeWidth = opts.nodeWidth ?? 10;
	const labelHeight = opts.labelHeight ?? 30;
	const flowHeight = opts.flowHeight ?? 360;
	const incomeColor = opts.incomeColor ?? "#1baf7a";
	const savingsColor = opts.savingsColor ?? "#1baf7a";
	const shortfallColor = opts.shortfallColor ?? "#e34948";
	const pad = 8;
	// Room above the columns for the hub's label, which can't sit beside its bar: ribbons cover both sides.
	const top = 40;

	const positive = <T extends FlowItem>(items: T[]) => items.filter((i) => i.amount > 0);
	const incomeItems = positive(detail === "categories" ? flow.income.categories : flow.income.groups);
	// In "both", a group's bar is the sum of the categories drawn off it, so it always fills exactly.
	const expenseGroups = flow.expenses.groups
		.map((g) => ({ ...g, amount: positive(g.categories).reduce((sum, c) => sum + c.amount, 0) }))
		.filter((g) => g.amount > 0);
	const expenseItems = detail === "categories" ? positive(flow.expenses.categories) : detail === "both" ? expenseGroups : positive(flow.expenses.groups);
	// Expense lines that refunds pushed below zero (a tax refund, a settlement) are money that came in,
	// so they're drawn as sources beside income rather than dropped — dropping them would make the
	// savings ribbon disagree with the net figure by exactly their total. Taken at the finest level
	// drawn, so in "both" a refunded category under an otherwise positive group shows up too.
	const refundItems = (detail === "groups" ? flow.expenses.groups : flow.expenses.categories).filter((i) => i.amount < 0);

	const inTotal = incomeItems.reduce((s, i) => s + i.amount, 0) - refundItems.reduce((s, i) => s + i.amount, 0);
	const outTotal = expenseItems.reduce((s, i) => s + i.amount, 0);
	const incomeTotal = flow.income.total;

	const saved = inTotal - outTotal;
	const hub = Math.max(inTotal, outTotal);
	if (hub <= 0) return { width, height: 0, nodes: [], links: [] };

	const col0: ColumnEntry[] = incomeItems.map((i) => ({ id: `in:${i.id}`, label: i.name, value: i.amount, color: i.color }));
	for (const r of refundItems) col0.push({ id: `refund:${r.id}`, label: `${r.name} (refunded)`, value: -r.amount, color: r.color });
	// Spending more than came in means the difference was drawn from somewhere — shown as its own
	// source so the hub still balances and the shortfall is impossible to miss.
	if (saved < 0) col0.push({ id: "shortfall", label: "From savings", value: -saved, color: shortfallColor });
	// Only called "Income" when that's all it is — refunds or a shortfall make it more than income.
	const hubLabel = refundItems.length === 0 && saved >= 0 ? "Income" : "Money in";
	const col1: ColumnEntry[] = [{ id: "hub", label: hubLabel, value: hub, color: incomeColor }];
	const col2: ColumnEntry[] = [];
	if (saved > 0) col2.push({ id: "savings", label: "Savings", value: saved, color: savingsColor });
	for (const e of expenseItems) col2.push({ id: `out:${e.id}`, label: e.name, value: e.amount, color: e.color });
	const col3: ColumnEntry[] = [];
	if (detail === "both") {
		for (const g of expenseGroups) {
			for (const c of positive(g.categories)) col3.push({ id: `leaf:${g.id}:${c.id}`, label: c.name, value: c.amount, color: g.color });
		}
	}

	const columns = detail === "both" ? [col0, col1, col2, col3] : [col0, col1, col2];
	const scale = flowHeight / hub;
	// The left labels carry "(refunded)" suffixes, so they get more room than the right ones.
	const firstX = 200;
	const lastX = width - 195 - nodeWidth;
	const columnX = (c: number) => firstX + ((lastX - firstX) * c) / (columns.length - 1);

	const nodes: SankeyNode[] = [];
	let height = 0;
	columns.forEach((column, c) => {
		let y = top;
		for (const entry of column) {
			const h = Math.max(entry.value * scale, 1);
			nodes.push({
				id: entry.id,
				label: entry.label,
				value: entry.value,
				color: entry.color,
				column: c,
				x: columnX(c),
				y,
				height: h,
				labelSide: c === 0 ? "left" : "right",
				share: entry.id === "hub" || incomeTotal <= 0 ? undefined : entry.value / incomeTotal,
			});
			y += Math.max(h, labelHeight) + 6;
		}
		height = Math.max(height, y + pad);
	});
	const byId = new Map(nodes.map((n) => [n.id, n]));

	const links: SankeyLink[] = [];
	const outOffset = new Map<string, number>();
	const inOffset = new Map<string, number>();
	const link = (sourceId: string, targetId: string, value: number, color: string) => {
		const s = byId.get(sourceId);
		const t = byId.get(targetId);
		if (!s || !t || value <= 0) return;
		const thickness = value * scale;
		const sy = s.y + (outOffset.get(sourceId) ?? 0);
		const ty = t.y + (inOffset.get(targetId) ?? 0);
		outOffset.set(sourceId, (outOffset.get(sourceId) ?? 0) + thickness);
		inOffset.set(targetId, (inOffset.get(targetId) ?? 0) + thickness);
		const x0 = s.x + nodeWidth;
		const x1 = t.x;
		const mid = (x0 + x1) / 2;
		const r = (n: number) => Math.round(n * 100) / 100;
		const path =
			`M${r(x0)},${r(sy)} C${r(mid)},${r(sy)} ${r(mid)},${r(ty)} ${r(x1)},${r(ty)} ` +
			`L${r(x1)},${r(ty + thickness)} C${r(mid)},${r(ty + thickness)} ${r(mid)},${r(sy + thickness)} ${r(x0)},${r(sy + thickness)} Z`;
		links.push({ source: sourceId, target: targetId, value, color, path });
	};

	for (const entry of col0) link(entry.id, "hub", entry.value, entry.color);
	for (const entry of col2) link("hub", entry.id, entry.value, entry.color);
	if (detail === "both") {
		for (const g of expenseGroups) {
			for (const c of positive(g.categories)) link(`out:${g.id}`, `leaf:${g.id}:${c.id}`, c.amount, g.color);
		}
	}

	return { width, height, nodes, links };
}
