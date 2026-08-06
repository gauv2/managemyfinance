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
	let s = raw.trim();
	let negative = false;
	if (s.startsWith("(") && s.endsWith(")")) {
		negative = true;
		s = s.slice(1, -1);
	}
	s = s.replace(/[€\s]/g, "");
	if (s.startsWith("-")) {
		negative = true;
		s = s.slice(1);
	}
	const n = parseFloat(s.replace(",", "."));
	if (isNaN(n)) return 0;
	return negative ? -n : n;
}

/** Trade Republic buy/sell/dividend/deposit rows, keyed on ticker rather than counterparty. */
export function parseTradeRepublicRows(headers: string[], rows: string[][], accountId: string): Transaction[] {
	const iDate = col(headers, "date");
	const iAction = col(headers, "action");
	const iType = col(headers, "type");
	const iDesc = col(headers, "description");
	const iTicker = col(headers, "ticker", "isin");
	const iAssetClass = col(headers, "asset class");
	const iShares = col(headers, "shares");
	const iPrice = col(headers, "price (eur)", "price");
	const iAmount = col(headers, "amount (eur)", "amount");
	const iFee = col(headers, "fee", "commission");
	const iTax = col(headers, "tax");
	const iCurrency = col(headers, "currency");

	const out: Transaction[] = [];
	for (const r of rows) {
		if (r.every((c) => c.trim() === "")) continue;

		const date = parseFlexibleDate(r[iDate] ?? "");
		const action = iAction !== -1 ? (r[iAction] ?? "").trim() : "";
		const type = iType !== -1 ? (r[iType] ?? "").trim() : "";
		const description = (iDesc !== -1 ? (r[iDesc] ?? "").trim() : "") || action;
		const amount = iAmount !== -1 ? parseAmount(r[iAmount] ?? "") : 0;
		const sharesRaw = iShares !== -1 ? parseFloat((r[iShares] ?? "").replace(",", ".")) : NaN;
		const price = iPrice !== -1 ? parseAmount(r[iPrice] ?? "") : undefined;
		const fee = iFee !== -1 ? parseAmount(r[iFee] ?? "") : undefined;
		const tax = iTax !== -1 ? parseAmount(r[iTax] ?? "") : undefined;
		const currency = iCurrency !== -1 ? (r[iCurrency] ?? "EUR").trim() || "EUR" : "EUR";
		const ticker = iTicker !== -1 ? (r[iTicker] ?? "").trim() : "";
		const assetClass = iAssetClass !== -1 ? (r[iAssetClass] ?? "").trim() : "";

		out.push({
			id: stableHash([accountId, date, amount.toFixed(2), description, ticker]),
			date,
			accountId,
			description,
			amount,
			currency,
			type: type || action || undefined,
			source: "trade-republic",
			ticker: ticker || undefined,
			assetClass: assetClass || undefined,
			shares: isNaN(sharesRaw) ? undefined : sharesRaw,
			price,
			fee,
			tax,
			action: action || undefined,
		});
	}
	return out;
}
