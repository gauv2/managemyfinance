/**
 * The two wire encodings the delivery channels need, as pure functions.
 *
 * Both exist because Obsidian's `requestUrl` is the only HTTP call available on both desktop and
 * mobile, and it takes a string or an ArrayBuffer — there is no FormData and no Blob to hand it. So
 * a file upload has to be assembled byte by byte, which is a thing worth having tests for rather
 * than debugging through a Telegram bot.
 */

/** Bytes to a base64 string, for JSON APIs that take attachments inline (Resend does). */
export function toBase64(bytes: Uint8Array): string {
	// Chunked rather than String.fromCharCode(...bytes): spreading a megabyte-long array into an
	// argument list overflows the call stack, and a PDF is exactly that size.
	const CHUNK = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

export interface MultipartField {
	name: string;
	/** A plain form value. Mutually exclusive with `data`. */
	value?: string;
	/** File bytes. Requires `filename`. */
	data?: Uint8Array;
	filename?: string;
	contentType?: string;
}

export interface MultipartBody {
	body: ArrayBuffer;
	contentType: string;
}

function utf8(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/** Escapes a quoted-string parameter in a Content-Disposition header. */
function quote(value: string): string {
	return value.replace(/["\\\r\n]/g, "_");
}

/**
 * Builds a multipart/form-data body.
 *
 * The boundary is caller-supplied so this stays pure and testable; callers pass a random one. It is
 * never checked against the payload — a real collision would need the payload to contain the exact
 * random token, which for a 32-hex-character boundary is not a thing that happens.
 */
export function buildMultipart(fields: MultipartField[], boundary: string): MultipartBody {
	const chunks: Uint8Array[] = [];

	for (const field of fields) {
		let header = `--${boundary}\r\nContent-Disposition: form-data; name="${quote(field.name)}"`;
		if (field.filename !== undefined) header += `; filename="${quote(field.filename)}"`;
		header += "\r\n";
		if (field.contentType) header += `Content-Type: ${field.contentType}\r\n`;
		header += "\r\n";

		chunks.push(utf8(header));
		chunks.push(field.data ?? utf8(field.value ?? ""));
		chunks.push(utf8("\r\n"));
	}
	chunks.push(utf8(`--${boundary}--\r\n`));

	const total = chunks.reduce((sum, c) => sum + c.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}

	return {
		// A fresh ArrayBuffer sized exactly to the content: `out.buffer` can be larger than `out` when
		// the array is a view, and requestUrl would send the trailing slack as garbage bytes.
		body: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer,
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

/** A boundary token with no chance of appearing in a payload by accident. */
export function randomBoundary(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return `----fp${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
