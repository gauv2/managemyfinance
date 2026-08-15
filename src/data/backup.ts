import { normalizePath, type App } from "obsidian";
import { toCSV } from "../csv";
import type FinancePlugin from "../main";
import type { MerchantMap } from "../import/merchantMemory";
import type { Account, BalanceSnapshot, Card, Category, CategoryRule, ImportBatch, OneOffBudget, Subscription, Transaction } from "../types";

/**
 * Export/import of a whole portfolio, so the data is recoverable independently of the vault it lives
 * in — a plain JSON file you can copy, keep, diff or hand-edit, rather than a folder of files whose
 * relationship you have to reconstruct yourself.
 *
 * The format is intentionally boring: one object, every collection under its own key, transactions
 * inline. Version is stamped so a future schema change can migrate rather than guess.
 */
/**
 * Bumped to 2 when hand-recorded balances, one-off budgets and import batches became things a
 * portfolio can hold. A v1 backup still restores — every collection is optional on the way in — so
 * the bump only stops a v2 backup being read by an older build that would quietly drop them.
 */
export const BACKUP_VERSION = 2;

export interface FinanceBackup {
	version: number;
	exportedAt: string;
	/** Informational — a backup restores into whichever portfolio is active, not the one it came from. */
	portfolioName?: string;
	pluginVersion?: string;
	accounts: Account[];
	categories: Category[];
	rules: CategoryRule[];
	subscriptions: Subscription[];
	cards: Card[];
	transactions: Transaction[];
	/** What the app has learned about merchants — the most expensive thing here to rebuild by hand. */
	merchants?: MerchantMap;
	/** Hand-recorded account balances. Irreplaceable: nothing else in the vault knows what your house
	 *  was worth in 2023, so a backup that dropped these would lose history no import can rebuild. */
	snapshots?: BalanceSnapshot[];
	oneOffBudgets?: OneOffBudget[];
	/** Import runs, so "undo this import" still works against a restored ledger. */
	batches?: ImportBatch[];
}

export interface BackupCounts {
	accounts: number;
	categories: number;
	rules: number;
	subscriptions: number;
	cards: number;
	transactions: number;
}

export function backupCounts(backup: FinanceBackup): BackupCounts {
	return {
		accounts: backup.accounts.length,
		categories: backup.categories.length,
		rules: backup.rules.length,
		subscriptions: backup.subscriptions.length,
		cards: backup.cards.length,
		transactions: backup.transactions.length,
	};
}

export function buildBackup(plugin: FinancePlugin): FinanceBackup {
	const store = plugin.store;
	return {
		version: BACKUP_VERSION,
		exportedAt: new Date().toISOString(),
		portfolioName: plugin.activePortfolio?.name,
		pluginVersion: plugin.manifest.version,
		accounts: store.accounts,
		categories: store.categories,
		rules: store.rules,
		subscriptions: store.subscriptions,
		cards: store.cards,
		transactions: store.transactions,
		merchants: store.merchants,
		snapshots: store.snapshots,
		oneOffBudgets: store.oneOffBudgets,
		batches: store.batches,
	};
}

export function serializeBackup(backup: FinanceBackup): string {
	return JSON.stringify(backup, null, "\t");
}

/**
 * Reads a backup file, rejecting anything that isn't one rather than half-importing it. Every
 * collection is optional on the way in (a hand-trimmed backup holding only subscriptions is a
 * perfectly reasonable thing to want to restore) but must be an array if present.
 */
