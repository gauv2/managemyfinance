import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import { parseCSV } from "./csv";
import { DEFAULT_SETTINGS, FinanceStore, type FinanceSettings } from "./store";
import type { Category, Transaction } from "./types";

/**
 * The ledger's persistence layer: schema migration, per-source/year filing, dedupe, edits and
 * deletes. This is the code that can quietly eat someone's data — a stale header read against
 * newly-shaped rows shifts every field by one and still parses — so it's the code most worth
 * pinning down.
 */

const FOLDER = "TestFinance";

function newStore(settings: Partial<FinanceSettings> = {}): { store: FinanceStore; app: App } {
	const app = new App();
	const store = new FinanceStore(app as never, { ...DEFAULT_SETTINGS, dataFolder: FOLDER, ...settings });
	return { store, app };
}

function tx(overrides: Partial<Transaction> = {}): Transaction {
	return {
		id: overrides.id ?? `tx-${Math.random().toString(36).slice(2)}`,
		date: "2024-03-15",
		accountId: "acc-1",
		description: "Groceries",
		amount: -12.5,
		currency: "EUR",
		source: "manual",
		...overrides,
	};
}

function ledgerPath(source: string, year: string): string {
	return `${FOLDER}/data/ledger/${source}/${year}.csv`;
}

describe("FinanceStore — ledger round-trip", () => {
	it("writes an imported transaction and reads back exactly what went in", async () => {
		const { store, app } = newStore();
		await store.load();

		await store.importTransactions([tx({ id: "a", amount: -12.5, counterparty: "Albert Heijn" })]);

		const reloaded = new FinanceStore(app as never, { ...DEFAULT_SETTINGS, dataFolder: FOLDER });
		await reloaded.load();

		expect(reloaded.transactions).toHaveLength(1);
		expect(reloaded.transactions[0]).toMatchObject({
			id: "a",
			amount: -12.5,
			counterparty: "Albert Heijn",
			date: "2024-03-15",
		});
	});

	it("reads an undated row back as an empty date, never undefined", async () => {
		const { store, app } = newStore();
		await store.load();

		// The importers file a row whose date never parsed under unknown.csv rather than dropping it,
		// so this is a shape the ledger genuinely holds — not a hypothetical.
		await store.importTransactions([tx({ id: "undated", date: "", amount: -9.99 })]);

		const reloaded = new FinanceStore(app as never, { ...DEFAULT_SETTINGS, dataFolder: FOLDER });
		await reloaded.load();

		const row = reloaded.transactions.find((t) => t.id === "undated");
		expect(row).toBeDefined();
		// `date` is declared `string`, so every reader is entitled to call string methods on it without
		// a guard. Handing back undefined threw a TypeError far from the CSV that caused it — the
		// category drill-down rendered an empty modal on "All time", the one scope that doesn't filter
		// undated rows out before sorting them.
		expect(row!.date).toBe("");
		expect(() => [row!].sort((a, b) => b.date.localeCompare(a.date))).not.toThrow();
	});

	it("keeps every other blank cell as undefined rather than an empty string", async () => {
		const { store, app } = newStore();
		await store.load();

		await store.importTransactions([tx({ id: "sparse", counterparty: "", notes: "" })]);

		const reloaded = new FinanceStore(app as never, { ...DEFAULT_SETTINGS, dataFolder: FOLDER });
		await reloaded.load();

		const row = reloaded.transactions.find((t) => t.id === "sparse");
		expect(row!.counterparty).toBeUndefined();
		expect(row!.notes).toBeUndefined();
	});

	it("files transactions by source and year, one file each", async () => {
		const { store, app } = newStore();
		await store.load();

		await store.importTransactions([
			tx({ id: "a", date: "2023-01-01", source: "ing" }),
			tx({ id: "b", date: "2024-01-01", source: "ing" }),
			tx({ id: "c", date: "2024-01-01", source: "revolut" }),
		]);

		expect(await app.vault.adapter.exists(ledgerPath("ing", "2023"))).toBe(true);
		expect(await app.vault.adapter.exists(ledgerPath("ing", "2024"))).toBe(true);
		expect(await app.vault.adapter.exists(ledgerPath("revolut", "2024"))).toBe(true);
	});

	it("skips transactions whose id is already in the ledger, so re-importing an overlap is a no-op", async () => {
		const { store } = newStore();
		await store.load();

		const first = await store.importTransactions([tx({ id: "a" }), tx({ id: "b" })]);
		const second = await store.importTransactions([tx({ id: "b" }), tx({ id: "c" })]);

		expect(first).toMatchObject({ added: 2, skipped: 0 });
		expect(second).toMatchObject({ added: 1, skipped: 1 });
		expect(store.transactions.map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
	});

	it("preserves values containing commas and quotes through the CSV round-trip", async () => {
		const { store, app } = newStore();
		await store.load();
		const nasty = 'Payment for "goods", misc';

		await store.importTransactions([tx({ id: "a", description: nasty })]);
		const reloaded = new FinanceStore(app as never, { ...DEFAULT_SETTINGS, dataFolder: FOLDER });
		await reloaded.load();

		expect(reloaded.transactions[0].description).toBe(nasty);
	});
});

describe("FinanceStore — Income category kind migration", () => {
	async function seeded(categories: Category[]): Promise<FinanceStore> {
		const { store, app } = newStore();
		await store.load();
		store.categories = categories;
		await store.saveCategories();
		const reloaded = new FinanceStore(app as never, { ...DEFAULT_SETTINGS, dataFolder: FOLDER });
		await reloaded.load();
		return reloaded;
	}
	const cat = (over: Partial<Category> = {}): Category => ({
		id: "cat-x",
		name: "Income",
		color: "#16a34a",
		icon: "wallet",
		aliases: [],
		...over,
	});

	it("flags a pre-existing Income category that never had a kind", async () => {
		const s = await seeded([cat({ id: "cat-12-income" }), cat({ id: "cat-food", name: "Food" })]);
		expect(s.categories.find((c) => c.name === "Income")!.kind).toBe("income");
	});

	it("leaves the vault alone once any category is already flagged", async () => {
		// Someone who flags "Salary" instead has expressed an opinion; overriding it would be rude and
		// would give them two income categories where they wanted one.
		const s = await seeded([cat({ id: "cat-12-income" }), cat({ id: "cat-salary", name: "Salary", kind: "income" })]);
		expect(s.categories.find((c) => c.name === "Income")!.kind).toBeUndefined();
		expect(s.categories.find((c) => c.name === "Salary")!.kind).toBe("income");
	});

	it("does nothing when there is no Income category at all", async () => {
		const s = await seeded([cat({ id: "cat-food", name: "Food" })]);
		expect(s.categories.some((c) => c.kind === "income")).toBe(false);
	});

	it("ignores a secondary category that happens to be called Income", async () => {
		const s = await seeded([cat({ id: "cat-biz", name: "Business" }), cat({ id: "cat-biz-sub", parentId: "cat-biz" })]);
		expect(s.categories.find((c) => c.parentId)!.kind).toBeUndefined();
	});

	it("is a no-op on the second load rather than fighting a later change", async () => {
		const { store, app } = newStore();
		await store.load();
		store.categories = [cat({ id: "cat-12-income" })];
		await store.saveCategories();
		const first = new FinanceStore(app as never, { ...DEFAULT_SETTINGS, dataFolder: FOLDER });
		await first.load();
		expect(first.categories[0].kind).toBe("income");
		const second = new FinanceStore(app as never, { ...DEFAULT_SETTINGS, dataFolder: FOLDER });
		await second.load();
		expect(second.categories[0].kind).toBe("income");
	});
});

describe("FinanceStore — rollover migrated from per-category to one global setting", () => {
	async function seeded(categories: unknown[]): Promise<FinanceStore> {
		const { store, app } = newStore();
		await store.load();
		store.categories = categories as Category[];
		await store.saveCategories();
		const reloaded = new FinanceStore(app as never, { ...DEFAULT_SETTINGS, dataFolder: FOLDER });
		await reloaded.load();
		return reloaded;
	}
	const cat = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
		id: "cat-x",
		name: "Food",
		color: "#000",
		icon: "utensils",
		aliases: [],
		...over,
	});

	it("folds a legacy per-category rollover:true into the global setting as full", async () => {
		const s = await seeded([cat({ rollover: true })]);
		expect(s.budgeting.rolloverMode).toBe("full");
		expect((s.categories[0] as unknown as { rollover?: boolean }).rollover).toBeUndefined();
	});

	it("folds a legacy per-category rollover:false into the global setting as off, dropping the old field", async () => {
		const s = await seeded([cat({ rollover: false })]);
		expect(s.budgeting.rolloverMode).toBe("off");
		expect((s.categories[0] as unknown as { rollover?: boolean }).rollover).toBeUndefined();
	});

	it("folds a legacy per-category rolloverMode into the global setting, dropping the old field", async () => {
		const s = await seeded([cat({ rolloverMode: "debt" })]);
		expect(s.budgeting.rolloverMode).toBe("debt");
		expect((s.categories[0] as unknown as { rolloverMode?: string }).rolloverMode).toBeUndefined();
	});

	it("prefers debt over full when different categories disagreed", async () => {
		const s = await seeded([cat({ id: "cat-a", rolloverMode: "full" }), cat({ id: "cat-b", name: "Travel", rolloverMode: "debt" })]);
		expect(s.budgeting.rolloverMode).toBe("debt");
	});

	it("leaves categories with no legacy field at all alone, and the global setting unset", async () => {
		const s = await seeded([cat()]);
		expect(s.budgeting.rolloverMode).toBeUndefined();
	});

	it("never overrides a global rolloverMode already chosen", async () => {
		const { store, app } = newStore();
		await store.load();
		store.categories = [cat({ rolloverMode: "full" })] as unknown as Category[];
		await store.saveCategories();
		store.budgeting.rolloverMode = "debt";
		await store.saveBudgeting();

		const reloaded = new FinanceStore(app as never, { ...DEFAULT_SETTINGS, dataFolder: FOLDER });
		await reloaded.load();
		expect(reloaded.budgeting.rolloverMode).toBe("debt");
	});
});

