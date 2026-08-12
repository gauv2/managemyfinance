import { CATEGORY_ALIAS_SEED } from "../constants";
import type { Category, CategoryRule, Transaction } from "../types";

/**
 * Legacy aliases are applied first and real categories second, so that when a secondary category's
 * own name matches one of the built-in subcategory alias keys (e.g. a "Public Transport" secondary
 * vs. the `CATEGORY_ALIAS_SEED["public transport"]` entry, which points at the flat "Auto & Transport"
 * primary), the actual category wins and the match lands at the correct, more specific level.
 */
export function buildAliasLookup(categories: Category[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const [alias, name] of Object.entries(CATEGORY_ALIAS_SEED)) {
		const cat = categories.find((c) => c.name === name);
		if (cat) map.set(alias, cat.id);
	}
	for (const cat of categories) {
		map.set(cat.name.toLowerCase(), cat.id);
		for (const alias of cat.aliases) map.set(alias.toLowerCase(), cat.id);
	}
	return map;
}

/** Returns the first matching rule's category, or undefined if nothing matches (falls back to "needs review"). */
export function applyRules(tx: Transaction, rules: CategoryRule[]): string | undefined {
	const haystack = `${tx.description} ${tx.counterparty ?? ""}`.toLowerCase();
	for (const rule of rules) {
		if (rule.isRegex) {
			try {
				if (new RegExp(rule.pattern, "i").test(haystack)) return rule.categoryId;
			} catch {
				continue;
			}
		} else if (haystack.includes(rule.pattern.toLowerCase())) {
			return rule.categoryId;
		}
	}
	return undefined;
}
