import { describe, it, expect } from "vitest";
import { parseTradeRepublicRows } from "./tradeRepublicParser";
import { detectFormat } from "./detect";

const ACCOUNT_ID = "acc-tr";

// Matches Trade Republic's newer "Transaction export" shape (pre-signed amounts, "symbol"/"type"/"category").
const NEW_HEADERS = ["date", "type", "category", "name", "symbol", "shares", "price", "amount", "fee", "tax", "currency", "description"];

function row(overrides: Partial<Record<(typeof NEW_HEADERS)[number], string>>): string[] {
	const base: Record<string, string> = {
		date: "2024-06-01",
		type: "",
		category: "",
		name: "",
		symbol: "",
		shares: "",
		price: "",
		amount: "0",
		fee: "",
		tax: "",
		currency: "EUR",
		description: "",
	};
	return NEW_HEADERS.map((h) => (overrides[h] ?? base[h]) as string);
}

describe("detectFormat", () => {
	it("recognizes the newer Trade Republic export (symbol column, no ticker/isin)", () => {
		expect(detectFormat(NEW_HEADERS)).toBe("trade-republic");
	});

	it("still recognizes the older Trade Republic export (ticker/isin + action)", () => {
		expect(detectFormat(["date", "action", "ticker", "amount"])).toBe("trade-republic");
	});
});

describe("parseTradeRepublicRows — newer 'Transaction export' shape", () => {
	it("keeps a BUY's amount negative (already signed) and stores shares as a positive magnitude", () => {
		const [tx] = parseTradeRepublicRows(
			NEW_HEADERS,
			[row({ type: "BUY", category: "TRADING", name: "NVIDIA", symbol: "US67066G1040", shares: "1.0000000000", price: "123.500000", amount: "-123.50", fee: "-1.00" })],
			ACCOUNT_ID
		);
		expect(tx.amount).toBe(-123.5);
		expect(tx.ticker).toBe("US67066G1040");
		expect(tx.shares).toBe(1);
		expect(tx.action).toBe("buy");
		expect(tx.assetClass).toBe("TRADING");
	});

	it("stores a SELL's negative raw shares as a positive magnitude", () => {
		const [tx] = parseTradeRepublicRows(
			NEW_HEADERS,
			[row({ type: "SELL", category: "TRADING", symbol: "US6701002056", shares: "-1.0000000000", price: "59.000000", amount: "59.00", fee: "-1.00" })],
			ACCOUNT_ID
		);
		expect(tx.action).toBe("sell");
		expect(tx.shares).toBe(1);
		expect(tx.amount).toBe(59);
	});

	it.each([
		["CUSTOMER_INBOUND", "deposit"],
		["VIBAN_TRANSFER_INBOUND", "deposit"],
		["TRANSFER_INSTANT_INBOUND", "deposit"],
		["CUSTOMER_OUTBOUND_REQUEST", "withdraw"],
		["TRANSFER_INSTANT_OUTBOUND", "withdraw"],
		["DIVIDEND", "dividend"],
		["INTEREST_PAYMENT", "interest"],
	])("maps type %s to action %s", (type, expectedAction) => {
		const [tx] = parseTradeRepublicRows(NEW_HEADERS, [row({ type, category: "CASH", amount: "10" })], ACCOUNT_ID);
		expect(tx.action).toBe(expectedAction);
	});

	it("does not tag a card transaction with a transfer/deposit action — it's a real expense", () => {
		const [tx] = parseTradeRepublicRows(NEW_HEADERS, [row({ type: "CARD_TRANSACTION", category: "CASH", amount: "-11.55", description: "TR Card Transaction" })], ACCOUNT_ID);
		expect(tx.action).toBeUndefined();
		expect(tx.amount).toBe(-11.55);
	});

	it("does not populate ticker/assetClass for a non-trading (cash) row even if symbol happens to be blank", () => {
		const [tx] = parseTradeRepublicRows(NEW_HEADERS, [row({ type: "DIVIDEND", category: "CASH", amount: "0.05" })], ACCOUNT_ID);
		expect(tx.ticker).toBeUndefined();
		expect(tx.assetClass).toBeUndefined();
	});
});

describe("parseTradeRepublicRows — older ticker/action shape (regression)", () => {
	it("still derives sign from the action column on an unsigned magnitude", () => {
		const headers = ["date", "action", "type", "description", "ticker", "amount", "shares"];
		const [tx] = parseTradeRepublicRows(headers, [["2024-06-01", "buy", "", "Buy NVDA", "US67066G1040", "123.50", "1"]], ACCOUNT_ID);
		expect(tx.amount).toBe(-123.5); // buy is cash-out, and this format reports an unsigned magnitude
	});
});
