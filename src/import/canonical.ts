/**
 * The one table shape every non-CSV statement format is converted into.
 *
 * CAMT.053, MT940, OFX and QIF have nothing in common structurally — XML, SWIFT line codes, SGML
 * tags, and single-letter record fields respectively. What they *do* have in common is the handful of
 * facts a ledger row needs. Each parser's job is therefore only to reach that handful; from there
 * they all flow through the same table preview, the same column-mapping step (still fully editable —
 * the mapping is pre-filled, not bypassed) and the same `parseIngRows` sign/id/category logic that
 * recognized CSV exports already use.
 *
 * The header names are exactly the aliases `parseIngRows` already looks for, which is what makes the
 * shared path work without a translation layer in between.
 */
import { emptyColumnMapping, type ColumnMapping } from "./columnMapping";

export const CANONICAL_HEADERS = [
	"date",
	"description",
	"counterparty",
	"amount",
	"currency",
	"transaction type",
	"code",
	"notifications",
	/** IBAN of the account the row belongs to — drives per-account mapping of a multi-account file. */
	"account",
] as const;

export interface CanonicalTable {
	headers: string[];
	rows: string[][];
	/** Distinct account identifiers seen in the file, in order — empty when it holds only one account. */
	ibans: string[];
}

export interface CanonicalRow {
	/** ISO "YYYY-MM-DD". */
	date: string;
	description: string;
	counterparty?: string;
	/** Already signed: negative is money out. Written with a plain "." decimal point. */
	amount: number;
	currency?: string;
	type?: string;
	code?: string;
	notes?: string;
	account?: string;
}

/**
 * The exact mapping for a canonical table, rather than letting the generic guesser work it out.
 *
 * The guesser matches by substring in field order, and "Debit/Credit" lists "type" among its hints —
 * so it claims the "transaction type" column before the type field ever gets a look at it, and the
 * bank's own classification is lost from every statement import. These headers are ours and known
 * exactly, so there is nothing to guess at.
 */
export function canonicalColumnMapping(): ColumnMapping {
	return {
		...emptyColumnMapping(),
		date: "date",
		description: "description",
		counterparty: "counterparty",
		amount: "amount",
		currency: "currency",
		type: "transaction type",
		notes: "notifications",
		code: "code",
		// Deliberately left unset: these rows carry an already-signed amount, so a direction column
		// would be a second, contradictory opinion about which way the money went.
		debitCredit: "",
		debitValue: "",
	};
}

export function toCanonicalTable(rows: CanonicalRow[]): CanonicalTable {
	const ibans: string[] = [];
	for (const row of rows) {
		const iban = (row.account ?? "").trim();
		if (iban && !ibans.includes(iban)) ibans.push(iban);
	}
	return {
		headers: [...CANONICAL_HEADERS],
		rows: rows.map((row) => [
			row.date,
			row.description,
			row.counterparty ?? "",
			// Fixed 2dp with a "." decimal separator: this string is re-parsed by parseMoney downstream,
			// and a locale-formatted number is exactly the ambiguity that module exists to avoid.
			row.amount.toFixed(2),
			row.currency ?? "",
			row.type ?? "",
			row.code ?? "",
			row.notes ?? "",
			row.account ?? "",
		]),
		ibans,
	};
}
