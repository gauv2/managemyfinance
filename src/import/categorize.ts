import { CATEGORY_ALIAS_SEED } from "../constants";
import type { Category, CategoryRule, CategoryRuleMatch, Transaction } from "../types";

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

/** What a "contains" or regex rule is tested against: description and counterparty as one
 *  case-folded string. Unchanged, so every rule written before match modes existed still behaves
 *  exactly as it did. */
export function ruleHaystack(tx: Pick<Transaction, "description" | "counterparty">): string {
	return `${tx.description} ${tx.counterparty ?? ""}`.toLowerCase();
}

/**
 * The two whole-field modes compare against each field on its own rather than the joined haystack.
 * Joining makes "exact" meaningless — no single field ever equals "description counterparty" — and
 * would break "starts with" for any bank that puts the merchant in the counterparty and something
 * generic like "Card payment" in the description.
 */
function ruleFields(tx: Pick<Transaction, "description" | "counterparty">): string[] {
	return [tx.description ?? "", tx.counterparty ?? ""].map((v) => v.trim().toLowerCase()).filter((v) => v.length > 0);
}

/** Half a cent: amounts arrive as parsed floats, so 9.99 is never bit-for-bit 9.99 and an equality
 *  test on them would drop rows at random. Well below any real currency's smallest unit. */
const AMOUNT_EPSILON = 0.005;

/**
 * The optional amount test. Absent means "any amount", so every rule written before amount conditions
 * existed is unaffected.
 */
export function amountMatches(amount: number | undefined, condition: CategoryRule["amount"]): boolean {
	if (!condition) return true;
	if (typeof amount !== "number" || !Number.isFinite(amount)) return false;
	const value = Math.abs(amount);

	switch (condition.op) {
		case "exactly":
			return Math.abs(value - Math.abs(condition.value)) <= AMOUNT_EPSILON;
		case "any-of": {
			// Falls back to the single `value` so a malformed condition still means something rather
			// than silently matching nothing.
			const values = condition.values?.length ? condition.values : [condition.value];
			return values.some((v) => Math.abs(value - Math.abs(v)) <= AMOUNT_EPSILON);
		}
		case "at-most":
			return value <= Math.abs(condition.value) + AMOUNT_EPSILON;
		case "at-least":
			return value >= Math.abs(condition.value) - AMOUNT_EPSILON;
		case "between": {
			// Bounds are sorted rather than trusted, so a range typed high-then-low still works.
			const a = Math.abs(condition.value);
			const b = Math.abs(condition.value2 ?? condition.value);
			return value >= Math.min(a, b) - AMOUNT_EPSILON && value <= Math.max(a, b) + AMOUNT_EPSILON;
		}
	}
}

/**
 * A nested quantifier — `(a+)+`, `(\d*)*`, `(x+)*` — the shape that makes a regex take exponential
 * time on input that *almost* matches.
 *
 * Deliberately a shape test rather than a proof: it catches the classic constructions and makes no
 * claim about the rest. The alternative is not "a safe regex engine", it is what happens today —
 * `(a+)+$` against a 32-character description never returns, and since the rule dialog re-runs the
 * pattern over the whole ledger on every keystroke, typing one freezes the window with no dialog
 * left to cancel and no way out but force-quitting Obsidian. Refusing a pattern that would hang is
 * strictly better than hanging on it, and a rule already saved in this shape could never have worked.
 */
const NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)\s*[*+]|\([^()]*[+*]\)\s*\{\d/;

/** Why this pattern must not be compiled, or undefined when it is fine to run. */
export function unsafeRegexReason(pattern: string): string | undefined {
	if (NESTED_QUANTIFIER.test(pattern)) {
		return "That pattern nests one repeat inside another (like \"(a+)+\"), which can take effectively forever to match. Rewrite it without the inner repeat.";
	}
	return undefined;
}

/** A rule's effective mode: `match` when set, else the legacy `isRegex` flag, else "contains". */
export function resolveRuleMatch(rule: Pick<CategoryRule, "match" | "isRegex">): CategoryRuleMatch {
	return rule.match ?? (rule.isRegex ? "regex" : "contains");
}

/**
 * Does this one rule match this one transaction?
 *
 * Split out of `applyRules` so that previewing a rule before saving it and applying it afterwards
 * cannot disagree — the "this will move 42 transactions" count and the 42 rows that actually move are
 * now the same predicate rather than two hand-written copies of it. An unparseable regex matches
 * nothing rather than throwing, exactly as it did inline.
 */
export function ruleMatches(
	// `amount` optional so callers that only have the text (seeding a pattern, say) still type-check;
	// a rule with no amount condition never reads it anyway.
	tx: Pick<Transaction, "description" | "counterparty"> & { amount?: number },
	rule: Pick<CategoryRule, "pattern" | "isRegex" | "match" | "amount">
): boolean {
	if (!amountMatches(tx.amount, rule.amount)) return false;
	// Ahead of every mode, regex included: an all-whitespace pattern is never deliberate, and each
	// mode would otherwise fail differently and only by accident of the text it was tested against.
	const needle = rule.pattern.trim().toLowerCase();
	if (!needle) return false;
	const mode = resolveRuleMatch(rule);

	if (mode === "regex") {
		// Checked before compiling, not after: the cost of a catastrophic pattern is paid at match
		// time, so there is nothing to catch once it has started.
		if (unsafeRegexReason(rule.pattern)) return false;
		try {
			return new RegExp(rule.pattern, "i").test(ruleHaystack(tx));
		} catch {
			return false;
		}
	}

	if (mode === "exact") return ruleFields(tx).some((field) => field === needle);
	if (mode === "starts-with") return ruleFields(tx).some((field) => field.startsWith(needle));
	return ruleHaystack(tx).includes(rule.pattern.toLowerCase());
}

/** Returns the first matching rule's category, or undefined if nothing matches (falls back to "needs review"). */
export function applyRules(tx: Transaction, rules: CategoryRule[]): string | undefined {
	for (const rule of rules) {
		if (ruleMatches(tx, rule)) return rule.categoryId;
	}
	return undefined;
}
