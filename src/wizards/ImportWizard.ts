import { Notice, normalizePath } from "obsidian";
import { parseCSV } from "../csv";
import { applyRules } from "../import/categorize";
import { detectFormat } from "../import/detect";
import { parseIngRows } from "../import/ingParser";
import { parseTradeRepublicRows } from "../import/tradeRepublicParser";
import type FinancePlugin from "../main";
import type { Transaction, TransactionSource } from "../types";
import { badge, emptyState, icon } from "../ui/dom";
import { WizardModal, WizardStep } from "./WizardModal";

/** Bank/broker CSV import: pick file → detect & preview → review categorization → confirm. */
export function openImportWizard(plugin: FinancePlugin): void {
	const store = plugin.store;

	let selectedFile: string | null = null;
	let headers: string[] = [];
	let dataRows: string[][] = [];
	let format: "ing" | "trade-republic" | "unknown" = "unknown";
	let accountId = store.accounts[0]?.id ?? "";
	let parsed: Transaction[] = [];

	const inboxPath = normalizePath(`${plugin.settings.dataFolder}/data/inbox`);

	function loadCsvText(name: string, text: string): void {
		selectedFile = name;
		const rows = parseCSV(text);
		headers = rows[0] ?? [];
		dataRows = rows.slice(1);
		format = detectFormat(headers);
	}

	const steps: WizardStep[] = [
		{
			id: "source",
			title: "Source",
			icon: "file-up",
			render: async (c) => {
				c.createEl("h3", { text: "Pick a file to import" });
				c.createEl("p", {
					cls: "fp-step-desc",
					text: `Drag a CSV export here, or drop it into "${inboxPath}" and choose it below.`,
				});

				const dropzone = c.createDiv({ cls: "fp-dropzone" });
				icon(dropzone, "upload", "fp-dropzone-icon");
				dropzone.createDiv({ cls: "fp-dropzone-text", text: "Drop a CSV file here" });
				dropzone.createDiv({ cls: "fp-dropzone-subtext", text: selectedFile ? `Selected: ${selectedFile}` : "or pick one from the inbox below" });

				dropzone.addEventListener("dragover", (ev) => {
					ev.preventDefault();
					dropzone.addClass("is-dragover");
				});
				dropzone.addEventListener("dragleave", () => dropzone.removeClass("is-dragover"));
				dropzone.addEventListener("drop", async (ev) => {
					ev.preventDefault();
					dropzone.removeClass("is-dragover");
					const file = ev.dataTransfer?.files?.[0];
					if (!file) return;
					const text = await file.text();
					loadCsvText(file.name, text);
					refresh();
				});

				const list = c.createDiv({ cls: "fp-file-list" });
				const adapter = plugin.app.vault.adapter;
				const exists = await adapter.exists(inboxPath);
				const files = exists ? (await adapter.list(inboxPath)).files : [];
				const csvFiles = files.filter((f) => f.toLowerCase().endsWith(".csv"));

				if (csvFiles.length === 0) {
					emptyState(list, {
						iconName: "inbox",
						title: "No files waiting in the inbox",
						description: "Drag a file onto the drop zone above, or export a CSV and drop it into the inbox folder, then reopen this wizard.",
					});
					return;
				}

				csvFiles.forEach((f) => {
					const row = list.createDiv({ cls: "fp-file-row" + (f === selectedFile ? " is-selected" : "") });
					icon(row, "file-text");
					row.createSpan({ text: f.split("/").pop() ?? f });
					row.addEventListener("click", async () => {
						loadCsvText(f, await adapter.read(f));
						refresh();
					});
				});

				function refresh() {
					c.empty();
					steps[0].render(c);
				}
			},
			canGoNext: () => !!selectedFile,
		},
		{
			id: "preview",
			title: "Preview",
			icon: "table",
			render: (c) => {
				c.createEl("h3", { text: "Preview & format" });
				const formatRow = c.createDiv({ cls: "fp-format-row" });
				if (format === "ing") badge(formatRow, "ING bank CSV detected", "good");
				else if (format === "trade-republic") badge(formatRow, "Trade Republic CSV detected", "good");
				else badge(formatRow, "Unrecognized format — column mapping isn't wired up yet", "warn");

				const accountRow = c.createDiv({ cls: "fp-setting-row" });
				accountRow.createSpan({ text: "Account: " });
				const select = accountRow.createEl("select");
				store.accounts.forEach((acc) => {
					const opt = select.createEl("option", { text: acc.name, value: acc.id });
					if (acc.id === accountId) opt.selected = true;
				});
				select.addEventListener("change", () => (accountId = select.value));

				const table = c.createEl("table", { cls: "fp-preview-table" });
				const thead = table.createEl("thead").createEl("tr");
				headers.forEach((h) => thead.createEl("th", { text: h }));
				const tbody = table.createEl("tbody");
				dataRows.slice(0, 6).forEach((r) => {
					const tr = tbody.createEl("tr");
					r.forEach((cell) => tr.createEl("td", { text: cell }));
				});
				c.createEl("p", { cls: "fp-step-desc", text: `${dataRows.length} rows found.` });
			},
			canGoNext: () => format !== "unknown" && !!accountId,
			onNext: () => {
				if (format === "ing") parsed = parseIngRows(headers, dataRows, accountId);
				else if (format === "trade-republic") parsed = parseTradeRepublicRows(headers, dataRows, accountId);
				for (const tx of parsed) {
					if (!tx.categoryId) tx.categoryId = applyRules(tx, store.rules);
				}
			},
		},
		{
			id: "review",
			title: "Categorize",
			icon: "tags",
			render: (c) => {
				const uncategorized = parsed.filter((t) => !t.categoryId);
				c.createEl("h3", { text: "Review categorization" });
				c.createEl("p", {
					cls: "fp-step-desc",
					text: `${parsed.length - uncategorized.length} auto-categorized, ${uncategorized.length} need a category.`,
				});
				const list = c.createDiv({ cls: "fp-review-list" });
				const shown = uncategorized.slice(0, 25);
				shown.forEach((tx) => {
					const row = list.createDiv({ cls: "fp-review-row" });
					row.createDiv({
						cls: "fp-review-desc",
						text: `${tx.date}  ·  ${tx.description}  ·  € ${tx.amount.toFixed(2)}`,
					});
					const select = row.createEl("select");
					select.createEl("option", { text: "Uncategorized", value: "" });
					store.categories.forEach((cat) => select.createEl("option", { text: cat.name, value: cat.id }));
					select.addEventListener("change", () => (tx.categoryId = select.value || undefined));
				});
				if (uncategorized.length > shown.length) {
					c.createEl("p", {
						cls: "fp-step-desc",
						text: `+ ${uncategorized.length - shown.length} more — categorize the rest from the Ledger afterwards.`,
					});
				}
			},
		},
		{
			id: "confirm",
			title: "Import",
			icon: "check-circle-2",
			render: (c) => {
				c.createEl("h3", { text: "Ready to import" });
				const stats = c.createDiv({ cls: "fp-import-stats" });
				const existing = store.existingIds();
				const dupes = parsed.filter((t) => existing.has(t.id)).length;
				stats.createDiv({ cls: "fp-import-stat", text: `${parsed.length} rows parsed` });
				stats.createDiv({ cls: "fp-import-stat", text: `${parsed.length - dupes} new` });
				stats.createDiv({ cls: "fp-import-stat", text: `${dupes} duplicate — will be skipped` });
			},
			nextLabel: "Import",
			onNext: async () => {
				const source: TransactionSource = format === "ing" ? "ing" : format === "trade-republic" ? "trade-republic" : "generic";
				const result = await store.importTransactions(source, parsed);
				new Notice(`Imported ${result.added} new transactions (${result.skipped} duplicates skipped)`);
				plugin.refreshViews();
			},
		},
	];

	new WizardModal(plugin.app, {
		title: "Import transactions",
		subtitle: "Bring in a bank or broker export without re-typing anything.",
		icon: "download",
		steps,
	}).open();
}
