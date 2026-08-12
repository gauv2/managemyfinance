import { describe, it, expect } from "vitest";
import { costForCycle, effectiveDisplayCycle, monthlyCost, scaleMonthly, yearlyCost } from "./subscriptions";
import type { Subscription } from "./types";

function sub(overrides: Partial<Subscription> = {}): Subscription {
	return {
		id: "sub-1",
		name: "Test",
		category: "Software",
		cost: 12,
		billingCycle: "monthly",
		paidVia: "private",
		nextDueDate: "2026-09-01",
		...overrides,
	};
}

describe("costForCycle", () => {
	it("quotes a monthly-billed subscription in either basis", () => {
		const s = sub({ cost: 15.99, billingCycle: "monthly" });
		expect(costForCycle(s, "monthly")).toBeCloseTo(15.99);
		expect(costForCycle(s, "yearly")).toBeCloseTo(191.88);
	});

	it("quotes a yearly-billed subscription in either basis", () => {
		const s = sub({ cost: 659.88, billingCycle: "yearly" });
		expect(costForCycle(s, "yearly")).toBeCloseTo(659.88);
		expect(costForCycle(s, "monthly")).toBeCloseTo(54.99);
	});

	it("normalises cycles that divide neither year nor month evenly", () => {
		const quarterly = sub({ cost: 30, billingCycle: "quarterly" });
		expect(costForCycle(quarterly, "monthly")).toBeCloseTo(10);
		expect(costForCycle(quarterly, "yearly")).toBeCloseTo(120);

		const weekly = sub({ cost: 10, billingCycle: "weekly" });
		expect(costForCycle(weekly, "yearly")).toBeCloseTo(520);
	});

	it("agrees with monthlyCost/yearlyCost", () => {
		const s = sub({ cost: 7.5, billingCycle: "quarterly" });
		expect(costForCycle(s, "monthly")).toBe(monthlyCost(s));
		expect(costForCycle(s, "yearly")).toBe(yearlyCost(s));
	});
});

describe("scaleMonthly", () => {
	it("is the identity for a monthly basis and ×12 for yearly", () => {
		expect(scaleMonthly(100, "monthly")).toBe(100);
		expect(scaleMonthly(100, "yearly")).toBe(1200);
	});
});

describe("effectiveDisplayCycle", () => {
	it("lets a fixed page setting override the subscription's own preference", () => {
		expect(effectiveDisplayCycle({ displayCycle: "yearly" }, "monthly")).toBe("monthly");
		expect(effectiveDisplayCycle({ displayCycle: "monthly" }, "yearly")).toBe("yearly");
	});

	it("defers to the subscription in mixed mode", () => {
		expect(effectiveDisplayCycle({ displayCycle: "yearly" }, "per-subscription")).toBe("yearly");
		expect(effectiveDisplayCycle({ displayCycle: "monthly" }, "per-subscription")).toBe("monthly");
	});

	it("falls back to monthly when neither is set", () => {
		expect(effectiveDisplayCycle({}, "per-subscription")).toBe("monthly");
		expect(effectiveDisplayCycle({}, undefined)).toBe("monthly");
	});
});
