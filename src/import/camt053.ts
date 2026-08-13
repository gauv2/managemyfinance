import { parseMoney } from "../money";
import { toCanonicalTable, type CanonicalRow, type CanonicalTable } from "./canonical";
import { find, findAll, parseXml, textAt, type XmlNode } from "./xml";

/**
 * ISO 20022 CAMT.053 — the bank-to-customer statement format Rabobank, ABN AMRO and ING all export,
 * and the one format worth supporting above any individual bank's CSV: one parser, several banks,
 * and it carries structured counterparty and remittance data that a CSV export usually flattens away.
 *
 * A statement is a tree of <Stmt> (one per account/period), each holding <Ntry> entries. The entry
 * has the money (<Amt>, <CdtDbtInd>) and the booking date; the meaningful description usually lives
 * one level deeper in <NtryDtls><TxDtls>, with <AddtlNtryInf> as the bank's own free-text summary.
 *
 * Direction lives in <CdtDbtInd> as CRDT/DBIT and the amount itself is always unsigned, so the sign
 * has to be applied here — a file read without it looks like an account that only ever receives money.
 */

function entryDate(entry: XmlNode): string {
	// Booking date is when it hit the account; value date is when it counts for interest. The ledger
	// wants the former, but a file that only carries the latter is better read than rejected.
	const booking = textAt(entry, "BookgDt", "Dt") || textAt(entry, "BookgDt", "DtTm");
	const value = textAt(entry, "ValDt", "Dt") || textAt(entry, "ValDt", "DtTm");
	return (booking || value).slice(0, 10);
}

/**
 * The counterparty of one entry: whoever is on the other side of the money. On an outgoing payment
 * that's the creditor; on an incoming one it's the debtor — reading the wrong one names you as your
 * own counterparty on half the ledger.
 */
function counterpartyOf(entry: XmlNode, isDebit: boolean): { name: string; iban: string } {
	const parties = find(entry, "RltdPties");
	if (!parties) return { name: "", iban: "" };
	const side = isDebit ? "Cdtr" : "Dbtr";
	const partyNode = find(parties, side);
	const acctNode = find(parties, `${side}Acct`);
	return {
		name: partyNode ? textAt(partyNode, "Nm") || partyNode.text : "",
		iban: acctNode ? textAt(acctNode, "IBAN") : "",
	};
}

/** Everything in <RmtInf> that a human wrote — structured or unstructured, joined into one line. */
function remittanceInfo(entry: XmlNode): string {
	const rmt = find(entry, "RmtInf");
	if (!rmt) return "";
	const parts = [...findAll(rmt, "Ustrd").map((n) => n.text), ...findAll(rmt, "Ref").map((n) => n.text), ...findAll(rmt, "AddtlRmtInf").map((n) => n.text)];
	return parts.filter(Boolean).join(" ").trim();
}

/** The bank's own transaction code — proprietary code first, since that's what a Dutch bank actually fills in. */
function transactionCode(entry: XmlNode): string {
	const bkTxCd = find(entry, "BkTxCd");
	if (!bkTxCd) return "";
	return textAt(bkTxCd, "Prtry", "Cd") || textAt(bkTxCd, "Domn", "Cd") || textAt(bkTxCd, "Cd");
}

export function isCamt053(text: string): boolean {
	const head = text.slice(0, 4000);
	return /<\s*(?:\w+:)?(?:BkToCstmrStmt|Document)\b/i.test(head) && /camt\.05[23]|BkToCstmrStmt/i.test(head);
}

/**
 * Reads every entry in every statement in the file. Multi-account files are supported directly: each
 * <Stmt> carries its own account IBAN, which is written onto each row so the wizard can map each IBAN
 * to one of your accounts exactly as it already does for a combined ING export.
 */
export function parseCamt053(text: string): CanonicalTable {
	const root = parseXml(text);
	const statements = findAll(root, "Stmt");
	const scopes = statements.length > 0 ? statements : [root];

	const out: CanonicalRow[] = [];
	for (const stmt of scopes) {
		const acctNode = find(stmt, "Acct");
		const accountIban = acctNode ? textAt(acctNode, "IBAN") || textAt(acctNode, "Othr", "Id") : "";
		const stmtCurrency = acctNode ? textAt(acctNode, "Ccy") : "";

		for (const entry of findAll(stmt, "Ntry")) {
			const amtNode = find(entry, "Amt");
			const magnitude = parseMoney(amtNode?.text ?? "");
			if (magnitude === undefined) continue;

			const indicator = textAt(entry, "CdtDbtInd").toUpperCase();
			const isDebit = indicator.startsWith("DBIT");
			const amount = isDebit ? -Math.abs(magnitude) : Math.abs(magnitude);

			const party = counterpartyOf(entry, isDebit);
			const remittance = remittanceInfo(entry);
			const additional = textAt(entry, "AddtlNtryInf");
			// Best available human-readable line, in descending order of usefulness: what the payer
			// wrote, then who it was with, then whatever summary the bank attached.
			const description = remittance || party.name || additional || "(no description)";

			out.push({
				date: entryDate(entry),
				description,
				counterparty: party.name || party.iban || undefined,
				amount,
				currency: amtNode?.attrs.Ccy || stmtCurrency || "EUR",
				// ISO's own family/sub-family classification ("PMNT/RCDT/ESCT" etc.) where the bank filled
				// it in — coarse, but it's the only structured "what kind of movement was this" CAMT has.
				type: [textAt(entry, "BkTxCd", "Domn", "Cd"), textAt(entry, "BkTxCd", "Domn", "Fmly", "Cd")].filter(Boolean).join("/"),
				code: transactionCode(entry),
				notes: additional && additional !== description ? additional : undefined,
				account: accountIban || undefined,
			});
		}
	}

	if (out.length === 0) throw new Error("No <Ntry> entries found — this doesn't look like a CAMT.053 statement.");
	return toCanonicalTable(out);
}
