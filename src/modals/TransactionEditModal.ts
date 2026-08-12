import { App, Modal, Notice } from "obsidian";
import { categoryChain } from "../categories";
import { CURRENCIES } from "../constants";
import { stableHash } from "../hash";
import type FinancePlugin from "../main";
import type { Transaction } from "../types";
import { icon, moneyInput, renderCategoryPicker, type CategoryPickerValue, type MoneyInputHandle } from "../ui/dom";

/**
 * Create or edit one transaction by hand.
 *
 * Until this existed the ledger was import-only, which had two consequences that no amount of import
 * polish could fix: a cash account had no possible way to be filled in (you don't get a CSV from your
 * wallet), and a wrong row was permanent unless you went and edited the CSV in the vault yourself.
 *
 * Amounts are entered as a positive number plus a direction, rather than as a signed figure. Asking
 * someone to type "-12.50" for a coffee is asking them to remember an internal convention; the sign
 * is a fact about the transaction, so the form asks about the fact.
 */
export class TransactionEditModal extends Modal {
	private amountField?: MoneyInputHandle;
	private category: CategoryPickerValue;
	private direction: "out" | "in";
	private date: string;
	private accountId: string;
	private description = "";
	private counterparty = "";
	private currency: string;
	private notes = "";

	constructor(
		app: App,
		private plugin: FinancePlugin,
		private opts: { transaction?: Transaction; defaultAccountId?: string; onSaved?: () => void }
	) {
		super(app);
		const tx = opts.transaction;
		const store = plugin.store;
		const chain = categoryChain(store.categories, tx?.categoryId);

		this.category = { primaryId: chain.primary?.id, secondaryId: chain.secondary?.id };
		this.direction = (tx?.amount ?? -1) < 0 ? "out" : "in";
		this.date = tx?.date ?? new Date().toISOString().slice(0, 10);
		this.accountId = tx?.accountId ?? opts.defaultAccountId ?? store.accounts[0]?.id ?? "";
		this.description = tx?.description ?? "";
		this.counterparty = tx?.counterparty ?? "";
		this.currency =
			tx?.currency || store.accounts.find((a) => a.id === this.accountId)?.currency || plugin.settings.baseCurrency || "EUR";
		this.notes = tx?.notes ?? "";
	}

	private get isEdit(): boolean {
		return !!this.opts.transaction;
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		const c = this.contentEl;
		c.addClass("fp-account-modal");

		c.createEl("h3", { text: this.isEdit ? "Edit transaction" : "Add transaction" });
		c.createDiv({
			cls: "fp-step-desc",
			text: this.isEdit
				? "Corrects the row wherever it lives in the ledger, including moving it between files if you change the date."
				: "For cash spending, a payment nothing exported, or anything an import got wrong.",
		});

		const store = this.plugin.store;
		const form = c.createDiv({ cls: "fp-form" });

		const dateRow = form.createDiv({ cls: "fp-form-row" });
		dateRow.createEl("label", { text: "Date" });
		const dateInput = dateRow.createEl("input", { type: "date" });
		dateInput.value = this.date;
		dateInput.addEventListener("change", () => (this.date = dateInput.value));

		const accountRow = form.createDiv({ cls: "fp-form-row" });
		accountRow.createEl("label", { text: "Account" });
		const accountSelect = accountRow.createEl("select");
		store.accounts.forEach((acc) => {
			const opt = accountSelect.createEl("option", { text: acc.name, value: acc.id });
			if (acc.id === this.accountId) opt.selected = true;
		});
		accountSelect.addEventListener("change", () => {
			this.accountId = accountSelect.value;
			// A new account usually means a new currency; following it saves a second edit, and the
			// field is right there to override when it doesn't.
			const account = store.accounts.find((a) => a.id === this.accountId);
			if (account?.currency) {
				this.currency = account.currency;
				currencySelect.value = account.currency;
				this.amountField?.setCurrency(account.currency);
			}
		});

		const descRow = form.createDiv({ cls: "fp-form-row" });
		descRow.createEl("label", { text: "Description" });
		const descInput = descRow.createEl("input", { type: "text", attr: { placeholder: "e.g. Lunch at the market" } });
		descInput.value = this.description;
		descInput.addEventListener("input", () => (this.description = descInput.value));

		const partyRow = form.createDiv({ cls: "fp-form-row" });
		partyRow.createEl("label", { text: "Counterparty" });
		const partyInput = partyRow.createEl("input", { type: "text", attr: { placeholder: "Optional — who it was with" } });
		partyInput.value = this.counterparty;
		partyInput.addEventListener("input", () => (this.counterparty = partyInput.value));

		const directionRow = form.createDiv({ cls: "fp-form-row" });
		directionRow.createEl("label", { text: "Direction" });
		const directionGroup = directionRow.createDiv({ cls: "fp-segmented" });
		([
			["out", "Money out"],
			["in", "Money in"],
		] as const).forEach(([value, label]) => {
			const btn = directionGroup.createEl("button", {
				cls: "fp-segmented-btn" + (this.direction === value ? " is-active" : ""),
				text: label,
			});
			btn.addEventListener("click", () => {
				this.direction = value;
				directionGroup.querySelectorAll(".fp-segmented-btn").forEach((el) => el.removeClass("is-active"));
				btn.addClass("is-active");
			});
		});

		const amountRow = form.createDiv({ cls: "fp-form-row" });
		amountRow.createEl("label", { text: "Amount" });
		const amountControl = amountRow.createDiv({ cls: "fp-field-control" });
		this.amountField = moneyInput(amountControl, {
			value: this.opts.transaction ? Math.abs(this.opts.transaction.amount) : undefined,
			currency: this.currency,
			// The sign comes from the direction buttons, so a typed minus is dropped rather than
			// silently combining with the direction into a double negative.
			allowNegative: false,
		});

		const currencyRow = form.createDiv({ cls: "fp-form-row" });
		currencyRow.createEl("label", { text: "Currency" });
		const currencySelect = currencyRow.createEl("select");
		CURRENCIES.forEach((code) => {
			const opt = currencySelect.createEl("option", { text: code, value: code });
			if (code === this.currency) opt.selected = true;
		});
		currencySelect.addEventListener("change", () => {
			this.currency = currencySelect.value;
			this.amountField?.setCurrency(this.currency);
		});

		const categoryRow = form.createDiv({ cls: "fp-form-row" });
		categoryRow.createEl("label", { text: "Category" });
		renderCategoryPicker(categoryRow.createDiv({ cls: "fp-field-control" }), {
			categories: store.categories,
			value: this.category,
			primaryPlaceholder: "Uncategorized",
			onChange: (value) => (this.category = value),
		});

		const notesRow = form.createDiv({ cls: "fp-form-row" });
		notesRow.createEl("label", { text: "Notes" });
		const notesInput = notesRow.createEl("input", { type: "text", attr: { placeholder: "Optional" } });
		notesInput.value = this.notes;
		notesInput.addEventListener("input", () => (this.notes = notesInput.value));

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		if (this.isEdit) {
			const deleteBtn = left.createEl("button", { cls: "fp-btn fp-btn-danger" });
			icon(deleteBtn, "trash-2");
			deleteBtn.createSpan({ text: "Delete" });
			deleteBtn.addEventListener("click", () => void this.confirmDelete());
		}

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const cancelBtn = right.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
		const saveBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(saveBtn, "check");
		saveBtn.createSpan({ text: this.isEdit ? "Save changes" : "Add transaction" });
		saveBtn.addEventListener("click", () => void this.save());
	}

