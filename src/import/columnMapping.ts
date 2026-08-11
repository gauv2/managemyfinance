/** One target ledger field a CSV column can be assigned to, via the manual-mapping step. */
export interface ColumnMappingField {
	key: keyof ColumnMapping;
	label: string;
	required?: boolean;
	/** Substrings (checked against lowercased headers) used to pre-guess a likely source column. */
	guesses: string[];
}

export interface ColumnMapping {
	date: string;
	description: string;
	counterparty: string;
	amount: string;
	debitCredit: string;
	debitValue: string;
	currency: string;
	type: string;
	notes: string;
	code: string;
}

export const COLUMN_MAPPING_FIELDS: ColumnMappingField[] = [
	{ key: "date", label: "Date", required: true, guesses: ["date", "datum"] },
	{ key: "description", label: "Description", required: true, guesses: ["description", "omschrijving", "memo", "name"] },
	{ key: "amount", label: "Amount", required: true, guesses: ["amount", "bedrag", "value"] },
	{ key: "counterparty", label: "Counterparty (optional)", guesses: ["counterparty", "tegenrekening", "payee", "merchant"] },
	{ key: "debitCredit", label: "Debit/Credit indicator (optional)", guesses: ["debit/credit", "direction", "type"] },
	{ key: "currency", label: "Currency (optional)", guesses: ["currency", "valuta"] },
	{ key: "type", label: "Transaction type (optional)", guesses: ["transaction type", "mutatiesoort", "category"] },
	{ key: "notes", label: "Notes (optional)", guesses: ["notif", "mededelingen", "note", "memo"] },
	{ key: "code", label: "Code (optional)", guesses: ["code"] },
];

export function emptyColumnMapping(): ColumnMapping {
	// debitValue defaults to "" (not e.g. "debit") on purpose: it must only take effect when the user
	// actually types a value, so a debitCredit column that gets auto-guessed on a recognized (e.g. ING)
	// import — where the underlying parser already has its own correct multi-locale default ("debit"/"af")
	// — doesn't get silently overridden to a single locale's value the user never chose.
	return { date: "", description: "", counterparty: "", amount: "", debitCredit: "", debitValue: "", currency: "", type: "", notes: "", code: "" };
}

/** Best-effort defaults so most CSVs need little more than a glance and Next. */
export function guessColumnMapping(headers: string[]): ColumnMapping {
	const mapping = emptyColumnMapping();
	const used = new Set<string>();
	for (const field of COLUMN_MAPPING_FIELDS) {
		if (field.key === "debitValue") continue;
		const match = headers.find((h) => !used.has(h) && field.guesses.some((g) => h.toLowerCase().includes(g)));
		if (match) {
			mapping[field.key] = match;
			used.add(match);
		}
	}
	return mapping;
}

/**
 * Renames the mapped source columns onto the canonical header names `parseIngRows` already
 * understands (via its own `col()` alias lookups), so a manually-mapped CSV reuses the exact same
 * parsing/sign/id logic as a recognized bank export instead of needing a second parser.
 */
export function applyColumnMapping(headers: string[], mapping: ColumnMapping): string[] {
	const canonical: Record<string, string> = {};
	if (mapping.date) canonical[mapping.date] = "date";
	if (mapping.description) canonical[mapping.description] = "description";
	if (mapping.counterparty) canonical[mapping.counterparty] = "counterparty";
	if (mapping.amount) canonical[mapping.amount] = "amount";
	if (mapping.debitCredit) canonical[mapping.debitCredit] = "debit/credit";
	if (mapping.currency) canonical[mapping.currency] = "currency";
	if (mapping.type) canonical[mapping.type] = "transaction type";
	if (mapping.notes) canonical[mapping.notes] = "notifications";
	if (mapping.code) canonical[mapping.code] = "code";
	return headers.map((h) => canonical[h] ?? h);
}
