import { Notice } from "obsidian";
import { parseCSV } from "../csv";
import { aiCategorize, describeAiResult } from "../ai/categorizer";
import { autoCategorize, effectiveRules } from "../import/autoCategorize";
import { applyMemory, applyPendingSuggestions, learnFromHistory, unknownMerchants } from "../import/merchantMemory";
import { buildAliasLookup } from "../import/categorize";
import { applyColumnMapping, COLUMN_MAPPING_FIELDS, emptyColumnMapping, guessColumnMapping } from "../import/columnMapping";
import { matchBankProfile } from "../import/bankProfiles";
import { parseCamt053 } from "../import/camt053";
import { countRepeatedIds, withOccurrenceSuffixes } from "../import/dedupe";
import { canonicalColumnMapping } from "../import/canonical";
import { detectFileFormat, detectFormat, IBAN_BEARING_FORMATS, type DetectedFormat } from "../import/detect";
import { parseMt940 } from "../import/mt940";
import { parseOfx } from "../import/ofx";
import { parseQif } from "../import/qif";
import { ingAccountIbans, parseIngRows } from "../import/ingParser";
import { parseTradeRepublicRows } from "../import/tradeRepublicParser";
import { extractTransactionTables, DetectedTable } from "../import/xlsxWorkbook";
import type FinancePlugin from "../main";
import { formatMoney } from "../money";
import type { Transaction, TransactionSource } from "../types";
import { badge, icon, renderCategoryPicker } from "../ui/dom";
import { WizardModal, type WizardControls, WizardStep } from "./WizardModal";

const FORMAT_LABEL: Record<DetectedFormat, string> = {
	ing: "ING bank",
	"trade-republic": "Trade Republic",
	revolut: "Revolut",
	bunq: "bunq",
	n26: "N26",
	knab: "KNAB",
	camt: "CAMT.053 statement",
	mt940: "MT940 statement",
	ofx: "OFX / QFX",
	qif: "QIF",
	unknown: "Unrecognized",
};

/** Every format the wizard can name, in the order the preview lists them. */
const KNOWN_FORMATS: DetectedFormat[] = ["ing", "trade-republic", "revolut", "bunq", "n26", "knab", "camt", "mt940", "ofx", "qif"];

/** A detected format is also the transaction's source, except for the formats that share the flat
 *  generic reader without being a named bank ("unknown" is a file whose columns you mapped by hand). */
function sourceFor(format: DetectedFormat): TransactionSource {
	return format === "unknown" ? "generic" : (format as TransactionSource);
}

