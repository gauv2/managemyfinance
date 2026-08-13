import { Notice } from "obsidian";

/**
 * PDF export, written straight to disk.
 *
 * This deliberately mirrors the mechanism the Food Spot and Are We There Yet plugins already use in
 * this vault, rather than inventing a third one. The approach that matters is the `<webview>` tag:
 * Electron gives it its own `printToPDF()`, so a document can be rendered and captured without
 * `@electron/remote`, without creating a BrowserWindow, and without the print dialog — which is the
 * difference between "opens a dialog you have to drive" and "there is a PDF on your disk now".
 *
 * The same renderer serves both callers. A person pressing Save as PDF gets a save dialog first; a
 * schedule firing at 9am on a Monday gets the bytes with no dialog at all, because there is nobody
 * there to answer one.
 */

/** A4 at 96dpi, so the CSS layout width is exactly the printed page width and nothing overflows. */
const PAGE_WIDTH = 794;
const PAGE_HEIGHT = 1123;

/** Time for fonts and layout to settle after the document reports itself loaded. */
const SETTLE_MS = 350;
/** A render that never finishes must not leave a promise hanging forever. */
const RENDER_TIMEOUT_MS = 20_000;

interface ElectronBits {
	showSaveDialog(opts: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<{ canceled: boolean; filePath?: string }>;
	writeFile(path: string, data: Uint8Array): void;
	tmpFile(name: string, content: string): string;
	removeFile(path: string): void;
	openPath?(path: string): void;
}

/**
 * Node and Electron, or null on mobile.
 *
 * Required lazily and behind a guard for the same reason the Claude CLI transport does it: these
 * modules don't exist in the mobile runtime, and a top-level import would break loading the plugin
 * there for everyone, including users who never export a PDF.
 */
function electronBits(): ElectronBits | null {
	const req = (globalThis as unknown as { require?: (m: string) => unknown }).require;
	if (typeof req !== "function") return null;
	try {
		const el = req("electron") as { remote?: { dialog?: unknown; shell?: { openPath(p: string): void } } };
		const fs = req("fs") as { writeFileSync(p: string, d: Uint8Array | string): void; unlinkSync(p: string): void };
		const os = req("os") as { tmpdir(): string };
		const path = req("path") as { join(...parts: string[]): string };
		const dialog = el.remote?.dialog as { showSaveDialog(o: unknown): Promise<{ canceled: boolean; filePath?: string }> } | undefined;
		if (!dialog || !fs || !os) return null;

		return {
			showSaveDialog: (opts) => dialog.showSaveDialog(opts),
			writeFile: (p, d) => fs.writeFileSync(p, d),
			tmpFile: (name, content) => {
				// The OS temp directory, not the vault: a half-written render file has no business
				// syncing to every other device before it gets cleaned up.
				const target = path.join(os.tmpdir(), name);
				fs.writeFileSync(target, content);
				return target;
			},
			removeFile: (p) => fs.unlinkSync(p),
			openPath: el.remote?.shell ? (p: string) => el.remote?.shell?.openPath(p) : undefined,
		};
	} catch {
		return null;
	}
}

export function canExportPdf(): boolean {
	return electronBits() !== null;
}

/** Electron's webview tag — an HTMLElement that owns a whole renderer, and with it printToPDF. */
interface WebviewTag extends HTMLElement {
	src: string;
	printToPDF(options: Record<string, unknown>): Promise<Uint8Array | ArrayBuffer>;
}

/**
 * Renders HTML into PDF bytes. No dialog, no user involvement — this is the part a schedule uses.
 *
 * The document goes through a temp file rather than a `data:` URL: Chromium blocks top-level
 * navigation to `data:`, and the URL length limit would clip a long report silently, producing a
 * truncated PDF that still looks like a PDF.
 */
export async function renderHtmlToPdf(html: string, namePrefix = "finance"): Promise<Uint8Array> {
	const bits = electronBits();
	if (!bits) throw new Error("PDF rendering needs the desktop app.");

	const tmpPath = bits.tmpFile(`${namePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`, html);

	const view = document.createElement("webview") as WebviewTag;
	view.setAttribute("nodeintegration", "false");
	view.style.cssText = `position:fixed;left:-10000px;top:0;width:${PAGE_WIDTH}px;height:${PAGE_HEIGHT}px;opacity:0;pointer-events:none;`;
	view.src = `file://${tmpPath}`;

	return new Promise<Uint8Array>((resolve, reject) => {
		let settled = false;
		let timeoutId = 0;

		const cleanup = (): void => {
			window.clearTimeout(timeoutId);
			view.remove();
			try {
				bits.removeFile(tmpPath);
			} catch {
				// A leftover file in the OS temp directory is not worth failing an export over.
			}
		};
		const fail = (message: string): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(message));
		};

		view.addEventListener(
			"did-finish-load",
			() => {
				window.setTimeout(() => {
					void (async () => {
						try {
							const data = await view.printToPDF({
								pageSize: "A4",
								printBackground: true,
								// Margins live in the document's own @page padding — see PRINT_CSS.
								margins: { marginType: "none" },
							});
							if (settled) return;
							settled = true;
							const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
							cleanup();
							resolve(bytes);
						} catch (e) {
							fail(`Couldn't render the PDF — ${e instanceof Error ? e.message : String(e)}`);
						}
					})();
				}, SETTLE_MS);
			},
			{ once: true }
		);
		view.addEventListener("did-fail-load", () => fail("The report couldn't be rendered for PDF export."), { once: true });
		timeoutId = window.setTimeout(() => fail("PDF export timed out."), RENDER_TIMEOUT_MS);

		document.body.appendChild(view);
	});
}

export type PdfExportStatus = "saved" | "cancelled" | "failed" | "unsupported";

/**
 * Asks where to put it, renders, writes it, and opens it.
 *
 * The save dialog comes *first*, before any rendering: cancelling should cost nothing, and a
 * twenty-second render that ends in "actually, no" is worse than no export at all.
 */
export async function exportHtmlToPdf(html: string, suggestedName: string): Promise<PdfExportStatus> {
	const bits = electronBits();
	if (!bits) {
		new Notice("Saving a PDF needs the desktop app. On mobile, write the report into your vault as a note instead.");
		return "unsupported";
	}

	let chosen: { canceled: boolean; filePath?: string };
	try {
		chosen = await bits.showSaveDialog({ defaultPath: suggestedName, filters: [{ name: "PDF", extensions: ["pdf"] }] });
	} catch (e) {
		new Notice(`Couldn't open the save dialog — ${e instanceof Error ? e.message : String(e)}`);
		return "failed";
	}
	if (chosen.canceled || !chosen.filePath) return "cancelled";
	const target = chosen.filePath;

	try {
		const bytes = await renderHtmlToPdf(html, "finance-report");
		bits.writeFile(target, bytes);
		new Notice(`PDF saved to ${target}`, 8000);
		bits.openPath?.(target);
		return "saved";
	} catch (e) {
		new Notice(`Couldn't write the PDF — ${e instanceof Error ? e.message : String(e)}`, 10000);
		return "failed";
	}
}
