import { describe, expect, it } from "vitest";
import { isCamt053, parseCamt053 } from "./camt053";
import { detectFileFormat, detectFormat } from "./detect";
import { countRepeatedIds, withOccurrenceSuffixes } from "./dedupe";
import { isMt940, parseMt940 } from "./mt940";
import { isOfx, parseOfx } from "./ofx";
import { detectDateOrder, isQif, parseQif, parseQifDate } from "./qif";
import { matchBankProfile } from "./bankProfiles";
import { find, findAll, parseXml, textAt } from "./xml";
import { canonicalColumnMapping, type CanonicalTable } from "./canonical";
import { applyColumnMapping } from "./columnMapping";
import { parseIngRows } from "./ingParser";

/** Reads a canonical table row back as an object, by header name. */
function row(table: CanonicalTable, index: number): Record<string, string> {
	const out: Record<string, string> = {};
	table.headers.forEach((h, i) => (out[h] = table.rows[index][i]));
	return out;
}

// ---------------------------------------------------------------------------

describe("parseXml", () => {
	it("reads elements, text, attributes and namespace-prefixed tags alike", () => {
		const root = parseXml(`<?xml version="1.0"?><ns:Doc><Amt Ccy="EUR">12.34</Amt><Empty/></ns:Doc>`);
		expect(root.name).toBe("Doc");
		const amt = find(root, "Amt")!;
		expect(amt.text).toBe("12.34");
		expect(amt.attrs.Ccy).toBe("EUR");
		expect(find(root, "Empty")).toBeDefined();
	});

	it("decodes entities and strips comments and CDATA wrappers", () => {
		const root = parseXml(`<Doc><!-- ignored --><Nm>Ben &amp; Jerry&apos;s</Nm><Ref><![CDATA[raw <text>]]></Ref></Doc>`);
		expect(textAt(root, "Nm")).toBe("Ben & Jerry's");
		expect(textAt(root, "Ref")).toContain("raw");
	});

	it("finds every matching descendant at any depth", () => {
		const root = parseXml(`<Doc><A><B>1</B></A><A><B>2</B><B>3</B></A></Doc>`);
		expect(findAll(root, "B").map((n) => n.text)).toEqual(["1", "2", "3"]);
	});

	it("throws on a file with no elements at all", () => {
		expect(() => parseXml("not xml")).toThrow();
	});
});

// ---------------------------------------------------------------------------

const CAMT = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
 <BkToCstmrStmt>
  <Stmt>
   <Acct><Id><IBAN>NL12INGB0001234567</IBAN></Id><Ccy>EUR</Ccy></Acct>
   <Ntry>
    <Amt Ccy="EUR">42.50</Amt>
    <CdtDbtInd>DBIT</CdtDbtInd>
    <BookgDt><Dt>2024-03-15</Dt></BookgDt>
    <BkTxCd><Prtry><Cd>IDEAL</Cd></Prtry><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd></Fmly></Domn></BkTxCd>
    <NtryDtls><TxDtls>
      <RltdPties>
        <Cdtr><Nm>Albert Heijn</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>NL99RABO0000000000</IBAN></Id></CdtrAcct>
      </RltdPties>
      <RmtInf><Ustrd>Groceries week 11</Ustrd></RmtInf>
    </TxDtls></NtryDtls>
    <AddtlNtryInf>SEPA iDEAL payment</AddtlNtryInf>
   </Ntry>
   <Ntry>
    <Amt Ccy="EUR">2500.00</Amt>
    <CdtDbtInd>CRDT</CdtDbtInd>
    <BookgDt><Dt>2024-03-25</Dt></BookgDt>
    <NtryDtls><TxDtls>
      <RltdPties><Dbtr><Nm>ACME BV</Nm></Dbtr></RltdPties>
      <RmtInf><Ustrd>Salary March</Ustrd></RmtInf>
    </TxDtls></NtryDtls>
   </Ntry>
  </Stmt>
 </BkToCstmrStmt>