export function parseBackup(text: string): FinanceBackup {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("That file isn't valid JSON.");
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("That file doesn't look like a Manage My Finance backup.");
	}
	const obj = raw as Record<string, unknown>;
	if (typeof obj.version !== "number") {
		throw new Error("That file doesn't look like a Manage My Finance backup (no version field).");
	}
	if (obj.version > BACKUP_VERSION) {
		throw new Error(`That backup was written by a newer version of this plugin (format v${obj.version}, this one reads v${BACKUP_VERSION}).`);
	}

	const list = <T>(key: string): T[] => {
		const value = obj[key];
		if (value === undefined || value === null) return [];
		if (!Array.isArray(value)) throw new Error(`"${key}" in that backup isn't a list.`);
		return value as T[];
	};

	return {
		version: obj.version,
		exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : "",
		portfolioName: typeof obj.portfolioName === "string" ? obj.portfolioName : undefined,
		pluginVersion: typeof obj.pluginVersion === "string" ? obj.pluginVersion : undefined,
		accounts: list<Account>("accounts"),
		categories: list<Category>("categories"),
		rules: list<CategoryRule>("rules"),
		subscriptions: list<Subscription>("subscriptions"),
		cards: list<Card>("cards"),
		transactions: list<Transaction>("transactions"),
		merchants: obj.merchants && typeof obj.merchants === "object" && !Array.isArray(obj.merchants) ? (obj.merchants as MerchantMap) : {},
		snapshots: list<BalanceSnapshot>("snapshots"),
		oneOffBudgets: list<OneOffBudget>("oneOffBudgets"),
		batches: list<ImportBatch>("batches"),
	};
}

export type RestoreMode = "merge" | "replace";

export interface RestoreResult {
	added: BackupCounts;
	skipped: BackupCounts;
}

/** Adds whatever isn't already present by id, existing entries winning — same rule as everything else. */
function mergeQuietly<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
	const seen = new Set(existing.map((x) => x.id));
	const out = [...existing];
	for (const item of incoming) {
		if (!item || typeof item.id !== "string" || seen.has(item.id)) continue;
		seen.add(item.id);
		out.push(item);
	}
	return out;
}

function emptyCounts(): BackupCounts {
	return { accounts: 0, categories: 0, rules: 0, subscriptions: 0, cards: 0, transactions: 0 };
}

/**
 * Restores a backup into the active portfolio.
 *
 * "merge" adds only what isn't already there, matched on id — so restoring the same backup twice is a
 * no-op, and restoring a backup over a vault that has moved on doesn't undo the newer work. Existing
 * records win on conflict, deliberately: a restore should never silently overwrite something you have
 * since edited.
 *
 * "replace" discards everything currently in the portfolio first. Rules are matched by id in merge
 * mode but by pattern+category too, since rules are the one collection commonly re-seeded from
 * defaults and would otherwise pile up duplicates.
 */