describe("FinanceStore — schema migration", () => {
	it("reads a file written before a column existed, without shifting every field", async () => {
		const { store, app } = newStore();
		await store.load();

		// A ledger file from an older build: the current schema has more columns than this.
		await app.vault.adapter.write(
			ledgerPath("ing", "2024"),
			"id,date,accountId,description,counterparty,amount,currency,categoryId\n" + "old-1,2024-05-01,acc-1,Rent,Landlord,-900,EUR,cat-home\n"
		);

		const reloaded = new FinanceStore(app as never, { ...DEFAULT_SETTINGS, dataFolder: FOLDER });
		await reloaded.load();

		expect(reloaded.transactions[0]).toMatchObject({
			id: "old-1",
			description: "Rent",
			counterparty: "Landlord",
			amount: -900,
			categoryId: "cat-home",
		});
	});

	it("rewrites a stale file onto the current schema when anything is appended to it", async () => {
		const { store, app } = newStore();
		await store.load();
		await app.vault.adapter.write(
			ledgerPath("ing", "2024"),
			"id,date,accountId,description,amount,currency,source\n" + "old-1,2024-05-01,acc-1,Rent,-900,EUR,ing\n"
		);

		const reloaded = new FinanceStore(app as never, { ...DEFAULT_SETTINGS, dataFolder: FOLDER });
		await reloaded.load();
		await reloaded.importTransactions([tx({ id: "new-1", date: "2024-06-01", source: "ing" })]);

		const rows = parseCSV(await app.vault.adapter.read(ledgerPath("ing", "2024")));
		expect(rows[0]).toContain("transferGroupId");
		// The old row survived the rewrite with its fields still in the right places.
		const oldRow = rows.find((r) => r[0] === "old-1")!;
		expect(oldRow[rows[0].indexOf("description")]).toBe("Rent");
		expect(oldRow[rows[0].indexOf("amount")]).toBe("-900");
	});
});

