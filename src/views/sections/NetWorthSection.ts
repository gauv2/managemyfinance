import { ACCOUNT_TYPE_META } from "../../constants";
import type FinancePlugin from "../../main";
import { formatMoney } from "../../money";
import {
	BUCKET_LABEL,
	BUCKET_ORDER,
	bucketTotals,
	change,
	sampleDates,
	WORTH_RANGES,
	worthHistory,
	type WorthBucket,
	type WorthRange,
} from "../../netWorthHistory";
import { todayIso } from "../../recurring";
import { areaChart, type AreaSeries } from "../../ui/areaChart";
import { icon } from "../../ui/dom";

/**
 * Everything you're worth, how it moved over a window, and what it's made of: a headline total with
 * its change, a bar splitting it into cash / investments / retirement / property against what's owed,
 * the line over time (as one total, per account, or per kind of account), and every account as a card
 * under the kind it belongs to.
 *
 * The numbers all come from netWorthHistory.ts, which only ever calls netWorthAsOf — so this page, the
 * dashboard and each account's own page value an account the same way.
 */

type ChartMode = "total" | "account" | "bucket";

/** Module scope so leaving the page and coming back keeps the window and the chart you had. */
const state = { range: "1m" as WorthRange, chart: "total" as ChartMode };

const BUCKET_COLOR: Record<WorthBucket, string> = {
	cash: "var(--fp-cat-4)",
	investments: "var(--fp-cat-6)",
	retirement: "var(--fp-cat-1)",
	property: "var(--fp-cat-7)",
	credit: "var(--fp-cat-5)",
	loans: "var(--fp-cat-8)",
};

const SERIES_COLORS = Array.from({ length: 10 }, (_, i) => `var(--fp-cat-${i + 1})`);

