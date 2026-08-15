import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiRankPlan, aiReadDocument, describeAiOutcome } from "./invoiceMatcher";
import { applyAiRanking, matchInvoices, type InvoiceCandidateTx, type InvoiceDocument, type InvoicePeriod } from "../invoiceMatch";

/**
 * The AI passes with the transport replaced, and specifically what happens when it doesn't answer.
 *
 * Both passes are optional enhancements, and the promise made in the UI is that a failing one costs
 * only itself. These tests are that promise: a rate limit on one document must leave the other one's
 * ranking intact and the deterministic matches untouched.
 *
 * vi.mock is hoisted above the imports by the runner, so ./invoiceMatcher gets the stub despite the
 * static import above reading as if it were loaded first.
 */
const callModel = vi.fn();
vi.mock("./provider", () => ({
	callModel: (...args: unknown[]) => callModel(...args),
}));

const APRIL: InvoicePeriod = { kind: "month", year: 2026, month: 4 };

let seq = 0;
function tx(over: Partial<InvoiceCandidateTx> = {}): InvoiceCandidateTx {
	seq++;
	return { id: `t${seq}`, date: "2026-04-12", accountId: "acc-1", description: "Some shop", amount: -49.99, currency: "EUR", ...over };
}

function doc(over: Partial<InvoiceDocument> = {}): InvoiceDocument {
	return { id: "doc-0", filename: "receipt.pdf", total: 49.99, date: "2026-04-12", ...over };
}

/** A plan whose single document has two candidates, so the ranking pass has something to rank. */
function twoCandidatePlan(): ReturnType<typeof matchInvoices> {
	return matchInvoices(
		[doc({ vendor: "AH To Go" })],
		[tx({ id: "wrong", description: "Some Shop" }), tx({ id: "right", description: "CCV*ALBERT HEIJN 1423" })],
		APRIL
	);
}

function reply(body: unknown): { raw: string; model: string; provider: "api" } {
	return { raw: JSON.stringify(body), model: "claude-opus-5", provider: "api" };
}

beforeEach(() => {
	callModel.mockReset();
	seq = 0;
});

describe("aiReadDocument", () => {
	it("sends the file itself when there was no text to send instead", async () => {
		callModel.mockResolvedValue(reply({ vendor: "Bol.com", total: 49.99 }));

		const { fields } = await aiReadDocument(doc({ filename: "photo.jpg" }), undefined, { mediaType: "image/png", data: "AAAA" }, {});

		expect(fields).toEqual({ vendor: "Bol.com", total: 49.99 });
		expect(callModel.mock.calls[0][0].attachments).toEqual([{ mediaType: "image/png", data: "AAAA" }]);
	});

	it("sends no attachment when local text was available, so the document stays in the vault", async () => {
		callModel.mockResolvedValue(reply({ total: 49.99 }));

		await aiReadDocument(doc(), "Totaal € 49.99", undefined, {});

		expect(callModel.mock.calls[0][0].attachments).toBeUndefined();
		expect(callModel.mock.calls[0][0].user).toContain("Totaal € 49.99");
	});

	it("passes a malformed reply out as an error for the caller to absorb", async () => {
		callModel.mockResolvedValue({ raw: "not json at all", model: "m", provider: "api" });
		await expect(aiReadDocument(doc(), "text", undefined, {})).rejects.toThrow();
	});
});

