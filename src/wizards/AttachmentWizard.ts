import { App, FuzzySuggestModal, Notice, TFile } from "obsidian";
import { writeAttachment } from "../data/attachments";
import type FinancePlugin from "../main";
import type { Transaction } from "../types";
import { icon } from "../ui/dom";
import { WizardModal, WizardStep } from "./WizardModal";

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

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

function extensionOf(path: string): string {
	return path.split(".").pop()?.toLowerCase() ?? "";
}

/**
 * Shows the current attachment in place — a PDF or image renders right in the popup, so checking a
 * receipt doesn't mean losing the ledger row it belongs to behind a newly-opened pane. Anything else
 * (docx, heic, …) falls back to a link that opens it the normal Obsidian way, since there's no way to
 * preview it inline anyway.
 */
function renderAttachmentPreview(container: HTMLElement, app: App, path: string): void {
	const file = app.vault.getAbstractFileByPath(path);
	const filename = path.split("/").pop() ?? path;

	if (!(file instanceof TFile)) {
		container.createDiv({ cls: "fp-step-desc", text: `${filename} (missing from the vault)` });
		return;
	}

	const ext = extensionOf(path);
	const resourcePath = app.vault.getResourcePath(file);

	if (ext === "pdf") {
		container.createEl("iframe", { cls: "fp-attachment-preview-pdf", attr: { src: resourcePath } });
	} else if (IMAGE_EXTENSIONS.has(ext)) {
		container.createEl("img", { cls: "fp-attachment-preview-image", attr: { src: resourcePath, alt: filename } });
	} else {
		const fallback = container.createDiv({ cls: "fp-step-desc" });
		fallback.setText(`${filename} — no inline preview for this file type. `);
		const openLink = fallback.createEl("a", { text: "Open it in a new pane" });
		openLink.addEventListener("click", (ev) => {
			ev.preventDefault();
			void app.workspace.openLinkText(path, "", true);
		});
	}
}

/**
 * Attach a receipt or invoice to a transaction, or check the one already linked — one popup for both,
 * so viewing a receipt never has to leave the ledger it belongs to behind a newly-opened pane. A file
 * already attached previews inline (PDF/image) above the dropzone; dropping or picking a new one there
 * replaces it. A secondary action still covers the other case — a document already somewhere in the
 * vault — without duplicating it.
 */
export function openAttachmentWizard(plugin: FinancePlugin, tx: Transaction, onAttached?: (path: string) => void): void {
	let pickedFile: File | undefined;

	const steps: WizardStep[] = [
		{
			id: "file",
			title: "File",
			icon: "paperclip",
			render: (c, wizard) => {
				const currentPath = tx.attachmentPath;
				c.createEl("h3", { text: currentPath ? "Attachment" : "Attach a receipt or invoice" });

				if (currentPath) {
					const currentRow = c.createDiv({ cls: "fp-attachment-current" });
					const currentHead = currentRow.createDiv({ cls: "fp-attachment-current-head" });
					currentHead.createSpan({ text: currentPath.split("/").pop() ?? currentPath });
					const removeBtn = currentHead.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon fp-btn-tiny" });
					icon(removeBtn, "x");
					removeBtn.setAttribute("aria-label", "Remove attachment");
					removeBtn.addEventListener("click", async () => {
						await plugin.store.updateTransaction(tx.id, { attachmentPath: undefined });
						tx.attachmentPath = undefined;
						plugin.refreshViews();
						new Notice("Attachment removed");
						refresh();
					});
					renderAttachmentPreview(currentRow, plugin.app, currentPath);

					c.createEl("p", { cls: "fp-step-desc", text: "Drop a new file below, or pick one, to replace it." });
				} else {
					c.createEl("p", {
						cls: "fp-step-desc",
						text: "Drag a file here, or click to browse — it's copied into the vault and linked to this transaction.",
					});
				}

				const dropzone = c.createDiv({ cls: "fp-dropzone" + (pickedFile ? " has-file" : "") });
				icon(dropzone, pickedFile ? "file-check-2" : "upload", "fp-dropzone-icon");
				dropzone.createDiv({ cls: "fp-dropzone-text", text: pickedFile?.name ?? "Drop a file here" });
				dropzone.createDiv({
					cls: "fp-dropzone-subtext",
					text: pickedFile ? "Click, or drop another file, to replace it" : "or click to browse",
				});

				const fileInput = c.createEl("input", { cls: "fp-file-input-hidden", attr: { type: "file" } });

				function handle(file: File): void {
					pickedFile = file;
					refresh();
				}

				dropzone.addEventListener("click", () => fileInput.click());
				fileInput.addEventListener("change", () => {
					const file = fileInput.files?.[0];
					if (file) handle(file);
				});
				dropzone.addEventListener("dragover", (ev) => {
					ev.preventDefault();
					dropzone.addClass("is-dragover");
				});
				dropzone.addEventListener("dragleave", () => dropzone.removeClass("is-dragover"));
				dropzone.addEventListener("drop", (ev) => {
					ev.preventDefault();
					dropzone.removeClass("is-dragover");
					const file = ev.dataTransfer?.files?.[0];
					if (file) handle(file);
				});

				const altRow = c.createDiv({ cls: "fp-attachment-alt-row" });
				const linkBtn = altRow.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-tiny" });
				icon(linkBtn, "link");
				linkBtn.createSpan({ text: "Or link a file already in the vault" });
				linkBtn.addEventListener("click", () => {
					new VaultFileSuggestModal(plugin.app, async (file) => {
						await plugin.store.updateTransaction(tx.id, { attachmentPath: file.path });
						tx.attachmentPath = file.path;
						plugin.refreshViews();
						new Notice(`Linked "${file.path}"`);
						onAttached?.(file.path);
						refresh();
					}).open();
				});

				function refresh(): void {
					c.empty();
					void steps[0].render(c, wizard);
					wizard.refreshFooter();
				}
			},
			canGoNext: () => !!pickedFile,
			nextLabel: "Attach",
			blockedReason: () => (tx.attachmentPath ? undefined : "Pick or drop a file first"),
			onNext: async () => {
				if (!pickedFile) return;
				try {
					const path = await writeAttachment(plugin.app, plugin.settings, pickedFile);
					await plugin.store.updateTransaction(tx.id, { attachmentPath: path });
					plugin.refreshViews();
					new Notice(`Attached "${pickedFile.name}"`);
					onAttached?.(path);
				} catch (err) {
					new Notice(`Couldn't save the attachment: ${err instanceof Error ? err.message : String(err)}`, 12000);
					throw err;
				}
			},
		},
	];

	new WizardModal(plugin.app, {
		title: tx.attachmentPath ? "Attachment" : "Attach a file",
		subtitle: "Copied into the vault and linked to this transaction.",
		icon: "paperclip",
		steps,
	}).open();
}
