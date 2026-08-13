/**
 * Everything the model is asked when deciding whether two bank descriptions are the same payee, and
 * everything it is trusted with — pure functions, same as prompt.ts, so what leaves the vault is a
 * value a test can assert on and the settings panel can print before anything is sent.
 *
 * This is the pass that string similarity structurally cannot do. "AH TO GO" and "Albert Heijn" share
 * no words and almost no characters; "T-Mobile" and "Ben" are the same company to a Dutch customer and
 * look nothing alike. Both need knowledge of the world, which is the one thing a metric hasn't got.
 *
 * The trade runs the other way too, which is why this is a third tier and not a replacement: a model
 * will confidently tell you two branches of a franchise are "the same merchant" when you file them
 * separately on purpose. So its answers arrive unticked, scored, and with the reason it gave.
 */

/** A merchant offered to the model as a possible match for the subject. */
export interface MatchCandidate {
	/** The local grouping key. Never sent — only the name goes over the wire. */
	key: string;
	/** The readable merchant name the model is shown and answers with. */
	name: string;
	/** How many transactions sit behind it, shown to the user rather than to the model. */
	count: number;
}

export interface MatchVerdict {
	/** The candidate's key, resolved back from the name the model answered with. */
	merchant: string;
	confidence: number;
	/** The model's one-line justification, shown verbatim next to the row. */
	reason: string;
}

export const MATCH_SYSTEM_PROMPT = [
	"You decide whether merchant names taken from bank statements refer to the same real-world payee.",
	"",
	"You are given one subject merchant and a list of candidate merchants. Return only the candidates that are the same payee as the subject.",
	"",
	"Rules:",
	"- Same payee means the same business a person would think of as one place they spend money: the same chain, the same company, or the same brand under a different trading name. Different branches, tills or cities of one chain are the same payee.",
	"- Sub-brands and store formats count as the same payee when they belong to the same chain and a person would think of them together (a supermarket's convenience format, a bank's payment brand).",
	"- Two different companies that merely sound alike are NOT the same payee. Neither are two different people who share a surname, nor a shop and an unrelated shop in the same sector.",
	"- Bank noise around a name (terminal codes, card numbers, branch numbers, dates, cities) should be ignored when judging — it is not part of the payee's identity.",
	"- Set confidence to how sure you are: 1.0 when the two names are unmistakably one company, around 0.5 when it is a reasonable read but you would want a human to confirm, below 0.3 when you are guessing.",
	"- Give a reason of at most twelve words, naming the connection ('AH To Go is Albert Heijn's convenience format').",
	"- Return nothing for a candidate that is not the same payee. Do not list candidates just to say no — an empty list is a valid and useful answer.",
	"- Judge only from the names. You have no amounts, dates or account details, and should not ask for them.",
].join("\n");

/** The exact text sent as the user turn. Shown verbatim in settings so it can be inspected first. */
export function buildMatchPrompt(subject: string, candidates: MatchCandidate[]): string {
	return [
		`Subject merchant: ${subject}`,
		"",
		"Candidate merchants:",
		candidates.map((c) => `- ${c.name}`).join("\n"),
		"",
		'Reply with JSON only: {"matches":[{"merchant":"<exact candidate string>","confidence":<0-1>,"reason":"<max 12 words>"}]}',
	].join("\n");
}

/** JSON Schema for the API transport's structured-output mode. */
export function matchResponseSchema(): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			matches: {
				type: "array",
				items: {
					type: "object",
					properties: {
						merchant: { type: "string" },
						confidence: { type: "number" },
						reason: { type: "string" },
					},
					required: ["merchant", "confidence", "reason"],
					additionalProperties: false,
				},
			},
		},
		required: ["matches"],
		additionalProperties: false,
	};
}

export interface MatchValidation {
	verdicts: MatchVerdict[];
	/** Answers thrown away, and why — surfaced rather than silently dropped. */
	rejected: { merchant: string; reason: string }[];
}

/**
 * Keeps only answers that are usable: a candidate we actually asked about, once, with a real
 * confidence.
 *
 * The guardrail that matters here is the "did we ask about this?" check. A hallucinated merchant name
 * has no key to resolve to, and letting one through would mean a bulk action listing a row that
 * doesn't exist — or worse, resolving to the wrong key and settling a merchant nobody looked at.
 */
export function validateMatches(parsed: unknown, askedFor: MatchCandidate[], subjectKey?: string): MatchValidation {
	const verdicts: MatchVerdict[] = [];
	const rejected: { merchant: string; reason: string }[] = [];

	const keyByName = new Map<string, string>();
	for (const candidate of askedFor) keyByName.set(candidate.name.trim().toLowerCase(), candidate.key);
	const seen = new Set<string>();

	const root = parsed as { matches?: unknown };
	const list = Array.isArray(root?.matches) ? root.matches : undefined;
	if (!list) throw new Error('The model\'s reply had no "matches" list.');

	for (const item of list) {
		const row = item as Partial<MatchVerdict>;
		const name = typeof row?.merchant === "string" ? row.merchant.trim().toLowerCase() : "";

		if (!name) {
			rejected.push({ merchant: String(row?.merchant ?? "?"), reason: "no merchant name" });
			continue;
		}
		const key = keyByName.get(name);
		if (!key) {
			rejected.push({ merchant: name, reason: "not a merchant we asked about" });
			continue;
		}
		// The subject is never a match for itself, and a model that echoes it back would otherwise
		// produce a row that selects the transaction the user is already acting on.
		if (subjectKey && key === subjectKey) {
			rejected.push({ merchant: name, reason: "that's the subject itself" });
			continue;
		}
		if (seen.has(key)) {
			rejected.push({ merchant: name, reason: "duplicate answer" });
			continue;
		}

		const confidence =
			typeof row.confidence === "number" && isFinite(row.confidence) ? Math.max(0, Math.min(1, row.confidence)) : 0;
		const reason = typeof row.reason === "string" ? row.reason.trim().slice(0, 120) : "";

		seen.add(key);
		verdicts.push({ merchant: key, confidence, reason });
	}

	verdicts.sort((a, b) => b.confidence - a.confidence);
	return { verdicts, rejected };
}
