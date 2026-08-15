import { App, FuzzySuggestModal, Notice, Platform } from "obsidian";
import { aiRankPlan, aiReadDocument, describeAiOutcome, emptyAiOutcome, type InvoiceAiOutcome } from "../ai/invoiceMatcher";
import { describeAiDisclosure } from "../ai/invoicePrompt";
import type { ModelAttachment } from "../ai/provider";
import { writeAttachment } from "../data/attachments";
import { merchantDisplayName } from "../import/merchantKey";
import { buildInvoiceDocument, localExtractionSufficient } from "../invoiceExtract";
import {
	applyAiRanking,
	checkFileSelection,
	DEFAULT_CANDIDATE_LIMIT,
	describeInvoicePeriod,
	describeOutcome,
	describeSearchScope,
	isSupportedInvoiceFile,
	matchInvoices,
	MAX_INVOICE_FILES,
	scoreCandidate,
	summarizeOutcome,
	SUPPORTED_INVOICE_EXTENSIONS,
	transactionsInPeriod,
	type AttachOutcome,
	type InvoiceDocument,
	type InvoiceMatchPlan,
	type InvoicePeriod,
	type InvoicePeriodKind,
	type InvoiceProposal,
	type ScoredCandidate,
} from "../invoiceMatch";
import { extractPdfText } from "../invoicePdfText";
import type FinancePlugin from "../main";
import { formatMoney } from "../money";
import { MONTH_NAMES } from "../period";
import type { Transaction } from "../types";
import { badge, icon, type Tone } from "../ui/dom";
import { WizardModal, WizardStep } from "./WizardModal";

/**
 * Ten receipts, one reporting period, and a list of proposals to rule on.
 *
 * Everything that decides anything lives in src/invoiceMatch.ts, deliberately: this file picks files
 * up, turns them into bytes, paints the answer and — only when the button at the bottom is pressed —
 * writes. Nothing reaches the vault before that press, which is what makes cancelling free. A dropped
 * file is held as a `File` in memory until it has been confirmed against a transaction, and only then
 * does it go through writeAttachment() like any other receipt.
 *
 * The AI passes sit either side of the deterministic one and neither is required. Reading a document
 * happens before matching, because a receipt whose total nobody could read matches nothing; re-ranking
 * happens after, because there is no shortlist to re-rank until the arithmetic has produced one.
 */

/** MIME types for the formats the dropzone accepts, so an attachment reaches the API correctly labelled. */
const MEDIA_TYPES: Record<string, string> = {
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	avif: "image/avif",
	heic: "image/heic",
};

/** Anthropic's per-file ceiling is well above this; the practical limit is what a phone will hold in memory. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const CONFIDENCE_TONE: Record<string, Tone> = { high: "good", medium: "warn", low: "bad" };
const CONFIDENCE_LABEL: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };

/** Picks any transaction from the chosen period — the escape hatch behind "Choose another transaction". */
class PeriodTransactionSuggestModal extends FuzzySuggestModal<Transaction> {
	constructor(
		app: App,
		private transactions: Transaction[],
		private accountName: (tx: Transaction) => string,
		private onChoose: (tx: Transaction) => void
	) {
		super(app);
		this.setPlaceholder("Search this period's transactions by date, description or amount…");
	}

	getItems(): Transaction[] {
		return this.transactions;
	}

	getItemText(tx: Transaction): string {
		const attached = tx.attachmentPath ? " · already attached" : "";
		return `${tx.date} · ${tx.description} · ${formatMoney(tx.amount, { currency: tx.currency })} · ${this.accountName(tx)}${attached}`;
	}

	onChooseItem(tx: Transaction): void {
		this.onChoose(tx);
	}
}

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function base64Of(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 8192) {
		binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)));
	}
	return btoa(binary);
}

