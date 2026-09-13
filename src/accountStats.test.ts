import { describe, expect, it } from "vitest";
import { accountStats, allAccountStats, orphanedTransactions } from "./accountStats";
import type { Account, Transaction } from "./types";

let n = 0;
function tx(overrides: Partial<Transaction> = {}): Transaction {
	n++;
	return {
		id: `t-${n}`,
		date: "2024-03-15",
		accountId: "acc-a",
		description: "Albert Heijn 1423 Den Haag",
		amount: -10,
		currency: "EUR",
		source: "manual",
		...overrides,
	};
}

function acc(id: string): Account {
	return { id, name: id, type: "debit", currency: "EUR" };
}

describe("accountStats", () => {
	it("counts only the account asked about", () => {
		const rows = [tx(), tx(), tx({ accountId: "acc-b" })];
		expect(accountStats(rows, "acc-a").transactions).toBe(2);
		expect(accountStats(rows, "acc-b").transactions).toBe(1);
	});

	it("reports the covered period", () => {
		const rows = [tx({ date: "2019-08-12" }), tx({ date: "2014-10-28" }), tx({ date: "2016-01-01" })];
		const s = accountStats(rows, "acc-a");
		expect(s.firstDate).toBe("2014-10-28");
		expect(s.lastDate).toBe("2019-08-12");
		// Oct 2014 to Aug 2019 inclusive.
		expect(s.monthsSpanned).toBe(59);
		expect(s.monthsWithActivity).toBe(3);
	});

	it("counts undated rows instead of hiding them", () => {
		// They still count in every total, so a stats panel that quietly dropped them would explain
		// the wrong number of transactions.
		const rows = [tx({ date: "2024-01-01" }), tx({ date: "" })];
		const s = accountStats(rows, "acc-a");
		expect(s.transactions).toBe(2);
		expect(s.undated).toBe(1);
		expect(s.firstDate).toBe("2024-01-01");
	});

	it("has no period at all when nothing is dated", () => {
		const s = accountStats([tx({ date: "" })], "acc-a");
		expect(s.firstDate).toBeUndefined();
		expect(s.monthsSpanned).toBe(0);
	});

	it("counts merchants by the same key merchant memory uses", () => {
		// Branch numbers collapse, city names do not — merchantKey deliberately under-merges, since
		// over-merging silently mis-files a whole group. So two branches of one shop count as two, and
		// the figure means "distinct things merchant memory is tracking" rather than "distinct shops".
		const rows = [
			tx({ description: "Albert Heijn 1423 Den Haag" }),
			tx({ description: "Albert Heijn 0891 Den Haag" }),
			tx({ description: "Albert Heijn 0891 Utrecht" }),
			tx({ description: "Jumbo 88" }),
		];
		expect(accountStats(rows, "acc-a").uniqueMerchants).toBe(3);
	});

	it("splits money in from money out", () => {
		const rows = [tx({ amount: -10 }), tx({ amount: -5 }), tx({ amount: 30 })];
		const s = accountStats(rows, "acc-a");
		expect(s.moneyOut).toBe(-15);
		expect(s.moneyIn).toBe(30);
	});

	it("splits filed from unfiled", () => {
		const rows = [tx({ categoryId: "cat-food" }), tx()];
		const s = accountStats(rows, "acc-a");
		expect(s.categorized).toBe(1);
		expect(s.uncategorized).toBe(1);
	});

	it("lists the sources and currencies present", () => {
		const rows = [tx({ source: "knab" }), tx({ source: "revolut", currency: "USD" }), tx({ source: "knab" })];
		const s = accountStats(rows, "acc-a");
		expect(s.sources).toEqual(["knab", "revolut"]);
		expect(s.currencies).toEqual(["EUR", "USD"]);
	});

	it("returns zeroes for an account with nothing in it", () => {
		const s = accountStats([], "acc-empty");
		expect(s.transactions).toBe(0);
		expect(s.uniqueMerchants).toBe(0);
		expect(s.monthsWithActivity).toBe(0);
	});
});

describe("allAccountStats", () => {
	it("keeps the order it was given", () => {
		const rows = [tx(), tx({ accountId: "acc-b" })];
		expect(allAccountStats(rows, [acc("acc-b"), acc("acc-a")]).map((s) => s.accountId)).toEqual(["acc-b", "acc-a"]);
	});
});

describe("orphanedTransactions", () => {
	it("finds rows whose account no longer exists", () => {
		// Deleting an account leaves its transactions behind, still counting toward totals while
		// belonging to nothing you can open.
		const rows = [tx(), tx({ accountId: "acc-deleted" })];
		expect(orphanedTransactions(rows, [acc("acc-a")]).map((t) => t.accountId)).toEqual(["acc-deleted"]);
	});

	it("finds none when every account is present", () => {
		expect(orphanedTransactions([tx()], [acc("acc-a")])).toHaveLength(0);
	});
});
