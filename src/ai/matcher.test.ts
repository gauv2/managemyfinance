import { describe, expect, it } from "vitest";
import { buildCandidatePool, describeMatchResult, MAX_CANDIDATES, type AiMatchResult } from "./matcher";
import type { Transaction } from "../types";

let seq = 0;
function tx(description: string, over: Partial<Transaction> = {}): Transaction {
	seq++;
	return {
		id: `t${seq}`,
		date: "2025-03-01",
		accountId: "acc",
		description,
		amount: -10,
		currency: "EUR",
		source: "manual",
		...over,
	} as Transaction;
}

describe("buildCandidatePool", () => {
	it("collects one candidate per distinct merchant, with its transactions", () => {
		const subject = tx("AH To Go Schiphol");
		const rows = [subject, tx("Albert Heijn 1423"), tx("CCV*ALBERT HEIJN 5566"), tx("Netflix")];
		const pool = buildCandidatePool(rows, subject);

		expect(pool.candidates).toHaveLength(2);
		const ah = pool.candidates.find((c) => c.name.toLowerCase().includes("albert"));
		expect(ah?.count).toBe(2);
		expect(pool.byKey.get(ah!.key)).toHaveLength(2);
	});

	it("never offers the subject's own merchant back as a candidate", () => {
		const subject = tx("Albert Heijn 1423");
		const pool = buildCandidatePool([subject, tx("Albert Heijn 5566"), tx("Netflix")], subject);
		expect(pool.candidates.map((c) => c.name)).toEqual(["Netflix"]);
	});

	it("takes the subject's readable name from its description", () => {
		const subject = tx("CCV*AH TO GO 1423");
		expect(buildCandidatePool([subject], subject).subjectName.toLowerCase()).toContain("ah to go");
	});

	it("excludes merchants the caller has already offered elsewhere", () => {
		const subject = tx("AH To Go");
		const rows = [subject, tx("Albert Heijn"), tx("Netflix")];
		const pool = buildCandidatePool(rows, subject, { exclude: new Set(["albert heijn"]) });
		expect(pool.candidates.map((c) => c.name)).toEqual(["Netflix"]);
	});

	it("honours the eligibility filter", () => {
		const subject = tx("AH To Go");
		const rows = [subject, tx("Netflix", { review: "approved" }), tx("Spotify")];
		const pool = buildCandidatePool(rows, subject, { eligible: (t) => (t.review ?? "new") !== "approved" });
		expect(pool.candidates.map((c) => c.name)).toEqual(["Spotify"]);
	});

	it("ranks candidates by how many transactions sit behind them", () => {
		const subject = tx("AH To Go");
		const rows = [subject, tx("Netflix"), tx("Spotify"), tx("Spotify"), tx("Spotify")];
		const pool = buildCandidatePool(rows, subject);
		expect(pool.candidates[0].name).toBe("Spotify");
	});

	it("caps the pool at the limit and says that it did", () => {
		const subject = tx("AH To Go");
		const rows = [subject, ...Array.from({ length: 10 }, (_, i) => tx(`Merchant Number${i} Shop`))];
		const pool = buildCandidatePool(rows, subject, { limit: 4 });
		expect(pool.candidates).toHaveLength(4);
		expect(pool.available).toBe(10);
		expect(pool.truncated).toBe(true);
	});

	it("is not truncated when everything fits", () => {
		const subject = tx("AH To Go");
		const pool = buildCandidatePool([subject, tx("Netflix")], subject);
		expect(pool.truncated).toBe(false);
		expect(pool.available).toBe(1);
	});

	// The whole reason this pass exists. Pre-filtering candidates by how much they already look like
	// the subject would drop exactly the answers a string metric cannot reach.
	it("keeps candidates that share no text with the subject at all", () => {
		const subject = tx("AH To Go");
		const pool = buildCandidatePool([subject, tx("Albert Heijn")], subject);
		expect(pool.candidates.map((c) => c.name)).toEqual(["Albert Heijn"]);
	});

	it("skips rows with no recognizable merchant name", () => {
		const subject = tx("AH To Go");
		const pool = buildCandidatePool([subject, tx("4738291047"), tx("Netflix")], subject);
		expect(pool.candidates.map((c) => c.name)).toEqual(["Netflix"]);
	});

	it("defaults to a bounded pool rather than the whole ledger", () => {
		expect(MAX_CANDIDATES).toBeLessThanOrEqual(500);
	});
});

describe("describeMatchResult", () => {
	function result(over: Partial<AiMatchResult> = {}): AiMatchResult {
		return { matches: [], asked: 10, available: 10, truncated: false, rejected: [], model: "claude-opus-5", ...over };
	}

	it("says so when there was nothing to compare against", () => {
		expect(describeMatchResult(result({ asked: 0 }))).toContain("Nothing else in the ledger");
	});

	it("reports a confident empty answer as an answer, with the size of the search", () => {
		expect(describeMatchResult(result())).toBe("Claude found no other merchant matching this one, out of 10 checked.");
	});

	it("counts merchants and the rows behind them", () => {
		const summary = describeMatchResult(
			result({
				matches: [
					{ merchant: "a", confidence: 1, reason: "", name: "Albert Heijn", transactions: [tx("x"), tx("y")] },
					{ merchant: "b", confidence: 0.8, reason: "", name: "AH XL", transactions: [tx("z")] },
				],
			})
		);
		expect(summary).toContain("2 merchants matched (3 transactions)");
	});

	// A capped search reported as a clean sweep is the silent-truncation failure this avoids.
	it("admits when the search covered only part of the ledger", () => {
		const summary = describeMatchResult(
			result({
				asked: 400,
				available: 1200,
				truncated: true,
				matches: [{ merchant: "a", confidence: 1, reason: "", name: "Albert Heijn", transactions: [tx("x")] }],
			})
		);
		expect(summary).toContain("of 1200 — busiest merchants only");
	});

	it("mentions discarded answers rather than hiding them", () => {
		const summary = describeMatchResult(
			result({
				matches: [{ merchant: "a", confidence: 1, reason: "", name: "AH", transactions: [tx("x")] }],
				rejected: [{ merchant: "ghost", reason: "not a merchant we asked about" }],
			})
		);
		expect(summary).toContain("1 invalid answer discarded");
	});
});
