import { App, Notice } from "obsidian";
import type FinancePlugin from "../main";
import type { Transaction } from "../types";
import { icon } from "./dom";
import { openAttachmentWizard } from "../wizards/AttachmentWizard";

/**
 * The attachment control for one transaction — attach, view, or clear a receipt/invoice. Re-renders
 * itself into `container` after any change.
 *
 * Viewing and attaching both go through the same popup (see AttachmentWizard) rather than
 * `openLinkText`, which would hand a receipt off to a newly-opened pane and leave whatever list this
 * control sits in — the ledger, the transaction's own detail modal — behind it.
 *
 * `compact` swaps the labelled buttons (used in the transaction detail modal) for icon-only ones sized
 * to sit inside a table cell — the ledger's own "File(s)" column, so a receipt can be opened or attached
 * without opening the transaction it belongs to first.
 */
export function renderAttachmentControl(
	container: HTMLElement,
	app: App,
	plugin: FinancePlugin,
	tx: Transaction,
	opts?: { compact?: boolean }
): void {
	container.empty();
	const store = plugin.store;
	const path = tx.attachmentPath;
	const refresh = (): void => renderAttachmentControl(container, app, plugin, tx, opts);
	const openPopup = (): void => openAttachmentWizard(plugin, tx, () => refresh());

	if (opts?.compact) {
		if (path) {
			const filename = path.split("/").pop() ?? path;
			const openBtn = container.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon fp-btn-tiny" });
			icon(openBtn, "file-text");
			openBtn.setAttribute("aria-label", `View ${filename}`);
			openBtn.setAttribute("title", filename);
			openBtn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				openPopup();
			});
		} else {
			const attachBtn = container.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon fp-btn-tiny" });
			icon(attachBtn, "paperclip");
			attachBtn.setAttribute("aria-label", "Attach a file");
			attachBtn.setAttribute("title", "Attach a file");
			attachBtn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				openPopup();
			});
		}
		return;
	}

	if (path) {
		const file = app.vault.getAbstractFileByPath(path);
		container.createSpan({ text: file ? path : `${path} (missing)`, cls: file ? undefined : "fp-sensitive" });

		const openBtn = container.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
		icon(openBtn, "external-link");
		openBtn.disabled = !file;
		openBtn.addEventListener("click", openPopup);

		const clearBtn = container.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
		icon(clearBtn, "x");
		clearBtn.addEventListener("click", async () => {
			await store.updateTransaction(tx.id, { attachmentPath: undefined });
			tx.attachmentPath = undefined;
			plugin.refreshViews();
			new Notice("Attachment removed");
			refresh();
		});
	} else {
		const attachBtn = container.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(attachBtn, "paperclip");
		attachBtn.createSpan({ text: "Attach file" });
		attachBtn.addEventListener("click", openPopup);
	}
}