describe("aiRankPlan", () => {
	it("asks once per document that has a shortlist worth ordering", async () => {
		callModel.mockResolvedValue(reply({ matches: [{ ref: "t2", confidence: 0.95, reason: "AH To Go is Albert Heijn" }] }));

		const { rankings, outcome } = await aiRankPlan(twoCandidatePlan(), {});

		expect(callModel).toHaveBeenCalledTimes(1);
		expect(outcome.ranked).toBe(1);
		expect(outcome.failures).toBe(0);
		expect(rankings[0].verdicts[0].reason).toBe("AH To Go is Albert Heijn");
	});

	it("resolves the model's per-request label back to a real transaction id", async () => {
		const plan = twoCandidatePlan();
		const topRef = plan.proposals[0].candidates[0];
		callModel.mockResolvedValue(reply({ matches: [{ ref: "t1", confidence: 0.9, reason: "x" }] }));

		const { rankings } = await aiRankPlan(plan, {});

		expect(rankings[0].verdicts[0].txId).toBe(topRef.tx.id);
	});

	it("asks nothing at all when there is only one candidate to consider", async () => {
		const plan = matchInvoices([doc({ vendor: "Albert Heijn" })], [tx({ description: "CCV*ALBERT HEIJN 1423" })], APRIL);

		const { outcome } = await aiRankPlan(plan, {});

		expect(callModel).not.toHaveBeenCalled();
		expect(outcome.ranked).toBe(0);
	});

	it("keeps going after a failed request and reports it rather than throwing", async () => {
		const plan = matchInvoices(
			[
				doc({ id: "doc-0", filename: "a.pdf", vendor: "AH To Go" }),
				doc({ id: "doc-1", filename: "b.pdf", vendor: "AH To Go", total: 12.99 }),
			],
			[
				tx({ id: "a1", description: "Some Shop" }),
				tx({ id: "a2", description: "CCV*ALBERT HEIJN 1423" }),
				tx({ id: "b1", description: "Other Shop", amount: -12.99 }),
				tx({ id: "b2", description: "ALBERT HEIJN 5566", amount: -12.99 }),
			],
			APRIL
		);
		callModel
			.mockRejectedValueOnce(new Error("Rate limited by the Claude API — wait a moment and try again."))
			.mockResolvedValueOnce(reply({ matches: [{ ref: "t1", confidence: 0.9, reason: "same shop" }] }));

		const { rankings, outcome } = await aiRankPlan(plan, {});

		expect(outcome.failures).toBe(1);
		expect(outcome.ranked).toBe(1);
		expect(outcome.lastError).toContain("Rate limited");
		expect(rankings).toHaveLength(1);
	});

	it("leaves the deterministic plan exactly as it was when every request fails", async () => {
		const plan = twoCandidatePlan();
		callModel.mockRejectedValue(new Error("Claude API error 500"));

		const { rankings, outcome } = await aiRankPlan(plan, {});
		const after = applyAiRanking(plan, rankings);

		expect(outcome.failures).toBe(1);
		expect(rankings).toEqual([]);
		expect(after.proposals[0].chosen?.tx.id).toBe(plan.proposals[0].chosen?.tx.id);
		expect(after.proposals[0].chosen?.aiReason).toBeUndefined();
	});

	it("discards a hallucinated candidate reference and says how many it threw out", async () => {
		callModel.mockResolvedValue(reply({ matches: [{ ref: "t99", confidence: 1, reason: "definitely" }] }));

		const { rankings, outcome } = await aiRankPlan(twoCandidatePlan(), {});

		expect(outcome.rejected).toEqual([{ ref: "t99", reason: "not a candidate we asked about" }]);
		expect(rankings[0].verdicts).toEqual([]);
	});
});

describe("describeAiOutcome", () => {
	it("says nothing when the pass did nothing, so the results screen stays quiet", () => {
		expect(describeAiOutcome({ read: 0, ranked: 0, failures: 0, model: "", rejected: [], unreadable: 0 })).toBeUndefined();
	});

	it("names the failure and points at what the results actually are", () => {
		const notice = describeAiOutcome({ read: 1, ranked: 0, failures: 2, lastError: "Rate limited", model: "m", rejected: [], unreadable: 0 });
		expect(notice).toContain("Claude read 1 document");
		expect(notice).toContain("2 requests failed (Rate limited)");
		expect(notice).toContain("the matches below are the deterministic ones");
	});
});

describe("a document nothing could read", () => {
	it("names the provider instead of letting it read as 'nothing matched'", () => {
		const notice = describeAiOutcome({ read: 0, ranked: 0, failures: 0, model: "", rejected: [], unreadable: 1 });
		// "No confident match" is what the row says, and on its own it implies the document was looked at
		// and lost. The notice has to say it was never looked at, and what would fix that.
		expect(notice).toContain("could not be read");
		expect(notice).toContain("API key provider");
	});

	it("counts several and still reads as one sentence", () => {
		const notice = describeAiOutcome({ read: 1, ranked: 2, failures: 0, model: "m", rejected: [], unreadable: 2 });
		expect(notice).toContain("Claude read 1 document");
		expect(notice).toContain("2 documents could not be read");
	});
});
