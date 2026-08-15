import { normalizePath, type App } from "obsidian";
import { timestampSlug } from "./backup";

/** Vault-unsafe filename characters, replaced so the write never fails on a stray "/", ":" etc. carried over from the OS file picker. */
function sanitizeFilename(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "_");
}

/**
 * Where receipts and invoices are written, vault-relative.
 *
 * Defaults to `<dataFolder>/attachments` so the plugin keeps everything it owns in one place, but a
 * vault that already has an attachments convention can point this anywhere — receipts are the one
 * thing here a person also opens outside the plugin, so forcing them into our folder is our
 * preference, not theirs.
 *
 * Only ever consulted when writing something new. A transaction stores the full vault path it was
 * given, so moving this setting later leaves every existing attachment exactly where it is and still
 * linked; it does not relocate anything, and nothing breaks.
 */
export function attachmentFolderOf(settings: { dataFolder: string; attachmentFolder?: string }): string {
	const custom = settings.attachmentFolder?.trim();
	return normalizePath(custom ? custom : `${settings.dataFolder}/attachments`);
}

/**
 * Copies a file picked from outside the vault (drag-and-drop or the OS file browser) into the
 * attachment folder, timestamped so two receipts both named "receipt.pdf" never collide.
 * Returns the vault-relative path written — ready to use as a transaction's attachmentPath.
 */
export async function writeAttachment(app: App, settings: { dataFolder: string; attachmentFolder?: string }, file: File): Promise<string> {
	const folder = attachmentFolderOf(settings);
	const adapter = app.vault.adapter;
	// A custom folder can be nested several levels deep and mkdir does not create parents, so walk it.
	let built = "";
	for (const part of folder.split("/")) {
		built = built ? `${built}/${part}` : part;
		if (!(await adapter.exists(built))) await adapter.mkdir(built);
	}
	const path = normalizePath(`${folder}/${timestampSlug()}-${sanitizeFilename(file.name)}`);
	await adapter.writeBinary(path, await file.arrayBuffer());
	return path;
}
