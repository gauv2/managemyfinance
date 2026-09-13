import { describe, expect, it } from "vitest";
import { activeAccounts, tracksBalance } from "./accounts";
import type { Account } from "./types";

function acc(id: string, overrides: Partial<Account> = {}): Account {
	return { id, name: id, type: "debit", currency: "EUR", ...overrides };
}

describe("activeAccounts", () => {
	it("offers every account when none is closed", () => {
		const list = [acc("a"), acc("b")];
		expect(activeAccounts(list).map((a) => a.id)).toEqual(["a", "b"]);
	});

	it("drops a closed account from the choices", () => {
		const list = [acc("a"), acc("b", { archived: true })];
		expect(activeAccounts(list).map((a) => a.id)).toEqual(["a"]);
	});

	it("keeps a closed account that is already the selected value", () => {
		// Otherwise opening a subscription that was paid from a since-closed account would silently
		// re-point it at whatever happened to be first in the list.
		const list = [acc("a"), acc("b", { archived: true })];
		expect(activeAccounts(list, "b").map((a) => a.id)).toEqual(["a", "b"]);
	});

	it("treats archived:false as open", () => {
		expect(activeAccounts([acc("a", { archived: false })]).map((a) => a.id)).toEqual(["a"]);
	});
});

describe("tracksBalance", () => {
	it("treats an account written before the option existed as tracked", () => {
		expect(tracksBalance(acc("a"))).toBe(true);
		expect(tracksBalance({ trackBalance: undefined })).toBe(true);
	});

	it("is false only when explicitly turned off", () => {
		expect(tracksBalance({ trackBalance: false })).toBe(false);
		expect(tracksBalance({ trackBalance: true })).toBe(true);
	});
});
