import { App, Modal, Notice } from "obsidian";
import { ACCOUNT_TYPE_META } from "../constants";
import { accountStats } from "../kpi";
import type FinancePlugin from "../main";
import { icon } from "../ui/dom";
import { CreateAccountModal } from "./CreateAccountModal";

function formatEUR(n: number): string {
	return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}

/** Full account roster: per-account transaction count and net total, plus add/remove — the "exact numbers per account" view. */
export class ManageAccountsModal extends Modal {
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
				const removeBtn = row.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
				icon(removeBtn, "x");
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

	private async remove(accountId: string, name: string): Promise<void> {
		const store = this.plugin.store;
		store.accounts = store.accounts.filter((a) => a.id !== accountId);
		if (this.plugin.settings.activeAccountId === accountId) {
			this.plugin.settings.activeAccountId = undefined;
			await this.plugin.saveSettings();
		}
		await store.saveAccounts();

		// Cards always require a linked account — an orphaned card pointing at a deleted account isn't a valid state.
		const linkedCards = store.cards.filter((c) => c.accountId === accountId);
		if (linkedCards.length > 0) {
			store.cards = store.cards.filter((c) => c.accountId !== accountId);
			await store.saveCards();
		}

		new Notice(`Removed "${name}"${linkedCards.length > 0 ? ` and ${linkedCards.length} linked card${linkedCards.length === 1 ? "" : "s"}` : ""}`);
		this.render();
		this.onChange?.();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
