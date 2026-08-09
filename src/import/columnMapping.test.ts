import { describe, it, expect } from "vitest";
import { applyColumnMapping, emptyColumnMapping, guessColumnMapping } from "./columnMapping";

describe("emptyColumnMapping", () => {
	it("defaults debitValue to empty, not a guessed value", () => {
		// Regression: a non-empty default here (e.g. "debit") would silently override
		// parseIngRows' own correct multi-locale default ("debit"/"af") the moment a
		// debitCredit column gets auto-guessed on a recognized (e.g. Dutch ING) import,
		// even though the user never typed anything into that field themselves.
		expect(emptyColumnMapping().debitValue).toBe("");
	});
});

describe("guessColumnMapping", () => {
	it("maps English ING headers to the right canonical fields", () => {
		const mapping = guessColumnMapping(["Date", "Name / Description", "Account", "Counterparty", "Code", "Debit/Credit", "Amount (EUR)", "Transaction type", "Notifications"]);
		expect(mapping.date).toBe("Date");
		expect(mapping.description).toBe("Name / Description");
		expect(mapping.amount).toBe("Amount (EUR)");
		expect(mapping.counterparty).toBe("Counterparty");
		expect(mapping.debitCredit).toBe("Debit/Credit");
		expect(mapping.type).toBe("Transaction type");
		expect(mapping.code).toBe("Code");
	});

	it("maps Dutch-locale ING headers", () => {
		const mapping = guessColumnMapping(["Datum", "Naam / Omschrijving", "Tegenrekening", "Af Bij", "Bedrag"]);
		expect(mapping.date).toBe("Datum");
		expect(mapping.description).toBe("Naam / Omschrijving");
		expect(mapping.counterparty).toBe("Tegenrekening");
		expect(mapping.amount).toBe("Bedrag");
	});

	it("never assigns the same header to two different fields", () => {
		const headers = ["Date", "Description", "Amount", "Debit/Credit", "Transaction type"];
		const mapping = guessColumnMapping(headers);
		const assigned = Object.values(mapping).filter((v) => v !== "" && v !== "debit");
		expect(new Set(assigned).size).toBe(assigned.length);
	});

	it("leaves fields unmapped when no header matches", () => {
		const mapping = guessColumnMapping(["Foo", "Bar"]);
		expect(mapping.date).toBe("");
		expect(mapping.description).toBe("");
		expect(mapping.amount).toBe("");
	});
});

describe("applyColumnMapping", () => {
	it("renames mapped columns to canonical names and leaves the rest untouched", () => {
		const headers = ["Datum", "Naam / Omschrijving", "Bedrag", "Some Other Column"];
		const mapping = { ...emptyColumnMapping(), date: "Datum", description: "Naam / Omschrijving", amount: "Bedrag" };
		const result = applyColumnMapping(headers, mapping);
		expect(result).toEqual(["date", "description", "amount", "Some Other Column"]);
	});

	it("is a no-op for headers with no mapping at all", () => {
		const headers = ["Debit/Credit", "Af Bij"];
		const result = applyColumnMapping(headers, emptyColumnMapping());
		expect(result).toEqual(headers);
	});
});
