import { describe, it, expect } from "vitest";
import { findCategorizationInconsistencies } from "./categorization";
import type { KpiStore } from "./kpi";
import type { Transaction } from "./types";

const ACCOUNT_ID = "acc-checking";
const CAT_INCOME = "cat-income";
const CAT_TRANSFERS = "cat-transfers";
const CAT_FOOD = "cat-food";

let nextId = 0;
function tx(date: string, counterparty: string, categoryId: string | undefined, amount = 10): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, date, accountId: ACCOUNT_ID, counterparty, amount, currency: "EUR", categoryId, description: counterparty, source: "manual" };
}

function store(transactions: Transaction[]): KpiStore {
	return {
		accounts: [{ id: ACCOUNT_ID, name: "Checking", type: "debit", currency: "EUR" }],
		categories: [
			{ id: CAT_INCOME, name: "Income", color: "#000", icon: "coins", aliases: [] },
			{ id: CAT_TRANSFERS, name: "Transfers", color: "#000", icon: "arrow", aliases: [] },
			{ id: CAT_FOOD, name: "Food", color: "#000", icon: "utensils", aliases: [] },
		],
		transactions,
	};
}

describe("findCategorizationInconsistencies", () => {
	it("flags a counterparty mostly tagged one way with a minority tagged differently (the real Zakgeld case)", () => {
		const s = store([
			tx("2024-01-01", "Mw A N van der Berg", CAT_INCOME),
			tx("2024-02-01", "Mw A N van der Berg", CAT_INCOME),
			tx("2024-03-01", "Mw A N van der Berg", CAT_INCOME),
			tx("2024-04-01", "Mw A N van der Berg", CAT_TRANSFERS),
		]);
		const flags = findCategorizationInconsistencies(s);
		expect(flags).toHaveLength(1);
		expect(flags[0]).toMatchObject({ key: "Mw A N van der Berg", totalCount: 4, majorityCategoryName: "Income", majorityCount: 3 });
		expect(flags[0].outliers).toHaveLength(1);
		expect(flags[0].outliers[0].categoryName).toBe("Transfers");
	});

	it("does not flag a counterparty consistently tagged the same category", () => {
		const s = store([
			tx("2024-01-01", "Albert Heijn", CAT_FOOD),
			tx("2024-02-01", "Albert Heijn", CAT_FOOD),
			tx("2024-03-01", "Albert Heijn", CAT_FOOD),
		]);
		expect(findCategorizationInconsistencies(s)).toHaveLength(0);
	});

	it("does not flag groups below the minimum size", () => {
		const s = store([tx("2024-01-01", "Rare Shop", CAT_FOOD), tx("2024-02-01", "Rare Shop", CAT_TRANSFERS)]);
		expect(findCategorizationInconsistencies(s)).toHaveLength(0);
	});

	it("does not flag a counterparty with no clear majority (an even split)", () => {
		const s = store([
			tx("2024-01-01", "Mixed Vendor", CAT_FOOD),
			tx("2024-02-01", "Mixed Vendor", CAT_FOOD),
			tx("2024-03-01", "Mixed Vendor", CAT_TRANSFERS),
			tx("2024-04-01", "Mixed Vendor", CAT_TRANSFERS),
		]);
		expect(findCategorizationInconsistencies(s)).toHaveLength(0);
	});

	it("groups by description when counterparty is absent", () => {
		const s = store([
			{ ...tx("2024-01-01", "", CAT_FOOD), counterparty: undefined, description: "OPLADEN OV-CHIPKAART" },
			{ ...tx("2024-02-01", "", CAT_FOOD), counterparty: undefined, description: "OPLADEN OV-CHIPKAART" },
			{ ...tx("2024-03-01", "", CAT_TRANSFERS), counterparty: undefined, description: "OPLADEN OV-CHIPKAART" },
		]);
		const flags = findCategorizationInconsistencies(s);
		expect(flags).toHaveLength(1);
		expect(flags[0].key).toBe("OPLADEN OV-CHIPKAART");
	});

	it("treats uncategorized as its own bucket, not a wildcard match", () => {
		const s = store([
			tx("2024-01-01", "Some Shop", CAT_FOOD),
			tx("2024-02-01", "Some Shop", CAT_FOOD),
			tx("2024-03-01", "Some Shop", undefined),
		]);
		const flags = findCategorizationInconsistencies(s);
		expect(flags).toHaveLength(1);
		expect(flags[0].outliers[0].categoryName).toBe("Uncategorized");
	});

	it("sorts flags by outlier count, most impactful first", () => {
		const s = store([
			tx("2024-01-01", "A", CAT_FOOD),
			tx("2024-02-01", "A", CAT_FOOD),
			tx("2024-03-01", "A", CAT_TRANSFERS),
			tx("2024-04-01", "B", CAT_FOOD),
			tx("2024-05-01", "B", CAT_FOOD),
			tx("2024-06-01", "B", CAT_FOOD),
			tx("2024-07-01", "B", CAT_TRANSFERS),
			tx("2024-08-01", "B", CAT_INCOME),
		]);
		const flags = findCategorizationInconsistencies(s);
		expect(flags[0].key).toBe("B"); // 2 outliers, vs A's 1
	});
});
