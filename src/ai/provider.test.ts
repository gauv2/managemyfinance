import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { callModel } from "./provider";

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	// Desktop, so the CLI transport gets past its own platform guard and reaches the attachment check
	// this file is actually about.
	return { ...actual, requestUrl: vi.fn(), Platform: { isMobile: false, isDesktopApp: true } };
});

const mockRequest = vi.mocked(requestUrl);

/**
 * The shape of what goes down the wire, now that a request can carry a file.
 *
 * The first test is the one that matters most and looks the least interesting: the two passes that
 * existed before receipts did must still send a bare string, because a payload that silently became a
 * content-block array would be a transport change discovered in production rather than here.
 */
const settings = { apiKey: "sk-test", model: "claude-opus-5" };
const request = { system: "S", user: "U", schema: { type: "object" } };

function ok(text: string): unknown {
	return { status: 200, json: { content: [{ type: "text", text }] }, text };
}

function sentBody(): Record<string, unknown> {
	// requestUrl also accepts a bare URL string, which this code path never uses.
	const param = mockRequest.mock.calls[0][0] as { body?: string };
	return JSON.parse(param.body ?? "{}") as Record<string, unknown>;
}

beforeEach(() => mockRequest.mockReset());

describe("callModel over the API", () => {
	it("sends a plain string for a request with no file attached", async () => {
		mockRequest.mockResolvedValue(ok("{}") as never);

		await callModel(request, settings);

		expect(sentBody().messages).toEqual([{ role: "user", content: "U" }]);
	});

	it("sends a PDF as a document block ahead of the question", async () => {
		mockRequest.mockResolvedValue(ok("{}") as never);

		await callModel({ ...request, attachments: [{ mediaType: "application/pdf", data: "QUJD" }] }, settings);

		expect(sentBody().messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "QUJD" } },
					{ type: "text", text: "U" },
				],
			},
		]);
	});

	it("sends a photograph as an image block", async () => {
		mockRequest.mockResolvedValue(ok("{}") as never);

		await callModel({ ...request, attachments: [{ mediaType: "image/jpeg", data: "QUJD" }] }, settings);

		const content = (sentBody().messages as { content: { type: string }[] }[])[0].content;
		expect(content[0].type).toBe("image");
	});

	it("translates a rejected key into something worth reading", async () => {
		mockRequest.mockResolvedValue({ status: 401, text: "{}", json: {} } as never);

		await expect(callModel(request, settings)).rejects.toThrow(/API key was rejected/);
	});
});

describe("callModel over the CLI", () => {
	/**
	 * The CLI has no field for bytes, so a document reaches it as a path it opens for itself. These
	 * stand in for Node, which vitest has no `window.require` to reach.
	 */
	function stubNode() {
		const written: { file: string; bytes: Buffer }[] = [];
		const removed: string[] = [];
		let promptSeen = "";

		const child_process = {
			spawn: () => {
				const handlers: Record<string, (arg?: unknown) => void> = {};
				return {
					stdin: { write: (p: string) => (promptSeen = p), end: () => undefined },
					stdout: { on: (_e: string, cb: (c: Buffer) => void) => setTimeout(() => cb(Buffer.from("{}")), 0) },
					stderr: { on: () => undefined },
					on: (event: string, cb: (arg?: unknown) => void) => {
						handlers[event] = cb;
						if (event === "close") setTimeout(() => cb(0), 1);
					},
					kill: () => undefined,
				};
			},
		};
		const modules: Record<string, unknown> = {
			child_process,
			os: { tmpdir: () => "/tmp" },
			path: { join: (...p: string[]) => p.join("/") },
			"fs/promises": {
				mkdtemp: async (prefix: string) => `${prefix}XXXX`,
				writeFile: async (file: string, bytes: Buffer) => void written.push({ file, bytes }),
				rm: async (dir: string) => void removed.push(dir),
			},
		};
		// vitest runs in node, where there is no `window` at all — the transport reaches Node through
		// Obsidian's, so the test has to provide one for the lookup to find.
		const g = globalThis as unknown as { window?: { require: (m: string) => unknown } };
		g.window = { require: (m: string) => modules[m] };
		return { written, removed, prompt: () => promptSeen };
	}

	it("writes the document somewhere the CLI can open it, and names it in the prompt", async () => {
		const node = stubNode();

		await callModel({ ...request, attachments: [{ mediaType: "image/png", data: "QUJD" }] }, { provider: "cli" });

		expect(node.written).toHaveLength(1);
		// "QUJD" is base64 for "ABC" — the bytes must arrive decoded, not as the base64 text.
		expect(node.written[0].bytes.toString()).toBe("ABC");
		expect(node.written[0].file).toMatch(/\.png$/);
		expect(node.prompt()).toContain(node.written[0].file);
	});

	it("never leaves the document behind in the temp directory", async () => {
		const node = stubNode();

		await callModel({ ...request, attachments: [{ mediaType: "application/pdf", data: "QUJD" }] }, { provider: "cli" });

		// A receipt left in /tmp is a copy of a private document nobody asked for.
		expect(node.removed).toHaveLength(1);
	});

	it("still sends a bare prompt, and stages nothing, when there is no document", async () => {
		const node = stubNode();

		await callModel(request, { provider: "cli" });

		expect(node.written).toHaveLength(0);
		expect(node.prompt()).not.toContain("Read this file");
	});
});
