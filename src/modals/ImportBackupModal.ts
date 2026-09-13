import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { applyBackup, backupCounts, parseBackup, type FinanceBackup, type RestoreMode } from "../data/backup";
import type FinancePlugin from "../main";
import { badge, icon } from "../ui/dom";

const COUNT_LABEL: { key: keyof ReturnType<typeof backupCounts>; label: string }[] = [
	{ key: "transactions", label: "transactions" },
	{ key: "accounts", label: "accounts" },
	{ key: "categories", label: "categories" },
	{ key: "subscriptions", label: "subscriptions" },
	{ key: "cards", label: "cards" },
	{ key: "rules", label: "rules" },
];

/**
 * Restores a JSON backup into the active portfolio: pick the file, see exactly what's in it, then
 * choose whether to merge it alongside what's already there or replace everything with it.
 *
 * The choice is deliberately made *after* the file is read and summarized, not before — "replace"
 * is destructive and shouldn't be picked blind.
 */
export class ImportBackupModal extends FinanceModal {
	private backup: FinanceBackup | null = null;
	private fileName = "";
	private error: string | null = null;

	constructor(app: App, private plugin: FinancePlugin, private onDone?: () => void) {
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

		c.createEl("h3", { text: "Import a backup" });
		c.createEl("p", {
			cls: "fp-step-desc",
			text: "Restores a .json backup exported from this plugin into the portfolio you're currently in.",
		});

		const dropzone = c.createDiv({ cls: "fp-dropzone" + (this.backup ? " has-file" : "") });
		icon(dropzone, this.backup ? "file-check-2" : "upload", "fp-dropzone-icon");
		dropzone.createDiv({ cls: "fp-dropzone-text", text: this.fileName || "Drop a backup .json file here" });
		dropzone.createDiv({
			cls: "fp-dropzone-subtext",
			text: this.backup ? "Click, or drop another file, to replace it" : "or click to browse",
		});

		const fileInput = c.createEl("input", { cls: "fp-file-input-hidden", attr: { type: "file", accept: ".json" } });

		const handleFile = async (file: File): Promise<void> => {
			this.fileName = file.name;
			try {
				this.backup = parseBackup(await file.text());
				this.error = null;
			} catch (err) {
				this.backup = null;
				this.error = err instanceof Error ? err.message : String(err);
			}
			this.render();
		};

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

		if (this.error) {
			const errRow = c.createDiv({ cls: "fp-format-row" });
			badge(errRow, this.error, "bad");
		}

		if (this.backup) {
			const counts = backupCounts(this.backup);
			const meta = c.createDiv({ cls: "fp-format-row" });
			if (this.backup.portfolioName) badge(meta, `from "${this.backup.portfolioName}"`, "neutral");
			if (this.backup.exportedAt) badge(meta, `exported ${this.backup.exportedAt.slice(0, 10)}`, "neutral");
			if (this.backup.pluginVersion) badge(meta, `v${this.backup.pluginVersion}`, "neutral");

			const stats = c.createDiv({ cls: "fp-import-stats" });
			COUNT_LABEL.forEach(({ key, label }) => {
				stats.createDiv({ cls: "fp-import-stat", text: `${counts[key]} ${label}` });
			});
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const cancel = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel" });
		cancel.addEventListener("click", () => this.close());

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });

		const mergeBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(mergeBtn, "git-merge");
		mergeBtn.createSpan({ text: "Merge in" });
		mergeBtn.disabled = !this.backup;
		mergeBtn.setAttribute("title", "Add anything the backup has that this portfolio doesn't. Nothing existing is changed or removed.");
		mergeBtn.addEventListener("click", () => void this.restore("merge"));

		const replaceBtn = right.createEl("button", { cls: "fp-btn fp-btn-danger" });
		icon(replaceBtn, "replace");
		replaceBtn.createSpan({ text: "Replace everything" });
		replaceBtn.disabled = !this.backup;
		replaceBtn.setAttribute("title", "Discard this portfolio's current data entirely and use the backup instead.");
		replaceBtn.addEventListener("click", () => void this.confirmReplace());
	}

	/** Replace throws away data that may not exist anywhere else, so it gets its own explicit step. */
	private async confirmReplace(): Promise<void> {
		const store = this.plugin.store;
		const existing = store.transactions.length + store.accounts.length + store.subscriptions.length;
		if (existing === 0) {
			await this.restore("replace");
			return;
		}
		const c = this.contentEl;
		c.empty();
		c.createEl("h3", { text: "Replace everything in this portfolio?" });
		c.createEl("p", {
			cls: "fp-step-desc",
			text: `This discards the ${store.transactions.length} transaction${store.transactions.length === 1 ? "" : "s"}, ${
				store.accounts.length
			} account${store.accounts.length === 1 ? "" : "s"} and ${store.subscriptions.length} subscription${
				store.subscriptions.length === 1 ? "" : "s"
			} currently in "${this.plugin.activePortfolio?.name ?? "this portfolio"}" and uses the backup instead. Export a backup first if you might want any of it back.`,
		});

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const back = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Back" });
		back.addEventListener("click", () => this.render());

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const confirm = right.createEl("button", { cls: "fp-btn fp-btn-danger" });
		icon(confirm, "replace");
		confirm.createSpan({ text: "Yes, replace everything" });
		confirm.addEventListener("click", () => void this.restore("replace"));
	}

	private async restore(mode: RestoreMode): Promise<void> {
		if (!this.backup) return;
		try {
			const result = await applyBackup(this.plugin, this.backup, mode);
			const a = result.added;
			new Notice(
				mode === "replace"
					? `Restored ${a.transactions} transactions, ${a.accounts} accounts, ${a.subscriptions} subscriptions.`
					: `Merged in ${a.transactions} transactions, ${a.accounts} accounts, ${a.subscriptions} subscriptions (duplicates skipped).`
			);
			this.onDone?.();
			this.close();
		} catch (err) {
			new Notice(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