/** Bank/broker CSV or Excel import: pick file → detect & preview → review categorization → confirm. */
export function openImportWizard(plugin: FinancePlugin): void {
	const store = plugin.store;

	let selectedFile: string | null = null;
	let tables: DetectedTable[] = [];
	// Whichever account's page this was opened from — the same "for the account you're looking at"
	// default hand-entering a transaction already uses. A file whose format can't say for itself
	// (or doesn't match the account you had open) still shows its own dropdown to override, but
	// starting from a type-based guess instead of where you actually were is how an AMEX statement
	// silently landed on a savings account: nothing about "first savings account" said AMEX, but
	// nothing about the page you'd just clicked Import from was consulted either.
	const activeAccountId = store.accounts.find((a) => a.id === plugin.settings.activeAccountId)?.id;
	// Kept separate on purpose: ING and Trade Republic rows never share a fallback account, so a
	// sheet of one format can never silently borrow whatever account the other format landed on.
	let ingAccountId = activeAccountId ?? store.accounts.find((a) => a.type !== "investing" && a.type !== "crypto")?.id ?? store.accounts[0]?.id ?? "";
	let tradeRepublicAccountId =
		activeAccountId ?? store.accounts.find((a) => a.type === "investing")?.id ?? store.accounts[0]?.id ?? "";
	let genericAccountId = activeAccountId ?? store.accounts.find((a) => a.type === "saving")?.id ?? store.accounts[0]?.id ?? "";
	let mapping = emptyColumnMapping();
	let ibans: string[] = [];
	let ibanAccountMap = new Map<string, string>();
	let parsed: Transaction[] = [];
	let fileHits = 0;
	let memoryHits = 0;
	let ruleHits = 0;
	let aiHits = 0;
	/** Set once the Categorize step has auto-run the AI, so re-rendering it doesn't fire again. */
	let aiAutoRun = false;
	let loadError: string | null = null;
	/** How many parsed rows needed an occurrence suffix to stay distinct — reported before importing. */
	let repeatedRows = 0;

	function setTables(name: string, newTables: DetectedTable[]): void {
		selectedFile = name;
		tables = newTables;
		// Any format that carries an account identifier per row can be split across your accounts, not
		// just ING — a CAMT or MT940 file covering two accounts is exactly the same problem.
		const ibanTables = tables.filter((t) => IBAN_BEARING_FORMATS.includes(t.format));
		ibans = Array.from(new Set(ibanTables.flatMap((t) => ingAccountIbans(t.headers, t.rows))));
		ibanAccountMap = new Map(
			ibans.filter((iban) => store.accounts.some((a) => a.iban === iban)).map((iban) => [iban, store.accounts.find((a) => a.iban === iban)!.id])
		);
	}

	/** Formats with no per-row account identifier: they can only be told which account they belong to. */
	function tablesNeedingGenericAccount(): DetectedTable[] {
		return tables.filter((t) => t.format !== "trade-republic" && !IBAN_BEARING_FORMATS.includes(t.format));
	}

	/** The mapping grid is shown (and used) for any table whose columns fit the flat ledger shape —
	 *  every format except Trade Republic, whose action/ticker/shares/price/fee/tax columns don't. Guessed
	 *  from the first such table so a multi-sheet export shares one mapping, same as the parsing step does. */
	function mappableHeaders(): string[] {
		return tables.find((t) => t.format !== "trade-republic")?.headers ?? [];
	}

	/**
	 * Reads any text file: a statement format (CAMT.053, MT940, OFX, QIF) is converted into the same
	 * table shape a CSV produces, so from here on every format shares one preview, one column-mapping
	 * step and one parser. That's deliberate — a statement format that bypassed the field selector
	 * would be the one kind of file you couldn't correct when a bank changed something.
	 */
	function loadTextFile(name: string, text: string): void {
		loadError = null;
		try {
			const kind = detectFileFormat(text, name);
			if (kind !== "csv") {
				const table =
					kind === "camt053" ? parseCamt053(text) : kind === "mt940" ? parseMt940(text) : kind === "ofx" ? parseOfx(text) : parseQif(text);
				// "xlsx" never reaches here — it's routed to loadXlsx before any text is read.
				const format: DetectedFormat = kind === "camt053" ? "camt" : (kind as Exclude<typeof kind, "camt053" | "xlsx" | "csv">);
				setTables(name, [{ sheetName: name, format, headers: table.headers, rows: table.rows }]);
				// Set exactly, not guessed: these are our own headers. See canonicalColumnMapping.
				mapping = canonicalColumnMapping();
				return;
			}

			const rows = parseCSV(text);
			const headers = rows[0] ?? [];
			const dataRows = rows.slice(1);
			const format = detectFormat(headers);
			// Unlike xlsx (which just skips unrecognized sheets — a workbook has plenty of other sheets to
			// fall back on), a single unrecognized CSV is kept so the mapping UI below has something to map.
			setTables(name, [{ sheetName: name, format, headers, rows: dataRows }]);

			// A recognized bank profile pre-fills the mapping with that bank's real columns instead of
			// the generic name-similarity guess. Still shown, still editable.
			const profile = matchBankProfile(headers);
			mapping = profile ? profile.mapping(headers) : guessColumnMapping(mappableHeaders());
		} catch (err) {
			setTables(name, []);
			loadError = err instanceof Error ? err.message : String(err);
		}
	}

	async function loadXlsx(name: string, data: ArrayBuffer): Promise<void> {
		loadError = null;
		try {
			setTables(name, await extractTransactionTables(data));
			// The same profile lookup the CSV path does. Without it a bank's workbook fell back to the
			// generic name-similarity guess, which is close enough to look right and wrong where it
			// matters: KNAB's "Tegenrekening" (the payee's account number) was guessed as the
			// counterparty over "Tegenpartij" (their name), and the Af/Bij column went unmapped
			// entirely, so every amount would have imported as money coming in.
			const headers = mappableHeaders();
			const profile = matchBankProfile(headers);
			mapping = profile ? profile.mapping(headers) : guessColumnMapping(headers);
		} catch (err) {
			setTables(name, []);
			loadError = err instanceof Error ? err.message : String(err);
		}
	}

	/**
	 * "Ask Claude" for the rows that survived merchant memory and the rule set.
	 *
	 * Always rendered when something is uncategorized — disabled with a route to the setting when the
	 * feature is off, rather than hidden. A button you cannot find is indistinguishable from one that
	 * does not exist.
	 */
	function renderAiAction(c: HTMLElement, uncategorized: Transaction[], wizard: WizardControls): void {
		const ai = plugin.settings.ai;
		const pending = unknownMerchants(uncategorized, store.merchants);
		const row = c.createDiv({ cls: "fp-ai-action" });

		if (!ai?.enabled) {
			icon(row, "sparkles", "fp-ai-action-icon");
			row.createSpan({
				cls: "fp-ai-action-text",
				text: `Claude can identify the ${pending.length} unrecognized merchant${pending.length === 1 ? "" : "s"} behind these — it's switched off.`,
			});
			const openBtn = row.createEl("button", { cls: "fp-btn fp-btn-secondary" });
			icon(openBtn, "settings");
			openBtn.createSpan({ text: "Turn on AI categorization" });
			openBtn.addEventListener("click", () => plugin.openVaultSettings("ai"));
			return;
		}

		if (pending.length === 0) {
			icon(row, "check-circle-2", "fp-ai-action-icon");
			row.createSpan({ cls: "fp-ai-action-text", text: "Claude has already seen every merchant here." });
			return;
		}

		icon(row, "sparkles", "fp-ai-action-icon");
		const text = row.createDiv({ cls: "fp-ai-action-text" });
		// Real per-merchant counts. The previous version divided total rows by merchant count, which
		// reported "1 merchant · 260 rows each" when that merchant covered a single row.
		const covered = pending.reduce((sum, m) => sum + m.count, 0);
		text.createDiv({
			text: `${pending.length} unrecognized merchant${pending.length === 1 ? "" : "s"}, covering ${covered} of these ${uncategorized.length} rows.`,
		});
		// Naming them makes the number actionable: 29 merchants is a decision you can reason about,
		// 223 rows is not.
		text.createDiv({
			cls: "fp-ai-action-names",
			text: pending.slice(0, 8).map((m) => `${m.name} (${m.count})`).join(" · ") + (pending.length > 8 ? ` · +${pending.length - 8} more` : ""),
		});

		const runBtn = row.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(runBtn, "sparkles");
		const label = runBtn.createSpan({ text: "Ask Claude" });
		runBtn.setAttribute("title", "Sends only the merchant names and your category tree — no amounts, dates or account details.");
		runBtn.addEventListener("click", async () => {
			runBtn.disabled = true;
			label.setText("Asking…");
			try {
				const result = await aiCategorize(uncategorized, store.categories, store.merchants, ai, (done, total) =>
					label.setText(`Asking… ${done}/${total}`)
				);
				store.merchants = result.memory;
				await store.saveMerchants();
				// These rows aren't in the store yet, so the answers are applied to the parsed batch
				// in memory and land in the ledger when the import completes.
				for (const tx of parsed) {
					const patch = result.patches.get(tx.id);
					if (!patch?.categoryId) continue;
					tx.categoryId = patch.categoryId;
					// Carried into the ledger with the row, so an uncertain answer is findable in Review
					// instead of being indistinguishable from a confident one.
					if (patch.review) tx.review = patch.review;
				}
				aiHits += result.patches.size;
				new Notice(describeAiResult(result, result.patches.size), 10000);
				c.empty();
				void steps[2].render(c, wizard);
				wizard.refreshFooter();
			} catch (err) {
				new Notice(`AI categorization failed: ${err instanceof Error ? err.message : String(err)}`, 12000);
				runBtn.disabled = false;
				label.setText("Ask Claude");
			}
		});

		// Opt-in: run it without being asked, so an import lands fully categorized in one pass.
		if (ai.autoOnImport && !aiAutoRun) {
			aiAutoRun = true;
			runBtn.click();
		}
	}

	const steps: WizardStep[] = [
		{
			id: "source",
			title: "Source",
			icon: "file-up",
			render: (c, wizard) => {
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

				const fileInput = c.createEl("input", { cls: "fp-file-input-hidden", attr: { type: "file", accept: ".csv,.xlsx,.xml,.sta,.940,.mt940,.ofx,.qfx,.qif,.txt" } });

				async function handleFile(file: File): Promise<void> {
					if (file.name.toLowerCase().endsWith(".xlsx")) await loadXlsx(file.name, await file.arrayBuffer());
					else loadTextFile(file.name, await file.text());
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
					void steps[0].render(c, wizard);
					wizard.refreshFooter();
				}
			},
			canGoNext: () => !!selectedFile,
		},
		{
			id: "preview",
			title: "Preview",
			icon: "table",
			render: (c, wizard) => {
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
							? "We didn't recognize this file's columns, so nothing has been read from it yet — tell us which of your columns holds each piece of data. Date, Description and Amount are required; the rest are optional."
							: "Column mapping (auto-detected) — check that each ledger field points at the right column before importing.",
					});

					// Live status: what's been mapped, and what's still missing. Rendered before the grid
					// so the answer to "is this file understood yet?" is the first thing on screen, and
					// repainted on every change so it always describes the current selection.
					const statusEl = c.createDiv({ cls: "fp-map-status" });
					const renderMapStatus = (): void => {
						statusEl.empty();
						const mapped = COLUMN_MAPPING_FIELDS.filter((f) => f.key !== "debitValue" && mapping[f.key]);
						const missingRequired = COLUMN_MAPPING_FIELDS.filter((f) => f.required && !mapping[f.key]);

						const head = statusEl.createDiv({ cls: "fp-map-status-head" });
						if (missingRequired.length > 0) {
							icon(head, "alert-triangle", "fp-map-status-icon is-warn");
							head.createSpan({
								cls: "fp-map-status-title",
								text:
									mapped.length === 0
										? "Not mapped yet — this file can't be read until the required fields are set"
										: `Still missing ${missingRequired.map((f) => f.label).join(", ")}`,
							});
						} else {
							icon(head, "check-circle-2", "fp-map-status-icon is-ok");
							head.createSpan({
								cls: "fp-map-status-title",
								text: `Mapped — ${mapped.length} field${mapped.length === 1 ? "" : "s"} will be read from this file`,
							});
						}

						if (mapped.length > 0) {
							const list = statusEl.createDiv({ cls: "fp-map-status-list" });
							mapped.forEach((f) => {
								const item = list.createDiv({ cls: "fp-map-status-item" });
								item.createSpan({ cls: "fp-map-status-field", text: f.label });
								icon(item, "arrow-left", "fp-map-status-arrow");
								item.createSpan({ cls: "fp-map-status-col", text: mapping[f.key] });
							});
						}

						const unmapped = COLUMN_MAPPING_FIELDS.filter((f) => f.key !== "debitValue" && !f.required && !mapping[f.key]);
						if (unmapped.length > 0 && missingRequired.length === 0) {
							statusEl.createDiv({
								cls: "fp-map-status-note",
								text: `Not mapped (optional): ${unmapped.map((f) => f.label).join(", ")}.`,
							});
						}
					};

					const mapGrid = c.createDiv({ cls: "fp-column-mapping-grid" });
					const headers = mappableHeaders();
					COLUMN_MAPPING_FIELDS.forEach((field) => {
						const row = mapGrid.createDiv({ cls: "fp-form-row" });
						const lbl = row.createEl("label");
						lbl.createSpan({ text: field.label });
						lbl.createSpan({
							cls: field.required ? "fp-field-req" : "fp-field-opt",
							text: field.required ? "required" : "optional",
						});
						const select = row.createEl("select");
						select.createEl("option", { text: "— none —", value: "" });
						headers.forEach((h) => {
							const opt = select.createEl("option", { text: h, value: h });
							if (mapping[field.key] === h) opt.selected = true;
						});
						select.addEventListener("change", () => {
							mapping[field.key] = select.value;
							renderMapStatus();
							// The Next button's enabled state depends on the required fields being set.
							wizard.refreshFooter();
						});
					});
					renderMapStatus();
					const dvRow = mapGrid.createDiv({ cls: "fp-form-row" });
					const dvLabel = dvRow.createEl("label");
					dvLabel.createSpan({ text: "\"Money out\" value" });
					dvLabel.createSpan({ cls: "fp-field-opt", text: "optional" });
					// Control and caveat share one wrapper so the row still occupies exactly the two subgrid
					// tracks every other row does — a third direct child would overlap the field.
					const dvControl = dvRow.createDiv({ cls: "fp-field-control" });
					const dvInput = dvControl.createEl("input", { type: "text", attr: { placeholder: "e.g. Debit, DR, -" } });
					dvInput.value = mapping.debitValue;
					dvInput.addEventListener("input", () => (mapping.debitValue = dvInput.value));
					// The caveat lives under the field rather than inside its label, where it ran to three
					// lines and dragged the whole row out of alignment.
					dvControl.createDiv({ cls: "fp-field-hint", text: "Only used when Debit/Credit is mapped." });
				}

				if (hasIng) {
					if (ibans.length > 1) {
						c.createEl("p", {
							cls: "fp-step-desc",
							text: "This export covers multiple accounts — map each account identifier to one of your Finance accounts.",
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
						accountRow.createSpan({ text: "Bank account: " });
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
			blockedReason: () => {
				if (tables.length === 0) return "No readable data in this file.";
				const missing = COLUMN_MAPPING_FIELDS.filter((f) => f.required && !mapping[f.key]);
				if (mappableHeaders().length > 0 && missing.length > 0) {
					return `Map ${missing.map((f) => f.label).join(", ")} first.`;
				}
				if (tablesNeedingGenericAccount().length > 0 && !genericAccountId) return "Choose an account to import into.";
				if (tables.some((t) => IBAN_BEARING_FORMATS.includes(t.format)) && ibans.length > 1 && !ibans.every((i) => ibanAccountMap.has(i))) {
					return "Map every IBAN to an account first.";
				}
				return undefined;
			},
			canGoNext: () => {
				if (tables.length === 0) return false;
				const mappingOk = mappableHeaders().length === 0 || (!!mapping.date && !!mapping.description && !!mapping.amount);
				const genericOk = tablesNeedingGenericAccount().length === 0 || !!genericAccountId;
				const ingOk =
					!tables.some((t) => IBAN_BEARING_FORMATS.includes(t.format)) ||
					(ibans.length > 1 ? ibans.every((i) => ibanAccountMap.has(i)) : !!ingAccountId);
				const trOk = !tables.some((t) => t.format === "trade-republic") || !!tradeRepublicAccountId;
				return mappingOk && genericOk && ingOk && trOk;
			},
			onNext: () => {
				const categoryLookup = buildAliasLookup(store.categories);
				parsed = [];
				for (const t of tables) {
					if (t.format === "trade-republic") {
						parsed.push(...parseTradeRepublicRows(t.headers, t.rows, tradeRepublicAccountId));
						continue;
					}
					// Every other format — recognized bank CSV, statement file, or a table you mapped by
					// hand — is a flat ledger table by this point, so they all read through one parser with
					// the mapping applied. The only difference between them is which account the rows land
					// in and what source they're filed under.
					const carriesIban = IBAN_BEARING_FORMATS.includes(t.format);
					const mappedHeaders = applyColumnMapping(t.headers, mapping);
					parsed.push(
						...parseIngRows(mappedHeaders, t.rows, {
							defaultAccountId: carriesIban ? ingAccountId : genericAccountId,
							accountByIban: carriesIban ? ibanAccountMap : undefined,
							categoryLookup,
							debitValues: mapping.debitCredit && mapping.debitValue ? [mapping.debitValue] : undefined,
							source: sourceFor(t.format),
						})
					);
				}

				// Two genuinely separate payments that agree on account, date, amount and description hash
				// to one id; without this the second one is mistaken for a duplicate of the first and never
				// arrives. See src/import/dedupe.ts for why the suffix is still re-import safe.
				repeatedRows = countRepeatedIds(parsed);
				parsed = withOccurrenceSuffixes(parsed);
				// Rows the export categorized itself, via its own Main Cat./Sub Cat. columns — counted
				// before anything else runs, since the parser has already applied them.
				fileHits = parsed.filter((tx) => tx.categoryId).length;

				// Merchant memory first: a shop you have already filed once is settled, and nothing a rule
				// or a model says should override a decision you made yourself.
				let learned = learnFromHistory(store.transactions, store.merchants);
				// Apply answers already given but never written — see applyPendingSuggestions().
				if (plugin.settings.ai?.applyLowConfidence !== false) {
					const pending = applyPendingSuggestions(learned);
					learned = pending.map;
					store.merchants = pending.map;
					if (pending.keys.size > 0) void store.saveMerchants();
				}
				const fromMemory = applyMemory(parsed, learned, store.categories);
				for (const tx of parsed) {
					const categoryId = fromMemory.patches.get(tx.id);
					if (categoryId) tx.categoryId = categoryId;
				}
				memoryHits = fromMemory.patches.size;

				// Then the shipped merchant rules and the user's own, plus the bank's own type column
				// for the unambiguous cases (ATM withdrawals, interest) — see autoCategorize().
				const rules = effectiveRules(store.categories, store.rules);
				const { patches } = autoCategorize(parsed, store.categories, rules);
				for (const tx of parsed) {
					const categoryId = patches.get(tx.id);
					if (categoryId) tx.categoryId = categoryId;
				}
				ruleHits = patches.size;
			},
		},
		{
			id: "review",
			title: "Categorize",
			icon: "tags",
			render: (c, wizard) => {
				const uncategorized = parsed.filter((t) => !t.categoryId);
				const done = parsed.length - uncategorized.length;
				c.createEl("h3", { text: "Review categorization" });

				// Says what was matched and by what, then names the biggest categories — a bare count
				// gives no way to tell "the rules worked" from "the rules found nothing".
				const summary = c.createDiv({ cls: "fp-map-status" });
				const head = summary.createDiv({ cls: "fp-map-status-head" });
				icon(head, done > 0 ? "check-circle-2" : "alert-triangle", `fp-map-status-icon ${done > 0 ? "is-ok" : "is-warn"}`);
				head.createSpan({
					cls: "fp-map-status-title",
					text:
						done > 0
							? `${done} of ${parsed.length} auto-categorized, ${uncategorized.length} still need a category`
							: `Nothing matched — all ${parsed.length} need a category`,
				});
				if (done > 0) {
					// Every contributor named. The previous version reported only memory and rules, so on
					// an export that carries its own category column the numbers didn't add up.
					const parts = [
						fileHits > 0 ? `${fileHits} from the file's own category column` : "",
						`${memoryHits} from merchants you've filed before`,
						`${ruleHits} from the built-in rules`,
						aiHits > 0 ? `${aiHits} from Claude` : "",
					].filter(Boolean);
					summary.createDiv({ cls: "fp-map-status-note", text: `${parts.join(", ")}.` });
				}

				if (done > 0) {
					const byCategory = new Map<string, number>();
					for (const tx of parsed) {
						if (!tx.categoryId) continue;
						const name = store.categories.find((cat) => cat.id === tx.categoryId)?.name ?? "Unknown";
						byCategory.set(name, (byCategory.get(name) ?? 0) + 1);
					}
					const list = summary.createDiv({ cls: "fp-map-status-list" });
					Array.from(byCategory.entries())
						.sort((a, b) => b[1] - a[1])
						.slice(0, 8)
						.forEach(([name, n]) => {
							const item = list.createDiv({ cls: "fp-map-status-item" });
							item.createSpan({ cls: "fp-map-status-field", text: name });
							item.createSpan({ cls: "fp-map-status-col", text: `${n}` });
						});
				}

				summary.createDiv({
					cls: "fp-map-status-note",
					text: "Anything left uncategorized still imports — it lands in the Review queue, where you can categorize in bulk rather than one row at a time here.",
				});

				// The AI step belongs here as much as on the Review page: this is where you are actually
				// looking at the rows nothing could identify.
				if (uncategorized.length > 0) renderAiAction(c, uncategorized, wizard);

				const list = c.createDiv({ cls: "fp-review-list" });
				const shown = uncategorized.slice(0, 25);
				shown.forEach((tx) => {
					const row = list.createDiv({ cls: "fp-review-row" });
					row.createDiv({
						cls: "fp-review-desc",
						text: `${tx.date}  ·  ${tx.description}  ·  ${formatMoney(tx.amount, { currency: tx.currency || "EUR" })}`,
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
						text: `+ ${uncategorized.length - shown.length} more — do those from the Review page after importing, where you can select many at once.`,
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
				if (repeatedRows > 0) {
					c.createEl("p", {
						cls: "fp-step-desc",
						text: `${repeatedRows} row${repeatedRows === 1 ? " is" : "s are"} identical to another row in this file (same date, amount and description). They're kept as separate transactions rather than treated as duplicates — two coffees at the same shop on the same day really are two coffees.`,
					});
				}
				c.createEl("p", {
					cls: "fp-step-desc",
					text: "This import is recorded as one batch, so it can be undone in one go from Vault settings → Import.",
				});
			},
			nextLabel: "Import",
			onNext: async () => {
				const result = await store.importTransactions(parsed, {
					fileName: selectedFile ?? undefined,
					format: tables[0] ? FORMAT_LABEL[tables[0].format] : undefined,
				});
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
		buildStamp: `v${plugin.manifest.version} · loaded ${plugin.loadedAt}`,
	}).open();
}
