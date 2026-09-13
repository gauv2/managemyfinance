import { emptyColumnMapping, type ColumnMapping } from "./columnMapping";
import type { TransactionSource } from "../types";

/**
 * Ordinary CSV exports from banks whose columns are stable enough to recognize and pre-map.
 *
 * These need no parser of their own — the generic column-mapping path already reads any flat CSV.
 * What they need is to stop being *unrecognized*, so a Revolut export imports on sight instead of
 * making you map nine columns by hand every month. A profile is therefore just two things: a header
 * signature to recognize it by, and the mapping it would have taken you a minute to fill in.
 *
 * The mapping is pre-filled, never forced: the field selector still renders with these as its
 * starting values, so a changed export (banks reshuffle columns without warning) is a correction
 * rather than a dead end.
 */
export interface BankProfile {
	id: TransactionSource;
	label: string;
	/** Headers that must all be present (lowercased, exact) for this profile to match. */
	signature: string[];
	mapping: (headers: string[]) => ColumnMapping;
	/** Shown in the preview so it's obvious which profile claimed the file. */
	note?: string;
}

function mappingOf(fields: Partial<ColumnMapping>): ColumnMapping {
	return { ...emptyColumnMapping(), ...fields };
}

/** The first header present out of several candidates — export column names drift between versions. */
function pick(headers: string[], ...candidates: string[]): string {
	const lower = headers.map((h) => h.trim().toLowerCase());
	for (const candidate of candidates) {
		const idx = lower.indexOf(candidate.toLowerCase());
		if (idx !== -1) return headers[idx];
	}
	return "";
}

export const BANK_PROFILES: BankProfile[] = [
	{
		id: "knab",
		label: "KNAB",
		// These headers are supplied by `knabSheet.ts` — the export itself has none. Matching them here
		// keeps KNAB on exactly the same path as every other recognised bank rather than giving it a
		// parser of its own.
		signature: ["datum", "af bij", "bedrag", "tegenpartij"],
		note: "Amounts are unsigned; the Af/Bij column decides the direction.",
		mapping: (headers) =>
			mappingOf({
				date: pick(headers, "Datum"),
				description: pick(headers, "Omschrijving"),
				// The payee's name, not "Tegenrekening" — that column holds their account number, and
				// filing an IBAN as the counterparty makes every merchant look like a different one.
				counterparty: pick(headers, "Tegenpartij"),
				amount: pick(headers, "Bedrag"),
				debitCredit: pick(headers, "Af Bij"),
				debitValue: "Af",
				type: pick(headers, "Soort"),
				code: pick(headers, "Transactienummer"),
			}),
	},
	{
		id: "revolut",
		label: "Revolut",
		signature: ["type", "product", "completed date", "amount", "currency"],
		note: "Amounts are already signed; the separate Fee column is not imported as its own row.",
		mapping: (headers) =>
			mappingOf({
				// Completed date is when it actually settled; started date can be days earlier for a
				// transfer that was still pending, and pending rows shouldn't date the ledger.
				date: pick(headers, "Completed Date", "Started Date"),
				description: pick(headers, "Description"),
				amount: pick(headers, "Amount"),
				currency: pick(headers, "Currency"),
				type: pick(headers, "Type"),
			}),
	},
	{
		id: "bunq",
		label: "bunq",
		signature: ["date", "amount", "counterparty", "description"],
		mapping: (headers) =>
			mappingOf({
				date: pick(headers, "Date"),
				description: pick(headers, "Description"),
				counterparty: pick(headers, "Counterparty", "Name"),
				amount: pick(headers, "Amount"),
				currency: pick(headers, "Currency"),
			}),
	},
	{
		id: "n26",
		label: "N26",
		signature: ["booking date", "partner name", "payment reference"],
		mapping: (headers) =>
			mappingOf({
				date: pick(headers, "Booking Date", "Date", "Value Date"),
				description: pick(headers, "Payment Reference", "Partner Name"),
				counterparty: pick(headers, "Partner Name", "Payee"),
				amount: pick(headers, "Amount (EUR)", "Amount"),
				type: pick(headers, "Type", "Transaction type"),
			}),
	},
	{
		id: "n26",
		label: "N26 (older export)",
		signature: ["payee", "payment reference", "transaction type"],
		mapping: (headers) =>
			mappingOf({
				date: pick(headers, "Date"),
				description: pick(headers, "Payment reference", "Payee"),
				counterparty: pick(headers, "Payee"),
				amount: pick(headers, "Amount (EUR)", "Amount"),
				type: pick(headers, "Transaction type"),
			}),
	},
];

/** The profile whose every signature header is present, most specific (longest signature) first. */
export function matchBankProfile(headers: string[]): BankProfile | undefined {
	const present = new Set(headers.map((h) => h.trim().toLowerCase()));
	return [...BANK_PROFILES]
		.sort((a, b) => b.signature.length - a.signature.length)
		.find((profile) => profile.signature.every((h) => present.has(h)));
}
