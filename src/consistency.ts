import type { MerchantEntry, MerchantMap } from "./import/merchantMemory";
import type { Category, Transaction } from "./types";

/**
 * Disagreements between what the ledger says and what the plugin's own memory says.
 *
 * Three records describe the same fact — a transaction's `categoryId`, the merchant memory entry the
 * next import will read, and the category list both point into — and nothing keeps them in step.
 * They drift in ordinary use: a category is renamed or deleted, a row is re-filed by hand without
 * teaching the merchant, an import writes memory for a shop whose rows are later deleted. Each drift
 * is silent and each one changes what a future import does, so the only way to find them is to look.
 *
 * Every finding here is expressed as a fix that can be applied, because a report of problems with no
 * way to act on them is a list of things to feel bad about.
 */

export type IssueKind =
	| "merchant-split"
	| "memory-disagrees"
	| "dangling-category"
	| "memory-missing-category"
	| "same-name-split";

export interface Issue {
	kind: IssueKind;
	/** Merchant key where the issue is about a merchant; absent for ledger-only problems. */
	key?: string;
	/** What to show as the subject of the row. */
	label: string;
	detail: string;
	/** Transactions the fix would rewrite. Empty when the fix only touches memory. */
	transactions: Transaction[];
	/** The category the fix would settle on, when there is one. */
	resolveTo?: string;
	/** Suggested wording for the button that applies it. */
	fixLabel?: string;
	/** "same-name-split" only: the merchant keys that read as the same shop. */
	variantKeys?: string[];
	/** Where a merchant's rows currently sit, worst first — the choice a fix has to make. */
	spread?: { categoryId: string; count: number }[];
	/** True for findings that are tidying rather than a disagreement, so the UI can fold them away. */
	housekeeping?: boolean;
}

export interface ConsistencyReport {
	issues: Issue[];
	checked: { transactions: number; merchants: number; categories: number };
}

const nameOf = (categories: Category[], id: string | undefined): string =>
	categories.find((c) => c.id === id)?.name ?? "unknown category";

/**
 * `merchantKeyOf` is injected rather than imported so this module stays pure and the caller decides
 * how a transaction maps to a merchant — the same key function the rest of the plugin groups by.
 */
