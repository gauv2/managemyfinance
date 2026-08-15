import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildInvoiceDocument, localExtractionSufficient } from "./invoiceExtract";
import { extractPdfText, textFromContentStream } from "./invoicePdfText";

/**
 * The PDF reader, against PDFs assembled here rather than checked in as binaries.
 *
 * Building the fixture in the test is the point: it states exactly which parts of the format are being
 * relied on — a Flate-wrapped content stream and the Tj/TJ operators inside it — so the day one of them
 * stops working the failure names the assumption instead of pointing at an opaque file.
 */

/** A minimal but structurally real PDF carrying one content stream. */
function pdfWith(content: string, compress: boolean): Uint8Array {
	const body = compress ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
	const head = Buffer.from(
		`%PDF-1.4\n1 0 obj\n<< /Type /Page /Contents 2 0 R >>\nendobj\n2 0 obj\n<< /Length ${body.length}${
			compress ? " /Filter /FlateDecode" : ""
		} >>\nstream\n`,
		"latin1"
	);
	const tail = Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");
	return new Uint8Array(Buffer.concat([head, body, tail]));
}

const INVOICE_CONTENT = [
	"BT",
	"/F1 12 Tf",
	"72 720 Td (Hosting Heroes B.V.) Tj",
	"0 -20 Td (Factuurdatum: 12-04-2026) Tj",
	"0 -20 Td [(Totaal incl. BTW) -250 (49.99)] TJ",
	"ET",
].join("\n");

describe("textFromContentStream", () => {
	it("pulls the drawn strings out of a content stream", () => {
		const text = textFromContentStream("BT (Hello) Tj 0 -20 Td (World) Tj ET");
		expect(text).toContain("Hello");
		expect(text).toContain("World");
	});

	it("keeps two runs on separate lines when the pen moved between them", () => {
		const text = textFromContentStream("BT (Totaal) Tj 0 -20 Td (49.99) Tj ET");
		expect(text.split(/\n+/).map((line) => line.trim()).filter(Boolean)).toEqual(["Totaal", "49.99"]);
	});

	it("reads a nested parenthesis as part of the string rather than the end of it", () => {
		expect(textFromContentStream("BT (Totaal (incl. BTW)) Tj ET")).toContain("Totaal (incl. BTW)");
	});

	it("unescapes the sequences a generator uses for literal brackets and backslashes", () => {
		expect(textFromContentStream("BT (a \\(b\\) c \\\\ d) Tj ET")).toContain("a (b) c \\ d");
	});

	it("reads an octal escape back to its character", () => {
		expect(textFromContentStream("BT (caf\\351) Tj ET")).toContain("café");
	});

	it("reads a hex string", () => {
		expect(textFromContentStream("BT <48656C6C6F> Tj ET")).toContain("Hello");
	});
});

describe("extractPdfText", () => {
	it("reads an uncompressed content stream", async () => {
		const text = await extractPdfText(pdfWith(INVOICE_CONTENT, false));
		expect(text).toContain("Hosting Heroes B.V.");
		expect(text).toContain("12-04-2026");
		expect(text).toContain("49.99");
	});

	it("inflates a FlateDecode content stream and reads that too", async () => {
		const text = await extractPdfText(pdfWith(INVOICE_CONTENT, true));
		expect(text).toContain("Hosting Heroes B.V.");
		expect(text).toContain("49.99");
	});

	it("returns nothing for a file that is not a PDF, instead of throwing", async () => {
		await expect(extractPdfText(new Uint8Array([1, 2, 3, 4]))).resolves.toBe("");
	});

	it("returns nothing for a scanned PDF, whose only stream is a picture", async () => {
		const image = new Uint8Array(
			Buffer.from(
				"%PDF-1.4\n2 0 obj\n<< /Type /XObject /Subtype /Image /Length 4 /Filter /DCTDecode >>\nstream\n\xff\xd8\xff\xdb\nendstream\n%%EOF\n",
				"latin1"
			)
		);
		await expect(extractPdfText(image)).resolves.toBe("");
	});

	it("survives a truncated file rather than taking the rest of the batch down with it", async () => {
		const truncated = pdfWith(INVOICE_CONTENT, true).slice(0, 80);
		await expect(extractPdfText(truncated)).resolves.toBeTypeOf("string");
	});

	it("hands the fields parser enough to read a real invoice without asking anyone", async () => {
		const text = await extractPdfText(pdfWith(INVOICE_CONTENT, true));
		const built = buildInvoiceDocument("doc-0", "invoice.pdf", text);
		expect(built).toMatchObject({ vendor: "Hosting Heroes B.V.", date: "2026-04-12", total: 49.99, source: "text" });
		expect(localExtractionSufficient(built)).toBe(true);
	});
});

describe("the seam between reading a PDF and parsing its fields", () => {
	/** A page that positions every line with Tm, which is what most generators emit. */
	const TM_POSITIONED = [
		"BT /F1 12 Tf",
		"1 0 0 1 60 760 Tm (VCK Cruises Destin B.V.) Tj",
		"1 0 0 1 60 690 Tm (Invoice date: 26-05-2026) Tj",
		"1 0 0 1 60 610 Tm (VAT 21% EUR 1911.51) Tj",
		"1 0 0 1 60 585 Tm (Total EUR 11013.95) Tj",
		"ET",
	].join("\n");

	it("keeps Tm-positioned lines apart instead of running them together", () => {
		const text = textFromContentStream(TM_POSITIONED);
		// The failure this pins produced "…EUR 1911.51Total EUR 11013.95", which no line-oriented parser
		// can read — and every field except the reference came back empty as a result.
		expect(text).toContain("Total EUR 11013.95");
		expect(text).not.toContain("1911.51Total");
		expect(text.split("\n").filter((l) => l.trim()).length).toBe(4);
	});
});
