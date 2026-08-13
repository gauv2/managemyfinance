import { normalizePath, type App } from "obsidian";

/**
 * Writes a generated report into the vault as a real note.
 *
 * Reports go under `<dataFolder>/reports/`, the folder the store has been creating since the
 * beginning and never had anything to put in. Regenerating overwrites the same path rather than
 * accumulating timestamped copies: a report for August is a statement about August, and there should
 * be exactly one of it, always current. (Exports, which *are* point-in-time artifacts, keep their
 * timestamped filenames — see data/backup.ts.)
 */
export async function writeReportNote(app: App, dataFolder: string, fileName: string, content: string): Promise<string> {
	const folder = normalizePath(`${dataFolder}/reports`);
	const adapter = app.vault.adapter;
	if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
	const path = normalizePath(`${folder}/${fileName}.md`);
	await adapter.write(path, content);
	return path;
}

/** Opens a just-written report in a new tab, so generating one lands you in it. */
export async function openNote(app: App, path: string): Promise<void> {
	await app.workspace.openLinkText(path, "", true);
}
