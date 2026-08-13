import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiFindMatches, buildCandidatePool } from "./matcher";
import type { Transaction } from "../types";

/**
 * The batching and failure handling in aiFindMatches, with the transport replaced.
 *
 * Split from matcher.test.ts so the pure-function tests stay free of module-mocking machinery.
 * vi.mock is hoisted above the imports by the runner, so ./matcher gets the stub despite the static
 * import above reading as if it were loaded first.
 */
const callModel = vi.fn();
vi.mock("./provider", () => ({
	callModel: (...args: unknown[]) => callModel(...args),
}));

let seq = 0;
function tx(description: string): Transaction {
	seq++;
	return {
		id: `t${seq}`,
		date: "2025-03-01",
		accountId: "acc",
		description,
		amount: -10,
		currency: "EUR",
		source: "manual",
	} as Transaction;
}

/** A reply naming the given candidate names as matches. */
function reply(names: string[], confidence = 0.9): { raw: string; model: string; provider: "api" } {
	return {
		raw: JSON.stringify({ matches: names.map((merchant) => ({ merchant, confidence, reason: "same chain" })) }),
		model: "claude-opus-5",
		provider: "api",
	};
}

beforeEach(() => {
	callModel.mockReset();
});

describe("aiFindMatches", () => {
	it("turns a verdict back into the transactions behind that merchant", async () => {
		const subject = tx("AH To Go Schiphol");
		const pool = buildCandidatePool([subject, tx("Albert Heijn 1423"), tx("Albert Heijn 5566"), tx("Netflix")], subject);
		callModel.mockResolvedValue(reply(["Albert Heijn"]));

		const result = await aiFindMatches(pool, {});

		expect(result.matches).toHaveLength(1);
		expect(result.matches[0].transactions).toHaveLength(2);
		expect(result.matches[0].reason).toBe("same chain");
		expect(result.model).toBe("claude-opus-5");
	});

	it("sends only merchant names in the prompt", async () => {
		const subject = tx("AH To Go");
		const pool = buildCandidatePool([subject, tx("Albert Heijn")], subject);
		callModel.mockResolvedValue(reply([]));

		await aiFindMatches(pool, {});

		const request = callModel.mock.calls[0][0] as { system: string; user: string };
		expect(request.user).toContain("Albert Heijn");
		expect(request.user).not.toContain("acc");
		expect(request.user).not.toContain("2025-03-01");
		expect(request.user).not.toContain("-10");
	});

	it("makes one request per batch", async () => {
		const subject = tx("AH To Go");
		const rows = [subject, ...Array.from({ length: 320 }, (_, i) => tx(`Merchant Alpha${i} Store`))];
		const pool = buildCandidatePool(rows, subject);
		callModel.mockResolvedValue(reply([]));

		await aiFindMatches(pool, {});

		// 320 candidates at 150 per request.
		expect(callModel).toHaveBeenCalledTimes(3);
	});

	it("reports progress as batches complete", async () => {
		const subject = tx("AH To Go");
		const rows = [subject, ...Array.from({ length: 200 }, (_, i) => tx(`Merchant Alpha${i} Store`))];
		const pool = buildCandidatePool(rows, subject);
		callModel.mockResolvedValue(reply([]));

		const seen: number[] = [];
		await aiFindMatches(pool, {}, (done) => seen.push(done));
		expect(seen).toEqual([150, 200]);
	});

	it("keeps the answers from batches that worked when one fails", async () => {
		const subject = tx("AH To Go");
		const rows = [subject, tx("Albert Heijn"), ...Array.from({ length: 200 }, (_, i) => tx(`Merchant Alpha${i} Store`))];
		const pool = buildCandidatePool(rows, subject);
		callModel.mockResolvedValueOnce(reply([pool.candidates[0].name])).mockRejectedValueOnce(new Error("rate limited"));

		const result = await aiFindMatches(pool, {});

		expect(result.matches).toHaveLength(1);
		// A partial answer must not present itself as a complete sweep of the ledger.
		expect(result.truncated).toBe(true);
	});

	it("throws when every batch fails, rather than reporting a confident zero", async () => {
		const subject = tx("AH To Go");
		const pool = buildCandidatePool([subject, tx("Albert Heijn")], subject);
		callModel.mockRejectedValue(new Error("That API key was rejected."));

		await expect(aiFindMatches(pool, {})).rejects.toThrow("That API key was rejected.");
	});

	it("does not call the model at all when there is nothing to compare against", async () => {
		const subject = tx("AH To Go");
		const pool = buildCandidatePool([subject], subject);

		const result = await aiFindMatches(pool, {});

		expect(callModel).not.toHaveBeenCalled();
		expect(result.asked).toBe(0);
	});

	it("refuses to run for a transaction with no merchant name in it", async () => {
		const subject = tx("4738291047");
		const pool = buildCandidatePool([subject, tx("Albert Heijn")], subject);

		await expect(aiFindMatches(pool, {})).rejects.toThrow(/no merchant name/);
		expect(callModel).not.toHaveBeenCalled();
	});

	it("drops a hallucinated merchant and records why", async () => {
		const subject = tx("AH To Go");
		const pool = buildCandidatePool([subject, tx("Albert Heijn")], subject);
		callModel.mockResolvedValue(reply(["A Shop That Was Never Sent"]));

		const result = await aiFindMatches(pool, {});

		expect(result.matches).toHaveLength(0);
		expect(result.rejected[0].reason).toBe("not a merchant we asked about");
	});

	it("survives a reply wrapped in a code fence, as the CLI transport produces", async () => {
		const subject = tx("AH To Go");
		const pool = buildCandidatePool([subject, tx("Albert Heijn")], subject);
		callModel.mockResolvedValue({
			raw: '```json\n{"matches":[{"merchant":"Albert Heijn","confidence":0.9,"reason":"same chain"}]}\n```',
			model: "claude-opus-5",
			provider: "cli",
		});

		const result = await aiFindMatches(pool, {});
		expect(result.matches).toHaveLength(1);
	});
});
