import { Notice } from "obsidian";
import { parseCSV } from "../csv";
import { applyRules, buildAliasLookup } from "../import/categorize";
import { applyColumnMapping, COLUMN_MAPPING_FIELDS, emptyColumnMapping, guessColumnMapping } from "../import/columnMapping";
import { detectFormat } from "../import/detect";
import { ingAccountIbans, parseIngRows } from "../import/ingParser";
import { parseTradeRepublicRows } from "../import/tradeRepublicParser";
import { extractTransactionTables, DetectedTable } from "../import/xlsxWorkbook";
import type FinancePlugin from "../main";
import type { Transaction } from "../types";
import { badge, icon, renderCategoryPicker } from "../ui/dom";
import { WizardModal, WizardStep } from "./WizardModal";

const FORMAT_LABEL: Record<DetectedTable["format"], string> = {
	ing: "ING bank",
	"trade-republic": "Trade Republic",
	unknown: "Unrecognized",
};

/** Bank/broker CSV or Excel import: pick file → detect & preview → review categorization → confirm. */
export function openImportWizard(plugin: FinancePlugin): void {
	const store = plugin.store;

	let selectedFile: string | null = null;
	let tables: DetectedTable[] = [];
	// Kept separate on purpose: ING and Trade Republic rows never share a fallback account, so a
	// sheet of one format can never silently borrow whatever account the other format landed on.
	let ingAccountId = store.accounts.find((a) => a.type !== "investing" && a.type !== "crypto")?.id ?? store.accounts[0]?.id ?? "";
	let tradeRepublicAccountId = store.accounts.find((a) => a.type === "investing")?.id ?? store.accounts[0]?.id ?? "";
	let genericAccountId = store.accounts.find((a) => a.type === "saving")?.id ?? store.accounts[0]?.id ?? "";
	let mapping = emptyColumnMapping();
	let ibans: string[] = [];
	let ibanAccountMap = new Map<string, string>();
	let parsed: Transaction[] = [];
	let loadError: string | null = null;

	function setTables(name: string, newTables: DetectedTable[]): void {
		selectedFile = name;
		tables = newTables;
		const ingTables = tables.filter((t) => t.format === "ing");
		ibans = Array.from(new Set(ingTables.flatMap((t) => ingAccountIbans(t.headers, t.rows))));
		ibanAccountMap = new Map(
			ibans.filter((iban) => store.accounts.some((a) => a.iban === iban)).map((iban) => [iban, store.accounts.find((a) => a.iban === iban)!.id])
		);
	}

	/** The mapping grid is shown (and used) for any table whose columns fit the flat ledger shape —
	 *  every format except Trade Republic, whose action/ticker/shares/price/fee/tax columns don't. Guessed
	 *  from the first such table so a multi-sheet export shares one mapping, same as the parsing step does. */
	function mappableHeaders(): string[] {
		return tables.find((t) => t.format !== "trade-republic")?.headers ?? [];
	}

	function loadCsvText(name: string, text: string): void {
		loadError = null;
		const rows = parseCSV(text);
		const headers = rows[0] ?? [];
		const dataRows = rows.slice(1);
		const format = detectFormat(headers);
		// Unlike xlsx (which just skips unrecognized sheets — a workbook has plenty of other sheets to
		// fall back on), a single unrecognized CSV is kept so the mapping UI below has something to map.
		setTables(name, [{ sheetName: name, format, headers, rows: dataRows }]);
		mapping = guessColumnMapping(mappableHeaders());
	}

	async function loadXlsx(name: string, data: ArrayBuffer): Promise<void> {
		loadError = null;
		try {
			setTables(name, await extractTransactionTables(data));
			mapping = guessColumnMapping(mappableHeaders());
		} catch (err) {
			setTables(name, []);
			loadError = err instanceof Error ? err.message : String(err);
		}
	}

	const steps: WizardStep[] = [
		{
			id: "source",
			title: "Source",
			icon: "file-up",
			render: (c) => {
				c.createEl("h3", { text: "Pick a file to import" });
				c.createEl("p", {
					cls: "fp-step-desc",
					text: "Drag a CSV or Excel (.xlsx) export here, or click to browse for one.",
				});

				const dropzone = c.createDiv({ cls: "fp-dropzone" + (selectedFile ? " has-file" : "") });
				icon(dropzone, selectedFile ? "file-check-2" : "upload", "fp-dropzone-icon");
				dropzone.createDiv({ cls: "fp-dropzone-text", text: selectedFile ?? "Drop a CSV or Excel file here" });
				dropzone.createDiv({
					cls: "fp-dropzone-subtext",
					text: selectedFile ? "Click, or drop another file, to replace it" : "or click to browse",
				});

				const fileInput = c.createEl("input", { cls: "fp-file-input-hidden", attr: { type: "file", accept: ".csv,.xlsx" } });

				async function handleFile(file: File): Promise<void> {
					if (file.name.toLowerCase().endsWith(".xlsx")) await loadXlsx(file.name, await file.arrayBuffer());
					else loadCsvText(file.name, await file.text());
					refresh();
				}

				dropzone.addEventListener("click", () => fileInput.click());
				fileInput.addEventListener("change", async () => {
					const file = fileInput.files?.[0];
					if (file) await handleFile(file);
				});
				dropzone.addEventListener("dragover", (ev) => {
					ev.preventDefault();
					dropzone.addClass("is-dragover");
				});
				dropzone.addEventListener("dragleave", () => dropzone.removeClass("is-dragover"));
				dropzone.addEventListener("drop", async (ev) => {
					ev.preventDefault();
					dropzone.removeClass("is-dragover");
					const file = ev.dataTransfer?.files?.[0];
					if (file) await handleFile(file);
				});

				if (loadError) {
					const errorRow = c.createDiv({ cls: "fp-format-row" });
					badge(errorRow, `Couldn't read "${selectedFile}": ${loadError}`, "bad");
				}

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
				const hasUnknown = tables.some((t) => t.format === "unknown");
				if (tables.length === 0) {
					badge(formatRow, "Couldn't find any data in this file", "bad");
				} else if (hasUnknown) {
					badge(formatRow, "Unrecognized format — map its columns below", "warn");
				} else {
					(["ing", "trade-republic"] as const).forEach((fmt) => {
						const count = tables.filter((t) => t.format === fmt).length;
						if (count > 0) badge(formatRow, `${FORMAT_LABEL[fmt]} — ${count} sheet${count === 1 ? "" : "s"} detected`, "good");
					});
				}

				const hasIng = tables.some((t) => t.format === "ing");
				const hasTradeRepublic = tables.some((t) => t.format === "trade-republic");
				const showMapping = mappableHeaders().length > 0;

				if (hasUnknown) {
					const accountRow = c.createDiv({ cls: "fp-setting-row" });
					accountRow.createSpan({ text: "Import into account: " });
					const accSelect = accountRow.createEl("select");
					store.accounts.forEach((acc) => {
						const opt = accSelect.createEl("option", { text: acc.name, value: acc.id });
						if (acc.id === genericAccountId) opt.selected = true;
					});
					accSelect.addEventListener("change", () => (genericAccountId = accSelect.value));
				}

				if (showMapping) {
					c.createEl("p", {
						cls: "fp-step-desc",
						text: hasUnknown
							? "We didn't recognize this file's columns — pick which of your file's columns holds each piece of data. Date, Description, and Amount are required; everything else is optional."
							: "Column mapping (auto-detected) — review or override which column holds each piece of data before importing.",
					});

					const mapGrid = c.createDiv({ cls: "fp-column-mapping-grid" });
					const headers = mappableHeaders();
					COLUMN_MAPPING_FIELDS.forEach((field) => {
						const row = mapGrid.createDiv({ cls: "fp-form-row" });
						row.createEl("label", { text: field.label });
						const select = row.createEl("select");
						select.createEl("option", { text: "— none —", value: "" });
						headers.forEach((h) => {
							const opt = select.createEl("option", { text: h, value: h });
							if (mapping[field.key] === h) opt.selected = true;
						});
						select.addEventListener("change", () => (mapping[field.key] = select.value));
					});
					const dvRow = mapGrid.createDiv({ cls: "fp-form-row" });
					dvRow.createEl("label", { text: "Value that means \"money out\" (only used if Debit/Credit is mapped)" });
					const dvInput = dvRow.createEl("input", { type: "text", attr: { placeholder: "e.g. Debit, DR, -" } });
					dvInput.value = mapping.debitValue;
					dvInput.addEventListener("input", () => (mapping.debitValue = dvInput.value));
				}

				if (hasIng) {
					if (ibans.length > 1) {
						c.createEl("p", {
							cls: "fp-step-desc",
							text: "This export covers multiple ING accounts — map each IBAN to one of your Finance accounts.",
						});
						const mapWrap = c.createDiv({ cls: "fp-iban-map" });
						ibans.forEach((iban) => {
							const row = mapWrap.createDiv({ cls: "fp-setting-row" });
							row.createSpan({ text: iban, cls: "fp-iban-label" });
							const select = row.createEl("select");
							select.createEl("option", { text: "Choose account…", value: "" });
							store.accounts.forEach((acc) => {
								const opt = select.createEl("option", { text: acc.name, value: acc.id });
								if (ibanAccountMap.get(iban) === acc.id) opt.selected = true;
							});
							select.addEventListener("change", () => {
								if (select.value) ibanAccountMap.set(iban, select.value);
								else ibanAccountMap.delete(iban);
							});
						});
						c.createEl("p", {
							cls: "fp-step-desc",
							text: "Don't see an account? Add it (with its IBAN) in Finance settings, then reopen this wizard.",
						});
					} else {
						const accountRow = c.createDiv({ cls: "fp-setting-row" });
						accountRow.createSpan({ text: "ING account: " });
						const select = accountRow.createEl("select");
						store.accounts.forEach((acc) => {
							const opt = select.createEl("option", { text: acc.name, value: acc.id });
							if (acc.id === ingAccountId) opt.selected = true;
						});
						if (ibans.length === 1 && ibanAccountMap.has(ibans[0])) {
							ingAccountId = ibanAccountMap.get(ibans[0])!;
							select.value = ingAccountId;
						}
						select.addEventListener("change", () => (ingAccountId = select.value));
					}
				}

				if (hasTradeRepublic) {
					const trRow = c.createDiv({ cls: "fp-setting-row" });
					trRow.createSpan({ text: "Trade Republic account: " });
					const trSelect = trRow.createEl("select");
					store.accounts.forEach((acc) => {
						const opt = trSelect.createEl("option", { text: acc.name, value: acc.id });
						if (acc.id === tradeRepublicAccountId) opt.selected = true;
					});
					trSelect.addEventListener("change", () => (tradeRepublicAccountId = trSelect.value));
				}

				const totalRows = tables.reduce((sum, t) => sum + t.rows.length, 0);
				tables.forEach((t) => {
					c.createEl("h4", { text: `${t.sheetName} — ${FORMAT_LABEL[t.format]} (${t.rows.length} rows)` });
					const table = c.createEl("table", { cls: "fp-preview-table" });
					const thead = table.createEl("thead").createEl("tr");
					t.headers.forEach((h) => thead.createEl("th", { text: h }));
					const tbody = table.createEl("tbody");
					t.rows.slice(0, 4).forEach((r) => {
						const tr = tbody.createEl("tr");
						r.forEach((cell) => tr.createEl("td", { text: cell }));
					});
				});
				if (tables.length > 0) {
					c.createEl("p", { cls: "fp-step-desc", text: `${totalRows} rows found across ${tables.length} sheet${tables.length === 1 ? "" : "s"}.` });
				}
			},
			canGoNext: () => {
				if (tables.length === 0) return false;
				const mappingOk = mappableHeaders().length === 0 || (!!mapping.date && !!mapping.description && !!mapping.amount);
				const genericOk = !tables.some((t) => t.format === "unknown") || !!genericAccountId;
				const ingOk = !tables.some((t) => t.format === "ing") || (ibans.length > 1 ? ibans.every((i) => ibanAccountMap.has(i)) : !!ingAccountId);
				const trOk = !tables.some((t) => t.format === "trade-republic") || !!tradeRepublicAccountId;
				return mappingOk && genericOk && ingOk && trOk;
			},
			onNext: () => {
				const categoryLookup = buildAliasLookup(store.categories);
				parsed = [];
				for (const t of tables) {
					if (t.format === "ing") {
						const mappedHeaders = applyColumnMapping(t.headers, mapping);
						parsed.push(
							...parseIngRows(mappedHeaders, t.rows, {
								defaultAccountId: ingAccountId,
								accountByIban: ibanAccountMap,
								categoryLookup,
								debitValues: mapping.debitCredit && mapping.debitValue ? [mapping.debitValue] : undefined,
							})
						);
					} else if (t.format === "trade-republic") {
						parsed.push(...parseTradeRepublicRows(t.headers, t.rows, tradeRepublicAccountId));
					} else if (t.format === "unknown") {
						const mappedHeaders = applyColumnMapping(t.headers, mapping);
						parsed.push(
							...parseIngRows(mappedHeaders, t.rows, {
								defaultAccountId: genericAccountId,
								categoryLookup,
								debitValues: mapping.debitCredit && mapping.debitValue ? [mapping.debitValue] : undefined,
								source: "generic",
							})
						);
					}
				}
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
					renderCategoryPicker(row, {
						categories: store.categories,
						primaryPlaceholder: "Uncategorized",
						onChange: ({ primaryId, secondaryId }) => {
							tx.categoryId = secondaryId ?? primaryId;
						},
					});
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
				const result = await store.importTransactions(parsed);
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
