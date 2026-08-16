import { describe, expect, it } from "vitest";
import {
	buildInvoiceExtractPrompt,
	buildInvoiceRankPrompt,
	describeAiDisclosure,
	validateInvoiceExtract,
	validateInvoiceRanking,
	type AiRankCandidate,
} from "./invoicePrompt";
import type { InvoiceDocument } from "../invoiceMatch";

/**
 * What leaves the vault, and what is allowed back in.
 *
 * The prompt builders are asserted on their exact output rather than loosely, because these are the
 * only functions in the feature whose result is a disclosure: a field that quietly starts appearing in
 * the payload is a privacy change, and it should break a test rather than ship.
 */

const doc: InvoiceDocument = {
	id: "doc-0",
	filename: "2026-04-12 Hosting Heroes.pdf",
	vendor: "Hosting Heroes B.V.",
	date: "2026-04-12",
	total: 49.99,
	currency: "EUR",
	invoiceNumber: "2026-00417",
};

const candidates: AiRankCandidate[] = [
	{ ref: "t1", date: "2026-04-12", merchant: "Hosting Heroes", amount: -49.99, currency: "EUR" },
	{ ref: "t2", date: "2026-04-14", merchant: "Netflix", amount: -12.99, currency: "EUR" },
];

describe("buildInvoiceExtractPrompt", () => {
	it("sends the locally extracted text when there is some, rather than the file", () => {
		const prompt = buildInvoiceExtractPrompt("invoice.pdf", "Totaal incl. BTW € 49.99");
		expect(prompt).toContain("Totaal incl. BTW € 49.99");
		expect(prompt).not.toContain("read the attached document itself");
	});

	it("says outright that there is nothing but the file to go on when extraction failed", () => {
		expect(buildInvoiceExtractPrompt("photo.jpg")).toContain("read the attached document itself");
	});

	it("trims a runaway text extraction rather than sending a whole book", () => {
		const prompt = buildInvoiceExtractPrompt("invoice.pdf", "x".repeat(20000));
		expect(prompt.length).toBeLessThan(7000);
	});
});

describe("buildInvoiceRankPrompt", () => {
	it("sends the document's fields and the shortlist, and nothing that identifies the vault", () => {
		const prompt = buildInvoiceRankPrompt(doc, candidates);
		expect(prompt).toContain("vendor: Hosting Heroes B.V.");
		expect(prompt).toContain("total: 49.99 EUR");
		expect(prompt).toContain("- t1: 2026-04-12 | Hosting Heroes | -49.99 EUR");
		// The mapping from ref back to a transaction id stays local; ids and account names never go over.
		expect(prompt).not.toContain("doc-0");
		expect(prompt).not.toContain("accountId");
	});

	it("admits to the model that the document yielded nothing, instead of sending an empty list of facts", () => {
		expect(buildInvoiceRankPrompt({ id: "doc-1", filename: "IMG.jpg" }, candidates)).toContain(
			"nothing could be read from this document"
		);
	});

	it("flags a credit note so the model isn't asked to match a refund to a payment", () => {
		expect(buildInvoiceRankPrompt({ ...doc, credit: true }, candidates)).toContain("this is a credit note or refund");
	});
});

describe("validateInvoiceExtract", () => {
	it("keeps a well-formed answer", () => {
		expect(
			validateInvoiceExtract({
				vendor: "  Bol.com  ",
				date: "2026-04-12",
				total: 49.99,
				currency: "eur",
				invoiceNumber: "INV-1",
				credit: true,
			})
		).toEqual({ vendor: "Bol.com", date: "2026-04-12", total: 49.99, currency: "EUR", invoiceNumber: "INV-1", credit: true });
	});

	it("throws away a total that arrived as a string, which would have matched nothing as NaN", () => {
		expect(validateInvoiceExtract({ total: "49,99" }).total).toBeUndefined();
	});

	it("throws away a date that isn't one, which would have made every day gap undefined", () => {
		expect(validateInvoiceExtract({ date: "12 April 2026" }).date).toBeUndefined();
	});

	it("throws away a currency that isn't a code, which would have conflicted with every row in the period", () => {
		expect(validateInvoiceExtract({ currency: "euros" }).currency).toBeUndefined();
	});

	it("takes the magnitude of a total the model signed for us", () => {
		expect(validateInvoiceExtract({ total: -49.99 }).total).toBe(49.99);
	});

	it("returns an empty set of fields for an empty or nonsense reply", () => {
		expect(validateInvoiceExtract({})).toEqual({});
		expect(validateInvoiceExtract(null)).toEqual({});
	});
});

describe("validateInvoiceRanking", () => {
	it("keeps verdicts about candidates we asked about, best first", () => {
		const { verdicts, rejected } = validateInvoiceRanking(
			{
				matches: [
					{ ref: "t2", confidence: 0.4, reason: "same week" },
					{ ref: "t1", confidence: 0.95, reason: "exact amount and name" },
				],
			},
			candidates
		);
		expect(verdicts.map((v) => v.ref)).toEqual(["t1", "t2"]);
		expect(rejected).toEqual([]);
	});

	it("refuses a candidate reference nobody offered — that would attach a receipt to a stranger", () => {
		const { verdicts, rejected } = validateInvoiceRanking({ matches: [{ ref: "t9", confidence: 1, reason: "x" }] }, candidates);
		expect(verdicts).toEqual([]);
		expect(rejected).toEqual([{ ref: "t9", reason: "not a candidate we asked about" }]);
	});

	it("keeps only the first of two answers about the same candidate", () => {
		const { verdicts, rejected } = validateInvoiceRanking(
			{ matches: [{ ref: "t1", confidence: 0.9, reason: "a" }, { ref: "t1", confidence: 0.2, reason: "b" }] },
			candidates
		);
		expect(verdicts).toHaveLength(1);
		expect(rejected[0].reason).toBe("duplicate answer");
	});

	it("clamps a confidence outside 0-1 rather than letting it distort the blend", () => {
		const { verdicts } = validateInvoiceRanking({ matches: [{ ref: "t1", confidence: 7, reason: "x" }] }, candidates);
		expect(verdicts[0].confidence).toBe(1);
	});

	it("throws when the reply has no matches list at all, so the caller can fall back", () => {
		expect(() => validateInvoiceRanking({ result: [] }, candidates)).toThrow(/matches/);
	});
});

describe("describeAiDisclosure", () => {
	it("distinguishes uploading a file from sending text read out of it", () => {
		expect(describeAiDisclosure(2, 1, 5)).toContain("2 documents will be uploaded in full");
		expect(describeAiDisclosure(2, 1, 5)).toContain("text from 1 document will be sent");
		expect(describeAiDisclosure(0, 0, 5)).toContain("the vendor, date and total read from each document will be sent");
	});

	it("says how much of the ledger goes with it", () => {
		expect(describeAiDisclosure(0, 0, 5)).toContain("up to 5 shortlisted transactions per document");
	});
});
