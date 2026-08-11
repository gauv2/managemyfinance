import { stableHash } from "../hash";
import type { Transaction, TransactionSource } from "../types";
import { parseFlexibleDate } from "../utils/dates";

function col(headers: string[], ...names: string[]): number {
	const normHeaders = headers.map((h) => h.trim().toLowerCase());
	for (const n of names) {
		const idx = normHeaders.indexOf(n);
		if (idx !== -1) return idx;
	}
	return -1;
}

function parseAmount(raw: string): number {
	if (!raw) return 0;
	const cleaned = raw.replace(/[€\s]/g, "").replace(",", ".");
	const n = parseFloat(cleaned);
	return isNaN(n) ? 0 : n;
}

/** Distinct IBANs found in the CSV's "Account" column, in file order — empty when the column is absent. */
export function ingAccountIbans(headers: string[], rows: string[][]): string[] {
	const iAccount = col(headers, "account", "rekening");
	if (iAccount === -1) return [];
	const seen = new Set<string>();
	for (const r of rows) {
		const iban = (r[iAccount] ?? "").trim();
		if (iban) seen.add(iban);
	}
	return Array.from(seen);
}

export interface ParseIngOptions {
	/** Used when the row has no Account column, or its IBAN isn't in accountByIban. */
	defaultAccountId: string;
	/** Maps the CSV's per-row IBAN to one of the vault's account ids (combined multi-account exports). */
	accountByIban?: Map<string, string>;
	/** Category name/alias → category id, used to trust the bank's own Main Cat./Sub Cat. columns when present. */
	categoryLookup?: Map<string, string>;
	/** Case-insensitive values in the Debit/Credit column that mean "money out" — defaults to ING's own ("debit", "af"). */
	debitValues?: string[];
	/** Tagged onto every parsed transaction; defaults to "ing" — pass "generic" for manually column-mapped imports. */
	source?: TransactionSource;
}

/**
 * Handles a plain fresh ING export (no Category column — auto-categorization fills that in), the
 * enriched historical/combined-accounts format with Account/Code/Main Cat./Sub Cat. columns, and
 * ING's raw Dutch-locale download (Datum, Naam / Omschrijving, Tegenrekening, Af Bij, ...).
 */
export function parseIngRows(headers: string[], rows: string[][], opts: ParseIngOptions): Transaction[] {
	const iDate = col(headers, "date", "datum");
	const iDesc = col(headers, "name / description", "naam / omschrijving", "description");
	const iAccount = col(headers, "account", "rekening");
	const iCounterparty = col(headers, "counterparty", "tegenrekening");
	const iCode = col(headers, "code");
	const iDebitCredit = col(headers, "debit/credit", "af bij");
	const iAmount = col(headers, "amount (eur)", "amount", "bedrag (eur)", "bedrag");
	const iDebit = col(headers, "debit");
	const iCredit = col(headers, "credit");
	const iCurrency = col(headers, "currency");
	const iType = col(headers, "transaction type", "mutatiesoort");
	const iNotif = col(headers, "notifications", "mededelingen");
	const iSubCat = col(headers, "sub cat.", "sub cat", "category");
	const iMainCat = col(headers, "main cat.", "main cat");

	const out: Transaction[] = [];
	for (const r of rows) {
		if (r.every((c) => c.trim() === "")) continue;

		const date = parseFlexibleDate(r[iDate] ?? "");
		const description = (r[iDesc] ?? "").trim();
		const counterparty = iCounterparty !== -1 ? (r[iCounterparty] ?? "").trim() : "";
		const debitCredit = (r[iDebitCredit] ?? "").trim().toLowerCase();
		const debitValues = (opts.debitValues ?? ["debit", "af"]).map((v) => v.toLowerCase());
		const isDebit = iDebitCredit !== -1 && debitValues.includes(debitCredit);
		const code = iCode !== -1 ? (r[iCode] ?? "").trim() : "";

		const iban = iAccount !== -1 ? (r[iAccount] ?? "").trim() : "";
		const accountId = (iban && opts.accountByIban?.get(iban)) || opts.defaultAccountId;

		let amount: number;
		if (iAmount !== -1 && r[iAmount]) {
			amount = parseAmount(r[iAmount]);
			if (isDebit && amount > 0) amount = -amount;
		} else {
			const debit = iDebit !== -1 ? parseAmount(r[iDebit] ?? "") : 0;
			const credit = iCredit !== -1 ? parseAmount(r[iCredit] ?? "") : 0;
			amount = credit - debit;
		}

		const raw = iNotif !== -1 ? (r[iNotif] ?? "").trim() : "";
		const type = iType !== -1 ? (r[iType] ?? "").trim() : "";
		const currency = (iCurrency !== -1 ? (r[iCurrency] ?? "").trim() : "") || "EUR";

		let categoryId: string | undefined;
		if (opts.categoryLookup) {
			const subCat = iSubCat !== -1 ? (r[iSubCat] ?? "").trim().toLowerCase() : "";
			const mainCat = iMainCat !== -1 ? (r[iMainCat] ?? "").trim().toLowerCase() : "";
			categoryId = (subCat && opts.categoryLookup.get(subCat)) || (mainCat && opts.categoryLookup.get(mainCat)) || undefined;
		}

		out.push({
			id: stableHash([accountId, date, amount.toFixed(2), description, counterparty]),
			date,
			accountId,
			description,
			counterparty: counterparty || undefined,
			amount,
			currency,
			type: type || undefined,
			code: code || undefined,
			categoryId,
			source: opts.source ?? "ing",
			raw: raw || undefined,
		});
	}
	return out;
}
