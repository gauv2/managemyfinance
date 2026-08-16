import { describe, expect, it } from "vitest";
import {
	applyAiRanking,
	checkFileSelection,
	describeInvoicePeriod,
	describeOutcome,
	describeSearchScope,
	documentLabel,
	invoicePeriodRange,
	isSupportedInvoiceFile,
	matchInvoices,
	MAX_INVOICE_FILES,
	scoreCandidate,
	summarizeOutcome,
	transactionsInPeriod,
	type InvoiceCandidateTx,
	type InvoiceDocument,
	type InvoicePeriod,
} from "./invoiceMatch";

/**
 * The matching engine on its own, against plain object literals.
 *
 * The point of keeping this module free of Obsidian is exactly this file: every safeguard the feature
 * promises — never overwriting an attachment, never straying outside the period, never handing one
 * transaction to two receipts, never calling a coin toss a match — is a claim that can be stated as a
 * sentence and checked in five lines.
 */

let seq = 0;
function tx(over: Partial<InvoiceCandidateTx> = {}): InvoiceCandidateTx {
	seq++;
	return {
		id: `t${seq}`,
		date: "2026-04-12",
		accountId: "acc-1",
		description: "Some shop",
		amount: -49.99,
		currency: "EUR",
		...over,
	};
}

function doc(over: Partial<InvoiceDocument> = {}): InvoiceDocument {
	return { id: "doc-0", filename: "receipt.pdf", ...over };
}

const APRIL: InvoicePeriod = { kind: "month", year: 2026, month: 4 };

describe("invoicePeriodRange", () => {
	it("gives a whole month, ending on its real last day", () => {
		expect(invoicePeriodRange({ kind: "month", year: 2026, month: 4 })).toEqual({ from: "2026-04-01", to: "2026-04-30" });
	});

	it("ends February on the 29th in a leap year", () => {
		expect(invoicePeriodRange({ kind: "month", year: 2028, month: 2 }).to).toBe("2028-02-29");
	});

	it("spans a quarter from the first of its first month to the last of its third", () => {
		expect(invoicePeriodRange({ kind: "quarter", year: 2026, quarter: 2 })).toEqual({ from: "2026-04-01", to: "2026-06-30" });
	});

	it("spans a whole calendar year", () => {
		expect(invoicePeriodRange({ kind: "year", year: 2026 })).toEqual({ from: "2026-01-01", to: "2026-12-31" });
	});

	it("names the period the way the person who chose it would", () => {
		expect(describeInvoicePeriod({ kind: "month", year: 2026, month: 4 })).toBe("April 2026");
		expect(describeInvoicePeriod({ kind: "quarter", year: 2026, quarter: 2 })).toBe("Q2 2026");
		expect(describeInvoicePeriod({ kind: "year", year: 2026 })).toBe("2026");
	});

	it("quotes the range it is about to search", () => {
		expect(describeSearchScope(82, { kind: "quarter", year: 2026, quarter: 2 })).toBe(
			"Searching 82 transactions from 2026-04-01 through 2026-06-30"
		);
	});
});

describe("transactionsInPeriod", () => {
	it("keeps both ends of the period inclusive", () => {
		const rows = [tx({ date: "2026-04-01" }), tx({ date: "2026-04-30" }), tx({ date: "2026-03-31" }), tx({ date: "2026-05-01" })];
		expect(transactionsInPeriod(rows, APRIL).map((r) => r.date)).toEqual(["2026-04-01", "2026-04-30"]);
	});
});

describe("checkFileSelection", () => {
	it("accepts the formats a receipt actually arrives in", () => {
		expect(isSupportedInvoiceFile("Invoice.PDF")).toBe(true);
		expect(isSupportedInvoiceFile("photo.jpeg")).toBe(true);
		expect(isSupportedInvoiceFile("notes.docx")).toBe(false);
	});

	it("refuses a batch over ten and says how many were dropped in", () => {
		const names = Array.from({ length: 11 }, (_, i) => `receipt-${i}.pdf`);
		const check = checkFileSelection(names);
		expect(check.accepted).toHaveLength(11);
		expect(check.tooMany).toContain("11 files");
		expect(check.tooMany).toContain(`${MAX_INVOICE_FILES} at a time`);
	});

	it("is happy with exactly ten", () => {
		const names = Array.from({ length: MAX_INVOICE_FILES }, (_, i) => `receipt-${i}.pdf`);
		expect(checkFileSelection(names).tooMany).toBeUndefined();
	});

	it("counts the cap against readable files only, so unsupported extras don't tip it over", () => {
		const names = [...Array.from({ length: 9 }, (_, i) => `receipt-${i}.pdf`), "notes.txt", "sheet.xlsx"];
		const check = checkFileSelection(names);
		expect(check.tooMany).toBeUndefined();
		expect(check.unsupported).toEqual(["notes.txt", "sheet.xlsx"]);
	});
});

