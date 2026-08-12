import { describe, it, expect } from "vitest";
import {
	canReparent,
	categoryChain,
	descendantIds,
	isSecondary,
	primaryCategories,
	reparentTargets,
	reparented,
	resolvePrimaryId,
	secondaryCategoriesOf,
} from "./categories";
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

describe("canReparent", () => {
	it("lets a secondary move to another primary", () => {
		expect(canReparent(categories, FUEL.id, FOOD.id)).toBe(true);
	});

	it("lets a secondary be promoted to the top level", () => {
		expect(canReparent(categories, FUEL.id, undefined)).toBe(true);
	});

	it("lets a childless primary become a secondary", () => {
		expect(canReparent(categories, FOOD.id, CAR.id)).toBe(true);
	});

	it("refuses to nest a primary that has children — the model is exactly two levels deep", () => {
		expect(canReparent(categories, CAR.id, FOOD.id)).toBe(false);
	});

	it("refuses a secondary as a parent, which would make three levels", () => {
		expect(canReparent(categories, FOOD.id, FUEL.id)).toBe(false);
	});

	it("refuses self-parenting and no-op moves", () => {
		expect(canReparent(categories, FUEL.id, FUEL.id)).toBe(false);
		expect(canReparent(categories, FUEL.id, CAR.id)).toBe(false);
		expect(canReparent(categories, FOOD.id, undefined)).toBe(false);
	});

	it("refuses unknown categories and unknown parents", () => {
		expect(canReparent(categories, "nope", CAR.id)).toBe(false);
		expect(canReparent(categories, FUEL.id, "nope")).toBe(false);
	});
});

describe("reparentTargets", () => {
	it("offers only primaries the move is legal for", () => {
		expect(reparentTargets(categories, FUEL.id).map((c) => c.id)).toEqual([FOOD.id]);
		expect(reparentTargets(categories, CAR.id)).toEqual([]);
	});
});

describe("reparented", () => {
	it("moves a secondary under a new primary", () => {
		const next = reparented(categories, FUEL.id, FOOD.id);
		expect(next.find((c) => c.id === FUEL.id)?.parentId).toBe(FOOD.id);
		expect(secondaryCategoriesOf(next, CAR.id).map((c) => c.id)).toEqual([CAR_WASH.id]);
		expect(secondaryCategoriesOf(next, FOOD.id).map((c) => c.id)).toEqual([FUEL.id]);
	});

	it("promotes a secondary to the top level", () => {
		const next = reparented(categories, FUEL.id, undefined);
		expect(next.find((c) => c.id === FUEL.id)?.parentId).toBeUndefined();
		expect(primaryCategories(next).map((c) => c.id)).toContain(FUEL.id);
	});

	it("drops budgetMode when a primary becomes a secondary, since it can no longer have children", () => {
		const withMode = categories.map((c) => (c.id === FOOD.id ? { ...c, budgetMode: "breakdown" as const, defaultSecondariesSeeded: true } : c));
		const next = reparented(withMode, FOOD.id, CAR.id);
		const moved = next.find((c) => c.id === FOOD.id);
		expect(moved?.parentId).toBe(CAR.id);
		expect(moved?.budgetMode).toBeUndefined();
		expect(moved?.defaultSecondariesSeeded).toBeUndefined();
	});

	it("is a no-op for an illegal move", () => {
		expect(reparented(categories, CAR.id, FOOD.id)).toBe(categories);
	});

	it("does not mutate the input list", () => {
		reparented(categories, FUEL.id, FOOD.id);
		expect(FUEL.parentId).toBe(CAR.id);
	});
});
