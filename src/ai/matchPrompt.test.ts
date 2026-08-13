import { describe, expect, it } from "vitest";
import { buildMatchPrompt, matchResponseSchema, MATCH_SYSTEM_PROMPT, validateMatches, type MatchCandidate } from "./matchPrompt";

function candidate(name: string, key = name.toLowerCase()): MatchCandidate {
	return { key, name, count: 1 };
}

const candidates = [candidate("Albert Heijn", "albert heijn"), candidate("Shell Rotterdam", "shell rotterdam"), candidate("Netflix", "netflix")];

describe("buildMatchPrompt", () => {
	const prompt = buildMatchPrompt("AH To Go Schiphol", candidates);

	it("names the subject and lists every candidate", () => {
		expect(prompt).toContain("Subject merchant: AH To Go Schiphol");
		for (const c of candidates) expect(prompt).toContain(`- ${c.name}`);
	});

	it("asks for JSON only", () => {
		expect(prompt).toContain('{"matches":[');
	});

	// The privacy promise is the same one the categorization pass makes, and it is only worth making
	// if something checks it. Merchant names go; nothing else about a transaction does.
	it("sends merchant names and nothing else about a transaction", () => {
		const withMoney = buildMatchPrompt("Albert Heijn", [candidate("Jumbo", "jumbo")]);
		for (const leak of ["amount", "IBAN", "balance", "accountId", "2025-", "EUR", "€"]) {
			expect(withMoney).not.toContain(leak);
		}
	});

	it("does not send the local grouping keys", () => {
		const keyed = buildMatchPrompt("Subject", [{ key: "secret-internal-key", name: "Albert Heijn", count: 3 }]);
		expect(keyed).not.toContain("secret-internal-key");
		expect(keyed).toContain("Albert Heijn");
	});
});

describe("MATCH_SYSTEM_PROMPT", () => {
	it("tells the model an empty answer is valid, so it isn't pushed into guessing", () => {
		expect(MATCH_SYSTEM_PROMPT).toContain("empty list is a valid");
	});

	it("warns off the two failure modes that matter", () => {
		expect(MATCH_SYSTEM_PROMPT).toContain("merely sound alike");
		expect(MATCH_SYSTEM_PROMPT).toContain("share a surname");
	});
});

describe("matchResponseSchema", () => {
	it("requires every field the validator reads", () => {
		const schema = matchResponseSchema() as {
			properties: { matches: { items: { required: string[]; additionalProperties: boolean } } };
		};
		expect(schema.properties.matches.items.required).toEqual(["merchant", "confidence", "reason"]);
		expect(schema.properties.matches.items.additionalProperties).toBe(false);
	});
});

describe("validateMatches", () => {
	it("resolves the answered name back to the local key", () => {
		const { verdicts } = validateMatches(
			{ matches: [{ merchant: "Albert Heijn", confidence: 0.95, reason: "AH To Go is AH's convenience format" }] },
			candidates
		);
		expect(verdicts).toEqual([
			{ merchant: "albert heijn", confidence: 0.95, reason: "AH To Go is AH's convenience format" },
		]);
	});

	it("matches the name case- and whitespace-insensitively", () => {
		const { verdicts } = validateMatches({ matches: [{ merchant: "  albert heijn  ", confidence: 1, reason: "x" }] }, candidates);
		expect(verdicts[0].merchant).toBe("albert heijn");
	});

	// The guardrail that matters: a name we never sent has no key, and letting it through would
	// resolve to nothing — or worse, to the wrong merchant.
	it("throws out a merchant it was never asked about", () => {
		const { verdicts, rejected } = validateMatches({ matches: [{ merchant: "Hallucinated BV", confidence: 1, reason: "x" }] }, candidates);
		expect(verdicts).toHaveLength(0);
		expect(rejected[0].reason).toBe("not a merchant we asked about");
	});

	it("throws out the subject echoed back as its own match", () => {
		const withSubject = [...candidates, candidate("AH To Go", "ah to go")];
		const { verdicts, rejected } = validateMatches(
			{ matches: [{ merchant: "AH To Go", confidence: 1, reason: "identical" }] },
			withSubject,
			"ah to go"
		);
		expect(verdicts).toHaveLength(0);
		expect(rejected[0].reason).toBe("that's the subject itself");
	});

	it("keeps only the first of a duplicated answer", () => {
		const { verdicts, rejected } = validateMatches(
			{
				matches: [
					{ merchant: "Albert Heijn", confidence: 0.9, reason: "a" },
					{ merchant: "albert heijn", confidence: 0.2, reason: "b" },
				],
			},
			candidates
		);
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0].confidence).toBe(0.9);
		expect(rejected[0].reason).toBe("duplicate answer");
	});

	it("clamps confidence into range and survives a missing one", () => {
		const { verdicts } = validateMatches(
			{
				matches: [
					{ merchant: "Albert Heijn", confidence: 7, reason: "a" },
					{ merchant: "Shell Rotterdam", confidence: -3, reason: "b" },
					{ merchant: "Netflix", reason: "c" },
				],
			},
			candidates
		);
		const byKey = new Map(verdicts.map((v) => [v.merchant, v.confidence]));
		expect(byKey.get("albert heijn")).toBe(1);
		expect(byKey.get("shell rotterdam")).toBe(0);
		expect(byKey.get("netflix")).toBe(0);
	});

	it("ranks the most confident answer first", () => {
		const { verdicts } = validateMatches(
			{
				matches: [
					{ merchant: "Netflix", confidence: 0.3, reason: "a" },
					{ merchant: "Albert Heijn", confidence: 0.9, reason: "b" },
				],
			},
			candidates
		);
		expect(verdicts.map((v) => v.merchant)).toEqual(["albert heijn", "netflix"]);
	});

	it("truncates a rambling reason rather than letting it into the UI", () => {
		const { verdicts } = validateMatches(
			{ matches: [{ merchant: "Albert Heijn", confidence: 1, reason: "x".repeat(400) }] },
			candidates
		);
		expect(verdicts[0].reason).toHaveLength(120);
	});

	it("accepts an empty match list as a real answer", () => {
		expect(validateMatches({ matches: [] }, candidates).verdicts).toEqual([]);
	});

	it("throws when the reply has no matches list at all", () => {
		expect(() => validateMatches({ nope: true }, candidates)).toThrow(/no "matches" list/);
	});
});