describe("FinanceStore — editing and deleting", () => {
	it("adds a manual transaction straight into the ledger file", async () => {
		const { store, app } = newStore();
		await store.load();

		await store.addTransaction(tx({ id: "m1", source: "manual", date: "2024-07-04" }));

		expect(await app.vault.adapter.exists(ledgerPath("manual", "2024"))).toBe(true);
		expect(store.transactions).toHaveLength(1);
	});

	it("deletes a transaction from memory and from its file", async () => {
		const { store, app } = newStore();
		await store.load();
		await store.importTransactions([tx({ id: "a" }), tx({ id: "b" })]);

		const removed = await store.deleteTransactions(["a"]);

		expect(removed).toBe(1);
		expect(store.transactions.map((t) => t.id)).toEqual(["b"]);
		const rows = parseCSV(await app.vault.adapter.read(ledgerPath("manual", "2024")));
		expect(rows.map((r) => r[0])).not.toContain("a");
	});

	it("leaves a header-only file behind when the last transaction in it is deleted", async () => {
		const { store, app } = newStore();
		await store.load();
		await store.importTransactions([tx({ id: "a" })]);

		await store.deleteTransactions(["a"]);

		const rows = parseCSV(await app.vault.adapter.read(ledgerPath("manual", "2024")));
		expect(rows).toHaveLength(1);
		expect(rows[0][0]).toBe("id");
	});

	it("moves a transaction between ledger files when an edit changes its year", async () => {
		const { store, app } = newStore();
		await store.load();
		await store.importTransactions([tx({ id: "a", date: "2023-12-31" })]);

		await store.editTransaction("a", { date: "2024-01-01" });

		const oldRows = parseCSV(await app.vault.adapter.read(ledgerPath("manual", "2023")));
		const newRows = parseCSV(await app.vault.adapter.read(ledgerPath("manual", "2024")));
		// The row must not exist in both places — that's a duplicated transaction in every total.
		expect(oldRows.map((r) => r[0])).not.toContain("a");
		expect(newRows.map((r) => r[0])).toContain("a");
	});

	it("rewrites each affected file exactly once for a bulk patch", async () => {
		const { store } = newStore();
		await store.load();
		await store.importTransactions([tx({ id: "a" }), tx({ id: "b" }), tx({ id: "c" })]);

		const changed = await store.updateTransactions(
			new Map([
				["a", { categoryId: "cat-food" }],
				["b", { categoryId: "cat-food" }],
				// Already unset, so this one isn't a change at all and shouldn't be counted.
				["c", { categoryId: undefined }],
			])
		);

		expect(changed).toBe(2);
		expect(store.transactions.filter((t) => t.categoryId === "cat-food")).toHaveLength(2);
	});
});

