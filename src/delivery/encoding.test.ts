import { describe, expect, it } from "vitest";
import { buildMultipart, randomBoundary, toBase64 } from "./encoding";

function decode(buffer: ArrayBuffer): string {
	return new TextDecoder().decode(new Uint8Array(buffer));
}

describe("toBase64", () => {
	it("encodes bytes the way atob reverses", () => {
		const bytes = new TextEncoder().encode("Restaurants · 2025");
		expect(atob(toBase64(bytes))).toBe(new TextDecoder("latin1").decode(bytes));
	});

	it("handles the full byte range, as a PDF will contain", () => {
		const bytes = new Uint8Array(256);
		for (let i = 0; i < 256; i++) bytes[i] = i;
		const round = Uint8Array.from(atob(toBase64(bytes)), (c) => c.charCodeAt(0));
		expect(Array.from(round)).toEqual(Array.from(bytes));
	});

	// Spreading a megabyte into String.fromCharCode(...) overflows the stack; a PDF is that size.
	it("survives a payload larger than the argument-list limit", () => {
		const bytes = new Uint8Array(600_000).fill(65);
		const encoded = toBase64(bytes);
		expect(encoded.length).toBeGreaterThan(700_000);
		expect(atob(encoded).length).toBe(600_000);
	});

	it("encodes an empty payload as an empty string", () => {
		expect(toBase64(new Uint8Array(0))).toBe("");
	});
});

describe("buildMultipart", () => {
	it("writes a plain field with its name", () => {
		const { body } = buildMultipart([{ name: "chat_id", value: "12345" }], "BOUND");
		const text = decode(body);
		expect(text).toContain('Content-Disposition: form-data; name="chat_id"');
		expect(text).toContain("12345");
	});

	it("writes a file field with filename and content type", () => {
		const { body } = buildMultipart(
			[{ name: "document", data: new TextEncoder().encode("PDF"), filename: "report.pdf", contentType: "application/pdf" }],
			"BOUND"
		);
		const text = decode(body);
		expect(text).toContain('name="document"; filename="report.pdf"');
		expect(text).toContain("Content-Type: application/pdf");
	});

	it("opens each part with the boundary and closes with the terminator", () => {
		const { body } = buildMultipart([{ name: "a", value: "1" }, { name: "b", value: "2" }], "BOUND");
		const text = decode(body);
		expect(text.match(/--BOUND\r\n/g)).toHaveLength(2);
		expect(text.endsWith("--BOUND--\r\n")).toBe(true);
	});

	it("reports the content type with the boundary in it", () => {
		expect(buildMultipart([], "BOUND").contentType).toBe("multipart/form-data; boundary=BOUND");
	});

	it("preserves binary bytes exactly", () => {
		const data = new Uint8Array([0, 13, 10, 255, 128, 37, 80, 68, 70]);
		const { body } = buildMultipart([{ name: "document", data, filename: "f.pdf" }], "B");
		const bytes = new Uint8Array(body);
		// Find the payload between the blank line after the headers and the trailing CRLF.
		const haystack = Array.from(bytes).join(",");
		expect(haystack).toContain(Array.from(data).join(","));
	});

	// A view's underlying buffer can be longer than the view; sending it raw appends garbage.
	it("returns a buffer sized exactly to the content", () => {
		const { body } = buildMultipart([{ name: "a", value: "hello" }], "B");
		expect(body.byteLength).toBe(decode(body).length);
	});

	it("neutralizes a filename that would break the header", () => {
		const { body } = buildMultipart([{ name: "document", data: new Uint8Array(1), filename: 'a"\r\nX-Evil: 1' }], "B");
		const text = decode(body);
		expect(text).not.toContain("X-Evil: 1\r\n\r\n");
		// Quote, CR and LF are each neutralized, so the header can't be split into a new one.
		expect(text).toContain('filename="a___X-Evil: 1"');
	});
});

describe("randomBoundary", () => {
	it("is long, hex, and different every time", () => {
		const a = randomBoundary();
		expect(a).toMatch(/^----fp[0-9a-f]{32}$/);
		expect(a).not.toBe(randomBoundary());
	});
});
