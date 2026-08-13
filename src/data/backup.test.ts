import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import type FinancePlugin from "../main";
import { DEFAULT_SETTINGS, FinanceStore } from "../store";
import type { Transaction } from "../types";
import { applyBackup, backupCounts, BACKUP_VERSION, buildBackup, parseBackup, serializeBackup, transactionsToCsv } from "./backup";

/**
 * A backup is the only copy of this data that survives the vault, so the tests that matter are about
 * what it *doesn't* lose: a collection missing from the format is a collection silently gone.
 */

async function newPlugin(): Promise<FinancePlugin> {
	const app = new App();
	const store = new FinanceStore(app as never, { ...DEFAULT_SETTINGS, dataFolder: "TestFinance" });
	await store.load();
	return {
		app,
		store,
		manifest: { version: "9.9.9" },
		activePortfolio: { id: "pf-1", name: "Test", folder: "TestFinance" },
		refreshViews: () => undefined,
	} as unknown as FinancePlugin;
}

function tx(id: string, overrides: Partial<Transaction> = {}): Transaction {
	return {
		id,
		date: "2024-03-15",
		accountId: "acc-1",
		description: "Groceries",
		amount: -12.5,
		currency: "EUR",
		source: "manual",
		...overrides,
	};
}

describe("buildBackup", () => {
	it("carries every collection, including the ones nothing else can rebuild", async () => {
		const plugin = await newPlugin();
		const store = plugin.store;
		store.accounts.push({ id: "acc-1", name: "Checking", type: "debit", currency: "EUR" });
		store.transactions.push(tx("t1"));
		store.snapshots.push({ id: "s1", accountId: "acc-1", date: "2024-01-01", balance: 400_000, note: "valuation" });
		store.oneOffBudgets.push({ id: "o1", name: "Japan", amount: 3000, startDate: "2024-01-01", endDate: "2024-06-30" });
		store.batches.push({ id: "b1", importedAt: "2024-03-01T10:00:00Z", source: "ing", count: 12 });

		const backup = buildBackup(plugin);

		expect(backup.version).toBe(BACKUP_VERSION);
		expect(backup.pluginVersion).toBe("9.9.9");
		expect(backup.portfolioName).toBe("Test");
		// Nothing in the vault knows what your house was worth in 2023 except this.
		expect(backup.snapshots).toHaveLength(1);
		expect(backup.oneOffBudgets).toHaveLength(1);
		expect(backup.batches).toHaveLength(1);
	});

	it("survives a round-trip through JSON unchanged", async () => {
		const plugin = await newPlugin();
		plugin.store.transactions.push(tx("t1"));
		plugin.store.snapshots.push({ id: "s1", accountId: "acc-1", date: "2024-01-01", balance: 100 });

		const restored = parseBackup(serializeBackup(buildBackup(plugin)));

		expect(restored.transactions).toHaveLength(1);
		expect(restored.snapshots).toHaveLength(1);
	});
});

