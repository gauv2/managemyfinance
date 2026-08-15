import { describe, expect, it } from "vitest";
import {
	buildInvoiceDocument,
	fieldsFromFilename,
	fieldsFromText,
	findDates,
	findInvoiceDate,
	findTotal,
	findVendor,
	localExtractionSufficient,
} from "./invoiceExtract";

/**
 * Reading invoices, against the shapes real ones actually arrive in.
 *
 * The cases that matter are the ambiguous ones — two dates on the page, three numbers called "total",
 * a filename that is either a price or a reference number — because those are where a parser is wrong
 * confidently rather than wrong obviously.
 */

const DUTCH_INVOICE = [
	"Hosting Heroes B.V.",
	"Keizersgracht 100",
	"1015 CS Amsterdam",
	"",
	"FACTUUR",
	"Factuurnummer: 2026-00417",
	"Factuurdatum: 12-04-2026",
	"Vervaldatum: 12-05-2026",
	"",
	"Webhosting jaarpakket    41.31",
	"BTW 21%                   8.68",
	"Totaal incl. BTW      € 49.99",
].join("\n");

describe("findDates", () => {
	it("reads an ISO date", () => {
		expect(findDates("dated 2026-04-12 here")).toEqual(["2026-04-12"]);
	});

	it("reads a European numeric date day-first", () => {
		expect(findDates("12-04-2026")).toEqual(["2026-04-12"]);
		expect(findDates("03/04/2026")).toEqual(["2026-04-03"]);
	});

	it("reads a written date in either language and either order", () => {
		expect(findDates("12 April 2026")).toEqual(["2026-04-12"]);
		expect(findDates("12 april 2026")).toEqual(["2026-04-12"]);
		expect(findDates("April 12, 2026")).toEqual(["2026-04-12"]);
		expect(findDates("1 oktober 2026")).toEqual(["2026-10-01"]);
	});

	it("refuses a date that does not exist", () => {
		expect(findDates("31-02-2026")).toEqual([]);
		expect(findDates("12-13-2026")).toEqual([]);
	});
});

describe("findInvoiceDate", () => {
	it("takes the invoice date rather than the due date, whichever comes first on the page", () => {
		expect(findInvoiceDate(DUTCH_INVOICE)).toBe("2026-04-12");
	});

	it("prefers a labelled date over an unlabelled one earlier in the text", () => {
		expect(findInvoiceDate("Period 01-01-2026 to 31-03-2026\nInvoice date: 05-04-2026")).toBe("2026-04-05");
	});

	it("falls back to the first date it can find when nothing is labelled", () => {
		expect(findInvoiceDate("Bought on 12-04-2026, thanks")).toBe("2026-04-12");
	});
});

describe("findTotal", () => {
	it("takes the payable gross, not the net or the VAT line", () => {
		expect(findTotal(DUTCH_INVOICE)).toEqual({ total: 49.99, currency: "EUR" });
	});

	it("prefers 'amount due' over a bare 'total' elsewhere on the page", () => {
		expect(findTotal("Total 100.00\nDiscount -10.00\nAmount due: 90.00")?.total).toBe(90);
	});

	it("reads a comma decimal separator and a dot thousands separator", () => {
		expect(findTotal("Totaal: € 1.234,56")).toEqual({ total: 1234.56, currency: "EUR" });
	});

	it("picks up a currency written after the number as well as before it", () => {
		expect(findTotal("Total: 42.00 USD")).toEqual({ total: 42, currency: "USD" });
	});

	it("has nothing to say about a page with no total on it", () => {
		expect(findTotal("Thank you for your custom")).toBeUndefined();
	});
});

describe("findVendor", () => {
	it("takes the supplier's name from the top and skips the document-type heading", () => {
		expect(findVendor(DUTCH_INVOICE)).toBe("Hosting Heroes B.V.");
	});

	it("skips a heading, an address line of digits, and a URL", () => {
		expect(findVendor("INVOICE\n1015 CS 100\nwww.example.com\nCafe Ola\n")).toBe("Cafe Ola");
	});
});

describe("fieldsFromText", () => {
	it("reads a whole Dutch invoice in one pass", () => {
		expect(fieldsFromText(DUTCH_INVOICE)).toEqual({
			vendor: "Hosting Heroes B.V.",
			date: "2026-04-12",
			total: 49.99,
			currency: "EUR",
			invoiceNumber: "2026-00417",
		});
	});

	it("recognises a credit note for what it is", () => {
		expect(fieldsFromText("Creditnota\nTotaal: € 20,00").credit).toBe(true);
		expect(fieldsFromText("Invoice\nTotal: 20.00").credit).toBeUndefined();
	});

	it("finds nothing in nothing, rather than inventing it", () => {
		expect(fieldsFromText("   ")).toEqual({});
	});
});

describe("fieldsFromFilename", () => {
	it("reads a well-named receipt completely", () => {
		expect(fieldsFromFilename("2026-04-12 Bol.com 49,99.pdf")).toEqual({
			date: "2026-04-12",
			total: 49.99,
			vendor: "Bol.com",
		});
	});

	it("refuses to read a bare integer as an amount — that is an invoice number, not euros", () => {
		expect(fieldsFromFilename("invoice 00417.pdf").total).toBeUndefined();
	});

	it("gets nothing useful out of a camera filename, and says so by returning nothing", () => {
		expect(fieldsFromFilename("IMG_4821.jpeg").vendor).toBeUndefined();
	});
});

describe("buildInvoiceDocument", () => {
	it("prefers the document's own text but keeps a field only the filename supplied", () => {
		const built = buildInvoiceDocument("doc-0", "2026-04-12 Hosting Heroes.pdf", "Totaal incl. BTW € 49.99");
		expect(built.total).toBe(49.99);
		expect(built.date).toBe("2026-04-12");
		expect(built.source).toBe("text");
	});

	it("falls back to the filename when the file gave up no text at all", () => {
		const built = buildInvoiceDocument("doc-0", "2026-04-12 Bol.com 49,99.pdf");
		expect(built).toMatchObject({ id: "doc-0", total: 49.99, date: "2026-04-12", vendor: "Bol.com", source: "filename" });
	});

	it("admits when it found nothing", () => {
		expect(buildInvoiceDocument("doc-0", "IMG_4821.jpeg", "").source).toBe("none");
	});
});

describe("localExtractionSufficient", () => {
	it("is never satisfied without a total, whatever else was found", () => {
		expect(localExtractionSufficient({ id: "d", filename: "f.pdf", vendor: "Bol.com", date: "2026-04-12" })).toBe(false);
	});

	it("wants one corroborating field alongside the total", () => {
		expect(localExtractionSufficient({ id: "d", filename: "f.pdf", total: 49.99 })).toBe(false);
		expect(localExtractionSufficient({ id: "d", filename: "f.pdf", total: 49.99, date: "2026-04-12" })).toBe(true);
	});
});
