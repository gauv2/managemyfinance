import { App, Modal, Notice } from "obsidian";
import { CARD_NETWORK_LABEL, CARD_TYPE_LABEL } from "../cards";
import type FinancePlugin from "../main";
import type { Card } from "../types";
import { renderCardVisual } from "../ui/cardVisual";
import { icon } from "../ui/dom";
import { openCardWizard } from "../wizards/CardWizard";

function row(container: HTMLElement, label: string, value: string): void {
	const r = container.createDiv({ cls: "fp-detail-row" });
	r.createDiv({ cls: "fp-detail-label", text: label });
	r.createDiv({ cls: "fp-detail-value", text: value });
}

/** A card's full detail, opened by clicking its tile — Edit/Delete live here instead of always-visible buttons on the tile. */
export class CardDetailModal extends Modal {
	constructor(app: App, private plugin: FinancePlugin, private card: Card, private accountName: string, private onChange?: () => void) {
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

		c.createDiv({ cls: "fp-card-tile-account", text: this.accountName.toUpperCase() });
		const previewWrap = c.createDiv({ cls: "fp-card-preview-wrap" });
		renderCardVisual(previewWrap, this.card);

		const body = c.createDiv({ cls: "fp-detail-body" });
		row(body, "Type", CARD_TYPE_LABEL[this.card.cardType]);
		row(body, "Network", CARD_NETWORK_LABEL[this.card.network]);
		if (this.card.notes) row(body, "Notes", this.card.notes);

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const deleteBtn = left.createEl("button", { cls: "fp-btn fp-btn-ghost" });
		icon(deleteBtn, "trash-2");
		deleteBtn.createSpan({ text: "Delete" });
		deleteBtn.addEventListener("click", () => void this.remove());

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const editBtn = right.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(editBtn, "pencil");
		editBtn.createSpan({ text: "Edit" });
		editBtn.addEventListener("click", () => {
			this.close();
			openCardWizard(this.plugin, { existing: this.card, onSaved: () => this.onChange?.() });
		});
		const closeBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(closeBtn, "check");
		closeBtn.createSpan({ text: "Close" });
		closeBtn.addEventListener("click", () => this.close());
	}

	private async remove(): Promise<void> {
		this.plugin.store.cards = this.plugin.store.cards.filter((c) => c.id !== this.card.id);
		await this.plugin.store.saveCards();
		new Notice(`Removed "${this.card.name}"`);
		this.onChange?.();
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
