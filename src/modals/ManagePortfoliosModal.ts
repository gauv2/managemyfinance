import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import type FinancePlugin from "../main";
import { icon } from "../ui/dom";
import { openCreatePortfolioWizard } from "../wizards/PortfolioWizard";
import { ConfirmDeletePortfolioModal } from "./ConfirmDeletePortfolioModal";

/** Full portfolio roster: rename in place, add via the wizard, remove from the list (files on disk are left untouched). */
export class ManagePortfoliosModal extends FinanceModal {
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
		head.createDiv({ cls: "fp-detail-desc", text: "Manage portfolios" });
		const addBtn = head.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(addBtn, "plus");
		addBtn.createSpan({ text: "New portfolio" });
		addBtn.addEventListener("click", () => {
			this.close();
			openCreatePortfolioWizard(this.plugin, () => this.onChange?.());
		});

		const portfolios = this.plugin.settings.portfolios ?? [];
		const list = c.createDiv({ cls: "fp-account-list" });
		portfolios.forEach((p) => {
			const row = list.createDiv({ cls: "fp-account-row" });
			icon(row, "briefcase", "fp-account-row-icon");
			const nameInput = row.createEl("input", { type: "text" });
			nameInput.value = p.name;
			nameInput.addEventListener("change", () => void this.rename(p.id, nameInput.value));

			if (p.id === this.plugin.settings.activePortfolioId) {
				row.createDiv({ cls: "fp-account-row-meta", text: "Active" });
			}

			const removeBtn = row.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
			icon(removeBtn, "x");
			removeBtn.addEventListener("click", () => this.remove(p.id, p.name, p.folder));
		});

		c.createEl("p", {
			cls: "fp-step-desc",
			text: "Removing a portfolio asks whether to keep or delete its folder — nothing happens without confirming.",
		});

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const closeBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(closeBtn, "check");
		closeBtn.createSpan({ text: "Done" });
		closeBtn.addEventListener("click", () => this.close());
	}

	private async rename(id: string, name: string): Promise<void> {
		if (!name.trim()) return;
		await this.plugin.renamePortfolio(id, name);
		this.onChange?.();
	}

	private remove(id: string, name: string, folder: string): void {
		const portfolios = this.plugin.settings.portfolios ?? [];
		if (portfolios.length <= 1) {
			new Notice("You need at least one portfolio.");
			return;
		}
		new ConfirmDeletePortfolioModal(this.app, name, folder, (deleteData) => {
			void (async () => {
				await this.plugin.deletePortfolio(id, { deleteData });
				new Notice(deleteData ? `Removed "${name}" and moved its folder to trash` : `Removed "${name}" from your portfolio list`);
				this.render();
				this.onChange?.();
			})();
		}).open();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