</Document>`;

describe("CAMT.053", () => {
	it("is recognized from its content", () => {
		expect(isCamt053(CAMT)).toBe(true);
		expect(detectFileFormat(CAMT, "statement.txt")).toBe("camt053");
	});

	it("signs a debit negative and a credit positive", () => {
		const table = parseCamt053(CAMT);
		expect(table.rows).toHaveLength(2);
		expect(row(table, 0).amount).toBe("-42.50");
		expect(row(table, 1).amount).toBe("2500.00");
	});

	it("reads the counterparty from the correct side of the payment", () => {
		const table = parseCamt053(CAMT);
		// Outgoing: the creditor is the other party. Incoming: the debtor is.
		expect(row(table, 0).counterparty).toBe("Albert Heijn");
		expect(row(table, 1).counterparty).toBe("ACME BV");
	});

	it("prefers the remittance text as the description", () => {
		const table = parseCamt053(CAMT);
		expect(row(table, 0).description).toBe("Groceries week 11");
		expect(row(table, 0).notifications).toBe("SEPA iDEAL payment");
	});

	it("carries the statement's account and currency onto every row", () => {
		const table = parseCamt053(CAMT);
		expect(row(table, 0).account).toBe("NL12INGB0001234567");
		expect(row(table, 0).currency).toBe("EUR");
		expect(table.ibans).toEqual(["NL12INGB0001234567"]);
	});

	it("keeps the bank's own transaction code", () => {
		expect(row(parseCamt053(CAMT), 0).code).toBe("IDEAL");
	});

	it("rejects a file with no entries rather than importing nothing silently", () => {
		expect(() => parseCamt053(`<Document><BkToCstmrStmt><Stmt/></BkToCstmrStmt></Document>`)).toThrow(/CAMT/);
	});
});

// ---------------------------------------------------------------------------

const MT940 = `:20:STARTUMS
:25:NL12INGB0001234567EUR
:28C:00135/001
:60F:C240301EUR1500,00
:61:2403150315D42,50NTRFNONREF//BANKREF1
:86:/TRTP/SEPA OVERBOEKING/IBAN/NL99RABO0000000000/NAME/ALBERT HEIJN/REMI/Groceries week 11
:61:2403250325C2500,00NSALNONREF
:86:/TRTP/SEPA OVERBOEKING/NAME/ACME BV/REMI/Salary March
:62F:C240331EUR3957,50
-`;

describe("MT940", () => {
	it("is recognized from its tag structure", () => {
		expect(isMt940(MT940)).toBe(true);
		expect(detectFileFormat(MT940, "statement.sta")).toBe("mt940");
	});

	it("signs D as money out and C as money in", () => {
		const table = parseMt940(MT940);
		expect(table.rows).toHaveLength(2);
		expect(row(table, 0).amount).toBe("-42.50");
		expect(row(table, 1).amount).toBe("2500.00");
	});

	it("reads a comma decimal separator correctly", () => {
		// "42,50" is 42.50, not 4250 — the mistake a naive comma-strip makes.
		expect(row(parseMt940(MT940), 0).amount).toBe("-42.50");
	});

	it("unpacks the /NAME/ and /REMI/ tags out of the :86: information line", () => {
		const table = parseMt940(MT940);
		expect(row(table, 0).counterparty).toBe("ALBERT HEIJN");
		expect(row(table, 0).description).toBe("Groceries week 11");
	});

	it("takes the account and currency from the :25: and :60F: fields", () => {
		const table = parseMt940(MT940);
		expect(row(table, 0).account).toBe("NL12INGB0001234567");
		expect(row(table, 0).currency).toBe("EUR");
	});

	it("dates rows from the entry date", () => {
		const table = parseMt940(MT940);
		expect(row(table, 0).date).toBe("2024-03-15");
		expect(row(table, 1).date).toBe("2024-03-25");
	});

	it("joins a wrapped :86: line rather than keeping the line break", () => {
		const wrapped = `:25:NL12INGB0001234567EUR
:61:2403150315D10,00NTRF
:86:/TRTP/SEPA/NAME/LONG SHOP
 NAME CONTINUED/REMI/Something
`;
		expect(row(parseMt940(wrapped), 0).notifications).not.toContain("\n");
	});

	it("keeps a :61: with no :86: after it", () => {
		const bare = `:25:NL12INGB0001234567EUR
