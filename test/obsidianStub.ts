/**
 * A minimal stand-in for the `obsidian` module under the test runner.
 *
 * Only the surface the testable modules actually touch is here: path normalization, the vault
 * adapter's file operations, and `requestUrl`. Everything else Obsidian exports (views, modals,
 * settings) belongs to UI code, which isn't what these tests are for.
 *
 * The adapter is a Map of path → contents, which is enough to exercise the whole ledger round-trip:
 * folders are implicit, writes overwrite, and reads of a missing file throw exactly as the real one
 * does.
 */

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

export class InMemoryAdapter {
	files = new Map<string, string>();
	folders = new Set<string>();

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.folders.has(path);
	}

	async mkdir(path: string): Promise<void> {
		this.folders.add(path);
	}

	async read(path: string): Promise<string> {
		const content = this.files.get(path);
		if (content === undefined) throw new Error(`ENOENT: ${path}`);
		return content;
	}

	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
		// Every parent directory of a written file exists, the way it would on a real filesystem.
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
	}

	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}

	/** Immediate children of `path`, split into files and folders — matches Obsidian's own shape. */
	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = path.endsWith("/") ? path : `${path}/`;
		const files = new Set<string>();
		const folders = new Set<string>();

		const classify = (candidate: string): void => {
			if (!candidate.startsWith(prefix)) return;
			const rest = candidate.slice(prefix.length);
			if (!rest) return;
			const slash = rest.indexOf("/");
			if (slash === -1) files.add(candidate);
			else folders.add(prefix + rest.slice(0, slash));
		};

		for (const file of this.files.keys()) classify(file);
		for (const folder of this.folders) {
			if (!folder.startsWith(prefix)) continue;
			const rest = folder.slice(prefix.length);
			if (!rest) continue;
			const slash = rest.indexOf("/");
			folders.add(prefix + (slash === -1 ? rest : rest.slice(0, slash)));
		}

		return { files: Array.from(files).sort(), folders: Array.from(folders).sort() };
	}
}

export class Vault {
	adapter = new InMemoryAdapter();
	getFiles(): unknown[] {
		return [];
	}
	getAbstractFileByPath(): unknown {
		return null;
	}
}

export class App {
	vault = new Vault();
}

/** Replaced per-test with vi.fn() where a test actually cares what was requested. */
export async function requestUrl(_options: { url: string }): Promise<{ json?: unknown; status: number; text: string }> {
	throw new Error("requestUrl is not stubbed for this test");
}

// --- Types and classes referenced only for their shape ----------------------

export class Plugin {}
export class PluginSettingTab {}
export class Modal {}
export class Setting {}
export class Notice {
	constructor(public message: string) {}
}
export class FuzzySuggestModal {}
export class ItemView {}
export class Menu {}
export const Platform = { isMobile: false };
export function setIcon(): void {
	/* no-op: icons are a rendering concern */
}
export type WorkspaceLeaf = unknown;
export type TFile = unknown;
export type MarkdownPostProcessorContext = unknown;
