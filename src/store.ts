import { App, normalizePath } from "obsidian";
import { parseCSV, toCSV } from "./csv";
import { defaultCategories } from "./constants";
import type { Account, Card, Category, CategoryRule, Portfolio, Subscription, Transaction } from "./types";

export interface FinanceSettings {
	/** The active portfolio's data folder — kept in sync with portfolios.find(p => p.id === activePortfolioId).folder. */
	dataFolder: string;
	fiMultiplier: number;
	expectedReturn: number;
	/** Scopes the whole workspace to one account's transactions; undefined means "All Accounts". */
	activeAccountId?: string;
	/** Selects a workspace page that isn't account-scoped, e.g. the subscriptions tracker. */
	activeView?: "budgets" | "subscriptions" | "cards";
	/** Blurs every displayed amount (hover to reveal) — for demoing the plugin without exposing real numbers. */
	privacyMode?: boolean;
	/** Every portfolio the vault knows about — each is a fully separate set of accounts/transactions/subscriptions. */
	portfolios?: Portfolio[];
	activePortfolioId?: string;
	/** True once the first-run "add your cards" wizard has been shown (skipped or completed) — never auto-shown again. */
	cardsIntroShown?: boolean;
	/** User-dragged order of the pinned sidebar tabs (All Accounts / Subscriptions / Cards) — missing/unknown ids fall back to the default order. */
	navOrder?: string[];
	/** User-dragged order of the account list in the sidebar — filtered to the active portfolio's own account ids at render time. */
	accountOrder?: string[];
	/** "auto" follows Obsidian's own Platform.isMobile; "on"/"off" force the mobile-friendly layout regardless of device. */
	mobileLayout?: "auto" | "on" | "off";
}

export const DEFAULT_SETTINGS: FinanceSettings = {
	dataFolder: "Finance",
	fiMultiplier: 25,
	expectedReturn: 0.07,
	mobileLayout: "auto",
};

const TX_COLUMNS: (keyof Transaction)[] = [
	"id",
	"date",
	"accountId",
	"description",
	"counterparty",
	"amount",
	"currency",
	"categoryId",
	"type",
	"code",
	"source",
	"raw",
	"notes",
	"ticker",
	"assetClass",
	"shares",
	"price",
	"fee",
	"tax",
	"action",
	"attachmentPath",
];

const NUMERIC_COLUMNS: (keyof Transaction)[] = ["amount", "shares", "price", "fee", "tax"];

/**
 * Loads/persists all Finance data inside the vault: accounts/categories/rules as JSON,
 * transactions as one CSV per source per year under data/ledger/<source>/<year>.csv.
 * Everything here is plain text so it stays diffable and readable outside the plugin too.
 */
export class FinanceStore {
	accounts: Account[] = [];
	categories: Category[] = [];
	rules: CategoryRule[] = [];
	transactions: Transaction[] = [];
	subscriptions: Subscription[] = [];
	cards: Card[] = [];

	constructor(private app: App, public settings: FinanceSettings) {}

	private path(...parts: string[]): string {
		return normalizePath([this.settings.dataFolder, ...parts].join("/"));
	}

