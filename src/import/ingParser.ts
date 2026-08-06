import { stableHash } from "../hash";
import type { Transaction } from "../types";
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

/**
 * Handles both a plain fresh ING export (no Category column — auto-categorization fills that in)
 * and the enriched historical format that already carries Category/Main Cat./Sub Cat. columns.
 */
export function parseIngRows(headers: string[], rows: string[][], accountId: string): Transaction[] {
	const iDate = col(headers, "date");
	const iDesc = col(headers, "name / description");
	const iCounterparty = col(headers, "counterparty");
	const iDebitCredit = col(headers, "debit/credit");
	const iAmount = col(headers, "amount (eur)", "amount");
	const iDebit = col(headers, "debit");
	const iCredit = col(headers, "credit");
	const iType = col(headers, "transaction type");
	const iNotif = col(headers, "notifications");

	const out: Transaction[] = [];
	for (const r of rows) {
		if (r.every((c) => c.trim() === "")) continue;

		const date = parseFlexibleDate(r[iDate] ?? "");
		const description = (r[iDesc] ?? "").trim();
		const counterparty = iCounterparty !== -1 ? (r[iCounterparty] ?? "").trim() : "";
		const debitCredit = (r[iDebitCredit] ?? "").trim().toLowerCase();

		let amount: number;
		if (iAmount !== -1 && r[iAmount]) {
			amount = parseAmount(r[iAmount]);
			if (debitCredit === "debit" && amount > 0) amount = -amount;
		} else {
			const debit = iDebit !== -1 ? parseAmount(r[iDebit] ?? "") : 0;
			const credit = iCredit !== -1 ? parseAmount(r[iCredit] ?? "") : 0;
			amount = credit - debit;
		}

		const raw = iNotif !== -1 ? (r[iNotif] ?? "").trim() : "";
		const type = iType !== -1 ? (r[iType] ?? "").trim() : "";

		out.push({
			id: stableHash([accountId, date, amount.toFixed(2), description, counterparty]),
			date,
			accountId,
			description,
			counterparty: counterparty || undefined,
			amount,
			currency: "EUR",
			type: type || undefined,
			source: "ing",
			raw: raw || undefined,
		});
	}
	return out;
}
