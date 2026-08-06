import { App, normalizePath } from "obsidian";
import { parseCSV, toCSV } from "./csv";
import { defaultCategories } from "./constants";
import type { Account, Category, CategoryRule, Transaction } from "./types";

export interface FinanceSettings {
	dataFolder: string;
	fiMultiplier: number;
	expectedReturn: number;
}

export const DEFAULT_SETTINGS: FinanceSettings = {
	dataFolder: "Finance",
	fiMultiplier: 25,
	expectedReturn: 0.07,
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
				const header = rows[0];
				for (const row of rows.slice(1)) {
					const record: Record<string, string> = {};
					header.forEach((h, i) => (record[h] = row[i] ?? ""));
					out.push(this.rowToTransaction(record));
				}
			}
		}
		return out;
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

	existingIds(): Set<string> {
		return new Set(this.transactions.map((t) => t.id));
	}

	/** Appends only transactions whose id isn't already known. Safe to re-run on an overlapping export. */
	async importTransactions(
		source: Transaction["source"],
		incoming: Transaction[]
	): Promise<{ added: number; skipped: number }> {
		const existing = this.existingIds();
		const byYear = new Map<string, Transaction[]>();
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
			if (!byYear.has(year)) byYear.set(year, []);
			byYear.get(year)!.push(tx);
			added++;
		}

		for (const [year, txs] of byYear) {
			await this.appendToLedger(source, year, txs);
		}
		return { added, skipped };
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
		if (rows.length === 0) rows.push(TX_COLUMNS as string[]);

		for (const tx of txs) {
			rows.push(TX_COLUMNS.map((c) => (tx as unknown as Record<string, unknown>)[c as string] as string | undefined ?? ""));
		}
		await adapter.write(file, toCSV(rows));
	}
}
