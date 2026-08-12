import { primaryCategories, secondaryCategoriesOf } from "../categories";
import type { Category } from "../types";

/**
 * Everything the model is asked, and everything it is trusted with, lives here as pure functions —
 * so what leaves the vault is a value you can print in a test and show in the settings panel, not
 * something assembled inside a network call.
 */

export interface MerchantAssignment {
	/** The merchant key, resolved back from the readable name the model was shown. */
	merchant: string;
	categoryId: string;
	confidence: number;
}

/** What gets sent: the grouping key stays local, the readable name goes to the model. */
export interface MerchantRequest {
	key: string;
	name: string;
}

/** One line per category the model may choose, ids included so the answer is directly usable. */
export function categoryOptions(categories: Category[]): { id: string; path: string }[] {
	const out: { id: string; path: string }[] = [];
	for (const primary of primaryCategories(categories)) {
		if (primary.archived) continue;
		out.push({ id: primary.id, path: primary.name });
		for (const secondary of secondaryCategoriesOf(categories, primary.id)) {
			if (secondary.archived) continue;
			out.push({ id: secondary.id, path: `${primary.name} > ${secondary.name}` });
		}
	}
	return out;
}

export const SYSTEM_PROMPT = [
	"You classify merchant names into a personal-finance category tree.",
	"",
	"You are given a list of merchant names taken from a bank statement, and the exact category tree they must be filed into. For each merchant, choose the single best category id from the tree.",
	"",
	"Rules:",
	"- Only ever return a category id that appears in the provided tree. Never invent one.",
	"- Prefer the most specific option. If a merchant clearly belongs to a subcategory, return the subcategory's id rather than its parent's.",
	"- Set confidence to how sure you are that a person tracking their own spending would file it that way: 1.0 for an unmistakable global brand, around 0.5 when the name is suggestive but ambiguous, below 0.3 when you are essentially guessing.",
	"- Answer for every merchant you can place at all. If a name is suggestive but not certain, still answer and set a low confidence — low-confidence answers are shown to the user for approval rather than applied, so a tentative answer is useful and costs nothing.",
	"- Omit a merchant only when the name genuinely tells you nothing at all: a bare reference code, or a personal name with no business attached. Omitting a merchant you could have placed at low confidence is the more expensive mistake.",
	"- Company names you don't recognise are still classifiable from their form: a person's or family name followed by Holding/BV/NV/Ltd is almost always a Transfers or Income counterparty rather than a shop.",
	"- Judge only from the name. You have no amounts, dates or account details, and should not ask for them.",
].join("\n");

/** The exact text sent as the user turn. Shown verbatim in settings so it can be inspected first. */
export function buildUserPrompt(merchants: (string | MerchantRequest)[], categories: Category[]): string {
	const names = merchants.map((m) => (typeof m === "string" ? m : m.name));
	const options = categoryOptions(categories)
		.map((o) => `${o.id}\t${o.path}`)
		.join("\n");
	return [
		"Category tree (id, then path):",
		options,
		"",
		"Merchants to classify:",
		names.map((m) => `- ${m}`).join("\n"),
		"",
		'Reply with JSON only: {"assignments":[{"merchant":"<exact merchant string>","categoryId":"<id from the tree>","confidence":<0-1>}]}',
	].join("\n");
}

/** JSON Schema for the API transport's structured-output mode, so the reply can't come back as prose. */
export function responseSchema(): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			assignments: {
				type: "array",
				items: {
					type: "object",
					properties: {
						merchant: { type: "string" },
						categoryId: { type: "string" },
						confidence: { type: "number" },
					},
					required: ["merchant", "categoryId", "confidence"],
					additionalProperties: false,
				},
			},
		},
		required: ["assignments"],
		additionalProperties: false,
	};
}

/**
 * Pulls the JSON object out of a model reply that may be wrapped in prose or a code fence — needed
 * for the CLI transport, which has no structured-output mode to enforce a bare object.
 */
export function extractJson(raw: string): unknown {
	const text = raw.trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	const candidate = fenced ? fenced[1] : text;

	try {
		return JSON.parse(candidate);
	} catch {
		// Fall back to the outermost {...} span, which survives a leading sentence of commentary.
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start === -1 || end <= start) throw new Error("The model's reply contained no JSON object.");
		try {
			return JSON.parse(candidate.slice(start, end + 1));
		} catch {
			throw new Error("The model's reply contained JSON that couldn't be parsed.");
		}
	}
}

export interface ValidationResult {
	assignments: MerchantAssignment[];
	/** Answers thrown away, and why — surfaced rather than silently dropped. */
	rejected: { merchant: string; reason: string }[];
}

/**
 * Keeps only answers that are actually usable: a merchant we asked about, a category that really
 * exists, and a confidence in range.
 *
 * This is the guardrail that matters. A hallucinated category id would otherwise be written into the
 * ledger as an id nothing resolves — displaying as "Uncategorized" everywhere while being invisible
 * to a filter for uncategorized, so the spend would simply vanish from every total.
 */
export function validateAssignments(
	parsed: unknown,
	askedFor: (string | MerchantRequest)[],
	categories: Category[]
): ValidationResult {
	const assignments: MerchantAssignment[] = [];
	const rejected: { merchant: string; reason: string }[] = [];

	const validIds = new Set(categories.filter((c) => !c.archived).map((c) => c.id));
	// The model answers with the readable name it was shown; everything downstream keys off the
	// merchant key, so map back here rather than letting the two identifiers leak into each other.
	const keyByName = new Map<string, string>();
	for (const item of askedFor) {
		if (typeof item === "string") keyByName.set(item.trim().toLowerCase(), item);
		else keyByName.set(item.name.trim().toLowerCase(), item.key);
	}
	const seen = new Set<string>();

	const root = parsed as { assignments?: unknown };
	const list = Array.isArray(root?.assignments) ? root.assignments : undefined;
	if (!list) throw new Error('The model\'s reply had no "assignments" list.');

	for (const item of list) {
		const row = item as Partial<MerchantAssignment>;
		const merchant = typeof row?.merchant === "string" ? row.merchant.trim().toLowerCase() : "";

		if (!merchant) {
			rejected.push({ merchant: String(row?.merchant ?? "?"), reason: "no merchant name" });
			continue;
		}
		const key = keyByName.get(merchant);
		if (!key) {
			rejected.push({ merchant, reason: "not a merchant we asked about" });
			continue;
		}
		if (seen.has(key)) {
			rejected.push({ merchant, reason: "duplicate answer" });
			continue;
		}
		if (typeof row.categoryId !== "string" || !validIds.has(row.categoryId)) {
			rejected.push({ merchant, reason: `unknown category "${String(row.categoryId)}"` });
			continue;
		}
		const confidence = typeof row.confidence === "number" && isFinite(row.confidence) ? Math.max(0, Math.min(1, row.confidence)) : 0;

		seen.add(key);
		assignments.push({ merchant: key, categoryId: row.categoryId, confidence });
	}

	return { assignments, rejected };
}