describe("scoreCandidate", () => {
	it("calls an exact amount, an exact merchant and the same date a High match", () => {
		const candidate = scoreCandidate(
			doc({ vendor: "Albert Heijn", date: "2026-04-12", total: 49.99, currency: "EUR" }),
			tx({ description: "CCV*ALBERT HEIJN 1423 DEN HAAG" })
		);
		expect(candidate.signals.amountExact).toBe(true);
		expect(candidate.confidence).toBe("high");
		expect(candidate.reason).toBe("Exact amount and merchant; same date");
	});

	it("names the date gap in the explanation", () => {
		const candidate = scoreCandidate(
			doc({ vendor: "Albert Heijn", date: "2026-04-11", total: 49.99 }),
			tx({ description: "ALBERT HEIJN 1423" })
		);
		expect(candidate.reason).toBe("Exact amount and merchant; date difference 1 day");
	});

	it("treats a cent of rounding as the same amount and two cents as not", () => {
		const document = doc({ total: 49.99 });
		expect(scoreCandidate(document, tx({ amount: -50.0 })).signals.amountExact).toBe(true);
		expect(scoreCandidate(document, tx({ amount: -50.01 })).signals.amountExact).toBe(false);
	});

	it("refuses to call anything High when the amounts disagree, however well everything else fits", () => {
		const candidate = scoreCandidate(
			doc({ vendor: "Albert Heijn", date: "2026-04-12", total: 60.0 }),
			tx({ description: "ALBERT HEIJN 1423", amount: -49.99 })
		);
		expect(candidate.confidence).not.toBe("high");
	});

	it("scores an invoice against an incoming payment at zero — that is the wrong side of the ledger", () => {
		const candidate = scoreCandidate(doc({ total: 49.99, date: "2026-04-12" }), tx({ amount: 49.99 }));
		expect(candidate.score).toBe(0);
		expect(candidate.reason).toBe("That row is money in, not a payment");
	});

	it("matches a credit note to money coming back instead", () => {
		const document = doc({ total: 49.99, date: "2026-04-12", credit: true });
		expect(scoreCandidate(document, tx({ amount: 49.99 })).score).toBeGreaterThan(0);
		expect(scoreCandidate(document, tx({ amount: -49.99 })).score).toBe(0);
	});

	it("rules out a candidate whose currency differs, rather than scoring it low", () => {
		const candidate = scoreCandidate(doc({ total: 49.99, currency: "USD" }), tx({ currency: "EUR" }));
		expect(candidate.score).toBe(0);
		expect(candidate.reason).toContain("Currency differs");
	});

	it("finds an invoice number buried in the bank text despite different punctuation", () => {
		const candidate = scoreCandidate(
			doc({ total: 49.99, invoiceNumber: "INV-2026/00417" }),
			tx({ description: "Factuur INV2026 00417 betaald" })
		);
		expect(candidate.signals.referenceHit).toBe(true);
		expect(candidate.reason).toContain("reference found in the bank text");
	});

	it("ignores a reference too short to be an identifier", () => {
		expect(scoreCandidate(doc({ total: 49.99, reference: "12" }), tx({ description: "Payment 12345" })).signals.referenceHit).toBe(
			false
		);
	});

	it("counts a date beyond the window against a candidate rather than for it", () => {
		const document = doc({ vendor: "Albert Heijn", date: "2026-04-01", total: 49.99 });
		const near = scoreCandidate(document, tx({ date: "2026-04-02", description: "ALBERT HEIJN" }));
		const far = scoreCandidate(document, tx({ date: "2026-04-28", description: "ALBERT HEIJN" }));
		expect(far.score).toBeLessThan(near.score);
		expect(far.confidence).not.toBe("high");
	});
});