describe("FinanceStore — import batches", () => {
	it("stamps every row of one import with the same batch id and records the batch", async () => {
		const { store } = newStore();
		await store.load();

		const result = await store.importTransactions([tx({ id: "a" }), tx({ id: "b" })], { fileName: "march.csv" });

		expect(result.batchId).toBeDefined();
		expect(store.transactions.every((t) => t.importBatchId === result.batchId)).toBe(true);
		expect(store.batches).toHaveLength(1);
		expect(store.batches[0]).toMatchObject({ count: 2, fileName: "march.csv" });
	});

	it("undoing an import removes exactly that import's rows and nothing else", async () => {
		const { store } = newStore();
		await store.load();
		const first = await store.importTransactions([tx({ id: "a" }), tx({ id: "b" })]);
		await store.importTransactions([tx({ id: "c" })]);

		const removed = await store.undoImportBatch(first.batchId!);

		expect(removed).toBe(2);
		expect(store.transactions.map((t) => t.id)).toEqual(["c"]);
		expect(store.batches).toHaveLength(1);
	});

	it("records no batch when every row was a duplicate", async () => {
		const { store } = newStore();
		await store.load();
		await store.importTransactions([tx({ id: "a" })]);

		const second = await store.importTransactions([tx({ id: "a" })]);

		expect(second).toMatchObject({ added: 0, skipped: 1, batchId: undefined });
		expect(store.batches).toHaveLength(1);
	});
});

describe("FinanceStore — collections", () => {
	it("persists snapshots, one-off budgets and batches across a reload", async () => {
		const { store, app } = newStore();
		await store.load();

		store.snapshots.push({ id: "s1", accountId: "acc-1", date: "2024-01-01", balance: 1000 });
		store.oneOffBudgets.push({ id: "o1", name: "Japan", amount: 3000, startDate: "2024-01-01", endDate: "2024-06-30" });
		await store.saveSnapshots();
		await store.saveOneOffBudgets();

		const reloaded = new FinanceStore(app as never, { ...DEFAULT_SETTINGS, dataFolder: FOLDER });
		await reloaded.load();

		expect(reloaded.snapshots).toHaveLength(1);
		expect(reloaded.oneOffBudgets[0]).toMatchObject({ name: "Japan", amount: 3000 });
	});

	it("deleteAllData empties every collection but re-seeds categories", async () => {
		const { store } = newStore();
		await store.load();
		await store.importTransactions([tx({ id: "a" })]);
		store.snapshots.push({ id: "s1", accountId: "acc-1", date: "2024-01-01", balance: 1 });
		store.accounts.push({ id: "acc-1", name: "Checking", type: "debit", currency: "EUR" });

		await store.deleteAllData();

		expect(store.transactions).toHaveLength(0);
		expect(store.accounts).toHaveLength(0);
		expect(store.snapshots).toHaveLength(0);
		expect(store.batches).toHaveLength(0);
		// A portfolio with no categories can't classify anything and would look broken, not reset.
		expect(store.categories.length).toBeGreaterThan(0);
	});

	it("exposes base currency and rates as an fx context for the calculation modules", async () => {
		const { store } = newStore({ baseCurrency: "USD", exchangeRates: { USD: 0.9 } });
		await store.load();

		expect(store.fx).toEqual({ baseCurrency: "USD", rates: { USD: 0.9 } });
	});
});

