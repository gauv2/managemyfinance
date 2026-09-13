import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { ACCOUNT_TYPE_META } from "../constants";
import { formatMoneyRounded } from "../money";
import { accountStats } from "../kpi";
import type FinancePlugin from "../main";
import { icon } from "../ui/dom";
import { ConfirmDeleteAccountModal } from "./ConfirmDeleteAccountModal";
import { CreateAccountModal } from "./CreateAccountModal";
import { EditAccountModal } from "./EditAccountModal";

function formatEUR(n: number): string {
	return formatMoneyRounded(n);
}

/** Full account roster: per-account transaction count and net total, plus add/remove — the "exact numbers per account" view. */
export class ManageAccountsModal extends FinanceModal {
	constructor(app: App, private plugin: FinancePlugin, private onChange?: () => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		this.render();
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();
		c.addClass("fp-account-modal");

		const head = c.createDiv({ cls: "fp-detail-header" });
		head.createDiv({ cls: "fp-detail-desc", text: "Manage accounts" });
		const addBtn = head.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(addBtn, "plus");
		addBtn.createSpan({ text: "Add account" });
		addBtn.addEventListener("click", () => {
			new CreateAccountModal(this.app, this.plugin, () => {
				this.render();
				this.onChange?.();
			}).open();
		});

		const store = this.plugin.store;
		if (store.accounts.length === 0) {
			c.createEl("p", { cls: "fp-step-desc", text: "No accounts yet — add one above." });
		} else {
			const list = c.createDiv({ cls: "fp-account-list" });
			store.accounts.forEach((acc) => {
				const stats = accountStats(store, acc.id);
				const row = list.createDiv({ cls: "fp-account-row" });
				icon(row, ACCOUNT_TYPE_META[acc.type].icon, "fp-account-row-icon");
				const info = row.createDiv({ cls: "fp-account-row-info" });
				info.createDiv({ cls: "fp-account-row-name", text: acc.name });
				const meta = info.createDiv({ cls: "fp-account-row-meta" });
				meta.createSpan({ text: ACCOUNT_TYPE_META[acc.type].label });
				if (acc.iban) {
					meta.createSpan({ text: " · " });
					meta.createSpan({ cls: "fp-iban", text: acc.iban });
				}
				meta.createSpan({ text: ` · ${stats.count} transaction${stats.count === 1 ? "" : "s"}` });
				row.createDiv({ cls: "fp-account-row-balance fp-money", text: formatEUR(stats.netWorth) });
				const editBtn = row.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
				icon(editBtn, "pencil");
				editBtn.setAttribute("aria-label", "Edit account");
				editBtn.addEventListener("click", () => {
					new EditAccountModal(this.app, this.plugin, acc, () => {
						this.render();
						this.onChange?.();
					}).open();
				});
				const removeBtn = row.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
				icon(removeBtn, "x");
				removeBtn.setAttribute("aria-label", "Remove account");
				removeBtn.addEventListener("click", () => void this.remove(acc.id, acc.name));
			});
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const closeBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(closeBtn, "check");
		closeBtn.createSpan({ text: "Done" });
		closeBtn.addEventListener("click", () => this.close());
	}

	/** Asks first, and says exactly what is attached — see ConfirmDeleteAccountModal. */
	private remove(accountId: string, name: string): void {
		const store = this.plugin.store;
		const impact = {
			transactions: store.transactions.filter((t) => t.accountId === accountId).length,
			snapshots: store.snapshots.filter((s) => s.accountId === accountId).length,
			cards: store.cards.filter((c) => c.accountId === accountId).length,
			subscriptions: store.subscriptions.filter((s) => s.accountId === accountId).length,
			debts: store.debts.filter((d) => d.accountId === accountId).length,
		};
		new ConfirmDeleteAccountModal(this.app, name, impact, (deleteTransactions) => {
			void this.performRemove(accountId, name, impact, deleteTransactions);
		}).open();
	}

	private async performRemove(
		accountId: string,
		name: string,
		impact: { transactions: number; cards: number },
		deleteTransactions: boolean
	): Promise<void> {
		const store = this.plugin.store;

		// The ledger first: rewriting it is the only step that can fail on I/O, and failing it *after*
		// the account is gone is what produces the orphan this whole dialog exists to prevent.
		if (deleteTransactions && impact.transactions > 0) {
			await store.deleteTransactions(store.transactions.filter((t) => t.accountId === accountId).map((t) => t.id));
		}

		// Recorded balances describe an account's worth at a date, so they cannot outlive it either way.
		const snapshotsBefore = store.snapshots.length;
		store.snapshots = store.snapshots.filter((s) => s.accountId !== accountId);
		if (store.snapshots.length !== snapshotsBefore) await store.saveSnapshots();

		// Cards always require a linked account — an orphaned card pointing at a deleted account isn't a valid state.
		const linkedCards = store.cards.filter((c) => c.accountId === accountId);
		if (linkedCards.length > 0) {
			store.cards = store.cards.filter((c) => c.accountId !== accountId);
			await store.saveCards();
		}

		// These only *refer* to the account, so they survive with the reference cleared rather than
		// silently pointing at something that no longer exists.
		let clearedSubscriptions = 0;
		for (const subscription of store.subscriptions) {
			if (subscription.accountId === accountId) {
				subscription.accountId = undefined;
				clearedSubscriptions++;
			}
		}
		if (clearedSubscriptions > 0) await store.saveSubscriptions();

		let clearedDebts = 0;
		for (const debt of store.debts) {
			if (debt.accountId === accountId) {
				debt.accountId = undefined;
				clearedDebts++;
			}
		}
		if (clearedDebts > 0) await store.saveDebts();

		store.accounts = store.accounts.filter((a) => a.id !== accountId);
		if (this.plugin.settings.activeAccountId === accountId) {
			this.plugin.settings.activeAccountId = undefined;
			await this.plugin.saveSettings();
		}
		await store.saveAccounts();

		const removed = [
			deleteTransactions && impact.transactions > 0
				? `${impact.transactions.toLocaleString()} transaction${impact.transactions === 1 ? "" : "s"}`
				: "",
			linkedCards.length > 0 ? `${linkedCards.length} card${linkedCards.length === 1 ? "" : "s"}` : "",
		].filter(Boolean);
		new Notice(`Removed "${name}"${removed.length > 0 ? ` and ${removed.join(" and ")}` : ""}`);
		this.render();
		this.onChange?.();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