export function renderNetWorthSection(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;
	const currency = store.fx.baseCurrency;
	const money = (n: number) => formatMoney(n, { currency });
	const compact = (n: number) => {
		const abs = Math.abs(n);
		const sign = n < 0 ? "−" : "";
		if (abs >= 1_000_000) return `${sign}${formatMoney(abs / 1_000_000, { currency, maximumFractionDigits: 1, minimumFractionDigits: 0 })}m`;
		if (abs >= 10_000) return `${sign}${formatMoney(abs / 1000, { currency, maximumFractionDigits: 0, minimumFractionDigits: 0 })}k`;
		return `${sign}${formatMoney(abs, { currency, maximumFractionDigits: 0, minimumFractionDigits: 0 })}`;
	};
	const pct = (p: number | undefined) => (p === undefined ? "" : ` (${p >= 0 ? "+" : ""}${(p * 100).toFixed(1)}%)`);

	function render(): void {
		container.empty();

		const header = container.createDiv({ cls: "fp-section-header" });
		const headText = header.createDiv({ cls: "fp-section-header-text" });
		const titleRow = headText.createDiv({ cls: "fp-section-title-row" });
		icon(titleRow.createDiv({ cls: "fp-section-icon-badge" }), "line-chart");
		titleRow.createEl("h2", { text: "Net worth" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: "Everything you own minus everything you owe, and how it moved. Accounts are valued exactly as on their own pages — recorded balances first, then every transaction since.",
		});

		const today = todayIso();
		const earliest = store.transactions.reduce<string | undefined>((min, t) => (t.date && (!min || t.date < min) ? t.date.slice(0, 10) : min), undefined);
		const history = worthHistory(store, sampleDates(state.range, today, earliest));
		if (history.accounts.length === 0) {
			container.createDiv({ cls: "fp-card" }).createEl("p", { cls: "fp-step-desc", text: "No accounts with a balance to track yet." });
			return;
		}

		renderHero(history);
		renderChart(history);
		renderAccounts(history);
	}

	function renderHero(history: ReturnType<typeof worthHistory>): void {
		const hero = container.createDiv({ cls: "fp-worth-hero" });
		const top = hero.createDiv({ cls: "fp-worth-hero-top" });
		const left = top.createDiv();
		left.createDiv({ cls: "fp-card-head-label", text: "Total" });
		const line = left.createDiv({ cls: "fp-worth-total-line" });
		const total = history.total[history.total.length - 1] ?? 0;
		line.createDiv({ cls: "fp-worth-total fp-money", text: money(total) });
		const delta = change(history.total);
		const pill = line.createDiv({ cls: "fp-worth-delta" + (delta.amount >= 0 ? " is-good" : " is-bad") });
		pill.createSpan({ cls: "fp-money", text: `${delta.amount >= 0 ? "+" : "−"}${money(Math.abs(delta.amount))}${pct(delta.pct)}` });
		pill.createSpan({ cls: "fp-worth-delta-note", text: ` over ${state.range === "all" ? "all time" : state.range}` });

		const ranges = top.createDiv({ cls: "fp-worth-ranges" });
		for (const r of WORTH_RANGES) {
			const btn = ranges.createEl("button", { cls: "fp-worth-range" + (r === state.range ? " is-active" : ""), text: r });
			btn.addEventListener("click", () => {
				if (r === state.range) return;
				state.range = r;
				render();
			});
		}

		// What it's made of: every bucket's share of the gross (owned plus owed), so debt gets a
		// segment of its own instead of being netted away.
		const buckets = bucketTotals(history);
		const gross = buckets.reduce((s, b) => s + Math.abs(b.value), 0);
		if (gross > 0) {
			const bar = hero.createDiv({ cls: "fp-worth-bar" });
			for (const b of buckets) {
				const seg = bar.createDiv({ cls: "fp-worth-bar-seg" });
				seg.style.flexGrow = String(Math.abs(b.value) / gross);
				seg.style.background = BUCKET_COLOR[b.bucket];
				seg.setAttribute("title", BUCKET_LABEL[b.bucket]);
			}
			const legend = hero.createDiv({ cls: "fp-worth-legend" });
			for (const b of buckets) {
				const item = legend.createDiv({ cls: "fp-worth-legend-item" });
				item.createSpan({ cls: "fp-pnl-dot" }).style.background = BUCKET_COLOR[b.bucket];
				item.createSpan({ text: BUCKET_LABEL[b.bucket] });
				item.createSpan({ cls: "fp-worth-legend-value fp-money", text: compact(b.value) });
			}
		}
	}

	function renderChart(history: ReturnType<typeof worthHistory>): void {
		const card = container.createDiv({ cls: "fp-card fp-worth-chart-card" });
		const head = card.createDiv({ cls: "fp-card-head-row" });
		head.createEl("h3", { text: "Over time" });
		const group = head.createDiv({ cls: "fp-segmented" });
		const modes: [ChartMode, string][] = [
			["total", "Total"],
			["account", "By account"],
			["bucket", "By kind"],
		];
		for (const [mode, label] of modes) {
			const btn = group.createEl("button", { cls: "fp-segmented-btn" + (mode === state.chart ? " is-active" : ""), text: label });
			btn.addEventListener("click", () => {
				if (mode === state.chart) return;
				state.chart = mode;
				render();
			});
		}

		let series: AreaSeries[];
		if (state.chart === "total") {
			series = [{ label: "Net worth", color: "var(--fp-cat-3)", values: history.total }];
		} else if (state.chart === "account") {
			series = history.accounts
				.filter((a) => a.values.some((v) => Math.abs(v) >= 0.005))
				.sort((a, b) => Math.abs(b.end) - Math.abs(a.end))
				.map((a, i) => ({ label: a.account.name, color: SERIES_COLORS[i % SERIES_COLORS.length], values: a.values }));
		} else {
			series = BUCKET_ORDER.map((bucket) => {
				const members = history.accounts.filter((a) => a.bucket === bucket);
				return { label: BUCKET_LABEL[bucket], color: BUCKET_COLOR[bucket], values: history.dates.map((_, i) => members.reduce((s, a) => s + a.values[i], 0)) };
			}).filter((s) => s.values.some((v) => Math.abs(v) >= 0.005));
		}

		if (series.length > 1) {
			const legend = card.createDiv({ cls: "fp-chart-legend" });
			for (const s of series) {
				const item = legend.createDiv({ cls: "fp-chart-legend-item" });
				item.createSpan({ cls: "fp-chart-swatch" }).style.setProperty("--fp-swatch-color", s.color);
				item.createSpan({ text: s.label });
			}
		}

		const labelOf = (iso: string) => {
			const d = new Date(`${iso}T00:00:00`);
			return state.range === "all" || state.range === "1y"
				? d.toLocaleDateString(undefined, { month: "short", year: "2-digit" })
				: d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
		};
		areaChart(card, series, {
			labels: history.dates.map(labelOf),
			height: 300,
			formatValue: compact,
			formatTooltip: money,
		});
	}

	function renderAccounts(history: ReturnType<typeof worthHistory>): void {
		const grid = container.createDiv({ cls: "fp-worth-groups" });
		for (const bucket of BUCKET_ORDER) {
			// A closed account with nothing left in it is history, not part of what you're worth.
			const members = history.accounts
				.filter((a) => a.bucket === bucket && !(a.account.archived && Math.abs(a.end) < 0.005))
				.sort((a, b) => Math.abs(b.end) - Math.abs(a.end));
			if (members.length === 0) continue;
			const group = grid.createDiv({ cls: "fp-worth-group" });
			group.createDiv({ cls: "fp-card-head-label fp-worth-group-label", text: BUCKET_LABEL[bucket] });
			for (const a of members) {
				const row = group.createDiv({ cls: "fp-worth-account" });
				row.setAttribute("role", "button");
				row.setAttribute("tabindex", "0");
				row.addEventListener("click", () => void plugin.openAccount(a.account.id));
				row.addEventListener("keydown", (ev: KeyboardEvent) => {
					if (ev.key === "Enter") void plugin.openAccount(a.account.id);
				});
				const avatar = row.createDiv({ cls: "fp-worth-avatar" });
				avatar.style.background = BUCKET_COLOR[bucket];
				avatar.setText((a.account.institution || a.account.name).trim().charAt(0).toUpperCase() || "?");
				const text = row.createDiv({ cls: "fp-worth-account-text" });
				text.createDiv({ cls: "fp-worth-account-name", text: a.account.name });
				text.createDiv({
					cls: "fp-worth-account-sub",
					text: [a.account.institution, ACCOUNT_TYPE_META[a.account.type]?.label, a.account.archived ? "Closed" : undefined].filter(Boolean).join(" · "),
				});
				const nums = row.createDiv({ cls: "fp-worth-account-nums" });
				nums.createDiv({ cls: "fp-worth-account-value fp-money", text: money(a.end) });
				const d = change(a.values);
				nums.createDiv({
					cls: "fp-worth-account-delta fp-money" + (d.amount > 0.005 ? " is-good" : d.amount < -0.005 ? " is-bad" : ""),
					text: `${d.amount >= 0 ? "+" : "−"}${money(Math.abs(d.amount))}${pct(d.pct)}`,
				});
			}
		}
	}

	render();
}