export async function applyBackup(plugin: FinancePlugin, backup: FinanceBackup, mode: RestoreMode): Promise<RestoreResult> {
	const store = plugin.store;
	const added = emptyCounts();
	const skipped = emptyCounts();

	if (mode === "replace") {
		store.accounts = [...backup.accounts];
		store.categories = [...backup.categories];
		store.rules = [...backup.rules];
		store.subscriptions = [...backup.subscriptions];
		store.cards = [...backup.cards];
		store.transactions = [...backup.transactions];
		store.merchants = { ...(backup.merchants ?? {}) };
		store.snapshots = [...(backup.snapshots ?? [])];
		store.oneOffBudgets = [...(backup.oneOffBudgets ?? [])];
		store.batches = [...(backup.batches ?? [])];
		added.accounts = backup.accounts.length;
		added.categories = backup.categories.length;
		added.rules = backup.rules.length;
		added.subscriptions = backup.subscriptions.length;
		added.cards = backup.cards.length;
		added.transactions = backup.transactions.length;
	} else {
		const mergeById = <T extends { id: string }>(existing: T[], incoming: T[], key: keyof BackupCounts): T[] => {
			const seen = new Set(existing.map((x) => x.id));
			const out = [...existing];
			for (const item of incoming) {
				if (!item || typeof item.id !== "string" || seen.has(item.id)) {
					skipped[key]++;
					continue;
				}
				seen.add(item.id);
				out.push(item);
				added[key]++;
			}
			return out;
		};

		store.accounts = mergeById(store.accounts, backup.accounts, "accounts");
		store.categories = mergeById(store.categories, backup.categories, "categories");
		store.subscriptions = mergeById(store.subscriptions, backup.subscriptions, "subscriptions");
		store.cards = mergeById(store.cards, backup.cards, "cards");
		store.transactions = mergeById(store.transactions, backup.transactions, "transactions");
		// Counted under no key of their own: BackupCounts is the summary shown to the user, and
		// "3 recorded balances merged" isn't a number anyone is deciding anything on.
		store.snapshots = mergeQuietly(store.snapshots, backup.snapshots ?? []);
		store.oneOffBudgets = mergeQuietly(store.oneOffBudgets, backup.oneOffBudgets ?? []);
		store.batches = mergeQuietly(store.batches, backup.batches ?? []);
		// Merchant memory merges key-by-key with existing entries winning, same as everything else.
		store.merchants = { ...(backup.merchants ?? {}), ...store.merchants };

		const ruleKey = (r: CategoryRule): string => `${r.pattern}::${r.categoryId}::${r.isRegex ? "re" : "kw"}`;
		const seenRules = new Set(store.rules.map(ruleKey));
		const seenRuleIds = new Set(store.rules.map((r) => r.id));
		for (const rule of backup.rules) {
			if (!rule || seenRuleIds.has(rule.id) || seenRules.has(ruleKey(rule))) {
				skipped.rules++;
				continue;
			}
			seenRules.add(ruleKey(rule));
			seenRuleIds.add(rule.id);
			store.rules.push(rule);
			added.rules++;
		}
	}

	await store.saveAll();
	plugin.refreshViews();
	return { added, skipped };
}

/** The ledger as one flat spreadsheet-friendly file, with ids resolved to names so it reads standalone. */
export function transactionsToCsv(plugin: FinancePlugin): string {
	const store = plugin.store;
	const accountName = new Map(store.accounts.map((a) => [a.id, a.name]));
	const categoryById = new Map(store.categories.map((c) => [c.id, c]));

	const header = [
		"date",
		"account",
		"description",
		"counterparty",
		"amount",
		"currency",
		"category",
		"subcategory",
		"type",
		"code",
		"source",
		"review",
		"notes",
	];
	const rows: (string | number | undefined)[][] = [header];

	for (const tx of [...store.transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
		const cat = tx.categoryId ? categoryById.get(tx.categoryId) : undefined;
		const parent = cat?.parentId ? categoryById.get(cat.parentId) : undefined;
		rows.push([
			tx.date,
			accountName.get(tx.accountId) ?? tx.accountId,
			tx.description,
			tx.counterparty,
			// Written with a plain "." decimal point regardless of display preference: this file is for
			// spreadsheets and other tools, which expect a machine-readable number, not a localized one.
			tx.amount.toFixed(2),
			tx.currency,
			parent?.name ?? cat?.name ?? "",
			parent ? cat?.name ?? "" : "",
			tx.type,
			tx.code,
			tx.source,
			tx.review ?? "new",
			tx.notes,
		]);
	}
	return toCSV(rows);
}

/** "2026-08-12-143005" — sortable, filename-safe, and unique enough to never clobber an earlier export. */
export function timestampSlug(now = new Date()): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(
		now.getSeconds()
	)}`;
}

/**
 * Writes an export into `<dataFolder>/exports/`, inside the vault, so it syncs and backs up with
 * everything else rather than landing somewhere outside it. Returns the path written.
 */
export async function writeExport(app: App, dataFolder: string, baseName: string, extension: string, content: string): Promise<string> {
	const folder = normalizePath(`${dataFolder}/exports`);
	const adapter = app.vault.adapter;
	if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
	const path = normalizePath(`${folder}/${baseName}-${timestampSlug()}.${extension}`);
	await adapter.write(path, content);
	return path;
}
