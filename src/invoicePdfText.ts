/**
 * Getting the words back out of a PDF without shipping a PDF library.
 *
 * The alternative was pdf.js, which is 300 KB of dependency for a plugin that currently ships under
 * 300 KB in total — and Obsidian's own bundled copy is not part of its plugin API, so borrowing it
 * would be relying on an implementation detail that is free to vanish in any release. What is available
 * everywhere Obsidian runs, desktop and mobile alike, is `DecompressionStream`, and that is the only
 * piece a PDF actually withholds: strip the zlib wrapper off the content streams and the text is
 * sitting there in plain view, drawn one string at a time by the operators below.
 *
 * The honest limits, since a half-working extractor that lies about it is worse than none:
 *
 * - Scanned invoices — a photograph wrapped in a PDF — contain no text to find. Nothing here does OCR.
 * - Fonts subsetted with a custom encoding map produce bytes that mean nothing without the CMap this
 *   does not parse, so they come out as noise.
 * - Layout is lost. PDF draws in whatever order suited the generator, so columns interleave.
 *
 * All three fail the same safe way: the fields parser finds no total, `localExtractionSufficient` says
 * so, and the document goes to Claude instead. Nothing downstream trusts this to have worked.
 */

/** Streams beyond this are not an invoice — they are a catalogue, and inflating them all would hang the dialog. */
const MAX_STREAMS = 300;

/** Enough text for any invoice. A PDF that needs more is not the document this feature is for. */
const MAX_TEXT_LENGTH = 400_000;

/** Bytes → a string where every character is one byte, which is how a PDF's own structure is written. */
function latin1(bytes: Uint8Array): string {
	let out = "";
	// Chunked because String.fromCharCode.apply blows the argument limit somewhere north of 100k.
	for (let i = 0; i < bytes.length; i += 8192) {
		out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)));
	}
	return out;
}

async function inflate(bytes: Uint8Array, format: "deflate" | "deflate-raw"): Promise<Uint8Array | undefined> {
	if (typeof DecompressionStream === "undefined") return undefined;
	try {
		const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	} catch {
		return undefined;
	}
}

/**
 * A PDF literal string, from its opening parenthesis to its matching close.
 *
 * Hand-scanned rather than matched with a regex because parentheses nest legally inside a PDF string —
 * "(Total (incl. VAT))" is one string, not a truncated one — and a regex either stops at the first
 * close bracket or needs recursion it hasn't got.
 */
function readLiteralString(content: string, start: number): { text: string; end: number } {
	let depth = 1;
	let out = "";
	let i = start + 1;

	while (i < content.length && depth > 0) {
		const ch = content[i];
		if (ch === "\\") {
			const next = content[i + 1] ?? "";
			const octal = /^[0-7]{1,3}/.exec(content.slice(i + 1, i + 4));
			if (octal) {
				out += String.fromCharCode(parseInt(octal[0], 8));
				i += 1 + octal[0].length;
				continue;
			}
			const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
			// A backslash before a newline is a line continuation and contributes nothing.
			if (next !== "\n" && next !== "\r") out += escapes[next] ?? next;
			i += 2;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) break;
		}
		if (depth > 0) out += ch;
		i++;
	}

	return { text: out, end: i };
}

function readHexString(content: string, start: number): { text: string; end: number } {
	const close = content.indexOf(">", start);
	if (close === -1) return { text: "", end: content.length };
	const digits = content.slice(start + 1, close).replace(/[^0-9A-Fa-f]/g, "");
	let out = "";
	for (let i = 0; i + 1 < digits.length; i += 2) out += String.fromCharCode(parseInt(digits.slice(i, i + 2), 16));
	return { text: out, end: close };
}

/**
 * The drawn text of one decoded content stream.
 *
 * Only the string operands are of interest; the positioning operators matter solely as evidence that
 * the pen moved, which is the only clue left that two runs of text belong on different lines. Losing
 * that distinction would glue a label to the number three fields away from it and make every
 * label-anchored lookup in invoiceExtract read the wrong value.
 */
