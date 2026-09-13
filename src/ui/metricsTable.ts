import { formatMoneyRounded } from "../money";

export function formatEUR(n: number): string {
	return formatMoneyRounded(n);
}

/** "N/A" for undefined (a savings rate with no meaningful denominator — see kpi.ts's savingsRateOf).
 *  "Incomplete" for NaN — a percentage built from an unconvertible currency (see currency.ts's convert)
 *  — rather than either one rendering as a number that isn't real. */
export function formatPct(n: number | undefined, digits = 0): string {
	if (n === undefined) return "N/A";
	if (Number.isNaN(n)) return "Incomplete";
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
/**
 * A metric row: one value per year/month, rendered via `format`. Generic over T so the ordinary case
 * (a `number[]` with a plain formatter like `formatEUR`) keeps working exactly as before, while a row
 * whose figure isn't always meaningful — a savings rate with no income to divide by — can pass a
 * `(number | undefined)[]` with `formatPct` and render "N/A" for the gaps instead of a caller having to
 * fake a 0 to satisfy the type.
 */
export function metricRow<T extends number | undefined>(
	tbody: HTMLTableSectionElement,
	label: string,
	values: T[],
	format: (n: T) => string,
	opts?: { emphasize?: boolean; heat?: "normal" | "invert" }
): void {
	const tr = tbody.createEl("tr", { cls: opts?.emphasize ? "fp-table-row-emphasis" : undefined });
	tr.createEl("td", { text: label });
	// Undefined cells (no meaningful figure) sit out of the row's own min/max, so one N/A month doesn't
	// collapse the heat scale for every other month.
	const defined = values.filter((v): v is number & T => v !== undefined);
	const min = Math.min(...defined);
	const max = Math.max(...defined);
	const money = (format as unknown) === formatEUR;
	values.forEach((v) => {
		const cell = tr.createEl("td", { text: format(v), cls: "fp-table-num" + (money ? " fp-money" : "") });
		if (opts?.heat && v !== undefined && max > min && v !== 0) {
			const t = ((v as number) - min) / (max - min);
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
 * A period narrower than a year leaves a column that only *looks* like a whole one. Rather than drop
 * the year — the period genuinely covers part of it, and the figures in it are real — `yearHeaderRow`
 * stars the column and this line says exactly how much of it is in view.
 */
export function partialYearsNote(parent: HTMLElement, years: { year: string; partial?: boolean }[], periodLabel: string): void {
	const partial = years.filter((y) => y.partial).map((y) => y.year);
	if (partial.length === 0) return;
	parent.createDiv({
		cls: "fp-table-note",
		text: `* ${partial.join(" and ")} ${partial.length === 1 ? "is" : "are"} partial — these figures cover ${periodLabel} only.`,
	});
}

/** The star `partialYearsNote` explains, for the years a period only partly covers. */
export function yearLabeller(years: { year: string; partial?: boolean }[]): (year: string) => string {
	return (year) => (years.find((y) => y.year === year)?.partial ? `${year}*` : year);
}

/**
 * Builds the `<thead>` for a year-columns metrics table (blank first cell, then one right-aligned
 * year per column). With `onClick`, each year header becomes a button into that year's detail; with
 * `labelFor`, a column can read as something other than its bare year (a period filter marks the
 * years it only partly covers) while still clicking through to the year itself.
 */
export function yearHeaderRow(
	table: HTMLTableElement,
	years: string[],
	opts?: { onClick?: (year: string) => void; labelFor?: (year: string) => string }
): void {
	const thead = table.createEl("thead").createEl("tr");
	thead.createEl("th", { text: "" });
	years.forEach((y) => {
		const th = thead.createEl("th", {
			text: opts?.labelFor ? opts.labelFor(y) : y,
			cls: "fp-table-num" + (opts?.onClick ? " fp-table-year-clickable" : ""),
		});
		if (opts?.onClick) {
			const onClick = opts.onClick;
			th.addEventListener("click", () => onClick(y));
		}
	});
}

/**
 * A year-by-year metrics table, inside something that can scroll.
 *
 * These tables grow a column every January, so any pane narrower than the years it holds eventually
 * clips the newest ones — the columns you actually came to read. Measured on a real vault, the
 * all-accounts history was 1,177px inside a 1,045px panel with `overflow-x: visible` on every
 * ancestor, so 2025 and 2026 were simply cut off with no way to reach them.
 *
 * A `<table>` cannot be its own scroll container without `display: block`, which would break its
 * column sizing, so the wrapper is the fix. Created here rather than at each call site because six of
 * the seven dashboards had forgotten it, and the seventh dashboard added later would have too.
 */
export function metricsTable(parent: HTMLElement): HTMLTableElement {
	const wrap = parent.createDiv({ cls: "fp-table-scroll" });
	return wrap.createEl("table", { cls: "fp-table fp-table-metrics" });
}
