import { App } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { icon } from "../ui/dom";

/** Asks whether a removed portfolio's vault folder should be kept (just unlisted) or deleted (moved to trash) along with it. */
export class ConfirmDeletePortfolioModal extends FinanceModal {
	constructor(app: App, private portfolioName: string, private folder: string, private onChoice: (deleteData: boolean) => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		const c = this.contentEl;
		c.addClass("fp-account-modal");

		c.createEl("h3", { text: `Remove "${this.portfolioName}"?` });
		c.createEl("p", {
			cls: "fp-step-desc",
			text: `Its data lives in "${this.folder}/". You can keep that folder in your vault, or delete it (moved to trash, not permanently erased).`,
		});

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const cancel = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel" });
		cancel.addEventListener("click", () => this.close());

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const keepBtn = right.createEl("button", { cls: "fp-btn fp-btn-secondary", text: "Keep the folder" });
		keepBtn.addEventListener("click", () => {
			this.onChoice(false);
			this.close();
		});
		const deleteBtn = right.createEl("button", { cls: "fp-btn fp-btn-danger" });
		icon(deleteBtn, "trash-2");
		deleteBtn.createSpan({ text: "Delete the folder" });
		deleteBtn.addEventListener("click", () => {
			this.onChoice(true);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
