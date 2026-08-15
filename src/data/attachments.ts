import { normalizePath, type App } from "obsidian";
import { timestampSlug } from "./backup";

/** Vault-unsafe filename characters, replaced so the write never fails on a stray "/", ":" etc. carried over from the OS file picker. */
function sanitizeFilename(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "_");
}

/**
 * Copies a file picked from outside the vault (drag-and-drop or the OS file browser) into
 * `<dataFolder>/attachments/`, timestamped so two receipts both named "receipt.pdf" never collide.
 * Returns the vault-relative path written — ready to use as a transaction's attachmentPath.
 */
export async function writeAttachment(app: App, dataFolder: string, file: File): Promise<string> {
	const folder = normalizePath(`${dataFolder}/attachments`);
	const adapter = app.vault.adapter;
	if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
	const path = normalizePath(`${folder}/${timestampSlug()}-${sanitizeFilename(file.name)}`);
	await adapter.writeBinary(path, await file.arrayBuffer());
	return path;
}
