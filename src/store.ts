import { App, normalizePath } from "obsidian";
import { parseCSV, toCSV } from "./csv";
import { DEFAULT_DATA_FOLDER, defaultCategories, defaultSecondaryCategories } from "./constants";
import { DEFAULT_BASE_CURRENCY, type FxContext } from "./currency";
import type { MerchantMap } from "./import/merchantMemory";
import type { NumberFormatPreference } from "./money";
import type { AiSettings } from "./ai/provider";
import type { EmailSettings, TelegramSettings, TestDeliverySettings } from "./delivery/channels";
import type { ReportSchedule } from "./reports/schedule";
import { reviewCounts, type ReviewCounts } from "./review";
import { defaultStrategy } from "./strategy";
import type {
	Account,
	BalanceSnapshot,
	Card,
	Category,
	CategoryRule,
	Debt,
	ImportBatch,
	OneOffBudget,
	Portfolio,
	PortfolioBudgetingSettings,
	Strategy,
	Subscription,
	Transaction,
} from "./types";

/** The workspace pages that aren't scoped to a single account. */
export type FinanceViewId =
	| "budgets"
	| "categories"
	| "subscriptions"
	| "debts"
	| "cards"
	| "review"
	| "reports"
	| "compare"
	| "strategy"
	| "settings";

export interface FinanceSettings {
	/** The active portfolio's data folder — kept in sync with portfolios.find(p => p.id === activePortfolioId).folder. */
	dataFolder: string;
	/** Where dropped receipts and invoices are copied to, vault-relative. Blank means the default,
	 *  `<dataFolder>/attachments` — see attachmentFolderOf, which is the only place that decides. */
	attachmentFolder?: string;
	fiMultiplier: number;
	expectedReturn: number;
	/** Scopes the whole workspace to one account's transactions; undefined means "All Accounts". */
	activeAccountId?: string;
	/** Selects a workspace page that isn't account-scoped, e.g. the subscriptions tracker. */
	activeView?: FinanceViewId;
	/** Whether Review's "By merchant" panel is folded away. It sits above the queue and is worth
	 *  hiding once its merchants are filed, without losing it. */
	reviewMerchantPanelCollapsed?: boolean;
	reviewCategoryPanelCollapsed?: boolean;
	/** Whether the sidebar's "Closed" group is open. Collapsed by default: a closed account is history
	 *  you occasionally consult, not something that should compete with the accounts you use. */
	closedAccountsExpanded?: boolean;
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
	/** Historical ECB rates, keyed by "YYYY-MM-DD" then currency code — the dated counterpart to
	 *  `exchangeRates`, used for flow (transaction-date) conversion. Populated only by the explicit
	 *  "Backfill historical rates" action in Settings → Currency (v1.2.7 remediation Phase 3), never
	 *  fetched automatically. Shared across portfolios, same as `exchangeRates` — a rate for a given
	 *  currency on a given date doesn't depend on which portfolio is asking. */
	exchangeRateHistory?: Record<string, Record<string, number>>;
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
	// Same append-only rule as above — debt payment split (v1.2.7 Phase 4), added after everything else.
	"principalAmount",
	"interestAmount",
	"feeAmount",
	// Same append-only rule again — category-rule provenance, added last.
	"categoryRuleId",
];

/**
 * A category set by anything other than the rule itself is no longer the rule's doing, so the
 * provenance stamp comes off with it.
 *
 * Applied here rather than at each call site because there are a dozen ways to re-file a row — the
 * detail modal, the edit modal, bulk re-categorize, the Review page, merchant memory, a later import
 * — and a stale "set by rule" badge on a row you fixed by hand is worse than no badge at all. A patch
 * that names `categoryRuleId` explicitly is left alone: that is the rule engine stamping its own work.
 */
function clearStaleRuleProvenance(patch: Partial<Transaction>): Partial<Transaction> {
	if (!("categoryId" in patch) || "categoryRuleId" in patch) return patch;
	return { ...patch, categoryRuleId: undefined };
}

const NUMERIC_COLUMNS: (keyof Transaction)[] = [
	"amount",
	"shares",
	"price",
	"fee",
	"tax",
	"principalAmount",
	"interestAmount",
	"feeAmount",
];

/**
 * The columns `Transaction` declares as always present, which a blank cell must therefore come back
 * from as `""` and not `undefined`.
 *
 * A row with no date is a real thing — the ledger files undated rows under `unknown.csv` on purpose —
 * but the type says `date: string`, so every reader downstream is entitled to call `.localeCompare`
 * or `.slice` on it without a guard. Blanking it to `undefined` behind this function's
 * `as unknown as Transaction` cast turned that entitlement into a TypeError thrown far from the CSV
 * that caused it: the category drill-down rendered an empty modal on "All time", because that is the
 * one scope whose period filter doesn't discard undated rows before the sort.
 *
 * `""` reads as "not known" everywhere that already mattered — `!tx.date` and `inPeriod` treat it
 * exactly as they treated `undefined` — so this narrows the blanking without changing any filter.
 */
const REQUIRED_TX_STRINGS = new Set<string>(["id", "date", "accountId", "description", "currency", "source"]);