export function textFromContentStream(content: string): string {
	let out = "";
	let i = 0;

	while (i < content.length) {
		const ch = content[i];

		if (ch === "(") {
			const { text, end } = readLiteralString(content, i);
			out += text;
			i = end + 1;
			continue;
		}
		if (ch === "<" && content[i + 1] !== "<") {
			const { text, end } = readHexString(content, i);
			out += text;
			i = end + 1;
			continue;
		}
		// A new line of text, or the end of a text object: both mean "what follows is elsewhere on the page".
		//
		// `Tm` belongs in this list as much as Td/TD/T*: it sets the text matrix outright, and a great many
		// generators position every single line that way rather than stepping relatively. Leaving it out ran
		// each line into the next — "…VAT 21% EUR 1911.51Total EUR 11013.95…" — which still reads fine to a
		// human and defeats the field parser entirely, since that works a line at a time. Every field except
		// the reference came back empty from a PDF whose text had been extracted perfectly.
		if (
			(ch === "T" && (content[i + 1] === "d" || content[i + 1] === "D" || content[i + 1] === "*" || content[i + 1] === "m")) ||
			(ch === "E" && content[i + 1] === "T")
		) {
			if (!out.endsWith("\n")) out += "\n";
			i += 2;
			continue;
		}
		// The gap operand inside a TJ array is kerning when it is small and a real space when it is not.
		if (ch === "]" || ch === "[") {
			i++;
			continue;
		}
		i++;
	}

	return out;
}

/** Every `stream…endstream` payload in the file, with the dictionary that introduced it. */
function findStreams(raw: string): { dict: string; body: string }[] {
	const streams: { dict: string; body: string }[] = [];
	let cursor = 0;

	while (streams.length < MAX_STREAMS) {
		const start = raw.indexOf("stream", cursor);
		if (start === -1) break;
		// "endstream" contains "stream"; stepping over it stops each stream being found twice.
		if (raw.slice(start - 3, start) === "end") {
			cursor = start + 6;
			continue;
		}
		const end = raw.indexOf("endstream", start);
		if (end === -1) break;

		let bodyStart = start + "stream".length;
		if (raw[bodyStart] === "\r") bodyStart++;
		if (raw[bodyStart] === "\n") bodyStart++;

		streams.push({ dict: raw.slice(Math.max(0, start - 600), start), body: raw.slice(bodyStart, end) });
		cursor = end + "endstream".length;
	}

	return streams;
}

function toBytes(binary: string): Uint8Array {
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
	return bytes;
}

/**
 * Inflates a stream body, allowing for the end-of-line the format puts before `endstream`.
 *
 * That newline is not part of the compressed data and `DecompressionStream` refuses outright when it
 * is left on — "trailing junk found after the end of the compressed stream" — which silently turned
 * every real-world PDF into an empty extraction while a hand-built fixture without the newline read
 * perfectly. The spec-conformant reading is tried first; the unstripped body is tried after it, for a
 * generator whose data genuinely ends in 0x0A and which wrote no separator of its own.
 */
async function inflateStreamBody(body: string): Promise<string | undefined> {
	const stripped = body.replace(/\r\n$|[\r\n]$/, "");
	for (const candidate of stripped === body ? [body] : [stripped, body]) {
		const bytes = toBytes(candidate);
		const inflated = (await inflate(bytes, "deflate")) ?? (await inflate(bytes, "deflate-raw"));
		if (inflated) return latin1(inflated);
	}
	return undefined;
}

/**
 * The readable text of a PDF, or "" when there is none to be had.
 *
 * Never throws. A malformed or encrypted file is an ordinary outcome in a batch of ten receipts, and
 * one bad document must not take the other nine down with it — the caller sees an empty string and
 * carries on with whatever the filename and Claude can supply.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
	try {
		const raw = latin1(bytes);
		if (!raw.startsWith("%PDF")) return "";

		let text = "";
		for (const { dict, body } of findStreams(raw)) {
			if (text.length > MAX_TEXT_LENGTH) break;
			// Images, fonts and metadata are streams too, and inflating a 4 MB JPEG to look for the word
			// "Totaal" in it costs real time and finds nothing.
			if (/\/Subtype\s*\/(Image|Type1C|CIDFontType0C|TrueType)|\/Type\s*\/(XObject|Font|Metadata)/.test(dict)) {
				if (!/\/Subtype\s*\/Form/.test(dict)) continue;
			}

			let content: string | undefined;
			if (/\/FlateDecode/.test(dict)) {
				content = await inflateStreamBody(body);
			} else if (!/\/(?:DCT|JPX|CCITTFax|JBIG2|RunLength|LZW)Decode/.test(dict)) {
				content = body;
			}
			if (!content) continue;
			// A content stream is the only kind that draws text, and every one of them uses BT/ET.
			if (!/\bBT\b/.test(content)) continue;

			text += `${textFromContentStream(content)}\n`;
		}

		return text.replace(/[ \t]{2,}/g, " ").slice(0, MAX_TEXT_LENGTH);
	} catch {
		return "";
	}
}