describe("matchInvoices", () => {
	it("ticks a clean, unambiguous, high-confidence match", () => {
		const plan = matchInvoices(
			[doc({ vendor: "Albert Heijn", date: "2026-04-12", total: 49.99 })],
			[tx({ description: "CCV*ALBERT HEIJN 1423" }), tx({ description: "Netflix", amount: -12.99 })],
			APRIL
		);
		expect(plan.searched).toBe(2);
		expect(plan.proposals[0].selected).toBe(true);
		expect(plan.proposals[0].chosen?.confidence).toBe("high");
		expect(plan.proposals[0].blockedReason).toBeUndefined();
	});

	it("excludes transactions dated outside the selected period, however perfectly they match", () => {
		const perfect = tx({ date: "2026-05-12", description: "CCV*ALBERT HEIJN 1423" });
		const plan = matchInvoices([doc({ vendor: "Albert Heijn", date: "2026-04-12", total: 49.99 })], [perfect], APRIL);
		expect(plan.searched).toBe(0);
		expect(plan.proposals[0].candidates).toHaveLength(0);
		expect(plan.proposals[0].chosen).toBeUndefined();
		expect(plan.proposals[0].blockedReason).toBe("No confident match");
	});

	it("refuses to pick between two candidates that score alike, and says why", () => {
		const plan = matchInvoices(
			[doc({ vendor: "Cafe Ola", date: "2026-04-10", total: 25.0 })],
			[
				tx({ date: "2026-04-10", description: "CAFE OLA AMSTERDAM", amount: -25.0 }),
				tx({ date: "2026-04-10", description: "CAFE OLA ROTTERDAM", amount: -25.0 }),
			],
			APRIL
		);
		expect(plan.proposals[0].chosen).toBeDefined();
		expect(plan.proposals[0].selected).toBe(false);
		expect(plan.proposals[0].blockedReason).toBe("Another transaction in this period scores just as well");
		expect(plan.proposals[0].chosen?.confidence).not.toBe("high");
	});

	it("labels a transaction that already carries a file and never ticks it", () => {
		const plan = matchInvoices(
			[doc({ vendor: "Albert Heijn", date: "2026-04-12", total: 49.99 })],
			[tx({ description: "CCV*ALBERT HEIJN 1423", attachmentPath: "Finance/attachments/old.pdf" })],
			APRIL
		);
		expect(plan.proposals[0].chosen?.alreadyAttached).toBe(true);
		expect(plan.proposals[0].selected).toBe(false);
		expect(plan.proposals[0].blockedReason).toBe("Already attached");
	});

	it("gives one transaction to only one document, and sends the loser to its own next-best", () => {
		const first = tx({ date: "2026-04-12", description: "CCV*ALBERT HEIJN 1423", amount: -49.99 });
		const second = tx({ date: "2026-04-14", description: "ALBERT HEIJN 5566", amount: -49.99 });
		const plan = matchInvoices(
			[
				doc({ id: "doc-0", filename: "a.pdf", vendor: "Albert Heijn", date: "2026-04-12", total: 49.99 }),
				doc({ id: "doc-1", filename: "b.pdf", vendor: "Albert Heijn", date: "2026-04-14", total: 49.99 }),
			],
			[first, second],
			APRIL
		);
		const chosenIds = plan.proposals.map((p) => p.chosen?.tx.id);
		expect(chosenIds).toContain(first.id);
		expect(chosenIds).toContain(second.id);
		expect(new Set(chosenIds).size).toBe(2);
	});

	it("leaves the second of two identical receipts unmatched when only one transaction exists", () => {
		const only = tx({ date: "2026-04-12", description: "CCV*ALBERT HEIJN 1423", amount: -49.99 });
		const plan = matchInvoices(
			[
				doc({ id: "doc-0", filename: "a.pdf", vendor: "Albert Heijn", date: "2026-04-12", total: 49.99 }),
				doc({ id: "doc-1", filename: "b.pdf", vendor: "Albert Heijn", date: "2026-04-12", total: 49.99 }),
			],
			[only],
			APRIL
		);
		const assigned = plan.proposals.filter((p) => p.chosen);
		expect(assigned).toHaveLength(1);
		expect(plan.proposals.find((p) => !p.chosen)?.blockedReason).toBe("No confident match");
	});

	it("caps the shortlist so a busy period doesn't turn into an unreadable list", () => {
		const rows = Array.from({ length: 20 }, (_, i) => tx({ date: "2026-04-05", amount: -49.99, description: `Shop ${i}` }));
		const plan = matchInvoices([doc({ total: 49.99, date: "2026-04-05" })], rows, APRIL);
		expect(plan.proposals[0].candidates).toHaveLength(5);
	});
});

