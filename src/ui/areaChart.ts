import { formatMoneyRounded } from "../money";

/**
 * A line-over-time chart without the per-point dots lineChart draws — for series with a point a day,
 * where dots turn the line into a bead string. One series gets a soft fill under it; several are
 * drawn as plain lines. `step` draws a balance the way it actually moves (flat, then a jump on the
 * day something posts) instead of sloping between days as if money trickled.
 *
 * Wrapped in `fp-chart-money` so privacy mode blurs its labels and tooltip like every other chart.
 */

export interface AreaSeries {
	label: string;
	color: string;
	values: number[];
}

export interface AreaMarker {
	index: number;
	value: number;
	label: string;
	tone?: "good" | "bad";
}

export interface AreaChartOptions {
	/** One per value: what the x axis and the tooltip call each point. */
	labels: string[];
	height?: number;
	step?: boolean;
	/** Index of "today", drawn as a dashed line. */
	todayIndex?: number;
	markers?: AreaMarker[];
	/** Roughly how many x labels to print. */
	xTicks?: number;
	formatValue?: (n: number) => string;
	formatTooltip?: (n: number) => string;
}

const NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
	const node = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
	parent.appendChild(node);
	return node;
}

function niceStep(span: number, count: number): number {
	const raw = span / count;
	const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
	const norm = raw / mag;
	return (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
}

export function areaChart(container: HTMLElement, series: AreaSeries[], opts: AreaChartOptions): void {
	const wrap = container.createDiv({ cls: "fp-chart fp-chart-money fp-area-chart" });
	const n = opts.labels.length;
	if (n === 0 || series.length === 0) return;

	const width = Math.max(container.clientWidth || 640, 320);
	const height = opts.height ?? 260;
	const padLeft = 64;
	const padRight = 16;
	const padTop = 14;
	const padBottom = 26;
	const plotW = width - padLeft - padRight;
	const plotH = height - padTop - padBottom;
	const fmt = opts.formatValue ?? ((v: number) => formatMoneyRounded(v));
	const fmtTip = opts.formatTooltip ?? fmt;

	const all = series.flatMap((s) => s.values).concat((opts.markers ?? []).map((m) => m.value));
	let lo = Math.min(...all);
	let hi = Math.max(...all);
	if (lo === hi) {
		lo -= Math.abs(lo) * 0.05 || 1;
		hi += Math.abs(hi) * 0.05 || 1;
	}
	const stepY = niceStep(hi - lo, 4);
	lo = Math.floor(lo / stepY) * stepY;
	hi = Math.ceil(hi / stepY) * stepY;
	const x = (i: number) => padLeft + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
	const y = (v: number) => padTop + plotH - ((v - lo) / (hi - lo || 1)) * plotH;

	const svg = el(wrap, "svg", { viewBox: `0 0 ${width} ${height}`, class: "fp-area-svg" });
	svg.style.width = "100%";
	svg.style.height = `${height}px`;

	for (let v = lo; v <= hi + stepY / 2; v += stepY) {
		el(svg, "line", { x1: padLeft, x2: width - padRight, y1: y(v), y2: y(v), class: Math.abs(v) < stepY / 2 ? "fp-chart-baseline" : "fp-chart-grid" });
		el(svg, "text", { x: padLeft - 8, y: y(v), "text-anchor": "end", "dominant-baseline": "middle", class: "fp-chart-axis-label" }).textContent = fmt(v);
	}
	const every = Math.max(1, Math.round(n / (opts.xTicks ?? 8)));
	for (let i = 0; i < n; i += every) {
		el(svg, "text", { x: x(i), y: height - 6, "text-anchor": "middle", class: "fp-chart-axis-label" }).textContent = opts.labels[i];
	}

	const pathFor = (values: number[]): string => {
		let d = `M${x(0)},${y(values[0])}`;
		for (let i = 1; i < values.length; i++) {
			if (opts.step) d += ` H${x(i)} V${y(values[i])}`;
			else d += ` L${x(i)},${y(values[i])}`;
		}
		return d;
	};

	series.forEach((s, si) => {
		if (series.length === 1) {
			const gradId = `fp-area-grad-${Math.random().toString(36).slice(2, 8)}`;
			const defs = el(svg, "defs", {});
			const grad = el(defs, "linearGradient", { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 });
			el(grad, "stop", { offset: "0%", "stop-color": s.color, "stop-opacity": 0.28 });
			el(grad, "stop", { offset: "100%", "stop-color": s.color, "stop-opacity": 0 });
			el(svg, "path", { d: `${pathFor(s.values)} V${padTop + plotH} H${x(0)} Z`, fill: `url(#${gradId})`, stroke: "none" });
		}
		const line = el(svg, "path", { d: pathFor(s.values), class: "fp-area-line" });
		line.style.stroke = s.color;
		line.dataset.series = String(si);
	});

	if (opts.todayIndex !== undefined && opts.todayIndex >= 0 && opts.todayIndex < n) {
		const tx = x(opts.todayIndex);
		el(svg, "line", { x1: tx, x2: tx, y1: padTop, y2: padTop + plotH, class: "fp-area-today" });
		el(svg, "text", { x: tx, y: padTop - 2, "text-anchor": "middle", class: "fp-area-today-label" }).textContent = "today";
	}

	for (const m of opts.markers ?? []) {
		const mx = x(m.index);
		const my = y(m.value);
		el(svg, "line", { x1: mx, x2: mx, y1: my, y2: padTop + plotH, class: `fp-area-marker-stem is-${m.tone ?? "good"}` });
		el(svg, "circle", { cx: mx, cy: my, r: 4, class: `fp-area-marker is-${m.tone ?? "good"}` });
		const label = el(svg, "text", { x: mx + 10, y: my + 4, class: `fp-area-marker-label is-${m.tone ?? "good"}` });
		label.textContent = m.label;
	}

	// Hover: a crosshair and every series' value at the nearest point.
	const cross = el(svg, "line", { x1: 0, x2: 0, y1: padTop, y2: padTop + plotH, class: "fp-area-cross" });
	cross.style.display = "none";
	const tip = wrap.createDiv({ cls: "fp-chart-tooltip fp-area-tip" });
	tip.style.display = "none";
	svg.addEventListener("mousemove", (ev: MouseEvent) => {
		const rect = svg.getBoundingClientRect();
		const px = ((ev.clientX - rect.left) / rect.width) * width;
		const i = Math.max(0, Math.min(n - 1, Math.round(((px - padLeft) / plotW) * (n - 1))));
		cross.style.display = "";
		cross.setAttribute("x1", String(x(i)));
		cross.setAttribute("x2", String(x(i)));
		tip.empty();
		tip.style.display = "";
		tip.createDiv({ cls: "fp-chart-tooltip-title", text: opts.labels[i] });
		for (const s of series) {
			const row = tip.createDiv({ cls: "fp-chart-tooltip-row" });
			const sw = row.createSpan({ cls: "fp-chart-swatch" });
			sw.style.setProperty("--fp-swatch-color", s.color);
			if (series.length > 1) row.createSpan({ text: s.label });
			row.createSpan({ cls: "fp-chart-tooltip-value", text: fmtTip(s.values[i]) });
		}
		const left = (x(i) / width) * rect.width;
		tip.style.left = `${Math.min(left + 12, rect.width - tip.offsetWidth - 4)}px`;
		tip.style.top = "8px";
	});
	svg.addEventListener("mouseleave", () => {
		cross.style.display = "none";
		tip.style.display = "none";
	});
}
