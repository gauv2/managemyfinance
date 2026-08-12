import type { Category } from "./types";

/** A secondary category is any category nested under a primary one via `parentId`. */
export function isSecondary(category: Pick<Category, "parentId">): boolean {
	return !!category.parentId;
}

export function primaryCategories(categories: Category[]): Category[] {
	return categories.filter((c) => !c.parentId);
}

export function secondaryCategoriesOf(categories: Category[], primaryId: string): Category[] {
	return categories.filter((c) => c.parentId === primaryId);
}

/**
 * Resolves any category id (primary or secondary) up to its primary category's id. Self-heals if a
 * secondary's parent has since been deleted (returns the secondary's own id instead) rather than
 * silently dropping its transactions from every rollup total.
 */
export function resolvePrimaryId(categories: Category[], categoryId: string | undefined): string | undefined {
	if (!categoryId) return undefined;
	const cat = categories.find((c) => c.id === categoryId);
	if (!cat) return categoryId;
	if (!cat.parentId) return cat.id;
	const parent = categories.find((c) => c.id === cat.parentId);
	return parent ? parent.id : cat.id;
}

export interface CategoryChain {
	primary?: Category;
	secondary?: Category;
}

/** The primary/secondary pair behind a category id — `secondary` is only set when `categoryId` itself
 *  points at a secondary category; `primary` is resolved either directly or via its parentId. */
export function categoryChain(categories: Category[], categoryId: string | undefined): CategoryChain {
	if (!categoryId) return {};
	const cat = categories.find((c) => c.id === categoryId);
	if (!cat) return {};
	if (!cat.parentId) return { primary: cat };
	const parent = categories.find((c) => c.id === cat.parentId);
	return { primary: parent, secondary: cat };
}

/** `primaryId` plus every secondary category nested under it — the full set of category ids whose
 *  transactions should count toward that primary category's rollup total. */
export function descendantIds(categories: Category[], primaryId: string): string[] {
	return [primaryId, ...secondaryCategoriesOf(categories, primaryId).map((c) => c.id)];
}

/**
 * Whether `categoryId` may be moved under `newParentId` (or to the top level, when that's undefined).
 *
 * The category model is deliberately exactly two levels deep — every rollup, budget and chart in the
 * app assumes a category is either a primary or one step below one. These rules are what keep that
 * true, so the check lives here next to the readers that depend on it rather than in the UI:
 *
 *   - nothing can be its own parent, or move to where it already is;
 *   - a parent must itself be a primary, otherwise the result is three levels deep;
 *   - a category that has children of its own can't become a child, for the same reason.
 */
export function canReparent(categories: Category[], categoryId: string, newParentId: string | undefined): boolean {
	const cat = categories.find((c) => c.id === categoryId);
	if (!cat) return false;
	if (newParentId === categoryId) return false;
	if ((cat.parentId ?? undefined) === (newParentId ?? undefined)) return false;

	if (newParentId === undefined) return true;

	const parent = categories.find((c) => c.id === newParentId);
	if (!parent || parent.parentId) return false;
	return secondaryCategoriesOf(categories, categoryId).length === 0;
}

/** The categories `categoryId` could legally be moved under, plus the top level. UI-facing companion
 *  to canReparent, so the dropdown only ever offers moves that will actually be accepted. */
export function reparentTargets(categories: Category[], categoryId: string): Category[] {
	return primaryCategories(categories).filter((p) => canReparent(categories, categoryId, p.id));
}

/**
 * Applies a move, returning a new list. Also drops `budgetMode` when a category stops being a primary,
 * since "budget is the sum of my subcategories" is meaningless for something that can't have any.
 */
export function reparented(categories: Category[], categoryId: string, newParentId: string | undefined): Category[] {
	if (!canReparent(categories, categoryId, newParentId)) return categories;
	return categories.map((c) => {
		if (c.id !== categoryId) return c;
		const moved: Category = { ...c };
		if (newParentId === undefined) {
			delete moved.parentId;
		} else {
			moved.parentId = newParentId;
			delete moved.budgetMode;
			delete moved.defaultSecondariesSeeded;
		}
		return moved;
	});
}