export function openInvoiceMatchWizard(plugin: FinancePlugin): void {
	const app = plugin.app;
	const store = plugin.store;
	const today = new Date();

	let files: File[] = [];
	let fileError: string | undefined;

	let period: InvoicePeriod = { kind: "month", year: today.getFullYear(), month: today.getMonth() + 1 };
	// Follows the AI setting but stays a per-run decision: a batch of receipts is exactly the kind of
	// thing someone might want kept local this once without turning the whole feature off.
	let useAi = !!plugin.settings.ai?.enabled;

	let plan: InvoiceMatchPlan | undefined;
	let analysing = false;
	let analysisError: string | undefined;
	let aiOutcome: InvoiceAiOutcome = emptyAiOutcome();
	let aiNotice: string | undefined;
	/** Documents whose file couldn't be read at all — reported, never allowed to stop the batch. */
	const unreadable = new Map<string, string>();

	/** Manual overrides: document id → the transaction the user picked instead of the proposal. */
	const overrides = new Map<string, ScoredCandidate>();
	/** Documents the user has ticked. Seeded from the plan's own defaults each time it is rebuilt. */
	const ticked = new Set<string>();

	let outcome: AttachOutcome | undefined;
	let attachErrors: string[] = [];

	const accountName = (tx: { accountId: string }): string =>
		store.accounts.find((a) => a.id === tx.accountId)?.name ?? "Unknown account";

	function scopedTransactions(): Transaction[] {
		return transactionsInPeriod(store.transactions, period);
	}

	function chosenFor(proposal: InvoiceProposal): ScoredCandidate | undefined {
		return overrides.get(proposal.doc.id) ?? proposal.chosen;
	}

	// ─── Step 1: the files ────────────────────────────────────────────────────────────────────────

	function addFiles(incoming: File[]): void {
		const combined = [...files, ...incoming];
		const check = checkFileSelection(combined.map((f) => f.name));
		fileError = check.tooMany;
		if (check.unsupported.length > 0) {
			const list = check.unsupported.slice(0, 3).join(", ");
			fileError = `${fileError ? `${fileError} ` : ""}Skipped ${check.unsupported.length} file${
				check.unsupported.length === 1 ? "" : "s"
			} of a type this can't read (${list}). PDF, PNG, JPG and similar images only.`;
		}
		// The unsupported ones are dropped and the supported ones kept even when the batch is over the
		// cap — the message says so, and the list on screen is then editable down to ten by hand, which
		// beats refusing the whole drop and making the user redo it.
		files = combined.filter((f) => isSupportedInvoiceFile(f.name));
		// Any change to the files invalidates a plan built from the old ones.
		plan = undefined;
	}

	const fileStep: WizardStep = {
		id: "files",
		title: "Documents",
		icon: "files",
		render: (c, wizard) => {
			c.createEl("h3", { text: "Invoices & receipts" });
			c.createEl("p", {
				cls: "fp-step-desc",
				text: `Drop up to ${MAX_INVOICE_FILES} invoices or receipts. Nothing is copied into the vault until you confirm a match — cancel at any point and the files stay exactly where they are.`,
			});

			const dropzone = c.createDiv({ cls: "fp-dropzone" + (files.length > 0 ? " has-file" : "") });
			icon(dropzone, files.length > 0 ? "file-check-2" : "upload", "fp-dropzone-icon");
			dropzone.createDiv({
				cls: "fp-dropzone-text",
				text: files.length > 0 ? `${files.length} of ${MAX_INVOICE_FILES} selected` : "Drop files here",
			});
			dropzone.createDiv({ cls: "fp-dropzone-subtext", text: "or click to browse — PDF, PNG, JPG, WebP, HEIC" });

			const fileInput = c.createEl("input", {
				cls: "fp-file-input-hidden",
				attr: {
					type: "file",
					multiple: "true",
					accept: SUPPORTED_INVOICE_EXTENSIONS.map((ext) => `.${ext}`).join(","),
				},
			});

			dropzone.addEventListener("click", () => fileInput.click());
			fileInput.addEventListener("change", () => {
				addFiles(Array.from(fileInput.files ?? []));
				redraw();
			});
			dropzone.addEventListener("dragover", (ev) => {
				ev.preventDefault();
				dropzone.addClass("is-dragover");
			});
			dropzone.addEventListener("dragleave", () => dropzone.removeClass("is-dragover"));
			dropzone.addEventListener("drop", (ev) => {
				ev.preventDefault();
				dropzone.removeClass("is-dragover");
				addFiles(Array.from(ev.dataTransfer?.files ?? []));
				redraw();
			});

			if (fileError) c.createDiv({ cls: "fp-invoice-warning", text: fileError });

			if (files.length > 0) {
				const list = c.createDiv({ cls: "fp-invoice-file-list" });
				files.forEach((file, index) => {
					const row = list.createDiv({ cls: "fp-invoice-file-row" });
					icon(row, extensionOf(file.name) === "pdf" ? "file-text" : "image", "fp-invoice-file-icon");
					row.createSpan({ cls: "fp-invoice-file-name fp-sensitive", text: file.name });
					row.createSpan({ cls: "fp-invoice-file-size", text: `${Math.max(1, Math.round(file.size / 1024))} KB` });
					const remove = row.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon fp-btn-tiny" });
					icon(remove, "x");
					remove.setAttribute("aria-label", `Remove ${file.name}`);
					remove.addEventListener("click", () => {
						files.splice(index, 1);
						fileError = undefined;
						plan = undefined;
						redraw();
					});
				});
			}

			function redraw(): void {
				c.empty();
				void fileStep.render(c, wizard);
				wizard.refreshFooter();
			}
		},
		canGoNext: () => files.length > 0 && files.length <= MAX_INVOICE_FILES,
		blockedReason: () =>
			files.length === 0
				? "Drop or pick at least one document"
				: files.length > MAX_INVOICE_FILES
					? `Remove ${files.length - MAX_INVOICE_FILES} — ${MAX_INVOICE_FILES} is the limit`
					: undefined,
	};

	// ─── Step 2: the period ───────────────────────────────────────────────────────────────────────

	const periodStep: WizardStep = {
		id: "period",
		title: "Period",
		icon: "calendar-range",
		render: (c, wizard) => {
			c.createEl("h3", { text: "Which period?" });
			c.createEl("p", {
				cls: "fp-step-desc",
				text: "Only transactions dated inside this period are considered. Nothing outside it can be matched, however well it scores.",
			});

			const kindRow = c.createDiv({ cls: "fp-invoice-period-row" });
			(
				[
					["month", "Month"],
					["quarter", "Quarter"],
					["year", "Year"],
				] as [InvoicePeriodKind, string][]
			).forEach(([kind, label]) => {
				const btn = kindRow.createEl("button", {
					cls: `fp-btn ${period.kind === kind ? "fp-btn-primary" : "fp-btn-secondary"}`,
					text: label,
				});
				btn.addEventListener("click", () => {
					// Defaults chosen so switching never lands on an empty selection: the quarter and month
					// that contain today, and the year already selected.
					period = {
						kind,
						year: period.year,
						month: kind === "month" ? (period.month ?? today.getMonth() + 1) : undefined,
						quarter: kind === "quarter" ? (period.quarter ?? Math.floor(today.getMonth() / 3) + 1) : undefined,
					};
					plan = undefined;
					redraw();
				});
			});

			const pickerRow = c.createDiv({ cls: "fp-invoice-period-row" });

			if (period.kind === "month") {
				const monthSelect = pickerRow.createEl("select", { cls: "fp-filter-select" });
				MONTH_NAMES.forEach((name, index) => monthSelect.createEl("option", { text: name, value: String(index + 1) }));
				monthSelect.value = String(period.month ?? 1);
				monthSelect.addEventListener("change", () => {
					period = { ...period, month: Number(monthSelect.value) };
					plan = undefined;
					redraw();
				});
			}

			if (period.kind === "quarter") {
				const quarterSelect = pickerRow.createEl("select", { cls: "fp-filter-select" });
				[1, 2, 3, 4].forEach((q) =>
					quarterSelect.createEl("option", {
						text: `Q${q} (${MONTH_NAMES[(q - 1) * 3].slice(0, 3)}–${MONTH_NAMES[(q - 1) * 3 + 2].slice(0, 3)})`,
						value: String(q),
					})
				);
				quarterSelect.value = String(period.quarter ?? 1);
				quarterSelect.addEventListener("change", () => {
					period = { ...period, quarter: Number(quarterSelect.value) };
					plan = undefined;
					redraw();
				});
			}

			const yearSelect = pickerRow.createEl("select", { cls: "fp-filter-select" });
			// Every year the ledger actually holds, plus this one — a period with no transactions in it is
			// a legal choice, but it should not be the only kind on offer.
			const years = new Set<number>([today.getFullYear()]);
			for (const tx of store.transactions) {
				const year = Number(tx.date?.slice(0, 4));
				if (isFinite(year) && year > 1900) years.add(year);
			}
			Array.from(years)
				.sort((a, b) => b - a)
				.forEach((year) => yearSelect.createEl("option", { text: String(year), value: String(year) }));
			yearSelect.value = String(period.year);
			yearSelect.addEventListener("change", () => {
				period = { ...period, year: Number(yearSelect.value) };
				plan = undefined;
				redraw();
			});

			const count = scopedTransactions().length;
			c.createDiv({ cls: "fp-invoice-scope", text: describeSearchScope(count, period) });
			if (count === 0) {
				c.createDiv({
					cls: "fp-invoice-warning",
					text: `There are no transactions in ${describeInvoicePeriod(period)}. Pick a period the ledger actually covers.`,
				});
			}

			// What leaves the vault, before it leaves the vault.
			const ai = plugin.settings.ai;
			const aiBox = c.createDiv({ cls: "fp-invoice-ai-box" });
			if (!ai?.enabled) {
				aiBox.createDiv({
					cls: "fp-step-desc",
					text: "AI is switched off, so matching will use amounts, merchants, dates and reference numbers only. Turn it on in Settings → AI to have Claude read the documents and rank the results as well.",
				});
			} else {
				const row = aiBox.createDiv({ cls: "fp-invoice-ai-toggle" });
				const box = row.createEl("input", { type: "checkbox", cls: "fp-review-check" });
				box.id = "fp-invoice-use-ai";
				box.checked = useAi;
				row.createEl("label", { text: "Let Claude read the documents and rank the results", attr: { for: "fp-invoice-use-ai" } });
				box.addEventListener("change", () => {
					useAi = box.checked;
					plan = undefined;
					redraw();
				});
				if (useAi) {
					aiBox.createDiv({ cls: "fp-step-desc", text: describeAiDisclosure(0, 0, DEFAULT_CANDIDATE_LIMIT) });
					aiBox.createDiv({
						cls: "fp-step-desc",
						text: "A document whose text can't be read locally — a photo, or a scanned PDF — is uploaded in full so Claude can see it. Everything else sends only the text already extracted from it.",
					});
					if ((ai.provider ?? "api") === "cli") {
						aiBox.createDiv({
							cls: "fp-invoice-warning",
							text: "The Claude CLI provider can't be sent a file, so photos and scanned PDFs will fall back to their filenames. Switch to the API key provider in Settings → AI to have them read.",
						});
					}
				}
			}

			function redraw(): void {
				c.empty();
				void periodStep.render(c, wizard);
				wizard.refreshFooter();
			}
		},
		nextLabel: "Find matches",
		canGoNext: () => scopedTransactions().length > 0,
		blockedReason: () => (scopedTransactions().length === 0 ? "No transactions in this period" : undefined),
	};

	// ─── Analysis ─────────────────────────────────────────────────────────────────────────────────

	/**
	 * Turns one picked file into a document.
	 *
	 * Reading is attempted in the cheapest order: the PDF's own text, then the filename, then Claude.
	 * A file that throws — corrupt, unreadable, permission-denied on a phone — is recorded and returns
	 * a document with nothing in it, which scores against nothing and shows as "No confident match".
	 * The other nine receipts are none of its business.
	 */
	async function readDocument(file: File, index: number): Promise<InvoiceDocument> {
		const id = `doc-${index}`;
		let text: string | undefined;
		let bytes: ArrayBuffer | undefined;

		try {
			bytes = await file.arrayBuffer();
			if (extensionOf(file.name) === "pdf" && bytes) text = await extractPdfText(new Uint8Array(bytes));
		} catch (e) {
			unreadable.set(id, e instanceof Error ? e.message : String(e));
		}

		const doc = buildInvoiceDocument(id, file.name, text);
		if (!useAi || localExtractionSufficient(doc)) return doc;

		// Only what local reading failed to produce goes over the wire, and the file itself only when
		// there was no text to send in its place.
		const mediaType = MEDIA_TYPES[extensionOf(file.name)];
		const canUpload = !!bytes && !!mediaType && bytes.byteLength <= MAX_UPLOAD_BYTES && (plugin.settings.ai?.provider ?? "api") !== "cli";
		const attachment: ModelAttachment | undefined =
			!text?.trim() && canUpload && bytes ? { mediaType, data: base64Of(bytes), filename: file.name } : undefined;

		try {
			const { fields, model } = await aiReadDocument(doc, text, attachment, plugin.settings.ai ?? {});
			aiOutcome.read++;
			aiOutcome.model = model;
			// Claude's reading wins over the filename's guesswork but is merged rather than substituted:
			// a filename that named the vendor is still the better vendor when the model didn't find one.
			return { ...doc, ...fields, source: Object.keys(fields).length > 0 ? "ai" : doc.source };
		} catch (e) {
			aiOutcome.failures++;
			aiOutcome.lastError = e instanceof Error ? e.message : String(e);
			return doc;
		}
	}

	async function analyse(): Promise<void> {
		analysing = true;
		analysisError = undefined;
		aiOutcome = emptyAiOutcome();
		aiNotice = undefined;
		unreadable.clear();
		overrides.clear();
		ticked.clear();

		try {
			const docs: InvoiceDocument[] = [];
			for (let i = 0; i < files.length; i++) docs.push(await readDocument(files[i], i));

			let built = matchInvoices(docs, scopedTransactions(), period);

			if (useAi && plugin.settings.ai?.enabled) {
				const { rankings, outcome: ranked } = await aiRankPlan(built, plugin.settings.ai);
				aiOutcome = {
					...ranked,
					read: aiOutcome.read,
					failures: aiOutcome.failures + ranked.failures,
					lastError: ranked.lastError ?? aiOutcome.lastError,
				};
				if (rankings.length > 0) built = applyAiRanking(built, rankings);
			}

			plan = built;
			for (const proposal of built.proposals) if (proposal.selected) ticked.add(proposal.doc.id);
			aiNotice = describeAiOutcome(aiOutcome);
		} catch (e) {
			analysisError = e instanceof Error ? e.message : String(e);
		} finally {
			analysing = false;
		}
	}

	// ─── Step 3: the matches ──────────────────────────────────────────────────────────────────────

	function selectedProposals(): InvoiceProposal[] {
		return (plan?.proposals ?? []).filter((p) => ticked.has(p.doc.id));
	}

	const matchStep: WizardStep = {
		id: "matches",
		title: "Matches",
		icon: "search-check",
		render: (c, wizard) => {
			const redraw = (): void => {
				c.empty();
				void matchStep.render(c, wizard);
				wizard.refreshFooter();
			};

			if (!plan && !analysing && !analysisError) {
				// Kicked off from render rather than awaited in it: an awaited render leaves the dialog
				// body blank for however long ten uploads take, which reads as a hung modal.
				void analyse().then(redraw);
			}

			if (analysing) {
				c.createEl("h3", { text: "Looking…" });
				c.createDiv({
					cls: "fp-step-desc",
					text: `Reading ${files.length} document${files.length === 1 ? "" : "s"} and weighing them against ${describeInvoicePeriod(period)}.`,
				});
				return;
			}

			if (analysisError) {
				c.createEl("h3", { text: "That didn't work" });
				c.createDiv({ cls: "fp-invoice-warning", text: analysisError });
				const retry = c.createEl("button", { cls: "fp-btn fp-btn-secondary", text: "Try again" });
				retry.addEventListener("click", () => {
					plan = undefined;
					analysisError = undefined;
					redraw();
				});
				return;
			}
			if (!plan) return;

			c.createEl("h3", { text: `Matches in ${describeInvoicePeriod(period)}` });
			c.createDiv({ cls: "fp-step-desc", text: describeSearchScope(plan.searched, period) });
			if (aiNotice) c.createDiv({ cls: "fp-invoice-notice", text: aiNotice });
			if (unreadable.size > 0) {
				c.createDiv({
					cls: "fp-invoice-warning",
					text: `${unreadable.size} document${unreadable.size === 1 ? "" : "s"} couldn't be opened and were matched on their filename alone.`,
				});
			}

			const list = c.createDiv({ cls: "fp-invoice-results" });
			for (const proposal of plan.proposals) renderProposal(list, proposal, redraw);
		},
		// A getter, not a string: the footer is repainted every time a row is ticked, and the count in the
		// button is the only place the size of the pending write is stated.
		get nextLabel(): string {
			return `Attach selected (${selectedProposals().length})`;
		},
		canGoNext: () => selectedProposals().length > 0,
		blockedReason: () =>
			analysing ? "Still looking…" : selectedProposals().length === 0 ? "Nothing ticked to attach" : undefined,
		onNext: async () => {
			await attachSelected();
		},
	};

	/** One result row: what the document says, what it is proposed against, and what can be done about it. */
	function renderProposal(container: HTMLElement, proposal: InvoiceProposal, redraw: () => void): void {
		const chosen = chosenFor(proposal);
		const row = container.createDiv({ cls: "fp-invoice-result" + (ticked.has(proposal.doc.id) ? " is-selected" : "") });

		const head = row.createDiv({ cls: "fp-invoice-result-head" });
		const check = head.createEl("input", { type: "checkbox", cls: "fp-review-check" });
		check.checked = ticked.has(proposal.doc.id);
		check.disabled = !chosen || chosen.alreadyAttached;
		check.addEventListener("change", () => {
			if (check.checked) ticked.add(proposal.doc.id);
			else ticked.delete(proposal.doc.id);
			redraw();
		});

		const title = head.createDiv({ cls: "fp-invoice-result-title" });
		title.createDiv({ cls: "fp-invoice-doc-name fp-sensitive", text: proposal.doc.filename });
		title.createDiv({ cls: "fp-invoice-doc-fields fp-sensitive", text: describeDocument(proposal.doc) });

		if (chosen) badge(head, CONFIDENCE_LABEL[chosen.confidence], CONFIDENCE_TONE[chosen.confidence]);
		else badge(head, "No match", "neutral");

		const body = row.createDiv({ cls: "fp-invoice-result-body" });

		if (chosen) {
			const tx = chosen.tx;
			const proposed = body.createDiv({ cls: "fp-invoice-proposed" });
			proposed.createSpan({ cls: "fp-invoice-tx-date", text: tx.date });
			proposed.createSpan({
				cls: "fp-invoice-tx-desc fp-sensitive",
				text: merchantDisplayName(tx.description || tx.counterparty || "") || tx.description || "(no description)",
			});
			proposed.createSpan({ cls: "fp-invoice-tx-amount fp-sensitive", text: formatMoney(tx.amount, { currency: tx.currency }) });
			proposed.createSpan({ cls: "fp-invoice-tx-account", text: accountName(tx) });

			body.createDiv({ cls: "fp-invoice-reason", text: chosen.reason });
			if (chosen.aiReason) {
				const aiLine = body.createDiv({ cls: "fp-invoice-reason fp-invoice-reason-ai" });
				icon(aiLine, "sparkles");
				aiLine.createSpan({ text: chosen.aiReason });
			}
		} else {
			body.createDiv({ cls: "fp-invoice-reason", text: "No confident match — pick a transaction yourself, or skip it." });
		}

		// Suppressed once the row has been overruled by hand: the reason belongs to the proposal the
		// engine made, and leaving it under a transaction the user chose themselves reads as an
		// objection to their own choice.
		if (proposal.blockedReason && !ticked.has(proposal.doc.id) && !overrides.has(proposal.doc.id)) {
			body.createDiv({ cls: "fp-invoice-blocked", text: proposal.blockedReason });
		}

		const actions = body.createDiv({ cls: "fp-invoice-actions" });
		const pick = actions.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-tiny" });
		icon(pick, "list-checks");
		pick.createSpan({ text: chosen ? "Choose another transaction" : "Choose a transaction" });
		pick.addEventListener("click", () => openPicker(proposal, redraw));

		if (ticked.has(proposal.doc.id)) {
			const skip = actions.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-tiny" });
			icon(skip, "circle-slash");
			skip.createSpan({ text: "Skip" });
			skip.addEventListener("click", () => {
				ticked.delete(proposal.doc.id);
				redraw();
			});
		} else if (chosen && !chosen.alreadyAttached) {
			const attach = actions.createEl("button", { cls: "fp-btn fp-btn-secondary fp-btn-tiny" });
			icon(attach, "paperclip");
			attach.createSpan({ text: "Attach" });
			attach.addEventListener("click", () => {
				ticked.add(proposal.doc.id);
				redraw();
			});
		}
	}

	/**
	 * Manual choice, with the same two rules the automatic pass obeys.
	 *
	 * A transaction that already carries a file is refused outright rather than warned about — this
	 * feature's one hard promise is that it never replaces an attachment, and an override that could
	 * break it would make the promise worthless. A transaction already claimed by another document in
	 * this same batch is refused for the matching reason: the batch writes once, and two receipts
	 * landing on one row would mean the second silently winning.
	 */
	function openPicker(proposal: InvoiceProposal, redraw: () => void): void {
		new PeriodTransactionSuggestModal(app, scopedTransactions(), accountName, (tx) => {
			if (tx.attachmentPath) {
				new Notice("That transaction already has a file attached. Nothing was changed.", 8000);
				return;
			}
			const claimedBy = (plan?.proposals ?? []).find(
				(other) => other.doc.id !== proposal.doc.id && ticked.has(other.doc.id) && chosenFor(other)?.tx.id === tx.id
			);
			if (claimedBy) {
				new Notice(`"${claimedBy.doc.filename}" is already going onto that transaction. Skip it first.`, 8000);
				return;
			}
			overrides.set(proposal.doc.id, scoreCandidate(proposal.doc, tx));
			ticked.add(proposal.doc.id);
			redraw();
		}).open();
	}

	function describeDocument(doc: InvoiceDocument): string {
		const parts: string[] = [];
		if (doc.vendor) parts.push(doc.vendor);
		if (doc.date) parts.push(doc.date);
		if (doc.total !== undefined) parts.push(formatMoney(doc.total, { currency: doc.currency || "EUR" }));
		if (doc.invoiceNumber) parts.push(`#${doc.invoiceNumber}`);
		if (doc.credit) parts.push("credit note");
		if (parts.length === 0) return "Nothing could be read from this document";
		return parts.join(" · ");
	}

	// ─── The writes ───────────────────────────────────────────────────────────────────────────────

	/**
	 * The only place anything is written, and it re-checks its own facts first.
	 *
	 * The plan was built minutes ago against a store that may have moved since — another pane, the
	 * transaction detail modal, a sync. So each row is looked up again by id and skipped if it has
	 * gained an attachment in the meantime, rather than trusting the snapshot the proposal is holding.
	 */
	async function attachSelected(): Promise<void> {
		const attached = new Set<string>();
		const failed = new Set<string>();
		const usedTx = new Set<string>();
		attachErrors = [];

		for (const proposal of selectedProposals()) {
			const candidate = chosenFor(proposal);
			const file = files[Number(proposal.doc.id.replace("doc-", ""))];
			if (!candidate || !file) {
				failed.add(proposal.doc.id);
				continue;
			}

			const live = store.transactions.find((t) => t.id === candidate.tx.id);
			if (!live) {
				failed.add(proposal.doc.id);
				attachErrors.push(`${proposal.doc.filename}: that transaction is no longer in the ledger.`);
				continue;
			}
			if (live.attachmentPath) {
				failed.add(proposal.doc.id);
				attachErrors.push(`${proposal.doc.filename}: that transaction already has a file — nothing was replaced.`);
				continue;
			}
			if (usedTx.has(live.id)) {
				failed.add(proposal.doc.id);
				attachErrors.push(`${proposal.doc.filename}: another document in this batch already claimed that transaction.`);
				continue;
			}

			try {
				const path = await writeAttachment(app, plugin.settings.dataFolder, file);
				await store.updateTransaction(live.id, { attachmentPath: path });
				usedTx.add(live.id);
				attached.add(proposal.doc.id);
			} catch (e) {
				failed.add(proposal.doc.id);
				attachErrors.push(`${proposal.doc.filename}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		outcome = summarizeOutcome(plan?.proposals ?? [], attached, failed);
		plugin.refreshViews();
		new Notice(describeOutcome(outcome), attached.size > 0 ? 6000 : 10000);
	}

	// ─── Step 4: what happened ────────────────────────────────────────────────────────────────────

	const doneStep: WizardStep = {
		id: "done",
		title: "Done",
		icon: "check",
		render: (c) => {
			c.createEl("h3", { text: "Finished" });
			if (!outcome) {
				c.createDiv({ cls: "fp-step-desc", text: "Nothing was attached." });
				return;
			}

			const tiles = c.createDiv({ cls: "fp-invoice-summary" });
			const tile = (label: string, value: number, tone: Tone): void => {
				const box = tiles.createDiv({ cls: `fp-invoice-summary-tile fp-tone-${tone}` });
				box.createDiv({ cls: "fp-invoice-summary-value", text: String(value) });
				box.createDiv({ cls: "fp-invoice-summary-label", text: label });
			};
			tile("attached", outcome.attached, "good");
			tile("skipped", outcome.skipped, "neutral");
			tile("unmatched", outcome.unmatched, "neutral");
			tile("failed", outcome.failed, outcome.failed > 0 ? "bad" : "neutral");

			if (outcome.attached > 0) {
				c.createDiv({
					cls: "fp-step-desc",
					text: `Copied into ${plugin.settings.dataFolder}/attachments and linked. They show in the ledger's File(s) column, and the "Has file" filter now finds them.`,
				});
			}
			if (attachErrors.length > 0) {
				const problems = c.createDiv({ cls: "fp-invoice-warning" });
				problems.createDiv({ text: "Not everything went through:" });
				attachErrors.forEach((message) => problems.createDiv({ text: `• ${message}` }));
			}
			if (outcome.unmatched > 0 || outcome.skipped > 0) {
				c.createDiv({
					cls: "fp-step-desc",
					text: "Whatever wasn't attached is untouched — the files never entered the vault. Run it again over a different period, or attach them one at a time from the ledger.",
				});
			}
		},
		nextLabel: "Close",
	};

	new WizardModal(app, {
		title: "Match invoices & receipts",
		subtitle: Platform.isMobile
			? "Pick your documents, choose a period, confirm the matches."
			: "Drop your documents, choose a period, confirm the matches.",
		icon: "receipt",
		steps: [fileStep, periodStep, matchStep, doneStep],
		buildStamp: `v${plugin.manifest.version} · loaded ${plugin.loadedAt}`,
	}).open();
}
