import { App, FuzzySuggestModal, Modal, Notice, TFile } from "obsidian";
import { categoryChain } from "../categories";
import { formatMoney } from "../money";
import type FinancePlugin from "../main";
import { transferSiblings } from "../transfers";
import type { ReviewStatus, Transaction } from "../types";
import { badge, categoryChainChip, icon, renderCategoryPicker } from "../ui/dom";
import { LinkSubscriptionModal } from "./SubscriptionLinkModal";
import { TransactionEditModal } from "./TransactionEditModal";

function formatAmount(tx: Transaction): string {
	return formatMoney(tx.amount, { currency: tx.currency || "EUR" });
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

/**
 * Everything known about one transaction, and everywhere it can be connected from: its category, its
 * review state, an attachment, the subscription it pays for, and the other leg of a transfer. Editing
 * and deleting live here too — this is where you land when a row looks wrong, so it's where the fix
 * has to be.
 */
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
		const chipHolder = catValue.createDiv();
		const chain = categoryChain(store.categories, this.tx.categoryId);
		categoryChainChip(chipHolder, chain.primary, chain.secondary);
		renderCategoryPicker(catValue, {
			categories: store.categories,
			value: { primaryId: chain.primary?.id, secondaryId: chain.secondary?.id },
			primaryPlaceholder: chain.primary ? "Change category…" : "Set category…",
			onChange: async ({ primaryId, secondaryId }) => {
				if (!primaryId) return;
				const categoryId = secondaryId ?? primaryId;
				// assignCategory, not updateTransaction: setting a category here is the same act as
				// setting one in the review queue, so it has to teach merchant memory the same way.
				// Writing only the row meant this correction was invisible to the next import unless
				// the merchant happened to have a clear majority for it to be inferred from.
				const alsoTagged = await this.plugin.assignCategory(this.tx, categoryId);
				const newChain = categoryChain(store.categories, categoryId);
				chipHolder.empty();
				categoryChainChip(chipHolder, newChain.primary, newChain.secondary);
				this.plugin.refreshViews();
				new Notice(
					alsoTagged > 0
						? `Category updated — also applied to ${alsoTagged} other transaction${alsoTagged === 1 ? "" : "s"} from this merchant.`
						: "Category updated. Future imports from this merchant will follow it."
				);
			},
		});

		const reviewRow = body.createDiv({ cls: "fp-detail-row" });
		reviewRow.createDiv({ cls: "fp-detail-label", text: "Review" });
		this.renderReview(reviewRow.createDiv({ cls: "fp-detail-value" }));

		row(body, "Type", this.tx.type || "—");
		if (this.tx.code) row(body, "Code", this.tx.code);
		row(body, "Source", this.tx.source);
		row(body, "Currency", this.tx.currency);

		const attachRow = body.createDiv({ cls: "fp-detail-row" });
		attachRow.createDiv({ cls: "fp-detail-label", text: "Attachment" });
		const attachValue = attachRow.createDiv({ cls: "fp-detail-value" });
		this.renderAttachment(attachValue);

		const subRow = body.createDiv({ cls: "fp-detail-row" });
		subRow.createDiv({ cls: "fp-detail-label", text: "Subscription" });
		this.renderSubscription(subRow.createDiv({ cls: "fp-detail-value" }));

		const transferRow = body.createDiv({ cls: "fp-detail-row" });
		transferRow.createDiv({ cls: "fp-detail-label", text: "Transfer" });
		this.renderTransfer(transferRow.createDiv({ cls: "fp-detail-value" }));

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
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const editBtn = left.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(editBtn, "pencil");
		editBtn.createSpan({ text: "Edit" });
		editBtn.addEventListener("click", () => {
			this.close();
			new TransactionEditModal(this.app, this.plugin, { transaction: this.tx }).open();
		});

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const closeBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(closeBtn, "check");
		closeBtn.createSpan({ text: "Close" });
		closeBtn.addEventListener("click", () => this.close());
	}

	/** The subscription this payment belongs to, if any — and the way to say which one it is. */
	private renderSubscription(container: HTMLElement): void {
		container.empty();
		const store = this.plugin.store;
		const sub = this.tx.subscriptionId ? store.subscriptions.find((s) => s.id === this.tx.subscriptionId) : undefined;

		if (sub) {
			badge(container, sub.name, "good");
		} else {
			container.createSpan({ cls: "fp-budget-hint-text", text: "Not linked" });
		}

		const linkBtn = container.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
		icon(linkBtn, sub ? "settings" : "repeat");
		linkBtn.setAttribute("title", sub ? "Change or remove the subscription link" : "Link this to a subscription, or create one from it");
		linkBtn.addEventListener("click", () => {
			new LinkSubscriptionModal(this.app, this.plugin, this.tx, () => this.renderSubscription(container)).open();
		});
	}

	/**
	 * Whether this row is one half of a movement between your own accounts. Linked legs are excluded
	 * from income and expenses entirely, so being able to see — and undo — the link matters: a wrong
	 * link quietly removes two real transactions from every total.
	 */
	private renderTransfer(container: HTMLElement): void {
		container.empty();
		const store = this.plugin.store;
		const siblings = transferSiblings(store.transactions, this.tx);

		if (!this.tx.transferGroupId) {
			container.createSpan({ cls: "fp-budget-hint-text", text: "Not part of a transfer" });
			return;
		}

		const accountName = (id: string): string => store.accounts.find((a) => a.id === id)?.name ?? id;
		if (siblings.length === 0) {
			badge(container, "Linked — other leg missing", "warn");
		} else {
			siblings.forEach((sibling) => {
				badge(container, `${accountName(sibling.accountId)} · ${sibling.date} · ${formatAmount(sibling)}`, "neutral");
			});
		}

		const unlinkBtn = container.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
		icon(unlinkBtn, "unlink");
		unlinkBtn.setAttribute("title", "Not a transfer — count both rows as income/expense again");
		unlinkBtn.addEventListener("click", async () => {
			const patches = new Map<string, Partial<Transaction>>([[this.tx.id, { transferGroupId: undefined }]]);
			siblings.forEach((sibling) => patches.set(sibling.id, { transferGroupId: undefined }));
			await store.updateTransactions(patches);
			this.tx.transferGroupId = undefined;
			new Notice("Transfer link removed");
			this.plugin.refreshViews();
			this.renderTransfer(container);
		});
	}

	/** The same three-state control the Review page uses, so a transaction opened from anywhere can be
	 *  signed off without going back to the queue to find it again. */
	private renderReview(container: HTMLElement): void {
		container.empty();
		const status: ReviewStatus = this.tx.review ?? "new";
		const meta: Record<ReviewStatus, { label: string; tone: "good" | "warn" | "neutral" }> = {
			new: { label: "Needs review", tone: "neutral" },
			approved: { label: "Approved", tone: "good" },
			flagged: { label: "Flagged", tone: "warn" },
		};
		badge(container, meta[status].label, meta[status].tone);

		const set = async (next: ReviewStatus): Promise<void> => {
			const review = next === "new" ? undefined : next;
			await this.plugin.store.updateTransaction(this.tx.id, { review });
			this.tx.review = review;
			this.plugin.refreshViews();
			this.renderReview(container);
		};

		const approveBtn = container.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" + (status === "approved" ? " is-active" : "") });
		icon(approveBtn, "check");
		approveBtn.setAttribute("title", status === "approved" ? "Mark as needing review again" : "Approve");
		approveBtn.addEventListener("click", () => void set(status === "approved" ? "new" : "approved"));

		const flagBtn = container.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" + (status === "flagged" ? " is-active" : "") });
		icon(flagBtn, "flag");
		flagBtn.setAttribute("title", status === "flagged" ? "Remove flag" : "Flag for a decision later");
		flagBtn.addEventListener("click", () => void set(status === "flagged" ? "new" : "flagged"));
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