export function checkConsistency(
	transactions: Transaction[],
	memory: MerchantMap,
	categories: Category[],
	merchantKeyOf: (tx: Transaction) => string | undefined,
	displayNameOf: (tx: Transaction) => string | undefined
): ConsistencyReport {
	const issues: Issue[] = [];
	const categoryIds = new Set(categories.map((c) => c.id));

	const rowsByKey = new Map<string, Transaction[]>();
	const votesByKey = new Map<string, Map<string, number>>();
	const nameByKey = new Map<string, string>();
	const dangling: Transaction[] = [];

	for (const tx of transactions) {
		if (tx.categoryId && !categoryIds.has(tx.categoryId)) dangling.push(tx);

		const key = merchantKeyOf(tx);
		if (!key) continue;
		const bucket = rowsByKey.get(key);
		if (bucket) bucket.push(tx);
		else rowsByKey.set(key, [tx]);

		if (tx.categoryId) {
			if (!votesByKey.has(key)) votesByKey.set(key, new Map());
			const votes = votesByKey.get(key)!;
			votes.set(tx.categoryId, (votes.get(tx.categoryId) ?? 0) + 1);
		}
		const display = displayNameOf(tx);
		if (display && display.length > (nameByKey.get(key) ?? "").length) nameByKey.set(key, display);
	}

	// A category that no longer exists. The rows still carry its id, so every total silently omits them
	// and no page can show what they were meant to be.
	if (dangling.length > 0) {
		issues.push({
			kind: "dangling-category",
			label: `${dangling.length} transaction${dangling.length === 1 ? "" : "s"} filed under a deleted category`,
			detail: "Their category id matches nothing in the category list, so they count towards no total anywhere.",
			transactions: dangling,
			fixLabel: "Clear the category",
		});
	}

	// The inconsistency people mean when they say "my merchants and categories disagree": one shop whose
	// rows sit under several categories. Sometimes deliberate (a supermarket selling fuel), often not,
	// and impossible to see without asking — no page in the plugin groups a merchant across categories.
	for (const [key, votes] of votesByKey) {
		if (votes.size < 2) continue;
		const spread = Array.from(votes.entries())
			.map(([categoryId, count]) => ({ categoryId, count }))
			.sort((a, b) => b.count - a.count);
		const total = spread.reduce((sum, e) => sum + e.count, 0);
		issues.push({
			kind: "merchant-split",
			key,
			label: nameByKey.get(key) ?? key,
			detail: `${total} rows across ${spread.length} categories: ${spread
				.map((e) => `${nameOf(categories, e.categoryId)} (${e.count})`)
				.join(", ")}.`,
			transactions: rowsByKey.get(key) ?? [],
			resolveTo: spread[0].categoryId,
			spread,
			fixLabel: `File all as ${nameOf(categories, spread[0].categoryId)}`,
		});
	}

	for (const [key, entry] of Object.entries(memory) as [string, MerchantEntry][]) {
		const rows = rowsByKey.get(key) ?? [];
		const label = nameByKey.get(key) ?? key;

		// Memory pointing at a category that has been deleted. The next import of this shop would file
		// its rows under an id nothing resolves, reproducing the problem above on fresh data.
		if (entry.categoryId && !categoryIds.has(entry.categoryId)) {
			issues.push({
				kind: "memory-missing-category",
				key,
				label,
				detail: "Remembered under a category that no longer exists — the next import of this merchant would file it nowhere.",
				transactions: rows,
				fixLabel: "Forget this merchant",
			});
			continue;
		}

		// Memory and ledger disagree. Whichever is right, a future import will contradict the rows that
		// are already there, and the difference is invisible until it happens.
		const votes = votesByKey.get(key);
		if (entry.categoryId && votes && votes.size > 0) {
			const ranked = Array.from(votes.entries()).sort((a, b) => b[1] - a[1]);
			const [ledgerCategory, ledgerCount] = ranked[0];
			const total = ranked.reduce((sum, [, n]) => sum + n, 0);
			const decisive = ranked.length === 1 || ledgerCount * 2 > total;
			if (decisive && ledgerCategory !== entry.categoryId) {
				issues.push({
					kind: "memory-disagrees",
					key,
					label,
					detail: `Filed as ${nameOf(categories, ledgerCategory)} in the ledger (${ledgerCount} of ${total} rows) but remembered as ${nameOf(
						categories,
						entry.categoryId
					)}. The next import would use the remembered one.`,
					transactions: rows.filter((t) => t.categoryId === ledgerCategory),
					resolveTo: ledgerCategory,
					fixLabel: "Trust the ledger",
				});
			}
		}

		// There is deliberately no "orphaned merchant" finding.
		//
		// It existed, and it was wrong. "No transaction produces this key" looks like proof the entry is
		// stale, and it is not: stored keys and freshly-derived keys can disagree. In a real vault it
		// reported 66 merchants as gone whose rows were sitting right there — memory keyed as
		// "barbershop rotterdam" against a ledger row reading "Barbershop Rotterdam Alexander", "to
		// wise" against "To Wise Europe SA". Every one of them would have been deleted by a button
		// labelled "clearing them costs nothing".
		//
		// Any version of this check has the same shape: it infers absence from a lookup miss, and a miss
		// is equally well explained by the two sides normalising differently. Merchant memory is also
		// the only place a categorization decision survives once the rows that taught it change. Tidying
		// a cache is not worth a mechanism that can silently discard years of that, so the check is gone
		// rather than tightened.
	}

	// Two different merchant keys reading as the same shop, filed differently. Usually a payee whose
	// bank text varies ("ALBERT HEIJN 1234" / "ALBERT HEIJN BV"), where one variant was categorized by
	// hand and the other never caught up.
	const byDisplay = new Map<string, { key: string; categoryId?: string }[]>();
	for (const [key, name] of nameByKey) {
		const normalized = name.trim().toLowerCase();
		const votes = votesByKey.get(key);
		const top = votes ? Array.from(votes.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
		const list = byDisplay.get(normalized) ?? [];
		list.push({ key, categoryId: top });
		byDisplay.set(normalized, list);
	}
	for (const [name, entries] of byDisplay) {
		const categorized = entries.filter((e) => e.categoryId);
		const distinct = new Set(categorized.map((e) => e.categoryId));
		if (entries.length > 1 && distinct.size > 1) {
			issues.push({
				kind: "same-name-split",
				label: name,
				detail: `${entries.length} merchant variants read as the same shop but are filed under ${distinct.size} different categories.`,
				transactions: entries.flatMap((e) => rowsByKey.get(e.key) ?? []),
				variantKeys: entries.map((e) => e.key),
			});
		}
	}

	// Disagreements first, tidying last — the order someone should read them in.
	issues.sort((a, b) => Number(a.housekeeping ?? false) - Number(b.housekeeping ?? false));

	return {
		issues,
		checked: { transactions: transactions.length, merchants: Object.keys(memory).length, categories: categories.length },
	};
}
