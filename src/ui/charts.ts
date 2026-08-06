import { icon } from "./dom";

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
 * an always-on legend, an end-of-line label for the last point of each series, and a
 * hover crosshair + tooltip. Colors come from the categorical palette via CSS variables
 * so light/dark stay in sync with Obsidian's theme.
 */
export function lineChart(
	container: HTMLElement,
	categories: string[],
	series: ChartSeries[],
	opts?: { height?: number; formatValue?: (n: number) => string }
): void {
	const height = opts?.height ?? 220;
	const width = 640;
	const padLeft = 52;
	const padRight = 16;
	const padTop = 16;
	const padBottom = 28;
	const plotW = width - padLeft - padRight;
	const plotH = height - padTop - padBottom;
	const formatValue = opts?.formatValue ?? ((n) => new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n));

	const allValues = series.flatMap((s) => s.values);
	const dataMin = Math.min(0, ...allValues);
	const dataMax = Math.max(0, ...allValues);
	const ticks = niceTicks(dataMin, dataMax, 4);
	const scaleMin = Math.min(dataMin, ticks[0] ?? dataMin);
	const scaleMax = Math.max(dataMax, ticks[ticks.length - 1] ?? dataMax);
	const scaleY = (v: number) => padTop + plotH - ((v - scaleMin) / (scaleMax - scaleMin || 1)) * plotH;
	const scaleX = (i: number) => padLeft + (categories.length <= 1 ? plotW / 2 : (i / (categories.length - 1)) * plotW);

	const wrap = container.createDiv({ cls: "fp-chart" });

	const legend = wrap.createDiv({ cls: "fp-chart-legend" });
	series.forEach((s) => {
		const item = legend.createDiv({ cls: "fp-chart-legend-item" });
		const swatch = item.createSpan({ cls: "fp-chart-swatch" });
		swatch.style.setProperty("--fp-swatch-color", s.color);
		item.createSpan({ text: s.label });
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
		svg.appendChild(line);

		const label = document.createElementNS(NS, "text");
		label.setAttribute("x", String(padLeft - 8));
		label.setAttribute("y", String(y));
		label.setAttribute("class", "fp-chart-axis-label");
		label.setAttribute("text-anchor", "end");
		label.setAttribute("dominant-baseline", "middle");
		label.textContent = formatCompact(t);
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

	// Lines + markers + end labels
	series.forEach((s) => {
		const points = s.values.map((v, i) => `${scaleX(i)},${scaleY(v)}`).join(" ");
		const polyline = document.createElementNS(NS, "polyline");
		polyline.setAttribute("points", points);
		polyline.setAttribute("class", "fp-chart-line");
		polyline.style.setProperty("--fp-line-color", s.color);
		svg.appendChild(polyline);

		s.values.forEach((v, i) => {
			const dot = document.createElementNS(NS, "circle");
			dot.setAttribute("cx", String(scaleX(i)));
			dot.setAttribute("cy", String(scaleY(v)));
			dot.setAttribute("r", "4");
			dot.setAttribute("class", "fp-chart-dot");
			dot.style.setProperty("--fp-line-color", s.color);
			svg.appendChild(dot);
		});

		const lastIdx = s.values.length - 1;
		if (lastIdx >= 0) {
			const endLabel = document.createElementNS(NS, "text");
			endLabel.setAttribute("x", String(scaleX(lastIdx) + 6));
			endLabel.setAttribute("y", String(scaleY(s.values[lastIdx])));
			endLabel.setAttribute("class", "fp-chart-end-label");
			endLabel.setAttribute("dominant-baseline", "middle");
			endLabel.textContent = formatCompact(s.values[lastIdx]);
			svg.appendChild(endLabel);
		}
	});

	// Hover crosshair + tooltip
	const crosshair = document.createElementNS(NS, "line");
	crosshair.setAttribute("y1", String(padTop));
	crosshair.setAttribute("y2", String(padTop + plotH));
	crosshair.setAttribute("class", "fp-chart-crosshair");
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
		series.forEach((s) => {
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
			cls: "fp-barchart-value",
			text: new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(r.value),
		});
	});
}
