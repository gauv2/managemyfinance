export function formatEUR(n: number): string {
	return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}

export function formatPct(n: number, digits = 0): string {
	return `${n * 100 >= 0 ? "+" : ""}${(n * 100).toFixed(digits)}%`;
}

/** YoY change as a fraction of the (absolute) prior value; undefined when there's no prior year to compare to. */
export function yoy(curr: number, prev: number | undefined): number | undefined {
	if (prev === undefined || prev === 0) return undefined;
	return (curr - prev) / Math.abs(prev);
}

const HEAT_BAD: [number, number, number] = [239, 68, 68];
const HEAT_WARN: [number, number, number] = [245, 158, 11];
const HEAT_GOOD: [number, number, number] = [34, 197, 94];

/** Excel-style 3-color scale: worst value in a row reads red, best reads green, via the row's own min/max. */
export function heatColor(t: number, invert: boolean): string {
	const x = Math.max(0, Math.min(1, invert ? 1 - t : t));
	const [from, to] = x < 0.5 ? [HEAT_BAD, HEAT_WARN] : [HEAT_WARN, HEAT_GOOD];
	const local = x < 0.5 ? x / 0.5 : (x - 0.5) / 0.5;
	const rgb = from.map((c, i) => Math.round(c + (to[i] - c) * local));
	return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.22)`;
}

/**
 * A metric row: one value per year, rendered via `format`. With `heat`, each cell is tinted red→yellow→green
 * relative to the other years in the same row (Excel color-scale conditional formatting), so the current year's
 * cell reads at a glance against its own history. `invert` flips the scale for metrics where lower is better.
 */
export function metricRow(
	tbody: HTMLTableSectionElement,
	label: string,
	values: number[],
	format: (n: number) => string,
	opts?: { emphasize?: boolean; heat?: "normal" | "invert" }
): void {
	const tr = tbody.createEl("tr", { cls: opts?.emphasize ? "fp-table-row-emphasis" : undefined });
	tr.createEl("td", { text: label });
	const min = Math.min(...values);
	const max = Math.max(...values);
	const money = format === formatEUR;
	values.forEach((v) => {
		const cell = tr.createEl("td", { text: format(v), cls: "fp-table-num" + (money ? " fp-money" : "") });
		if (opts?.heat && max > min && v !== 0) {
			const t = (v - min) / (max - min);
			cell.style.backgroundColor = heatColor(t, opts.heat === "invert");
		}
	});
}

/** A "Δ YoY" row under a metric row: blank for the first year, a colored % change for the rest. */
export function deltaRow(tbody: HTMLTableSectionElement, values: number[], opts?: { invert?: boolean; label?: string }): void {
	const tr = tbody.createEl("tr", { cls: "fp-table-row-delta" });
	tr.createEl("td", { text: opts?.label ?? "Δ YoY" });
	values.forEach((v, i) => {
		const cell = tr.createEl("td", { cls: "fp-table-num" });
		const change = yoy(v, values[i - 1]);
		if (change === undefined) {
			cell.setText("—");
			return;
		}
		const good = opts?.invert ? change <= 0 : change >= 0;
		cell.addClass(good ? "fp-delta-good" : "fp-delta-bad");
		cell.setText(formatPct(change));
	});
}

/**
 * Builds the `<thead>` for a year-columns metrics table (blank first cell, then one right-aligned
 * year per column). With `onClick`, each year header becomes a button into that year's detail.
 */
export function yearHeaderRow(table: HTMLTableElement, years: string[], opts?: { onClick?: (year: string) => void }): void {
	const thead = table.createEl("thead").createEl("tr");
	thead.createEl("th", { text: "" });
	years.forEach((y) => {
		const th = thead.createEl("th", { text: y, cls: "fp-table-num" + (opts?.onClick ? " fp-table-year-clickable" : "") });
		if (opts?.onClick) {
			const onClick = opts.onClick;
			th.addEventListener("click", () => onClick(y));
		}
	});
}
