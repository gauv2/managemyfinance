import { App, normalizePath } from "obsidian";
import { parseCSV, toCSV } from "./csv";
import { DEFAULT_DATA_FOLDER, defaultCategories, defaultSecondaryCategories } from "./constants";
import { DEFAULT_BASE_CURRENCY, type FxContext } from "./currency";
import type { MerchantMap } from "./import/merchantMemory";
import type { NumberFormatPreference } from "./money";
import type { AiSettings } from "./ai/provider";
import type { EmailSettings, TelegramSettings, TestDeliverySettings } from "./delivery/channels";
import type { ReportSchedule } from "./reports/schedule";
import type {
	Account,
	BalanceSnapshot,
	Card,
	Category,
	CategoryRule,
	ImportBatch,
	OneOffBudget,
	Portfolio,
	Subscription,
	Transaction,
} from "./types";

/** The workspace pages that aren't scoped to a single account. */
export type FinanceViewId = "budgets" | "subscriptions" | "cards" | "review" | "reports" | "settings";

export interface FinanceSettings {
	/** The active portfolio's data folder — kept in sync with portfolios.find(p => p.id === activePortfolioId).folder. */
	dataFolder: string;
	fiMultiplier: number;
	expectedReturn: number;
	/** Scopes the whole workspace to one account's transactions; undefined means "All Accounts". */
	activeAccountId?: string;
	/** Selects a workspace page that isn't account-scoped, e.g. the subscriptions tracker. */
	activeView?: FinanceViewId;
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
	/** Manual, user-maintained rate table (Settings → Currency) for converting non-EUR subscriptions into EUR when
	 *  summing totals — keyed by currency code, 1 unit of that currency = this many EUR. No network calls, ever. */
	exchangeRates?: Record<string, number>;
	/** User-dragged width of the sidebar, in pixels — undefined means the default (268px, set in CSS). */
	navWidth?: number;
	/** Which separators amounts are written with throughout the app — "1.234,56" vs "1,234.56".
	 *  Only affects display and how editable fields are pre-filled; parsing always accepts both. */
	numberFormat?: NumberFormatPreference;
	/** Whether the Subscriptions page quotes everything per month or per year. Individual subscriptions
	 *  can carry their own preference (Subscription.displayCycle), which this overrides when set to
	 *  something other than "per-subscription". */
	subscriptionView?: "monthly" | "yearly" | "per-subscription";
	/** Hides transactions you've already approved from the Review queue (the default) — turn off to
	 *  browse everything, approved rows included. */
	reviewHideApproved?: boolean;
	/** After approving a single row, offer to apply the same decision to every other transaction from
	 *  the same merchant. On by default — it's the difference between one click and forty. The match
	 *  sheet is still reachable per-row when this is off. */
	reviewMatchPrompt?: boolean;
	/** Delimiter for exported report CSVs. ";" for a locale where Excel reads "," as a decimal point
	 *  and so refuses to split a comma-delimited file into columns. Never affects the vault's own data
	 *  files, which are always comma-delimited. */
	reportCsvDelimiter?: "," | ";";
	/** Rows per page in the ledger table. 0 means "all on one page". Persisted because it is a
	 *  preference about how you read, not about the data. */
	ledgerPageSize?: number;
	/** Recurring report deliveries. Nothing fires while Obsidian is closed — a due report is sent on
	 *  the next launch instead. See src/reports/schedule.ts. */
	reportSchedules?: ReportSchedule[];
	/** Credentials for the delivery channels. Stored in this vault's plugin data.json in plain text,
	 *  exactly like the AI key, and the settings panel says so. */
	delivery?: {
		email?: EmailSettings;
		telegram?: TelegramSettings;
		test?: TestDeliverySettings;
	};
	/** AI-assisted categorization. Disabled unless explicitly turned on — see src/ai/provider.ts. */
	ai?: AiSettings;
	/** The currency every total is expressed in. Amounts in any other currency are converted through
	 *  the rate table above. Defaults to EUR, which is what the whole app assumed before this existed. */
	baseCurrency?: string;
	/** Warn when a category's spending crosses `budgetAlertThreshold` of its monthly budget. */
	budgetAlerts?: boolean;
	/** Fraction of a budget at which the warning fires — 0.9 means "tell me at 90%". */
	budgetAlertThreshold?: number;
	/** Tips retired one-by-one by builds before the deck gained a single on/off switch. Nothing writes
	 *  to this any more; it is still honoured so those tips stay gone, and cleared when tips are
	 *  switched back on in settings. See src/ui/tips.ts. */
	dismissedTips?: string[];
	/** Whether the sidebar tip deck appears at all. Closing the card switches this off in one click,
	 *  rather than making you retire ten tips one at a time; the settings page turns it back on. */
	tipsEnabled?: boolean;
	/** Notify on plugin load about subscriptions renewing within the next few days. */
	subscriptionReminders?: boolean;
	/** How many days ahead a subscription renewal reminder fires. */
	subscriptionReminderDays?: number;
}

