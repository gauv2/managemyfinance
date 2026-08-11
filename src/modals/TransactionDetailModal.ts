import { App, FuzzySuggestModal, Modal, Notice, TFile } from "obsidian";
import type FinancePlugin from "../main";
import type { Transaction } from "../types";
import { categoryChip, icon } from "../ui/dom";

function formatAmount(tx: Transaction): string {
	return new Intl.NumberFormat("en-IE", { style: "currency", currency: tx.currency || "EUR" }).format(tx.amount);
}

function row(container: HTMLElement, label: string, value: string | HTMLElement, opts?: { sensitive?: boolean }): void {
	const r = container.createDiv({ cls: "fp-detail-row" });
	r.createDiv({ cls: "fp-detail-label", text: label });
	const valueEl = r.createDiv({ cls: "fp-detail-value" + (opts?.sensitive ? " fp-sensitive" : "") });
	if (typeof value === "string") valueEl.setText(value);
	else valueEl.appendChild(value);
}

/** Fuzzy-picks any existing file already in the vault, the standard Obsidian idiom for linking to a file. */
class VaultFileSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onChoose: (file: TFile) => void) {
		super(app);
		this.setPlaceholder("Link an existing vault file as the attachment…");
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles();
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}

/** Read-only breakdown of every field on a transaction, plus a quick category fix for uncategorized rows. */
export class TransactionDetailModal extends Modal {
	constructor(app: App, private plugin: FinancePlugin, private tx: Transaction) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		const c = this.contentEl;
		c.addClass("fp-detail-modal");

		const store = this.plugin.store;
		const account = store.accounts.find((a) => a.id === this.tx.accountId);
		const category = this.tx.categoryId ? store.categories.find((cat) => cat.id === this.tx.categoryId) : undefined;

		const head = c.createDiv({ cls: "fp-detail-header" });
		head.createDiv({ cls: "fp-detail-desc fp-sensitive", text: this.tx.description || "(no description)" });
		const amount = head.createDiv({
			cls: "fp-cell-amount fp-detail-amount fp-money " + (this.tx.amount < 0 ? "is-negative" : "is-positive"),
		});
		amount.setText(formatAmount(this.tx));

		const body = c.createDiv({ cls: "fp-detail-body" });
		row(body, "Date", this.tx.date);
		row(body, "Account", account?.name ?? this.tx.accountId);
		row(body, "Counterparty", this.tx.counterparty || "—", { sensitive: true });

		const catRow = body.createDiv({ cls: "fp-detail-row" });
		catRow.createDiv({ cls: "fp-detail-label", text: "Category" });
		const catValue = catRow.createDiv({ cls: "fp-detail-value" });
		if (category) categoryChip(catValue, category.name, category.color, category.icon);
		const select = catValue.createEl("select", { cls: "fp-setup-select" });
		select.createEl("option", { text: category ? "Change category…" : "Set category…", value: "" });
		store.categories.forEach((cat) => {
			const opt = select.createEl("option", { text: cat.name, value: cat.id });
			if (cat.id === this.tx.categoryId) opt.selected = true;
		});
		select.addEventListener("change", async () => {
			if (!select.value) return;
			await store.updateTransaction(this.tx.id, { categoryId: select.value });
			this.plugin.refreshViews();
			new Notice("Category updated");
			this.close();
		});

		row(body, "Type", this.tx.type || "—");
		if (this.tx.code) row(body, "Code", this.tx.code);
		row(body, "Source", this.tx.source);
		row(body, "Currency", this.tx.currency);

		const attachRow = body.createDiv({ cls: "fp-detail-row" });
		attachRow.createDiv({ cls: "fp-detail-label", text: "Attachment" });
		const attachValue = attachRow.createDiv({ cls: "fp-detail-value" });
		this.renderAttachment(attachValue);

		if (this.tx.ticker || this.tx.assetClass || this.tx.shares !== undefined) {
			body.createEl("h4", { text: "Investment details" });
			if (this.tx.ticker) row(body, "Ticker / ISIN", this.tx.ticker);
			if (this.tx.assetClass) row(body, "Asset class", this.tx.assetClass);
			if (this.tx.action) row(body, "Action", this.tx.action);
			if (this.tx.shares !== undefined) row(body, "Shares", String(this.tx.shares));
			if (this.tx.price !== undefined) row(body, "Price", String(this.tx.price));
			if (this.tx.fee !== undefined) row(body, "Fee", String(this.tx.fee));
			if (this.tx.tax !== undefined) row(body, "Tax", String(this.tx.tax));
		}

		if (this.tx.notes) row(body, "Notes", this.tx.notes, { sensitive: true });

		if (this.tx.raw) {
			body.createEl("h4", { text: "Raw notification" });
			const rawBox = body.createDiv({ cls: "fp-detail-raw fp-sensitive" });
			rawBox.setText(this.tx.raw);
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const closeBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(closeBtn, "check");
		closeBtn.createSpan({ text: "Close" });
		closeBtn.addEventListener("click", () => this.close());
	}

	/** Renders the current attachment state into `container`, re-rendering itself in place after any change. */
	private renderAttachment(container: HTMLElement): void {
		container.empty();
		const store = this.plugin.store;
		const path = this.tx.attachmentPath;

		if (path) {
			const file = this.app.vault.getAbstractFileByPath(path);
			container.createSpan({ text: file ? path : `${path} (missing)`, cls: file ? undefined : "fp-sensitive" });

			const openBtn = container.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
			icon(openBtn, "external-link");
			openBtn.disabled = !file;
			openBtn.addEventListener("click", async () => {
				await this.app.workspace.openLinkText(path, "", true);
			});

			const clearBtn = container.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
			icon(clearBtn, "x");
			clearBtn.addEventListener("click", async () => {
				await store.updateTransaction(this.tx.id, { attachmentPath: undefined });
				this.tx.attachmentPath = undefined;
				this.plugin.refreshViews();
				new Notice("Attachment removed");
				this.renderAttachment(container);
			});
		} else {
			const attachBtn = container.createEl("button", { cls: "fp-btn fp-btn-secondary" });
			icon(attachBtn, "paperclip");
			attachBtn.createSpan({ text: "Attach file" });
			attachBtn.addEventListener("click", () => {
				new VaultFileSuggestModal(this.app, async (file) => {
					await store.updateTransaction(this.tx.id, { attachmentPath: file.path });
					this.tx.attachmentPath = file.path;
					this.plugin.refreshViews();
					new Notice("Attachment linked");
					this.renderAttachment(container);
				}).open();
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
