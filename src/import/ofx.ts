import { parseMoney } from "../money";
import { toCanonicalTable, type CanonicalRow, type CanonicalTable } from "./canonical";

/**
 * OFX / QFX — Open Financial Exchange, the format behind "download for Quicken/Money" buttons.
 *
 * Two dialects share one parser here: OFX 1.x is SGML with unclosed tags (`<TRNAMT>-12.34` and then
 * the next tag), OFX 2.x is well-formed XML. Since both use identical tag names and every field of
 * interest is a leaf, reading `<TAG>value` up to the next `<` covers both exactly — and avoids
 * needing an SGML parser for the older dialect, which no XML reader will accept.
 *
 * Amounts here are already signed (a debit is negative in TRNAMT), unlike CAMT and MT940, so the sign
 * is taken as given rather than derived from a direction marker.
 */

/** `<TAG>value` up to the next tag or newline — the same read for closed and unclosed tags alike. */
function tagValue(block: string, tag: string): string {
	const m = new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, "i").exec(block);
	return (m?.[1] ?? "").trim();
}

/** OFX dates are "YYYYMMDD" with an optional time and bracketed timezone glued on. */
function ofxDate(raw: string): string {
	const digits = raw.replace(/\[.*$/, "").trim();
	if (digits.length < 8) return "";
	return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

export function isOfx(text: string): boolean {
	const head = text.slice(0, 4000).toUpperCase();
	return head.includes("<OFX") || head.includes("OFXHEADER");
}

export function parseOfx(text: string): CanonicalTable {
	const defaultCurrency = tagValue(text, "CURDEF") || "EUR";

	// One account block per <STMTRS>/<CCSTMTRS> (bank and credit-card statements respectively), so a
	// file covering several accounts keeps each one's transactions attributed to the right IBAN.
	const accountBlocks = text.split(/<(?:STMTRS|CCSTMTRS)>/i).slice(1);
	const scopes = accountBlocks.length > 0 ? accountBlocks : [text];

	const out: CanonicalRow[] = [];
	for (const scope of scopes) {
		const account = tagValue(scope, "ACCTID") || tagValue(scope, "IBAN");
		const currency = tagValue(scope, "CURDEF") || defaultCurrency;

		for (const raw of scope.split(/<STMTTRN>/i).slice(1)) {
			const block = raw.split(/<\/STMTTRN>/i)[0];
			const amount = parseMoney(tagValue(block, "TRNAMT"));
			if (amount === undefined) continue;

			const name = tagValue(block, "NAME") || tagValue(block, "PAYEE");
			const memo = tagValue(block, "MEMO");
			const checkNum = tagValue(block, "CHECKNUM");

			out.push({
				date: ofxDate(tagValue(block, "DTPOSTED") || tagValue(block, "DTUSER")),
				description: name || memo || "(no description)",
				counterparty: name || undefined,
				amount,
				currency: tagValue(block, "CURSYM") || currency,
				type: tagValue(block, "TRNTYPE"),
				code: checkNum || undefined,
				notes: memo && memo !== name ? memo : undefined,
				account: account || undefined,
			});
		}
	}

	if (out.length === 0) throw new Error("No <STMTTRN> transactions found — this doesn't look like an OFX file.");
	return toCanonicalTable(out);
}
