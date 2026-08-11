import type { KpiStore } from "./kpi";
import type { Transaction } from "./types";

export interface CategoryOutlier {
	transaction: Transaction;
	categoryName: string;
}

export interface CategorizationFlag {
	/** The counterparty (or description, when no counterparty is recorded) this group matched on. */
	key: string;
	totalCount: number;
	majorityCategoryName: string;
	majorityCount: number;
	outliers: CategoryOutlier[];
}

const MIN_GROUP_SIZE = 3;
const UNCATEGORIZED = "__uncategorized__";

function groupKey(tx: Transaction): string {
	return (tx.counterparty?.trim() || tx.description?.trim() || "").toLowerCase();
}

/**
 * Flags recurring counterparties whose transactions are split across more than one category — a
 * strong signal of miscategorization or import-rule drift. This is exactly the pattern that hid a
 * real user's income inside a "Transfers" category in practice (most of a family member's transfers
 * were tagged Income, a handful were tagged Transfers by the auto-importer) — surfacing it here means
 * that kind of thing doesn't have to be found by accident while debugging a chart.
 *
 * Only counterparties with at least MIN_GROUP_SIZE transactions AND a clear majority category are
 * flagged — a genuinely varied counterparty (e.g. a supermarket bought under different categories on
 * purpose) with no dominant pattern, or a small sample, isn't flagged as noise.
 */
export function findCategorizationInconsistencies(store: KpiStore): CategorizationFlag[] {
	const categoryName = (id: string | undefined): string => (id ? store.categories.find((c) => c.id === id)?.name ?? "Uncategorized" : "Uncategorized");

	const groups = new Map<string, { display: string; transactions: Transaction[] }>();
	for (const tx of store.transactions) {
		const key = groupKey(tx);
		if (!key) continue;
		if (!groups.has(key)) groups.set(key, { display: tx.counterparty?.trim() || tx.description?.trim() || key, transactions: [] });
		groups.get(key)!.transactions.push(tx);
	}

	const flags: CategorizationFlag[] = [];
	for (const { display, transactions } of groups.values()) {
		if (transactions.length < MIN_GROUP_SIZE) continue;

		const counts = new Map<string, number>();
		for (const tx of transactions) {
			const catKey = tx.categoryId ?? UNCATEGORIZED;
			counts.set(catKey, (counts.get(catKey) ?? 0) + 1);
		}
		if (counts.size < 2) continue; // already fully consistent

		const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
		const [majorityKey, majorityCount] = ranked[0];
		const runnerUp = ranked[1][1];
		if (majorityCount <= runnerUp) continue; // no clear majority — likely intentional variety, not a mistake

		const outliers = transactions
			.filter((tx) => (tx.categoryId ?? UNCATEGORIZED) !== majorityKey)
			.map((tx) => ({ transaction: tx, categoryName: categoryName(tx.categoryId) }))
			.sort((a, b) => (a.transaction.date < b.transaction.date ? 1 : -1));

		flags.push({
			key: display,
			totalCount: transactions.length,
			majorityCategoryName: categoryName(majorityKey === UNCATEGORIZED ? undefined : majorityKey),
			majorityCount,
			outliers,
		});
	}

	return flags.sort((a, b) => b.outliers.length - a.outliers.length);
}