	/** The signed amount, from the magnitude typed plus the direction chosen. */
	private signedAmount(): number | undefined {
		const magnitude = this.amountField?.value();
		if (magnitude === undefined || magnitude === 0) return undefined;
		return this.direction === "out" ? -Math.abs(magnitude) : Math.abs(magnitude);
	}

	private async save(): Promise<void> {
		const amount = this.signedAmount();
		if (!this.accountId) {
			new Notice("Add an account first — a transaction has to live somewhere.");
			return;
		}
		if (!this.date) {
			new Notice("Pick a date.");
			return;
		}
		if (amount === undefined) {
			new Notice("Enter an amount.");
			return;
		}
		if (!this.description.trim()) {
			new Notice("Give it a description — you'll want to recognize it later.");
			return;
		}

		const store = this.plugin.store;
		const categoryId = this.category.secondaryId ?? this.category.primaryId;
		const patch: Partial<Transaction> = {
			date: this.date,
			accountId: this.accountId,
			description: this.description.trim(),
			counterparty: this.counterparty.trim() || undefined,
			amount,
			currency: this.currency,
			categoryId,
			notes: this.notes.trim() || undefined,
		};

		if (this.opts.transaction) {
			await store.editTransaction(this.opts.transaction.id, patch);
			new Notice("Transaction updated");
		} else {
			// Hashed from the same fields an importer uses, so a manual row and a later import of the
			// same payment collide and dedupe instead of both landing in the ledger. The random tail
			// keeps two genuinely separate identical cash entries distinct.
			const id = `${stableHash([this.accountId, this.date, amount.toFixed(2), patch.description, patch.counterparty])}-m${Math.random()
				.toString(36)
				.slice(2, 6)}`;
			await store.addTransaction({
				id,
				date: this.date,
				accountId: this.accountId,
				description: patch.description!,
				counterparty: patch.counterparty,
				amount,
				currency: this.currency,
				categoryId,
				notes: patch.notes,
				source: "manual",
				// Nothing to review: you just entered it, so it arrives already signed off.
				review: "approved",
			});
			new Notice("Transaction added");
		}

		this.plugin.refreshViews();
		this.opts.onSaved?.();
		this.close();
	}

	private async confirmDelete(): Promise<void> {
		const tx = this.opts.transaction;
		if (!tx) return;
		new ConfirmDeleteTransactionModal(this.app, tx, async () => {
			await this.plugin.store.deleteTransactions([tx.id]);
			new Notice("Transaction deleted");
			this.plugin.refreshViews();
			this.opts.onSaved?.();
			this.close();
		}).open();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Deleting a ledger row is not recoverable from inside the app, so it asks first — every time. */
export class ConfirmDeleteTransactionModal extends Modal {
	constructor(app: App, private tx: Transaction, private onConfirm: () => Promise<void>) {
		super(app);
	}

	onOpen(): void {
		const c = this.contentEl;
		c.addClass("fp-confirm-modal");
		c.createEl("h3", { text: "Delete this transaction?" });
		c.createEl("p", {
			cls: "fp-step-desc",
			text: `"${this.tx.description || "(no description)"}" on ${this.tx.date}. It's removed from the ledger file too — this can't be undone from here.`,
		});
		if (this.tx.importBatchId) {
			c.createEl("p", {
				cls: "fp-step-desc",
				text: "This row came from an import. Re-importing that file would bring it back.",
			});
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const cancelBtn = right.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Keep it" });
		cancelBtn.addEventListener("click", () => this.close());
		const deleteBtn = right.createEl("button", { cls: "fp-btn fp-btn-danger" });
		icon(deleteBtn, "trash-2");
		deleteBtn.createSpan({ text: "Delete" });
		deleteBtn.addEventListener("click", async () => {
			this.close();
			await this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
