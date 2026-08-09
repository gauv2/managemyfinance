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

// Trade Republic's own export reports every "Amount" as an unsigned magnitude — direction lives
// only in the Action column, so it has to be applied here or every row reads as cash coming in.
const CASH_OUT_ACTIONS = new Set(["buy", "withdraw", "card payment", "card payment (intl)"]);
const CASH_IN_ACTIONS = new Set(["sell", "deposit", "dividend", "interest", "interest income", "saveback", "gift", "referral bonus"]);

function signedAmount(magnitude: number, action: string): number {
	const key = action.trim().toLowerCase();
	if (CASH_OUT_ACTIONS.has(key)) return -Math.abs(magnitude);
	if (CASH_IN_ACTIONS.has(key)) return Math.abs(magnitude);
	return magnitude;
}

// Trade Republic's newer "Transaction export" (Account activity → Export) uses a completely different
// shape from the older action/ticker export above: amounts are already signed (no derivation needed),
// the security identifier column is "symbol" (holding an ISIN) instead of "ticker"/"isin", and the
// direction/kind of a row lives in "type" using its own vocabulary (BUY/SELL/DIVIDEND/CARD_TRANSACTION/
// CUSTOMER_INBOUND/...) rather than the lowercase action words the older export used.
const TR_TYPE_TO_ACTION: Record<string, string> = {
	buy: "buy",
	sell: "sell",
	dividend: "dividend",
	interest_payment: "interest",
	customer_inbound: "deposit",
	viban_transfer_inbound: "deposit",
	transfer_instant_inbound: "deposit",
	customer_outbound_request: "withdraw",
	transfer_instant_outbound: "withdraw",
};

function parseTradeRepublicTransactionExport(headers: string[], rows: string[][], accountId: string): Transaction[] {
	const iDate = col(headers, "date");
	const iType = col(headers, "type");
	const iCategory = col(headers, "category");
	const iName = col(headers, "name");
	const iSymbol = col(headers, "symbol");
	const iShares = col(headers, "shares");
	const iPrice = col(headers, "price");
	const iAmount = col(headers, "amount");
	const iFee = col(headers, "fee");
	const iTax = col(headers, "tax");
	const iCurrency = col(headers, "currency");
	const iDesc = col(headers, "description");

	const out: Transaction[] = [];
	for (const r of rows) {
		if (r.every((c) => c.trim() === "")) continue;

		const date = parseFlexibleDate(r[iDate] ?? "");
		const type = iType !== -1 ? (r[iType] ?? "").trim() : "";
		const category = iCategory !== -1 ? (r[iCategory] ?? "").trim() : "";
		const isTrade = category === "TRADING";
		const name = iName !== -1 ? (r[iName] ?? "").trim() : "";
		const description = (iDesc !== -1 ? (r[iDesc] ?? "").trim() : "") || name || type;
		const amount = iAmount !== -1 ? parseAmount(r[iAmount] ?? "") : 0;
		const sharesRaw = iShares !== -1 ? parseFloat((r[iShares] ?? "").replace(",", ".")) : NaN;
		const price = iPrice !== -1 ? parseAmount(r[iPrice] ?? "") : undefined;
		const fee = iFee !== -1 ? parseAmount(r[iFee] ?? "") : undefined;
		const tax = iTax !== -1 ? parseAmount(r[iTax] ?? "") : undefined;
		const currency = iCurrency !== -1 ? (r[iCurrency] ?? "EUR").trim() || "EUR" : "EUR";
		const ticker = isTrade && iSymbol !== -1 ? (r[iSymbol] ?? "").trim() : "";

		out.push({
			id: stableHash([accountId, date, amount.toFixed(2), description, ticker, type]),
			date,
			accountId,
			description,
			amount,
			currency,
			type: type || undefined,
			source: "trade-republic",
			ticker: ticker || undefined,
			assetClass: isTrade ? category : undefined,
			// Trade Republic reports a sell's own shares as a negative magnitude; the rest of the app
			// (investingHoldings) expects a plain positive count and uses buy/sell action to net it out.
			shares: isNaN(sharesRaw) ? undefined : Math.abs(sharesRaw),
			price,
			fee,
			tax,
			action: TR_TYPE_TO_ACTION[type.toLowerCase()] ?? undefined,
		});
	}
	return out;
}

/** Trade Republic buy/sell/dividend/deposit rows, keyed on ticker rather than counterparty. */
export function parseTradeRepublicRows(headers: string[], rows: string[][], accountId: string): Transaction[] {
	// The two Trade Republic export shapes are distinguished by their security-identifier column —
	// "symbol" (newer "Transaction export") vs. "ticker"/"isin" (older report) — see
	// parseTradeRepublicTransactionExport's own comment for the rest of the differences.
	if (col(headers, "symbol") !== -1 && col(headers, "ticker", "isin") === -1) {
		return parseTradeRepublicTransactionExport(headers, rows, accountId);
	}

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
		const amount = iAmount !== -1 ? signedAmount(parseAmount(r[iAmount] ?? ""), action) : 0;
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
