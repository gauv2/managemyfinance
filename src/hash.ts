/**
 * Stable, non-cryptographic hash used to dedupe transactions across repeated CSV imports.
 * Two rows with the same account/date/amount/description/counterparty collapse to the same id,
 * so re-importing an overlapping export is a no-op.
 */
export function stableHash(parts: (string | number | undefined)[]): string {
	const input = parts.map((p) => (p === undefined ? "" : String(p))).join("|");
	let h1 = 0xdeadbeef ^ input.length;
	let h2 = 0x41c6ce57 ^ input.length;
	for (let i = 0; i < input.length; i++) {
		const ch = input.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
	return combined.toString(36);
}