/**
 * Loads/persists all Finance data inside the vault: accounts/categories/rules as JSON,
 * transactions as one CSV per source per year under data/ledger/<source>/<year>.csv.
 * Everything here is plain text so it stays diffable and readable outside the plugin too.
 */
export class FinanceStore {
	/**
	 * Told the review tallies either side of any write that could move them.
	 *
	 * Lives here because this is the one place every path goes through: fifteen files write a
	 * transaction, and anything that watched only some of them would miss the rest.
	 */
	onReviewChange?: (before: ReviewCounts, after: ReviewCounts) => void;

	private reviewTally(): ReviewCounts {
		return reviewCounts(this.transactions);
	}

	accounts: Account[] = [];
	categories: Category[] = [];
	rules: CategoryRule[] = [];
	transactions: Transaction[] = [];
	subscriptions: Subscription[] = [];
	/** Informal debts with people and companies — a register, deliberately outside every total. See Debt. */
	debts: Debt[] = [];
	cards: Card[] = [];
	/** merchant key → what this portfolio has learned about it. See import/merchantMemory.ts. */
	merchants: MerchantMap = {};
	/** Hand-recorded account balances — see BalanceSnapshot. */
	snapshots: BalanceSnapshot[] = [];
	/** One entry per import run, newest last — what makes an import undoable. */
	batches: ImportBatch[] = [];
	/** Named one-off budgets (a holiday, a kitchen) — see OneOffBudget. */
	oneOffBudgets: OneOffBudget[] = [];
	/** The written financial plan — a singleton, not a collection. See Strategy. */
	strategy: Strategy = defaultStrategy();
	/** How this portfolio budgets — calendar month or pay cycle. See payCycle.ts. */
	budgeting: PortfolioBudgetingSettings = { periodMode: "calendar" };

	constructor(private app: App, public settings: FinanceSettings) {}