describe("parseBackup", () => {
	it("rejects things that aren't backups, with an explanation", () => {
		expect(() => parseBackup("not json")).toThrow(/valid JSON/);
		expect(() => parseBackup("[]")).toThrow(/doesn't look like/);
		expect(() => parseBackup("{}")).toThrow(/no version field/);
	});

	it("refuses a backup from a newer format rather than dropping what it can't read", () => {
		expect(() => parseBackup(JSON.stringify({ version: BACKUP_VERSION + 1 }))).toThrow(/newer version/);
	});

	it("accepts an older backup and treats its missing collections as empty", () => {
		const v1 = JSON.stringify({ version: 1, accounts: [], transactions: [{ id: "t1" }] });
		const parsed = parseBackup(v1);
		expect(parsed.transactions).toHaveLength(1);
		expect(parsed.snapshots).toEqual([]);
	});

	it("rejects a collection that isn't a list", () => {
		expect(() => parseBackup(JSON.stringify({ version: 1, accounts: "nope" }))).toThrow(/isn't a list/);
	});
});

describe("applyBackup", () => {
	it("merge adds only what isn't there, existing records winning", async () => {
		const plugin = await newPlugin();
		plugin.store.transactions.push(tx("t1", { description: "Mine" }));

		const result = await applyBackup(
			plugin,
			parseBackup(
				JSON.stringify({
					version: BACKUP_VERSION,
					transactions: [tx("t1", { description: "Theirs" }), tx("t2")],
				})
			),
			"merge"
		);

		expect(result.added.transactions).toBe(1);
		expect(result.skipped.transactions).toBe(1);
		// A restore should never overwrite something you've since edited.
		expect(plugin.store.transactions.find((t) => t.id === "t1")!.description).toBe("Mine");
	});

	it("merge is idempotent — restoring the same backup twice changes nothing the second time", async () => {
		const plugin = await newPlugin();
		const backup = parseBackup(JSON.stringify({ version: BACKUP_VERSION, transactions: [tx("t1"), tx("t2")] }));

		await applyBackup(plugin, backup, "merge");
		const second = await applyBackup(plugin, backup, "merge");

		expect(second.added.transactions).toBe(0);
		expect(plugin.store.transactions).toHaveLength(2);
	});

	it("merge brings in snapshots and one-off budgets too", async () => {
		const plugin = await newPlugin();
		await applyBackup(
			plugin,
			parseBackup(
				JSON.stringify({
					version: BACKUP_VERSION,
					snapshots: [{ id: "s1", accountId: "acc-1", date: "2024-01-01", balance: 100 }],
					oneOffBudgets: [{ id: "o1", name: "Japan", amount: 3000, startDate: "2024-01-01", endDate: "2024-06-30" }],
				})
			),
			"merge"
		);

		expect(plugin.store.snapshots).toHaveLength(1);
		expect(plugin.store.oneOffBudgets).toHaveLength(1);
	});

	it("replace discards what was there first", async () => {
		const plugin = await newPlugin();
		plugin.store.transactions.push(tx("old"));
		plugin.store.snapshots.push({ id: "old-s", accountId: "acc-1", date: "2024-01-01", balance: 1 });

		await applyBackup(plugin, parseBackup(JSON.stringify({ version: BACKUP_VERSION, transactions: [tx("new")] })), "replace");

		expect(plugin.store.transactions.map((t) => t.id)).toEqual(["new"]);
		expect(plugin.store.snapshots).toEqual([]);
	});

	it("dedupes rules by pattern as well as by id, since rules get re-seeded from defaults", async () => {
		const plugin = await newPlugin();
		plugin.store.rules.push({ id: "r1", pattern: "Q-Park", categoryId: "cat-auto" });

		const result = await applyBackup(
			plugin,
			parseBackup(
				JSON.stringify({
					version: BACKUP_VERSION,
					rules: [{ id: "different-id", pattern: "Q-Park", categoryId: "cat-auto" }],
				})
			),
			"merge"
		);

		expect(result.skipped.rules).toBe(1);
		expect(plugin.store.rules).toHaveLength(1);
	});
});

describe("transactionsToCsv", () => {
	it("resolves ids to names so the file reads standalone", async () => {
		const plugin = await newPlugin();
		plugin.store.accounts.push({ id: "acc-1", name: "Checking", type: "debit", currency: "EUR" });
		plugin.store.categories = [
			{ id: "cat-food", name: "Food", color: "#000", icon: "x", aliases: [] },
			{ id: "cat-groceries", name: "Groceries", color: "#000", icon: "x", aliases: [], parentId: "cat-food" },
		];
		plugin.store.transactions.push(tx("t1", { categoryId: "cat-groceries" }));

		const csv = transactionsToCsv(plugin);
		const line = csv.split("\n")[1];

		expect(line).toContain("Checking");
		expect(line).toContain("Food");
		expect(line).toContain("Groceries");
		// Machine-readable decimal point regardless of the display format setting.
		expect(line).toContain("-12.50");
	});
});

describe("backupCounts", () => {
	it("counts every collection the summary shows", () => {
		const counts = backupCounts(parseBackup(JSON.stringify({ version: BACKUP_VERSION, transactions: [tx("a"), tx("b")] })));
		expect(counts.transactions).toBe(2);
		expect(counts.accounts).toBe(0);
	});
});
