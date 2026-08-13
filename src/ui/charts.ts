import { icon } from "./dom";
import { formatMoneyRounded } from "../money";

export interface ChartSeries {
	label: string;
	color: string;
	values: number[];
}

function formatCompact(n: number): string {
	const abs = Math.abs(n);
	if (abs >= 1000) return `${n < 0 ? "-" : ""}${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
	return String(Math.round(n));
}

function niceTicks(min: number, max: number, count = 4): number[] {
	if (min === max) return [min];
	const span = max - min;
	const rawStep = span / count;
	const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
	const norm = rawStep / mag;
	const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
	const start = Math.ceil(min / step) * step;
	const ticks: number[] = [];
	for (let v = start; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
	return ticks;
}

/**
 * Renders a multi-series SVG line chart: hairline gridlines, ring-marked data points,
 * a legend that doubles as a (de)select toggle per series, an end-of-line label for the
 * last point of each series, and a hover crosshair + tooltip. Colors come from the
 * categorical palette via CSS variables so light/dark stay in sync with Obsidian's theme.
 */
export function lineChart(
	container: HTMLElement,
	categories: string[],
	series: ChartSeries[],
	opts?: { height?: number; width?: number; formatValue?: (n: number) => string; money?: boolean }
): void {
	const height = opts?.height ?? 220;
	const money = opts?.money !== false;
	const width = opts?.width ?? 640;
	const padLeft = 52;
	const padRight = 16;
	const padTop = 16;
	const padBottom = 28;
	const plotW = width - padLeft - padRight;
	const plotH = height - padTop - padBottom;
	const formatValue = opts?.formatValue ?? ((n) => formatMoneyRounded(n));
	const formatLabel = opts?.formatValue ?? formatCompact;

	const allValues = series.flatMap((s) => s.values);
	const dataMin = Math.min(0, ...allValues);
	const dataMax = Math.max(0, ...allValues);
	const ticks = niceTicks(dataMin, dataMax, 4);
	const scaleMin = Math.min(dataMin, ticks[0] ?? dataMin);
	const scaleMax = Math.max(dataMax, ticks[ticks.length - 1] ?? dataMax);
	const scaleY = (v: number) => padTop + plotH - ((v - scaleMin) / (scaleMax - scaleMin || 1)) * plotH;
	const scaleX = (i: number) => padLeft + (categories.length <= 1 ? plotW / 2 : (i / (categories.length - 1)) * plotW);

	const wrap = container.createDiv({ cls: "fp-chart" + (money ? " fp-chart-money" : "") });

	// One entry per series, toggled by clicking (or Enter/Space on) its legend item. The
	// mark elements themselves are created further down; these arrays are filled in as
	// they're built and read back here once the toggle actually fires (always after the
	// whole chart has finished its synchronous render, so the arrays are never read empty).
	const visible = series.map(() => true);
	const lineEls: SVGPolylineElement[] = [];
	const dotEls: SVGCircleElement[][] = [];
	const endLabelEls: (SVGTextElement | undefined)[] = [];

	const legend = wrap.createDiv({ cls: "fp-chart-legend" });
	series.forEach((s, i) => {
		const item = legend.createDiv({ cls: "fp-chart-legend-item" });
		item.setAttribute("role", "button");
		item.setAttribute("tabindex", "0");
		item.setAttribute("aria-pressed", "true");
		const swatch = item.createSpan({ cls: "fp-chart-swatch" });
		swatch.style.setProperty("--fp-swatch-color", s.color);
		item.createSpan({ text: s.label });

		const toggle = () => {
			visible[i] = !visible[i];
			item.toggleClass("is-off", !visible[i]);
			item.setAttribute("aria-pressed", String(visible[i]));
			const display = visible[i] ? "" : "none";
			lineEls[i].style.display = display;
			dotEls[i].forEach((dot) => (dot.style.display = display));
			if (endLabelEls[i]) endLabelEls[i]!.style.display = display;
		};
		item.addEventListener("click", toggle);
		item.addEventListener("keydown", (ev: KeyboardEvent) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				toggle();
			}
		});
	});

	const svgWrap = wrap.createDiv({ cls: "fp-chart-svg-wrap" });
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
	svg.setAttribute("class", "fp-chart-svg");
	svgWrap.appendChild(svg);

	const NS = "http://www.w3.org/2000/svg";

	// Gridlines + y-axis labels
	for (const t of ticks) {
		const y = scaleY(t);
		const line = document.createElementNS(NS, "line");
		line.setAttribute("x1", String(padLeft));
		line.setAttribute("x2", String(width - padRight));
		line.setAttribute("y1", String(y));
		line.setAttribute("y2", String(y));
		line.setAttribute("class", t === 0 ? "fp-chart-baseline" : "fp-chart-grid");
		line.setAttribute("vector-effect", "non-scaling-stroke");
		svg.appendChild(line);

		const label = document.createElementNS(NS, "text");
		label.setAttribute("x", String(padLeft - 8));
		label.setAttribute("y", String(y));
		label.setAttribute("class", "fp-chart-axis-label");
		label.setAttribute("text-anchor", "end");
		label.setAttribute("dominant-baseline", "middle");
		label.textContent = formatLabel(t);
		svg.appendChild(label);
	}

	// x-axis labels
	categories.forEach((cat, i) => {
		const label = document.createElementNS(NS, "text");
		label.setAttribute("x", String(scaleX(i)));
		label.setAttribute("y", String(height - padBottom + 18));
		label.setAttribute("class", "fp-chart-axis-label");
		label.setAttribute("text-anchor", "middle");
		label.textContent = cat;
		svg.appendChild(label);
	});

	// Lines + markers
	series.forEach((s) => {
		const points = s.values.map((v, i) => `${scaleX(i)},${scaleY(v)}`).join(" ");
		const polyline = document.createElementNS(NS, "polyline");
		polyline.setAttribute("points", points);
		polyline.setAttribute("class", "fp-chart-line");
		polyline.setAttribute("vector-effect", "non-scaling-stroke");
		polyline.style.setProperty("--fp-line-color", s.color);
		svg.appendChild(polyline);
		lineEls.push(polyline);

		const dots: SVGCircleElement[] = [];
		s.values.forEach((v, i) => {
			const dot = document.createElementNS(NS, "circle");
			dot.setAttribute("cx", String(scaleX(i)));
			dot.setAttribute("cy", String(scaleY(v)));
			dot.setAttribute("r", "4");
			dot.setAttribute("class", "fp-chart-dot");
			dot.setAttribute("vector-effect", "non-scaling-stroke");
			dot.style.setProperty("--fp-line-color", s.color);
			svg.appendChild(dot);
			dots.push(dot);
		});
		dotEls.push(dots);
	});

	// End-of-line labels — series whose last value lands within a text-height of each other would
	// otherwise render on top of one another (e.g. two rate lines both hovering near 0%), so labels
	// are collision-resolved (sorted top-to-bottom, pushed apart to a minimum gap) before drawing.
	const lastIdx = categories.length - 1;
	if (lastIdx >= 0) {
		const MIN_GAP = 14;
		const endLabels = series
			.map((s, i) => ({ i, y: scaleY(s.values[lastIdx]), text: formatLabel(s.values[lastIdx]) }))
			.sort((a, b) => a.y - b.y);
		for (let i = 1; i < endLabels.length; i++) {
			const min = endLabels[i - 1].y + MIN_GAP;
			if (endLabels[i].y < min) endLabels[i].y = min;
		}
		endLabels.forEach(({ i, y, text }) => {
			const endLabel = document.createElementNS(NS, "text");
			endLabel.setAttribute("x", String(scaleX(lastIdx) + 6));
			endLabel.setAttribute("y", String(y));
			endLabel.setAttribute("class", "fp-chart-end-label");
			endLabel.setAttribute("dominant-baseline", "middle");
			endLabel.textContent = text;
			svg.appendChild(endLabel);
			endLabelEls[i] = endLabel;
		});
	}

	// Hover crosshair + tooltip
	const crosshair = document.createElementNS(NS, "line");
	crosshair.setAttribute("y1", String(padTop));
	crosshair.setAttribute("y2", String(padTop + plotH));
	crosshair.setAttribute("class", "fp-chart-crosshair");
	crosshair.setAttribute("vector-effect", "non-scaling-stroke");
	crosshair.style.display = "none";
	svg.appendChild(crosshair);

	const tooltip = svgWrap.createDiv({ cls: "fp-chart-tooltip" });
	tooltip.style.display = "none";

	const hitRect = document.createElementNS(NS, "rect");
	hitRect.setAttribute("x", String(padLeft));
	hitRect.setAttribute("y", String(padTop));
	hitRect.setAttribute("width", String(plotW));
	hitRect.setAttribute("height", String(plotH));
	hitRect.setAttribute("class", "fp-chart-hit");
	svg.appendChild(hitRect);

	hitRect.addEventListener("mousemove", (ev: MouseEvent) => {
		const rect = svg.getBoundingClientRect();
		const scale = width / rect.width;
		const localX = (ev.clientX - rect.left) * scale;
		const idx = Math.round(((localX - padLeft) / plotW) * (categories.length - 1));
		const clamped = Math.max(0, Math.min(categories.length - 1, idx));

		crosshair.style.display = "";
		crosshair.setAttribute("x1", String(scaleX(clamped)));
		crosshair.setAttribute("x2", String(scaleX(clamped)));

		tooltip.style.display = "";
		tooltip.empty();
		tooltip.createDiv({ cls: "fp-chart-tooltip-title", text: categories[clamped] });
		series.forEach((s, i) => {
			if (!visible[i]) return;
			const row = tooltip.createDiv({ cls: "fp-chart-tooltip-row" });
			const swatch = row.createSpan({ cls: "fp-chart-swatch" });
			swatch.style.setProperty("--fp-swatch-color", s.color);
			row.createSpan({ text: s.label });
			row.createSpan({ cls: "fp-chart-tooltip-value", text: formatValue(s.values[clamped]) });
		});

		const leftPct = (scaleX(clamped) / width) * 100;
		tooltip.style.left = `${leftPct}%`;
		tooltip.style.transform = leftPct > 60 ? "translateX(-100%)" : "translateX(0)";
	});
	hitRect.addEventListener("mouseleave", () => {
		crosshair.style.display = "none";
		tooltip.style.display = "none";
	});
}

/**
 * A tiny trend-only line (stat-tile contract): the history rides in the de-emphasis
 * ink, only the current/last point picks up the series' accent color. No axes, no
 * tooltip — it's a glance, not a chart the reader interrogates on its own.
 */
export function sparkline(container: HTMLElement, values: number[], accentColor: string, opts?: { height?: number; width?: number }): void {
	if (values.length === 0) return;
	const height = opts?.height ?? 32;
	const width = opts?.width ?? 96;
	const pad = 3;
	const min = Math.min(...values, 0);
	const max = Math.max(...values, 0);
	const span = max - min || 1;
	const scaleY = (v: number) => pad + (height - pad * 2) * (1 - (v - min) / span);
	const scaleX = (i: number) => (values.length <= 1 ? width / 2 : pad + (i / (values.length - 1)) * (width - pad * 2));

	const NS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
	svg.setAttribute("class", "fp-sparkline");
	container.appendChild(svg);

	const polyline = document.createElementNS(NS, "polyline");
	polyline.setAttribute("points", values.map((v, i) => `${scaleX(i)},${scaleY(v)}`).join(" "));
	polyline.setAttribute("class", "fp-sparkline-line");
	svg.appendChild(polyline);

	const lastIdx = values.length - 1;
	const dot = document.createElementNS(NS, "circle");
	dot.setAttribute("cx", String(scaleX(lastIdx)));
	dot.setAttribute("cy", String(scaleY(values[lastIdx])));
	dot.setAttribute("r", "2.5");
	dot.setAttribute("class", "fp-sparkline-dot");
	dot.style.setProperty("--fp-line-color", accentColor);
	svg.appendChild(dot);
}

/**
 * Part-to-whole as a single horizontal bar (categorical color per segment, a 2px
 * surface gap between them) plus a legend with the value and share — the
 * skill-recommended form for part-to-whole instead of a pie/donut.
 */
export function stackedShareBar(
	container: HTMLElement,
	segments: { label: string; value: number; color: string }[],
	opts?: { formatValue?: (n: number) => string }
): void {
	const formatValue = opts?.formatValue ?? ((n: number) => String(n));
	const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);

	const wrap = container.createDiv({ cls: "fp-share-bar-wrap" });
	const bar = wrap.createDiv({ cls: "fp-share-bar" });
	segments.forEach((s) => {
		const pct = total > 0 ? Math.max(0, s.value) / total : 0;
		if (pct <= 0) return;
		const seg = bar.createDiv({ cls: "fp-share-bar-seg" });
		seg.style.width = `${pct * 100}%`;
		seg.style.setProperty("--fp-seg-color", s.color);
	});

	const legend = wrap.createDiv({ cls: "fp-share-bar-legend" });
	segments.forEach((s) => {
		const pct = total > 0 ? (Math.max(0, s.value) / total) * 100 : 0;
		const item = legend.createDiv({ cls: "fp-share-bar-legend-item" });
		const swatch = item.createSpan({ cls: "fp-chart-swatch" });
		swatch.style.setProperty("--fp-swatch-color", s.color);
		item.createSpan({ cls: "fp-share-bar-legend-label", text: s.label });
		item.createSpan({ cls: "fp-share-bar-legend-value fp-money", text: `${formatValue(s.value)} · ${pct.toFixed(0)}%` });
	});
}

/** Horizontal bar chart for category totals — each bar keeps that category's own color. */
export function barChart(
	container: HTMLElement,
	rows: { label: string; value: number; color: string; iconName?: string }[]
): void {
	const wrap = container.createDiv({ cls: "fp-barchart" });
	const max = Math.max(...rows.map((r) => r.value), 1);
	rows.forEach((r) => {
		const row = wrap.createDiv({ cls: "fp-barchart-row" });
		const labelEl = row.createDiv({ cls: "fp-barchart-label" });
		if (r.iconName) icon(labelEl, r.iconName, "fp-barchart-icon");
		labelEl.createSpan({ text: r.label });

		const track = row.createDiv({ cls: "fp-barchart-track" });
		const fill = track.createDiv({ cls: "fp-barchart-fill" });
		fill.style.setProperty("--fp-bar-color", r.color);
		fill.style.width = `${Math.max(2, (r.value / max) * 100)}%`;

		row.createDiv({
			cls: "fp-barchart-value fp-money",
			text: formatMoneyRounded(r.value),
		});
	});
}