:61:2403150315D10,00NTRFsome reference
`;
		const table = parseMt940(bare);
		expect(table.rows).toHaveLength(1);
		expect(row(table, 0).amount).toBe("-10.00");
	});

	it("rejects a file with no statement lines", () => {
		expect(() => parseMt940(":20:HEADER\n:25:NL12\n")).toThrow(/MT940/);
	});
});

// ---------------------------------------------------------------------------

const OFX = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>EUR
<BANKACCTFROM><ACCTID>NL12INGB0001234567</ACCTID></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240315120000[0:GMT]
<TRNAMT>-42.50
<FITID>abc123
<NAME>ALBERT HEIJN
<MEMO>Groceries week 11
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240325
<TRNAMT>2500.00
<NAME>ACME BV
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("OFX", () => {
	it("is recognized from its header", () => {
		expect(isOfx(OFX)).toBe(true);
		expect(detectFileFormat(OFX, "export.qfx")).toBe("ofx");
	});

	it("reads unclosed SGML tags the same as closed XML ones", () => {
		const table = parseOfx(OFX);
		expect(table.rows).toHaveLength(2);
		expect(row(table, 0).description).toBe("ALBERT HEIJN");
	});

	it("takes the sign as given, since OFX amounts are already signed", () => {
		const table = parseOfx(OFX);
		expect(row(table, 0).amount).toBe("-42.50");
		expect(row(table, 1).amount).toBe("2500.00");
	});

	it("reads a date with a time and timezone glued on", () => {
		expect(row(parseOfx(OFX), 0).date).toBe("2024-03-15");
		expect(row(parseOfx(OFX), 1).date).toBe("2024-03-25");
	});

	it("carries the account id and default currency", () => {
		const table = parseOfx(OFX);
		expect(row(table, 0).account).toBe("NL12INGB0001234567");
		expect(row(table, 0).currency).toBe("EUR");
	});

	it("rejects a file with no transactions", () => {
		expect(() => parseOfx("<OFX></OFX>")).toThrow(/OFX/);
	});
});

// ---------------------------------------------------------------------------

const QIF = `!Type:Bank
D15/03/2024
T-42.50
PALBERT HEIJN
MGroceries week 11
LFood:Groceries
^
D25/03/2024
T2500.00
PACME BV
^`;

describe("QIF", () => {
	it("is recognized from its !Type header", () => {
		expect(isQif(QIF)).toBe(true);
		expect(detectFileFormat(QIF, "export.qif")).toBe("qif");
	});

	it("reads records terminated by ^", () => {
		const table = parseQif(QIF);
		expect(table.rows).toHaveLength(2);
		expect(row(table, 0).description).toBe("ALBERT HEIJN");
		expect(row(table, 0).amount).toBe("-42.50");
	});

	it("keeps the exporting tool's own category so alias matching can use it", () => {
		expect(row(parseQif(QIF), 0)["transaction type"]).toBe("Food:Groceries");
	});

	describe("date order", () => {
		it("settles day-first vs month-first from the file as a whole", () => {
			// 15 can only be a day, so the whole file is day-first — including "01/05" further down,
			// which on its own is ambiguous.
			expect(detectDateOrder(["15/03/2024", "01/05/2024"])).toBe("dmy");
			expect(detectDateOrder(["03/15/2024", "05/01/2024"])).toBe("mdy");
		});

		it("falls back to day-first when every date is ambiguous", () => {
			expect(detectDateOrder(["01/05/2024", "02/06/2024"])).toBe("dmy");
		});

		it("applies one order to the whole file, so a ledger never holds two calendars", () => {
			const mdy = `!Type:Bank\nD03/15/2024\nT-1.00\nPA\n^\nD05/01/2024\nT-2.00\nPB\n^`;
			const table = parseQif(mdy);
			expect(row(table, 0).date).toBe("2024-03-15");
			expect(row(table, 1).date).toBe("2024-05-01");
		});

		it("reads Quicken's apostrophe year and two-digit years", () => {
			expect(parseQifDate("1/ 5'24", "dmy")).toBe("2024-05-01");
			expect(parseQifDate("15/03/99", "dmy")).toBe("1999-03-15");
		});

		it("passes an ISO date straight through", () => {
			expect(parseQifDate("2024-03-15", "mdy")).toBe("2024-03-15");
		});
	});

	it("rejects a file with no usable records", () => {
		expect(() => parseQif("!Type:Bank\n^\n")).toThrow(/QIF/);
	});
});

// ---------------------------------------------------------------------------

describe("bank CSV profiles", () => {
	it("recognizes a Revolut export and pre-fills its columns", () => {
		const headers = ["Type", "Product", "Started Date", "Completed Date", "Description", "Amount", "Fee", "Currency", "State", "Balance"];
		const profile = matchBankProfile(headers)!;
		expect(profile.id).toBe("revolut");
		const mapping = profile.mapping(headers);
		// Completed, not started: a pending row shouldn't date the ledger.
		expect(mapping.date).toBe("Completed Date");
		expect(mapping.amount).toBe("Amount");
		expect(detectFormat(headers)).toBe("revolut");
	});

	it("recognizes bunq and N26 exports", () => {
		expect(detectFormat(["Date", "Amount", "Account", "Counterparty", "Name", "Description"])).toBe("bunq");
		expect(detectFormat(["Booking Date", "Value Date", "Partner Name", "Partner Iban", "Type", "Payment Reference", "Amount (EUR)"])).toBe("n26");
	});

	it("still lets the dedicated ING and Trade Republic parsers win", () => {
		expect(detectFormat(["Date", "Name / Description", "Counterparty", "Debit/credit", "Amount"])).toBe("ing");
		expect(detectFormat(["Action", "Ticker", "Amount"])).toBe("trade-republic");
	});

	it("leaves an unrecognized CSV to the manual column mapper", () => {
		expect(detectFormat(["when", "what", "how much"])).toBe("unknown");
		expect(detectFileFormat("a,b,c\n1,2,3", "thing.csv")).toBe("csv");
	});
});

// ---------------------------------------------------------------------------

describe("occurrence suffixes", () => {
	const dup = (id: string) => ({ id, date: "2024-03-15", accountId: "a", description: "Coffee", amount: -3.5, currency: "EUR", source: "manual" as const });

	it("keeps two genuinely separate identical payments as two transactions", () => {
		const out = withOccurrenceSuffixes([dup("h"), dup("h")]);
		expect(out.map((t) => t.id)).toEqual(["h", "h~2"]);
	});

	it("is stable, so re-importing the same file produces the same ids and dedupes cleanly", () => {
		const first = withOccurrenceSuffixes([dup("h"), dup("h"), dup("h")]).map((t) => t.id);
		const second = withOccurrenceSuffixes([dup("h"), dup("h"), dup("h")]).map((t) => t.id);
		expect(first).toEqual(second);
	});

	it("adds only the genuinely new row when an export contains one more repeat than before", () => {
		const known = new Set(withOccurrenceSuffixes([dup("h"), dup("h")]).map((t) => t.id));
		const incoming = withOccurrenceSuffixes([dup("h"), dup("h"), dup("h")]);
		expect(incoming.filter((t) => !known.has(t.id)).map((t) => t.id)).toEqual(["h~3"]);
	});

	it("leaves distinct ids untouched", () => {
		expect(withOccurrenceSuffixes([dup("a"), dup("b")]).map((t) => t.id)).toEqual(["a", "b"]);
	});

	it("counts how many rows needed rescuing", () => {
		expect(countRepeatedIds([dup("h"), dup("h"), dup("h"), dup("x")])).toBe(2);
	});
});

// ---------------------------------------------------------------------------

describe("statement → ledger, end to end", () => {
	it("reads a CAMT file all the way into transactions, keeping sign, type and counterparty", () => {
		const table = parseCamt053(CAMT);
		const mapping = canonicalColumnMapping();
		const transactions = parseIngRows(applyColumnMapping(table.headers, mapping), table.rows, {
			defaultAccountId: "acc-1",
			source: "camt",
		});

		expect(transactions).toHaveLength(2);
		expect(transactions[0]).toMatchObject({
			date: "2024-03-15",
			amount: -42.5,
			counterparty: "Albert Heijn",
			description: "Groceries week 11",
			source: "camt",
			currency: "EUR",
		});
		// The bank's own classification survives the trip — the field-order collision in the generic
		// guesser used to hand this column to Debit/Credit and lose it.
		expect(transactions[0].type).toBe("PMNT/ICDT");
		expect(transactions[1].amount).toBe(2500);
	});

	it("attributes each row to the account its IBAN maps to", () => {
		const table = parseCamt053(CAMT);
		const transactions = parseIngRows(applyColumnMapping(table.headers, canonicalColumnMapping()), table.rows, {
			defaultAccountId: "fallback",
			accountByIban: new Map([["NL12INGB0001234567", "acc-ing"]]),
			source: "camt",
		});
		expect(transactions.every((t) => t.accountId === "acc-ing")).toBe(true);
	});

	it("never lets a direction column contradict an already-signed amount", () => {
		// OFX writes TRNTYPE=DEBIT alongside a negative TRNAMT. Mapping that column to Debit/Credit
		// would be a second opinion about direction; the mapping deliberately leaves it unset.
		const mapping = canonicalColumnMapping();
		expect(mapping.debitCredit).toBe("");

		const table = parseOfx(OFX);
		const transactions = parseIngRows(applyColumnMapping(table.headers, mapping), table.rows, {
			defaultAccountId: "acc-1",
			source: "ofx",
		});
		expect(transactions[0].amount).toBe(-42.5);
		expect(transactions[1].amount).toBe(2500);
		expect(transactions[0].type).toBe("DEBIT");
	});

	it("reads an MT940 file into transactions with its comma decimals intact", () => {
		const table = parseMt940(MT940);
		const transactions = parseIngRows(applyColumnMapping(table.headers, canonicalColumnMapping()), table.rows, {
			defaultAccountId: "acc-1",
			source: "mt940",
		});
		expect(transactions[0].amount).toBe(-42.5);
		expect(transactions[0].counterparty).toBe("ALBERT HEIJN");
	});
});
