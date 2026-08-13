/**
 * Year-on-year category comparison.
 *
 * The dashboards answer "what did this year cost?" one year at a time. That is the wrong shape for
 * the question people actually ask of a ledger they have kept for a while — is this getting worse,
 * and where. Answering that means holding several years of the same category side by side, so this
 * module turns per-year category totals into a matrix with the arithmetic already done: change
 * against the previous year, change across the whole span, a growth rate that is comparable between
 * a two-year and a five-year selection, and each category's share of the year it sits in.
 *
 * It takes plain maps rather than the store so the maths can be tested without a vault, and so the
 * caller decides what a "year" contains — all accounts, one account, before or after transfers.
 */

export interface CategoryMeta {
	id: string;
	label: string;
	color: string;
	icon?: string;
}

export interface CategoryYearRow {
	categoryId: string;
	label: string;
	color: string;
	icon?: string;
	/** One value per year, aligned to `years` and zero-filled — a category absent from a year spent nothing. */
	values: number[];
	/** Summed across the selected years, which is what "biggest overall" should sort by. */
	total: number;
	/** Change against the previous selected year, absolute and relative. Undefined when there is no
	 *  previous year, or when the previous year was zero — a jump from nothing is not a percentage. */
	changeAbs?: number;
	changePct?: number;
	/** Last selected year against the first, for the whole span rather than the final step. */
	spanChangePct?: number;
	/** Compound annual growth across the span. Comparable between selections of different lengths,
	 *  which a raw span percentage is not: +60% over two years and +60% over five are not the same. */
	cagr?: number;
	/** Share of the final year's total spend, so a big mover can be weighed against its size. */
	shareOfLast: number;
}

export interface Comparison {
	years: string[];
	rows: CategoryYearRow[];
	/** Column totals, aligned to `years`. */
	totals: number[];
	totalChangePct?: number;
	totalSpanChangePct?: number;
	/** Sorted by absolute change against the previous year — the categories that moved the needle. */
	risers: CategoryYearRow[];
	fallers: CategoryYearRow[];
}

/** Relative change, or undefined when there is nothing to divide by. */
export function pctChange(curr: number, prev: number | undefined): number | undefined {
	if (prev === undefined || prev === 0) return undefined;
	return (curr - prev) / Math.abs(prev);
}

/**
 * Compound annual growth rate across `periods` steps. Undefined unless both ends are positive:
 * a category that started or finished at zero has no meaningful rate, and negative spend (a refund
 * year) would produce a complex root.
 */
export function cagr(first: number, last: number, periods: number): number | undefined {
	if (periods <= 0 || first <= 0 || last <= 0) return undefined;
	return Math.pow(last / first, 1 / periods) - 1;
}

/**
 * Builds the comparison matrix.
 *
 * `totalsByYear` is one map per entry in `years`, in the same order, keyed by category id. Any
 * category appearing in any year gets a row, zero-filled for the years it is missing from, so the
 * table stays rectangular and a category that only exists in one year is still visible rather than
 * silently dropped.
 */
export function buildComparison(
	years: string[],
	totalsByYear: Map<string, number>[],
	meta: Map<string, CategoryMeta>
): Comparison {
	const ids = new Set<string>();
	totalsByYear.forEach((m) => m.forEach((_v, id) => ids.add(id)));

	const totals = years.map((_y, i) => {
		let sum = 0;
		totalsByYear[i]?.forEach((v) => (sum += v));
		return sum;
	});

	const lastIndex = years.length - 1;
	const lastTotal = totals[lastIndex] ?? 0;

	const rows: CategoryYearRow[] = Array.from(ids).map((id) => {
		const values = years.map((_y, i) => totalsByYear[i]?.get(id) ?? 0);
		const info = meta.get(id);
		const last = values[lastIndex] ?? 0;
		const prev = lastIndex > 0 ? values[lastIndex - 1] : undefined;
		const first = values[0] ?? 0;

		return {
			categoryId: id,
			label: info?.label ?? "Uncategorized",
			color: info?.color ?? "#6b7280",
			icon: info?.icon,
			values,
			total: values.reduce((a, b) => a + b, 0),
			changeAbs: prev === undefined ? undefined : last - prev,
			changePct: pctChange(last, prev),
			spanChangePct: years.length > 1 ? pctChange(last, first) : undefined,
			cagr: years.length > 1 ? cagr(first, last, years.length - 1) : undefined,
			shareOfLast: lastTotal > 0 ? last / lastTotal : 0,
		};
	});

	// Biggest spend first: the eye should land on what dominates the bill, not on an alphabet.
	rows.sort((a, b) => b.total - a.total);

	const moved = rows.filter((r) => r.changeAbs !== undefined && r.changeAbs !== 0);
	const risers = [...moved].sort((a, b) => (b.changeAbs ?? 0) - (a.changeAbs ?? 0)).filter((r) => (r.changeAbs ?? 0) > 0);
	const fallers = [...moved].sort((a, b) => (a.changeAbs ?? 0) - (b.changeAbs ?? 0)).filter((r) => (r.changeAbs ?? 0) < 0);

	return {
		years,
		rows,
		totals,
		totalChangePct: lastIndex > 0 ? pctChange(lastTotal, totals[lastIndex - 1]) : undefined,
		totalSpanChangePct: years.length > 1 ? pctChange(lastTotal, totals[0]) : undefined,
		risers,
		fallers,
	};
}

/**
 * The categories worth plotting by default. A chart with thirty lines communicates nothing, so this
 * takes the biggest by total spend; everything else stays in the table, which has room for it.
 */
export function topCategories(comparison: Comparison, limit: number): string[] {
	return comparison.rows.slice(0, limit).map((r) => r.categoryId);
}
