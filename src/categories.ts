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
