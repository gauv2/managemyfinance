import { describe, it, expect } from "vitest";
import { categoryChain, descendantIds, isSecondary, primaryCategories, resolvePrimaryId, secondaryCategoriesOf } from "./categories";
import type { Category } from "./types";

const CAR: Category = { id: "cat-car", name: "Auto & Transport", color: "#3b82f6", icon: "car", aliases: [] };
const CAR_WASH: Category = { id: "cat-car-wash", name: "Car Wash", color: "#3b82f6", icon: "sparkles", aliases: [], parentId: "cat-car" };
const FUEL: Category = { id: "cat-fuel", name: "Fuel", color: "#3b82f6", icon: "fuel", aliases: [], parentId: "cat-car" };
const FOOD: Category = { id: "cat-food", name: "Food", color: "#f97316", icon: "utensils", aliases: [] };

const categories = [CAR, CAR_WASH, FUEL, FOOD];

describe("isSecondary", () => {
	it("is true only when parentId is set", () => {
		expect(isSecondary(CAR)).toBe(false);
		expect(isSecondary(CAR_WASH)).toBe(true);
	});
});

describe("primaryCategories / secondaryCategoriesOf", () => {
	it("splits the flat list by parentId", () => {
		expect(primaryCategories(categories).map((c) => c.id)).toEqual([CAR.id, FOOD.id]);
		expect(secondaryCategoriesOf(categories, CAR.id).map((c) => c.id)).toEqual([CAR_WASH.id, FUEL.id]);
		expect(secondaryCategoriesOf(categories, FOOD.id)).toEqual([]);
	});
});

describe("resolvePrimaryId", () => {
	it("returns the id itself for a primary category", () => {
		expect(resolvePrimaryId(categories, CAR.id)).toBe(CAR.id);
	});

	it("walks up to the parent for a secondary category", () => {
		expect(resolvePrimaryId(categories, CAR_WASH.id)).toBe(CAR.id);
	});

	it("returns undefined for an uncategorized transaction", () => {
		expect(resolvePrimaryId(categories, undefined)).toBeUndefined();
	});

	it("self-heals when the parent category no longer exists", () => {
		const orphan: Category = { id: "cat-orphan", name: "Orphan", color: "#000", icon: "tag", aliases: [], parentId: "cat-deleted" };
		expect(resolvePrimaryId([...categories, orphan], orphan.id)).toBe(orphan.id);
	});
});

describe("categoryChain", () => {
	it("returns only primary for a primary-tagged transaction", () => {
		expect(categoryChain(categories, CAR.id)).toEqual({ primary: CAR });
	});

	it("returns both for a secondary-tagged transaction", () => {
		expect(categoryChain(categories, CAR_WASH.id)).toEqual({ primary: CAR, secondary: CAR_WASH });
	});

	it("returns an empty chain for an unset/unknown category", () => {
		expect(categoryChain(categories, undefined)).toEqual({});
		expect(categoryChain(categories, "cat-nope")).toEqual({});
	});
});

describe("descendantIds", () => {
	it("includes the primary and all of its secondaries", () => {
		expect(descendantIds(categories, CAR.id).sort()).toEqual([CAR.id, CAR_WASH.id, FUEL.id].sort());
	});

	it("is just the primary itself when it has no secondaries", () => {
		expect(descendantIds(categories, FOOD.id)).toEqual([FOOD.id]);
	});
});
