import type FinancePlugin from "../main";

/**
 * The sidebar's rotating tips.
 *
 * A single tip that appears until you happen to satisfy it is a nag with no way out; it also can't
 * teach you anything about the rest of the app. This is a small deck instead: each tip knows when
 * it's *relevant* (there's no point suggesting transfer matching to someone with one account), you
 * can page through them, and dismissing one is permanent — dismissal is stored per tip id, so a
 * dismissed tip never returns even after a restart or a new release adds more.
 */
export interface Tip {
	id: string;
	title: string;
	body: string;
	/** Optional call to action. Omitted for tips that are purely informational. */
	action?: { label: string; icon: string; run: (plugin: FinancePlugin) => void };
	/** Whether this tip has anything to say given the current state of the vault. */
	isRelevant: (plugin: FinancePlugin) => boolean;
}

const hasAnyBudget = (plugin: FinancePlugin): boolean =>
	plugin.store.categories.some((c) => Object.values(c.budgetHistory ?? {}).some((v) => v > 0));

/**
 * The deck. Ordered roughly by how early in a vault's life the advice matters, since a fresh vault
 * satisfies the relevance checks of the later ones anyway.
 */
export const TIPS: Tip[] = [
	{
		id: "set-budgets",
		title: "Set a budget",
		body: "Plan a monthly limit per category and every page starts telling you where you stand, not just what happened.",
		action: { label: "Suggest budgets", icon: "wand-2", run: (plugin) => void plugin.openView("budgets") },
		isRelevant: (plugin) => !hasAnyBudget(plugin),
	},
	{
		id: "link-transfers",
		title: "Link your transfers",
		body: "Money moved between your own accounts arrives as two unconnected rows, inflating income and expenses alike. Linking them fixes your savings rate.",
		action: { label: "Find transfers", icon: "arrow-left-right", run: (plugin) => plugin.openTransferMatcher() },
		isRelevant: (plugin) => plugin.store.accounts.length > 1 && plugin.store.transactions.some((t) => !t.transferGroupId),
	},
	{
		id: "review-queue",
		title: "Empty the review queue",
		body: "Imported rows wait in Review until you've looked at them. Bulk-categorize, flag anything you can't decide on, and get it to zero.",
		action: { label: "Open Review", icon: "check-check", run: (plugin) => void plugin.openView("review") },
		isRelevant: (plugin) => plugin.store.transactions.filter((t) => (t.review ?? "new") === "new").length > 20,
	},
	{
		id: "record-balances",
		title: "Record what things are worth",
		body: "A pension, a house or a savings account you never export can't be valued from transactions. Record a balance now and then and net worth stops being a guess.",
		action: { label: "Record a balance", icon: "scale", run: (plugin) => plugin.openBalanceSnapshot() },
		isRelevant: (plugin) => plugin.store.snapshots.length === 0 && plugin.store.accounts.length > 0,
	},
	{
		id: "detect-subscriptions",
		title: "Find hidden subscriptions",
		body: "Charges that repeat on a regular cycle for the same amount are almost always subscriptions — including the ones you've forgotten you're paying.",
		action: { label: "Scan the ledger", icon: "repeat", run: (plugin) => plugin.openSubscriptionDetector() },
		isRelevant: (plugin) => plugin.store.transactions.length > 50,
	},
	{
		id: "embed-in-notes",
		title: "Put figures in your notes",
		body: "A ```finance code block renders a live budget meter, spending chart or net worth card inside any note — handy in a monthly review.",
		isRelevant: () => true,
	},
	{
		id: "manual-entry",
		title: "Cash counts too",
		body: "Add a transaction by hand for anything no export will ever carry — cash spending, a payment between friends, or a row an import got wrong.",
		action: { label: "Add a transaction", icon: "plus", run: (plugin) => plugin.openTransactionEditor() },
		isRelevant: (plugin) => plugin.store.accounts.some((a) => a.type === "cash"),
	},
	{
		id: "merchant-memory",
		title: "Categorize once, not forever",
		body: "Set a category on a merchant and every other transaction from that shop follows — backwards through the ledger and forwards through future imports.",
		isRelevant: (plugin) => plugin.store.transactions.some((t) => !t.categoryId),
	},
	{
		id: "monthly-report",
		title: "Write the month down",
		body: "Generate a monthly report and it lands in your vault as a real note with frontmatter — searchable, linkable, and queryable by Dataview.",
		action: { label: "Write this month", icon: "file-text", run: (plugin) => void plugin.writeMonthlyReport() },
		isRelevant: (plugin) => plugin.store.transactions.length > 0,
	},
	{
		id: "privacy-mode",
		title: "Hide the numbers",
		body: "The eye button blurs every amount, IBAN and card number at once — for screen-sharing, or working with the vault open in company.",
		isRelevant: () => true,
	},
];

/** Tips worth showing right now: relevant, and not dismissed. */
export function availableTips(plugin: FinancePlugin): Tip[] {
	const dismissed = new Set(plugin.settings.dismissedTips ?? []);
	return TIPS.filter((tip) => !dismissed.has(tip.id) && tip.isRelevant(plugin));
}

/** Dismisses a tip for good. Returns the updated dismissed list for saving. */
export function dismissTip(plugin: FinancePlugin, id: string): string[] {
	const dismissed = new Set(plugin.settings.dismissedTips ?? []);
	dismissed.add(id);
	return Array.from(dismissed);
}