export const DEFAULT_SETTINGS: FinanceSettings = {
	dataFolder: DEFAULT_DATA_FOLDER,
	fiMultiplier: 25,
	expectedReturn: 0.07,
	mobileLayout: "auto",
	numberFormat: "auto",
	subscriptionView: "monthly",
	reviewHideApproved: true,
	reviewMatchPrompt: true,
	reportCsvDelimiter: ",",
	baseCurrency: DEFAULT_BASE_CURRENCY,
	budgetAlerts: true,
	budgetAlertThreshold: 0.9,
	subscriptionReminders: true,
	subscriptionReminderDays: 3,
	tipsEnabled: true,
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
	// Appended, never inserted: rows written before these columns existed are shorter than the current
	// schema, which is exactly the case rowHeader()/migrateLedgerRows() already handle by rewriting the
	// file onto the current shape on next write. Inserting mid-list instead would misalign old rows.
	"review",
	"reviewNote",
	"transferGroupId",
	"importBatchId",
	"subscriptionId",
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
	/** merchant key → what this portfolio has learned about it. See import/merchantMemory.ts. */
	merchants: MerchantMap = {};
	/** Hand-recorded account balances — see BalanceSnapshot. */
	snapshots: BalanceSnapshot[] = [];
	/** One entry per import run, newest last — what makes an import undoable. */
	batches: ImportBatch[] = [];
	/** Named one-off budgets (a holiday, a kitchen) — see OneOffBudget. */
	oneOffBudgets: OneOffBudget[] = [];

	constructor(private app: App, public settings: FinanceSettings) {}

	/**
	 * Base currency + rate table, in the shape every calculation module takes. Read fresh each time
	 * rather than cached, so changing the base currency or fetching new rates is reflected on the next
	 * render without anything having to invalidate anything.
	 */
	get fx(): FxContext {
		return { baseCurrency: this.settings.baseCurrency ?? DEFAULT_BASE_CURRENCY, rates: this.settings.exchangeRates };
	}

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
		await this.migrateLegacyCategoryBudgets();
		await this.seedDefaultSecondaryCategories();
		this.accounts = await this.readJson<Account[]>(this.path("data", "accounts.json"), []);
		this.rules = await this.readJson<CategoryRule[]>(this.path("data", "rules.json"), []);
		this.subscriptions = await this.readJson<Subscription[]>(this.path("data", "subscriptions.json"), []);
		this.cards = await this.readJson<Card[]>(this.path("data", "cards.json"), []);
		this.merchants = await this.readJson<MerchantMap>(this.path("data", "merchants.json"), {});
		this.snapshots = await this.readJson<BalanceSnapshot[]>(this.path("data", "snapshots.json"), []);
		this.batches = await this.readJson<ImportBatch[]>(this.path("data", "import-batches.json"), []);
		this.oneOffBudgets = await this.readJson<OneOffBudget[]>(this.path("data", "oneoff-budgets.json"), []);
		await this.migrateLegacyCardExpiry();

		this.transactions = await this.readLedger();
	}

	/** One-time migration: pre-history installs stored a single flat `budget` per category. Fold that
	 *  into `budgetHistory` under the current month (so nothing already planned is lost) and drop the
	 *  legacy field — safe to run every load, it's a no-op once every category has moved over. */
	private async migrateLegacyCategoryBudgets(): Promise<void> {
		const now = new Date();
		const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
		let changed = false;
		for (const cat of this.categories) {
			const legacy = (cat as unknown as { budget?: number }).budget;
			if (legacy === undefined) continue;
			cat.budgetHistory = { ...cat.budgetHistory };
			if (cat.budgetHistory[month] === undefined) cat.budgetHistory[month] = legacy;
			delete (cat as unknown as { budget?: number }).budget;
			changed = true;
		}
		if (changed) await this.saveCategories();
	}

	/** One-time (but safe to re-run) seed: adds the default secondary categories for any primary
	 *  category that hasn't been seeded yet — additive only, never touches existing categories, and
	 *  never resurrects secondaries the user deliberately deleted (tracked via `defaultSecondariesSeeded`). */
	async seedDefaultSecondaryCategories(): Promise<void> {
		const unseeded = this.categories.filter((c) => !c.parentId && !c.defaultSecondariesSeeded);
		if (unseeded.length === 0) return;
		const seeded = defaultSecondaryCategories(unseeded);
		this.categories.push(...seeded);
		for (const primary of unseeded) primary.defaultSecondariesSeeded = true;
		await this.saveCategories();
	}

	/** One-time migration: pre-history installs stored expiry as a single "MM/YY" string. Split it into
	 *  expiryMonth/expiryYear and drop the legacy field — safe to run every load. */
	private async migrateLegacyCardExpiry(): Promise<void> {
		let changed = false;
		for (const card of this.cards) {
			const legacy = (card as unknown as { expiry?: string }).expiry;
			if (legacy !== undefined) {
				const m = /^(\d{1,2})\s*\/\s*(\d{2,4})$/.exec(legacy.trim());
				if (m && card.expiryMonth === undefined && card.expiryYear === undefined) {
					card.expiryMonth = parseInt(m[1], 10);
					const y = parseInt(m[2], 10);
					card.expiryYear = y < 100 ? 2000 + y : y;
				}
				delete (card as unknown as { expiry?: string }).expiry;
				changed = true;
			}
		}
		if (changed) await this.saveCards();
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

	async saveMerchants(): Promise<void> {
		await this.app.vault.adapter.write(this.path("data", "merchants.json"), JSON.stringify(this.merchants, null, "\t"));
	}

	async saveSnapshots(): Promise<void> {
		this.snapshots.sort((a, b) => a.date.localeCompare(b.date));
		await this.app.vault.adapter.write(this.path("data", "snapshots.json"), JSON.stringify(this.snapshots, null, "\t"));
	}

	async saveBatches(): Promise<void> {
		await this.app.vault.adapter.write(this.path("data", "import-batches.json"), JSON.stringify(this.batches, null, "\t"));
	}

	async saveOneOffBudgets(): Promise<void> {
		await this.app.vault.adapter.write(this.path("data", "oneoff-budgets.json"), JSON.stringify(this.oneOffBudgets, null, "\t"));
	}

	existingIds(): Set<string> {
		return new Set(this.transactions.map((t) => t.id));
	}

	/**
	 * Appends only transactions whose id isn't already known. Safe to re-run on an overlapping export.
	 * Groups by each transaction's own `source`/year — a single import (e.g. one combined workbook)
	 * can carry rows from more than one source.
	 */
	async importTransactions(
		incoming: Transaction[],
		meta?: { fileName?: string; format?: string }
	): Promise<{ added: number; skipped: number; batchId?: string }> {
		const existing = this.existingIds();
		const bySourceYear = new Map<string, Transaction[]>();
		let added = 0;
		let skipped = 0;

		// Every row from one run of the wizard carries the same batch id, which is the whole basis of
		// "undo this import" — without it a mistaken import can only be unpicked row by row.
		const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

		for (const tx of incoming) {
			if (existing.has(tx.id)) {
				skipped++;
				continue;
			}
			existing.add(tx.id);
			tx.importBatchId = batchId;
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

		if (added > 0) {
			this.batches.push({
				id: batchId,
				importedAt: new Date().toISOString(),
				source: (incoming.find((t) => t.importBatchId === batchId)?.source ?? "generic") as Transaction["source"],
				fileName: meta?.fileName,
				format: meta?.format,
				count: added,
			});
			await this.saveBatches();
		}
		return { added, skipped, batchId: added > 0 ? batchId : undefined };
	}

	/**
	 * Adds one hand-entered transaction. Separate from importTransactions because a manual entry has
	 * no batch, no duplicate check against an export, and should land in the ledger immediately — but
	 * it writes into exactly the same per-source/year CSV, so a manual row is a first-class ledger row
	 * rather than a second class of data living somewhere else.
	 */
	async addTransaction(tx: Transaction): Promise<void> {
		this.transactions.push(tx);
		const year = tx.date.slice(0, 4) || "unknown";
		await this.appendToLedger(tx.source, year, [tx]);
	}

	/**
	 * Removes transactions outright and rewrites every ledger file they touched.
	 *
	 * A deletion has to rewrite rather than append, so this is the one place that has to be careful:
	 * files are recomputed from what's left in memory, and a file whose last transaction just went
	 * away is written back as a header-only file rather than left holding stale rows.
	 */
	async deleteTransactions(ids: Iterable<string>): Promise<number> {
		const doomed = new Set(ids);
		if (doomed.size === 0) return 0;

		const touchedFiles = new Set<string>();
		let removed = 0;
		this.transactions = this.transactions.filter((tx) => {
			if (!doomed.has(tx.id)) return true;
			touchedFiles.add(this.ledgerKey(tx));
			removed++;
			return false;
		});
		for (const key of touchedFiles) await this.rewriteLedgerFile(key);
		return removed;
	}

	/**
	 * A full edit of one transaction, including the fields that decide which ledger file it lives in.
	 *
	 * `updateTransaction` rewrites the file the transaction belongs to *now*, which is correct for a
	 * category or review change but silently leaves a stale copy behind when an edit moves the row to
	 * a different file — changing a date from December to January moves it into the next year's ledger
	 * while the old year still holds the original. Editing a date is the single most likely correction
	 * anyone makes to an imported row, so it gets a method that rewrites both ends of the move.
	 */
	async editTransaction(id: string, patch: Partial<Transaction>): Promise<void> {
		const tx = this.transactions.find((t) => t.id === id);
		if (!tx) return;
		const previousKey = this.ledgerKey(tx);
		Object.assign(tx, patch);
		const nextKey = this.ledgerKey(tx);
		await this.rewriteLedgerFile(nextKey);
		if (previousKey !== nextKey) await this.rewriteLedgerFile(previousKey);
	}

	/** Everything one import run brought in — the rows "undo this import" would remove. */
	transactionsInBatch(batchId: string): Transaction[] {
		return this.transactions.filter((t) => t.importBatchId === batchId);
	}

	/**
	 * Undoes one import: deletes every transaction it created and forgets the batch.
	 *
	 * Rows you've since edited are deleted too, deliberately — "undo this import" means the file
	 * shouldn't have been imported at all, and leaving behind the handful you happened to touch would
	 * be a stranger outcome than removing them. The confirmation dialog says as much.
	 */
	async undoImportBatch(batchId: string): Promise<number> {
		const removed = await this.deleteTransactions(this.transactionsInBatch(batchId).map((t) => t.id));
		this.batches = this.batches.filter((b) => b.id !== batchId);
		await this.saveBatches();
		return removed;
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
		const asPatches = new Map<string, Partial<Transaction>>();
		for (const [id, categoryId] of patches) asPatches.set(id, { categoryId });
		return this.updateTransactions(asPatches);
	}

	/**
	 * The general form of the above: an arbitrary partial patch per transaction id, with each affected
	 * (source, year) ledger file read and rewritten exactly once regardless of how many rows changed.
	 * This is what bulk re-categorizing and bulk approving from the Review page run through — doing it
	 * one updateTransaction() call at a time would rewrite the same CSV once per row.
	 */
	async updateTransactions(patches: Map<string, Partial<Transaction>>): Promise<number> {
		const touchedFiles = new Set<string>();
		let count = 0;
		for (const tx of this.transactions) {
			const patch = patches.get(tx.id);
			if (!patch) continue;
			const keys = Object.keys(patch) as (keyof Transaction)[];
			if (keys.every((k) => tx[k] === patch[k])) continue;
			Object.assign(tx, patch);
			touchedFiles.add(this.ledgerKey(tx));
			count++;
		}
		for (const key of touchedFiles) await this.rewriteLedgerFile(key);
		return count;
	}

	private ledgerKey(tx: Transaction): string {
		return `${tx.source}::${(tx.date || "").slice(0, 4) || "unknown"}`;
	}

	/** Rewrites one "<source>::<year>" ledger file from whatever is currently in memory for it. */
	private async rewriteLedgerFile(key: string): Promise<void> {
		const [source, year] = key.split("::");
		const folder = this.path("data", "ledger", source);
		await this.ensureFolder(folder);
		const file = normalizePath(`${folder}/${year}.csv`);
		const rows: (string | number | undefined)[][] = [TX_COLUMNS];
		for (const t of this.transactions) {
			if (this.ledgerKey(t) === key) rows.push(this.serializeTx(t));
		}
		await this.app.vault.adapter.write(file, toCSV(rows));
	}

	/**
	 * Writes every in-memory transaction back out, one file per (source, year), after first deleting
	 * the existing ledger tree — used by a "replace" restore, where files belonging to a source/year
	 * combination that no longer has any transactions must disappear rather than linger with stale rows.
	 */
	async rewriteAllLedgers(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const ledgerRoot = this.path("data", "ledger");
		if (await adapter.exists(ledgerRoot)) {
			const { folders } = await adapter.list(ledgerRoot);
			for (const sourceFolder of folders) {
				const { files } = await adapter.list(sourceFolder);
				for (const file of files) {
					if (file.toLowerCase().endsWith(".csv")) await adapter.remove(file);
				}
			}
		}
		await this.ensureFolder(ledgerRoot);
		const keys = new Set(this.transactions.map((t) => this.ledgerKey(t)));
		for (const key of keys) await this.rewriteLedgerFile(key);
	}

	/** Persists every JSON collection at once — the counterpart to a bulk in-memory replacement. */
	async saveAll(): Promise<void> {
		await this.saveAccounts();
		await this.saveCategories();
		await this.saveRules();
		await this.saveSubscriptions();
		await this.saveCards();
		await this.saveMerchants();
		await this.saveSnapshots();
		await this.saveBatches();
		await this.saveOneOffBudgets();
		await this.rewriteAllLedgers();
	}

	/**
	 * Empties this portfolio: every account, category, rule, subscription, card and transaction.
	 * Categories are re-seeded from the defaults rather than left empty, because a portfolio with zero
	 * categories can't classify anything and the app would look broken rather than reset. The data
	 * folder itself and its structure are kept — this is "start over", not "uninstall".
	 */
	async deleteAllData(): Promise<void> {
		this.accounts = [];
		this.rules = [];
		this.subscriptions = [];
		this.cards = [];
		this.transactions = [];
		this.merchants = {};
		this.snapshots = [];
		this.batches = [];
		this.oneOffBudgets = [];
		this.categories = defaultCategories();
		await this.saveAll();
		await this.seedDefaultSecondaryCategories();
	}
}