describe("FinanceStore — category-rule provenance", () => {
	it("keeps the stamp when the rule engine sets the category and the stamp together", async () => {
		const { store } = newStore();
		await store.load();
		await store.importTransactions([tx({ id: "a" })]);

		await store.updateTransactions(new Map([["a", { categoryId: "cat-food", categoryRuleId: "rule-1" }]]));

		expect(store.transactions.find((t) => t.id === "a")?.categoryRuleId).toBe("rule-1");
	});

	it("drops the stamp when the category is later set by hand", async () => {
		// A row you re-filed yourself is no longer the rule's doing, and a badge still claiming it is
		// would be a lie told by the UI about work the user did.
		const { store } = newStore();
		await store.load();
		await store.importTransactions([tx({ id: "a" })]);
		await store.updateTransactions(new Map([["a", { categoryId: "cat-food", categoryRuleId: "rule-1" }]]));

		await store.updateTransaction("a", { categoryId: "cat-travel" });

		const row = store.transactions.find((t) => t.id === "a");
		expect(row?.categoryId).toBe("cat-travel");
		expect(row?.categoryRuleId).toBeUndefined();
	});

	it("drops the stamp through editTransaction too", async () => {
		const { store } = newStore();
		await store.load();
		await store.importTransactions([tx({ id: "a" })]);
		await store.updateTransactions(new Map([["a", { categoryId: "cat-food", categoryRuleId: "rule-1" }]]));

		await store.editTransaction("a", { categoryId: "cat-travel" });

		expect(store.transactions.find((t) => t.id === "a")?.categoryRuleId).toBeUndefined();
	});

	it("drops the stamp even when the category is re-set to the same value", async () => {
		// The early-out in updateTransactions compares the whole patch, so this must not slip through
		// as a no-op and leave the row still claiming a rule owns it.
		const { store } = newStore();
		await store.load();
		await store.importTransactions([tx({ id: "a" })]);
		await store.updateTransactions(new Map([["a", { categoryId: "cat-food", categoryRuleId: "rule-1" }]]));

		await store.updateTransactions(new Map([["a", { categoryId: "cat-food" }]]));

		expect(store.transactions.find((t) => t.id === "a")?.categoryRuleId).toBeUndefined();
	});

	it("leaves the stamp alone on a patch that isn't about the category at all", async () => {
		const { store } = newStore();
		await store.load();
		await store.importTransactions([tx({ id: "a" })]);
		await store.updateTransactions(new Map([["a", { categoryId: "cat-food", categoryRuleId: "rule-1" }]]));

		await store.updateTransactions(new Map([["a", { review: "approved" as const }]]));

		expect(store.transactions.find((t) => t.id === "a")?.categoryRuleId).toBe("rule-1");
	});

	it("round-trips the stamp through the ledger CSV", async () => {
		// categoryRuleId was appended to TX_COLUMNS; if the column were missing the value would
		// silently vanish on the next load and every badge with it.
		const { store, app } = newStore();
		await store.load();
		await store.importTransactions([tx({ id: "a" })]);
		await store.updateTransactions(new Map([["a", { categoryId: "cat-food", categoryRuleId: "rule-1" }]]));

		const reloaded = new FinanceStore(app as never, { ...DEFAULT_SETTINGS, dataFolder: FOLDER });
		await reloaded.load();

		expect(reloaded.transactions.find((t) => t.id === "a")?.categoryRuleId).toBe("rule-1");
	});
});
