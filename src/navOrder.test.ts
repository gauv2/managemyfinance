import { describe, it, expect } from "vitest";
import { mergeNavOrder } from "./navOrder";

const DEFAULTS = ["all-accounts", "cashflow", "networth", "strategy", "budgets", "reports"];

describe("mergeNavOrder", () => {
	it("uses the defaults when nothing has been saved", () => {
		expect(mergeNavOrder([], DEFAULTS)).toEqual(DEFAULTS);
	});

	it("slots a new tab in after the tab it follows by default, not at the bottom", () => {
		expect(mergeNavOrder(["all-accounts", "budgets", "strategy", "reports"], DEFAULTS)).toEqual([
			"all-accounts",
			"cashflow",
			"networth",
			"budgets",
			"strategy",
			"reports",
		]);
	});

	it("follows the anchor wherever you dragged it", () => {
		expect(mergeNavOrder(["reports", "strategy", "budgets", "all-accounts"], DEFAULTS)).toEqual([
			"reports",
			"strategy",
			"budgets",
			"all-accounts",
			"cashflow",
			"networth",
		]);
	});

	it("puts a new first tab first", () => {
		expect(mergeNavOrder(["reports", "cashflow"], ["new", "cashflow", "reports"])).toEqual(["new", "reports", "cashflow"]);
	});

	it("drops tabs that no longer exist, and duplicates", () => {
		expect(mergeNavOrder(["gone", "reports", "reports"], ["reports"])).toEqual(["reports"]);
	});
});
