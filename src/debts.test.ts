import { describe, expect, it } from "vitest";
import { debtTotals, isOverdue, isSettled, outstanding, sortDebts } from "./debts";
import type { Debt } from "./types";

let n = 0;
function debt(overrides: Partial<Debt> = {}): Debt {
	n++;
	return {
		id: `d-${n}`,
		counterparty: "A Friend",
		direction: "owe",
		amount: 100,
		currency: "EUR",
		date: "2026-01-01",
		...overrides,
	};
}

const TODAY = "2026-06-15";

describe("outstanding", () => {
	it("is the whole amount when nothing has been repaid", () => {
		expect(outstanding(debt({ amount: 250 }))).toBe(250);
	});

	it("subtracts what has been repaid", () => {
		expect(outstanding(debt({ amount: 250, paid: 100 }))).toBe(150);
	});

	it("never goes negative when someone overpays", () => {
		expect(outstanding(debt({ amount: 100, paid: 130 }))).toBe(0);
	});
});

describe("isSettled", () => {
	it("is true once marked settled", () => {
		expect(isSettled(debt({ settledDate: "2026-05-01" }))).toBe(true);
	});

	it("is true once it has been repaid in full, even without a settled date", () => {
		// The same statement reached from the other end; a register that only understood the explicit
		// act would keep showing a fully-repaid debt as outstanding.
		expect(isSettled(debt({ amount: 100, paid: 100 }))).toBe(true);
	});

	it("is false while anything is left", () => {
		expect(isSettled(debt({ amount: 100, paid: 99.99 }))).toBe(false);
	});
});

describe("isOverdue", () => {
	it("is true past the due date", () => {
		expect(isOverdue(debt({ dueDate: "2026-05-01" }), TODAY)).toBe(true);
	});

	it("is false on the due date itself", () => {
		expect(isOverdue(debt({ dueDate: TODAY }), TODAY)).toBe(false);
	});

	it("is false without a due date — undated is not late", () => {
		expect(isOverdue(debt({}), TODAY)).toBe(false);
	});

	it("is false once settled, however late it was", () => {
		expect(isOverdue(debt({ dueDate: "2020-01-01", settledDate: "2026-01-01" }), TODAY)).toBe(false);
	});
});

describe("debtTotals", () => {
	it("keeps the two directions apart", () => {
		const totals = debtTotals([debt({ direction: "owe", amount: 100 }), debt({ direction: "owed", amount: 40 })], TODAY);
		expect(totals.owe.EUR).toBe(100);
		expect(totals.owed.EUR).toBe(40);
	});

	it("counts only what is outstanding", () => {
		expect(debtTotals([debt({ amount: 100, paid: 60 })], TODAY).owe.EUR).toBe(40);
	});

	it("leaves settled debts out of the totals but still counts them", () => {
		const totals = debtTotals([debt({ settledDate: "2026-02-02" }), debt({ amount: 30 })], TODAY);
		expect(totals.owe.EUR).toBe(30);
		expect(totals.settledCount).toBe(1);
		expect(totals.openCount).toBe(1);
	});

	it("never adds two currencies together", () => {
		// No rate here would be honest about a personal IOU, so they stay side by side.
		const totals = debtTotals([debt({ amount: 100 }), debt({ amount: 50, currency: "USD" })], TODAY);
		expect(totals.owe).toEqual({ EUR: 100, USD: 50 });
	});

	it("counts what is overdue", () => {
		const totals = debtTotals([debt({ dueDate: "2026-01-01" }), debt({ dueDate: "2026-12-01" })], TODAY);
		expect(totals.overdueCount).toBe(1);
	});

	it("is all zeroes for an empty register", () => {
		expect(debtTotals([], TODAY)).toEqual({ owe: {}, owed: {}, openCount: 0, settledCount: 0, overdueCount: 0 });
	});
});

describe("sortDebts", () => {
	it("leads with what needs attention and sinks what is done", () => {
		const settled = debt({ id: "settled", settledDate: "2026-02-02" });
		const overdue = debt({ id: "overdue", dueDate: "2026-01-01" });
		const upcoming = debt({ id: "upcoming", dueDate: "2026-12-01" });
		const undated = debt({ id: "undated" });

		expect(sortDebts([settled, undated, upcoming, overdue], TODAY).map((d) => d.id)).toEqual([
			"overdue",
			"upcoming",
			"undated",
			"settled",
		]);
	});

	it("orders two overdue debts by how long they have been overdue", () => {
		const older = debt({ id: "older", dueDate: "2025-01-01" });
		const newer = debt({ id: "newer", dueDate: "2026-05-01" });
		expect(sortDebts([newer, older], TODAY).map((d) => d.id)).toEqual(["older", "newer"]);
	});

	it("falls back to the larger amount when nothing else separates them", () => {
		const small = debt({ id: "small", amount: 10 });
		const large = debt({ id: "large", amount: 900 });
		expect(sortDebts([small, large], TODAY).map((d) => d.id)).toEqual(["large", "small"]);
	});

	it("does not mutate what it was given", () => {
		const input = [debt({ id: "a" }), debt({ id: "b", dueDate: "2020-01-01" })];
		const before = input.map((d) => d.id);
		sortDebts(input, TODAY);
		expect(input.map((d) => d.id)).toEqual(before);
	});
});