describe("applyAiRanking", () => {
	const document = doc({ vendor: "AH To Go", date: "2026-04-12", total: 49.99 });

	function planWithTwo(): ReturnType<typeof matchInvoices> {
		return matchInvoices(
			[document],
			[
				tx({ id: "wrong", date: "2026-04-12", description: "Some Shop", amount: -49.99 }),
				tx({ id: "right", date: "2026-04-12", description: "CCV*ALBERT HEIJN 1423", amount: -49.99 }),
			],
			APRIL
		);
	}

	it("lets Claude promote the candidate a string comparison could never have found", () => {
		const before = planWithTwo();
		const after = applyAiRanking(before, [
			{ docId: "doc-0", verdicts: [{ txId: "right", confidence: 1, reason: "AH To Go is Albert Heijn's convenience format" }] },
		]);
		expect(after.proposals[0].chosen?.tx.id).toBe("right");
		expect(after.proposals[0].chosen?.aiReason).toBe("AH To Go is Albert Heijn's convenience format");
	});

	it("still refuses High to a candidate whose amount is wrong, however sure Claude is", () => {
		const before = matchInvoices([doc({ vendor: "Albert Heijn", date: "2026-04-12", total: 60 })], [tx({ id: "cheap", amount: -49.99, description: "ALBERT HEIJN" })], APRIL);
		const after = applyAiRanking(before, [{ docId: "doc-0", verdicts: [{ txId: "cheap", confidence: 1, reason: "definitely this one" }] }]);
		expect(after.proposals[0].chosen?.confidence).not.toBe("high");
		expect(after.proposals[0].selected).toBe(false);
	});

	it("never lets a ranking resurrect a transaction that already has a file", () => {
		const before = matchInvoices(
			[document],
			[tx({ id: "taken", description: "CCV*ALBERT HEIJN 1423", attachmentPath: "Finance/attachments/old.pdf" })],
			APRIL
		);
		const after = applyAiRanking(before, [{ docId: "doc-0", verdicts: [{ txId: "taken", confidence: 1, reason: "same shop" }] }]);
		expect(after.proposals[0].selected).toBe(false);
		expect(after.proposals[0].blockedReason).toBe("Already attached");
	});

	it("ignores verdicts about documents and transactions it has never heard of", () => {
		const before = planWithTwo();
		const after = applyAiRanking(before, [
			{ docId: "doc-99", verdicts: [{ txId: "right", confidence: 1, reason: "x" }] },
			{ docId: "doc-0", verdicts: [{ txId: "ghost", confidence: 1, reason: "x" }] },
		]);
		// The plan comes back exactly as the deterministic pass left it — no throw, and no verdict applied.
		expect(after.proposals[0].chosen?.tx.id).toBe(before.proposals[0].chosen?.tx.id);
		expect(after.proposals[0].chosen?.aiReason).toBeUndefined();
		expect(after.proposals[0].chosen?.score).toBe(before.proposals[0].chosen?.score);
	});
});

describe("summarizeOutcome", () => {
	it("counts skipped and unmatched apart, because they mean different things", () => {
		const plan = matchInvoices(
			[
				doc({ id: "doc-0", vendor: "Albert Heijn", date: "2026-04-12", total: 49.99 }),
				doc({ id: "doc-1", vendor: "Albert Heijn", date: "2026-04-12", total: 49.99 }),
				doc({ id: "doc-2", vendor: "Nothing At All", date: "2026-04-12", total: 1234.56 }),
			],
			[tx({ description: "CCV*ALBERT HEIJN 1423" }), tx({ description: "ALBERT HEIJN 5566" })],
			APRIL
		);
		const outcome = summarizeOutcome(plan.proposals, new Set(["doc-0"]), new Set());
		expect(outcome).toEqual({ attached: 1, skipped: 1, unmatched: 1, failed: 0 });
		expect(describeOutcome(outcome)).toBe("1 attached · 1 skipped · 1 unmatched");
	});

	it("reports a failure ahead of anything else that document might also have been", () => {
		const plan = matchInvoices([doc({ vendor: "Albert Heijn", date: "2026-04-12", total: 49.99 })], [tx({ description: "ALBERT HEIJN" })], APRIL);
		expect(summarizeOutcome(plan.proposals, new Set(["doc-0"]), new Set(["doc-0"]))).toEqual({
			attached: 0,
			skipped: 0,
			unmatched: 0,
			failed: 1,
		});
	});
});

describe("documentLabel", () => {
	it("prefers the vendor, falls back to a cleaned filename, and never returns nothing", () => {
		expect(documentLabel(doc({ vendor: "Bol.com" }))).toBe("Bol.com");
		expect(documentLabel(doc({ filename: "ALBERT HEIJN 1423.pdf" }))).toBe("Albert Heijn");
		expect(documentLabel(doc({ filename: "1423.pdf" }))).toBe("1423.pdf");
	});
});
