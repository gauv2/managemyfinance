import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { buildBackup, serializeBackup, writeExport } from "../data/backup";
import type FinancePlugin from "../main";
import { icon } from "../ui/dom";

/**
 * Wipes the active portfolio's data. Guarded by two things rather than one "are you sure?":
 *
 *   1. an offer to write a backup first, taken by default — the cheapest possible undo;
 *   2. typing the portfolio's own name, so the destructive button can't be reached by reflex.
 *
 * Deletes the *contents*, not the folder: accounts, transactions, subscriptions, cards and rules all
 * go, and categories reset to the defaults so the portfolio is usable immediately afterwards rather
 * than being an empty shell that can't classify anything.
 */
export class DeleteAllDataModal extends FinanceModal {
	private typed = "";
	private backupFirst = true;

	constructor(app: App, private plugin: FinancePlugin, private onDone?: () => void) {
		super(app);
	}

	private get portfolioName(): string {
		return this.plugin.activePortfolio?.name ?? "this portfolio";
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		const c = this.contentEl;
		c.addClass("fp-account-modal");
		const store = this.plugin.store;

		c.createEl("h3", { text: `Delete all data in "${this.portfolioName}"?` });
		c.createEl("p", {
			cls: "fp-step-desc",
			text: "This clears the portfolio and cannot be undone from inside the plugin. Other portfolios are untouched.",
		});

		const stats = c.createDiv({ cls: "fp-import-stats" });
		[
			`${store.transactions.length} transactions`,
			`${store.accounts.length} accounts`,
			`${store.subscriptions.length} subscriptions`,
			`${store.cards.length} cards`,
			`${store.rules.length} rules`,
		].forEach((text) => stats.createDiv({ cls: "fp-import-stat", text }));

		c.createEl("p", {
			cls: "fp-step-desc",
			text: "Categories are reset to the built-in default set rather than emptied, so the portfolio still works afterwards.",
		});

		const backupRow = c.createDiv({ cls: "fp-form-row fp-form-row-inline" });
		const backupToggle = backupRow.createEl("input", { type: "checkbox" });
		backupToggle.checked = this.backupFirst;
		backupToggle.id = "fp-delete-all-backup";
		backupRow.createEl("label", {
			text: "Export a backup into the vault first (recommended)",
			attr: { for: "fp-delete-all-backup" },
		});
		backupToggle.addEventListener("change", () => (this.backupFirst = backupToggle.checked));

		const confirmRow = c.createDiv({ cls: "fp-form-row" });
		confirmRow.createEl("label", { text: `Type "${this.portfolioName}" to confirm` });
		const confirmInput = confirmRow.createEl("input", { type: "text", attr: { placeholder: this.portfolioName, autocomplete: "off" } });

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const cancel = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel" });
		cancel.addEventListener("click", () => this.close());

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const deleteBtn = right.createEl("button", { cls: "fp-btn fp-btn-danger" });
		icon(deleteBtn, "trash-2");
		deleteBtn.createSpan({ text: "Delete all data" });
		deleteBtn.disabled = true;
		deleteBtn.addEventListener("click", () => void this.submit());

		confirmInput.addEventListener("input", () => {
			this.typed = confirmInput.value;
			deleteBtn.disabled = this.typed.trim() !== this.portfolioName;
		});
		confirmInput.focus();
	}

	private async submit(): Promise<void> {
		if (this.typed.trim() !== this.portfolioName) return;

		if (this.backupFirst) {
			try {
				const path = await writeExport(
					this.app,
					this.plugin.settings.dataFolder,
					"backup-before-delete",
					"json",
					serializeBackup(buildBackup(this.plugin))
				);
				new Notice(`Backup written to ${path}`);
			} catch (err) {
				// A failed backup means the safety net isn't there, so the delete doesn't proceed.
				new Notice(`Couldn't write the backup, so nothing was deleted: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
		}

		try {
			await this.plugin.store.deleteAllData();
			this.plugin.settings.activeAccountId = undefined;
			await this.plugin.saveSettings();
			new Notice(`Cleared all data in "${this.portfolioName}".`);
			this.onDone?.();
			this.plugin.refreshViews();
			this.close();
		} catch (err) {
			new Notice(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