	private async ensureFolder(path: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(path))) {
			await adapter.mkdir(path);
		}
	}

	async load(): Promise<void> {
		await this.ensureFolder(this.path());
		await this.ensureFolder(this.path("data"));
		await this.ensureFolder(this.path("data", "ledger"));
		await this.ensureFolder(this.path("data", "inbox"));
		await this.ensureFolder(this.path("reports"));

		this.categories = await this.readJson<Category[]>(this.path("data", "categories.json"), defaultCategories());
		this.accounts = await this.readJson<Account[]>(this.path("data", "accounts.json"), []);
		this.rules = await this.readJson<CategoryRule[]>(this.path("data", "rules.json"), []);
		this.subscriptions = await this.readJson<Subscription[]>(this.path("data", "subscriptions.json"), []);
		this.cards = await this.readJson<Card[]>(this.path("data", "cards.json"), []);

		this.transactions = await this.readLedger();
	}

	private async readJson<T>(path: string, fallback: T): Promise<T> {
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(path)) {
			try {
				return JSON.parse(await adapter.read(path)) as T;
			} catch {
				return fallback;
			}
		}
		await adapter.write(path, JSON.stringify(fallback, null, "\t"));
		return fallback;
	}

	private async readLedger(): Promise<Transaction[]> {
		const adapter = this.app.vault.adapter;
		const ledgerRoot = this.path("data", "ledger");
		const out: Transaction[] = [];
		if (!(await adapter.exists(ledgerRoot))) return out;

		const { folders } = await adapter.list(ledgerRoot);
		for (const sourceFolder of folders) {
			const { files } = await adapter.list(sourceFolder);
			for (const file of files) {
				if (!file.toLowerCase().endsWith(".csv")) continue;
				const rows = parseCSV(await adapter.read(file));
				if (rows.length < 1) continue;
				const fileHeader = rows[0];
				for (const row of rows.slice(1)) {
					const record: Record<string, string> = {};
					this.rowHeader(row, fileHeader).forEach((h, i) => (record[h] = row[i] ?? ""));
					out.push(this.rowToTransaction(record));
				}
			}
		}
		return out;
	}

	/**
	 * A row whose field count matches the *current* schema is read against the current column
	 * order, even if the file's stored header line is stale — otherwise a schema change (a column
	 * added after the file already existed) silently shifts every field read against the old header.
	 */
	private rowHeader(row: string[], fileHeader: string[]): string[] {
		const current = TX_COLUMNS as string[];
		return row.length === current.length ? current : fileHeader;
	}

	private rowToTransaction(record: Record<string, string>): Transaction {
		const tx: Record<string, unknown> = { ...record };
		for (const col of NUMERIC_COLUMNS) {
			const raw = record[col as string];
			tx[col as string] = raw === undefined || raw === "" ? undefined : parseFloat(raw);
		}
		for (const key of Object.keys(tx)) {
			if (tx[key] === "") tx[key] = undefined;
		}
		return tx as unknown as Transaction;
	}

	async saveAccounts(): Promise<void> {
		await this.app.vault.adapter.write(this.path("data", "accounts.json"), JSON.stringify(this.accounts, null, "\t"));
	}

	async saveCategories(): Promise<void> {
		await this.app.vault.adapter.write(this.path("data", "categories.json"), JSON.stringify(this.categories, null, "\t"));
	}

	async saveRules(): Promise<void> {
		await this.app.vault.adapter.write(this.path("data", "rules.json"), JSON.stringify(this.rules, null, "\t"));
	}

	async saveSubscriptions(): Promise<void> {
		await this.app.vault.adapter.write(this.path("data", "subscriptions.json"), JSON.stringify(this.subscriptions, null, "\t"));
	}

	async saveCards(): Promise<void> {
		await this.app.vault.adapter.write(this.path("data", "cards.json"), JSON.stringify(this.cards, null, "\t"));
	}

	existingIds(): Set<string> {
		return new Set(this.transactions.map((t) => t.id));
	}

	/**
	 * Appends only transactions whose id isn't already known. Safe to re-run on an overlapping export.
	 * Groups by each transaction's own `source`/year — a single import (e.g. one combined workbook)
	 * can carry rows from more than one source.
	 */
	async importTransactions(incoming: Transaction[]): Promise<{ added: number; skipped: number }> {
		const existing = this.existingIds();
		const bySourceYear = new Map<string, Transaction[]>();
		let added = 0;
		let skipped = 0;

		for (const tx of incoming) {
			if (existing.has(tx.id)) {
				skipped++;
				continue;
			}
			existing.add(tx.id);
			this.transactions.push(tx);
			const year = tx.date.slice(0, 4) || "unknown";
			const key = `${tx.source}::${year}`;
			if (!bySourceYear.has(key)) bySourceYear.set(key, []);
			bySourceYear.get(key)!.push(tx);
			added++;
		}

		for (const [key, txs] of bySourceYear) {
			const [source, year] = key.split("::");
			await this.appendToLedger(source, year, txs);
		}
		return { added, skipped };
	}

	private serializeTx(tx: Transaction): (string | number | undefined)[] {
		return TX_COLUMNS.map((c) => (tx as unknown as Record<string, unknown>)[c as string] as string | number | undefined);
	}

	private async appendToLedger(source: string, year: string, txs: Transaction[]): Promise<void> {
		const folder = this.path("data", "ledger", source);
		await this.ensureFolder(folder);
		const file = normalizePath(`${folder}/${year}.csv`);
		const adapter = this.app.vault.adapter;

		let rows: string[][] = [];
		if (await adapter.exists(file)) {
			rows = parseCSV(await adapter.read(file));
		}
		rows = this.migrateLedgerRows(rows);

		for (const tx of txs) rows.push(this.serializeTx(tx) as string[]);
		await adapter.write(file, toCSV(rows));
	}

	/** Rewrites a ledger file's header + every row onto the current TX_COLUMNS shape, so a schema
	 *  change never leaves a file with a stale header underneath newly-shaped rows. */
	private migrateLedgerRows(rows: string[][]): string[][] {
		const current = TX_COLUMNS as string[];
		if (rows.length === 0) return [current];
		const fileHeader = rows[0];
		const isCurrent = fileHeader.length === current.length && fileHeader.every((h, i) => h === current[i]);
		if (isCurrent) return rows;

		const migrated: string[][] = [current];
		for (const row of rows.slice(1)) {
			const record: Record<string, string> = {};
			this.rowHeader(row, fileHeader).forEach((h, i) => (record[h] = row[i] ?? ""));
			migrated.push(current.map((h) => record[h] ?? ""));
		}
		return migrated;
	}

	/** Applies an in-place edit (e.g. re-categorizing) and rewrites the transaction's ledger file to match. */
	async updateTransaction(id: string, patch: Partial<Transaction>): Promise<void> {
		const tx = this.transactions.find((t) => t.id === id);
		if (!tx) return;
		Object.assign(tx, patch);

		const year = tx.date.slice(0, 4) || "unknown";
		const folder = this.path("data", "ledger", tx.source);
		await this.ensureFolder(folder);
		const file = normalizePath(`${folder}/${year}.csv`);

		const rows: (string | number | undefined)[][] = [TX_COLUMNS];
		for (const t of this.transactions) {
			if (t.source === tx.source && (t.date || "").slice(0, 4) === year) rows.push(this.serializeTx(t));
		}
		await this.app.vault.adapter.write(file, toCSV(rows));
	}

	/**
	 * Bulk categoryId patch (e.g. from auto-categorization) — unlike calling updateTransaction in a
	 * loop, each affected (source, year) ledger file is only read/rewritten once, not once per row.
	 */
	async recategorize(patches: Map<string, string>): Promise<number> {
		const touchedFiles = new Set<string>();
		let count = 0;
		for (const tx of this.transactions) {
			const newCategoryId = patches.get(tx.id);
			if (newCategoryId === undefined || tx.categoryId === newCategoryId) continue;
			tx.categoryId = newCategoryId;
			touchedFiles.add(`${tx.source}::${(tx.date || "").slice(0, 4) || "unknown"}`);
			count++;
		}

		for (const key of touchedFiles) {
			const [source, year] = key.split("::");
			const folder = this.path("data", "ledger", source);
			await this.ensureFolder(folder);
			const file = normalizePath(`${folder}/${year}.csv`);
			const rows: (string | number | undefined)[][] = [TX_COLUMNS];
			for (const t of this.transactions) {
				if (t.source === source && (t.date || "").slice(0, 4) === year) rows.push(this.serializeTx(t));
			}
			await this.app.vault.adapter.write(file, toCSV(rows));
		}
		return count;
	}
}