	/**
	 * Base currency + rate table, in the shape every calculation module takes. Read fresh each time
	 * rather than cached, so changing the base currency or fetching new rates is reflected on the next
	 * render without anything having to invalidate anything.
	 */
	get fx(): FxContext {
		return {
			baseCurrency: this.settings.baseCurrency ?? DEFAULT_BASE_CURRENCY,
			rates: this.settings.exchangeRates,
			history: this.settings.exchangeRateHistory,
		};
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
		await this.migrateIncomeCategoryKind();
		await this.seedDefaultSecondaryCategories();
		this.accounts = await this.readJson<Account[]>(this.path("data", "accounts.json"), []);
		this.rules = await this.readJson<CategoryRule[]>(this.path("data", "rules.json"), []);
		this.subscriptions = await this.readJson<Subscription[]>(this.path("data", "subscriptions.json"), []);
		this.debts = await this.readJson<Debt[]>(this.path("data", "debts.json"), []);
		this.cards = await this.readJson<Card[]>(this.path("data", "cards.json"), []);
		this.merchants = await this.readJson<MerchantMap>(this.path("data", "merchants.json"), {});
		this.snapshots = await this.readJson<BalanceSnapshot[]>(this.path("data", "snapshots.json"), []);
		this.batches = await this.readJson<ImportBatch[]>(this.path("data", "import-batches.json"), []);
		this.oneOffBudgets = await this.readJson<OneOffBudget[]>(this.path("data", "oneoff-budgets.json"), []);
		this.strategy = await this.readJson<Strategy>(this.path("data", "strategy.json"), defaultStrategy());
		this.budgeting = await this.readJson<PortfolioBudgetingSettings>(this.path("data", "budgeting.json"), { periodMode: "calendar" });
		await this.migrateRolloverToGlobal();
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

	/**
	 * One-time migration: `kind` arrived after the default categories were already seeded, so every
	 * vault created before it has an Income category that reads as an expense — its budget scored as a
	 * ceiling to stay under rather than a target to reach, and money arriving into it indistinguishable
	 * from a refund (see isRefund in kpi.ts, which is gated on this flag existing somewhere).
	 *
	 * Guarded on *nothing* in the vault being flagged as income, rather than on a stored "already ran"
	 * marker. That makes it self-limiting: it bootstraps the flag once, and from then on the guard is
	 * false forever — including for someone who flags a differently-named category ("Salary") instead,
	 * whose choice it must not override. A vault that has already expressed an opinion is never touched.
	 *
	 * Matches the default category by name, since that is the one this plugin created.
	 */
	private async migrateIncomeCategoryKind(): Promise<void> {
		if (this.categories.some((c) => c.kind === "income")) return;
		const income = this.categories.find((c) => !c.parentId && c.name.trim().toLowerCase() === "income");
		if (!income) return;
		income.kind = "income";
		await this.saveCategories();
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

	/**
	 * One-time migration: rollover used to be set per category — first a plain boolean, then briefly
	 * a per-category `"off" | "full" | "debt"` mode — before becoming one dial for the whole portfolio
	 * (`this.budgeting.rolloverMode`). Whichever legacy shape a category carries, its mode feeds a
	 * single winner: `"debt"` beats `"full"` beats `"off"`, favouring whoever most clearly opted into
	 * carrying something forward rather than the weakest signal found. Never overrides a global mode
	 * already chosen. Safe to re-run: once no category carries either legacy field, there's nothing
	 * left to migrate.
	 */
	private async migrateRolloverToGlobal(): Promise<void> {
		let changed = false;
		const found = new Set<"off" | "full" | "debt">();
		for (const cat of this.categories) {
			const legacyFlag = (cat as unknown as { rollover?: boolean }).rollover;
			const legacyMode = (cat as unknown as { rolloverMode?: "off" | "full" | "debt" }).rolloverMode;
			if (legacyFlag !== undefined) {
				found.add(legacyFlag ? "full" : "off");
				delete (cat as unknown as { rollover?: boolean }).rollover;
				changed = true;
			}
			if (legacyMode !== undefined) {
				found.add(legacyMode);
				delete (cat as unknown as { rolloverMode?: "off" | "full" | "debt" }).rolloverMode;
				changed = true;
			}
		}
		if (found.size > 0 && this.budgeting.rolloverMode === undefined) {
			this.budgeting.rolloverMode = found.has("debt") ? "debt" : found.has("full") ? "full" : "off";
			await this.saveBudgeting();
		}
		if (changed) await this.saveCategories();
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
			if (tx[key] === "" && !REQUIRED_TX_STRINGS.has(key)) tx[key] = undefined;
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

	async saveDebts(): Promise<void> {
		await this.app.vault.adapter.write(this.path("data", "debts.json"), JSON.stringify(this.debts, null, "\t"));
	}

	async saveCards(): Promise<void> {
		await this.app.vault.adapter.write(this.path("data", "cards.json"), JSON.stringify(this.cards, null, "\t"));
	}

	async saveMerchants(): Promise<void> {
		await this.app.vault.adapter.write(this.path("data", "merchants.json"), JSON.stringify(this.merchants, null, "\t"));
	}

	/**
	 * Copies merchant memory aside before something destructive overwrites it.
	 *
	 * Merchant memory is the only place a categorization decision survives once the rows that taught it
	 * are gone, and every write here replaces the whole file — there is no per-entry history to fall
	 * back on. A snapshot costs one small file and turns "I clicked the wrong button" from permanent
	 * into a rename. Returns the path so the caller can say where it went.
	 */
	async backupMerchants(reason: string): Promise<string> {
		const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
		const folder = this.path("data", "backups");
		await this.ensureFolder(folder);
		const file = normalizePath(`${folder}/merchants-${stamp}-${reason}.json`);
		await this.app.vault.adapter.write(file, JSON.stringify(this.merchants, null, "\t"));
		return file;
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

	async saveStrategy(): Promise<void> {
		await this.app.vault.adapter.write(this.path("data", "strategy.json"), JSON.stringify(this.strategy, null, "\t"));
	}

	async saveBudgeting(): Promise<void> {
		await this.app.vault.adapter.write(this.path("data", "budgeting.json"), JSON.stringify(this.budgeting, null, "\t"));
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
		const before = this.onReviewChange ? this.reviewTally() : undefined;
		Object.assign(tx, clearStaleRuleProvenance(patch));
		if (before) this.onReviewChange?.(before, this.reviewTally());
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
		const before = this.onReviewChange ? this.reviewTally() : undefined;
		Object.assign(tx, clearStaleRuleProvenance(patch));
		if (before) this.onReviewChange?.(before, this.reviewTally());

		// Was a hand-inlined copy of rewriteLedgerFile that derived the year twice, and differently:
		// the filename used `tx.date.slice(0,4) || "unknown"` while the row filter compared against
		// that same string. For a row with no date the two disagreed — the file was named "unknown"
		// but the predicate asked for rows whose year equalled "unknown", which no row satisfies — so
		// the file was rewritten empty and every dateless row of that source was dropped from disk.
		// It also dereferenced tx.date unguarded, throwing outright once the row round-tripped through
		// readLedger as undefined. One helper, one definition of the key, neither failure possible.
		await this.rewriteLedgerFile(this.ledgerKey(tx));
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
		const before = this.onReviewChange ? this.reviewTally() : undefined;
		let count = 0;
		for (const tx of this.transactions) {
			const raw = patches.get(tx.id);
			if (!raw) continue;
			const patch = clearStaleRuleProvenance(raw);
			const keys = Object.keys(patch) as (keyof Transaction)[];
			if (keys.every((k) => tx[k] === patch[k])) continue;
			Object.assign(tx, patch);
			touchedFiles.add(this.ledgerKey(tx));
			count++;
		}
		for (const key of touchedFiles) await this.rewriteLedgerFile(key);
		if (before) this.onReviewChange?.(before, this.reviewTally());
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
		await this.saveDebts();
		await this.saveCards();
		await this.saveMerchants();
		await this.saveSnapshots();
		await this.saveBatches();
		await this.saveOneOffBudgets();
		await this.saveStrategy();
		await this.saveBudgeting();
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
		this.strategy = defaultStrategy();
		this.categories = defaultCategories();
		await this.saveAll();
		await this.seedDefaultSecondaryCategories();
	}
}
