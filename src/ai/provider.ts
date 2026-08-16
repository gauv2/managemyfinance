import { Platform, requestUrl } from "obsidian";
import type { Category } from "../types";
import { buildUserPrompt, extractJson, type MerchantRequest, responseSchema, SYSTEM_PROMPT, validateAssignments, type ValidationResult } from "./prompt";

/** Which way a request reaches Claude. */
export type AiProviderId = "api" | "cli";

export interface AiSettings {
	enabled?: boolean;
	provider?: AiProviderId;
	/** Stored in this vault's plugin data.json, in plain text — the settings panel says so. */
	apiKey?: string;
	model?: string;
	/** Absolute path to the `claude` binary. Empty means "look on PATH". */
	cliPath?: string;
	/** Answers at or above this apply on their own; below it they're parked for review. */
	confidenceThreshold?: number;
	/** Run the AI pass automatically during import instead of waiting for the button. Off by default:
	 *  an import shouldn't make a network request you didn't ask for. */
	autoOnImport?: boolean;
	/** Apply answers that fall below the confidence bar as well, marking them flagged rather than
	 *  holding them back for approval. On by default — an uncategorized row is worse than a
	 *  categorized-but-flagged one, because only the flagged one is findable later. */
	applyLowConfidence?: boolean;
}

export const DEFAULT_AI_MODEL = "claude-opus-5";

export const AI_MODELS: { id: string; label: string }[] = [
	{ id: "claude-opus-5", label: "Claude Opus 5 — most capable" },
	{ id: "claude-sonnet-5", label: "Claude Sonnet 5 — faster, cheaper" },
	{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — cheapest" },
];

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

/** The Claude CLI needs to spawn a subprocess, which only exists in the desktop app. */
export function cliAvailable(): boolean {
	return Platform.isDesktopApp;
}

export interface ClassifyResult extends ValidationResult {
	model: string;
	provider: AiProviderId;
}

/**
 * One question for the model: what it is, what to answer, and the shape the answer must take.
 *
 * Both AI passes — classifying merchants into categories, and deciding whether two merchant names are
 * the same payee — are the same request with different words in it. Threading the prompt through as a
 * value rather than baking it into the transport means the second pass reuses the API path, the CLI
 * path, the error translation and the timeout, instead of growing a parallel copy of all four.
 */
export interface ModelRequest {
	system: string;
	user: string;
	/** JSON Schema for the API's structured-output mode. The CLI has none; extractJson covers it. */
	schema: Record<string, unknown>;
	/**
	 * Files to show the model alongside the question — a receipt whose text nothing local could read.
	 *
	 * The two transports carry these very differently. The API takes them inline as base64 content
	 * blocks. The CLI has no such field — it is one string down stdin — but the tool on the other end
	 * can open a file for itself, so the file is written to a temporary path and named in the prompt,
	 * then deleted. Neither path asks the model to identify a receipt it was never shown.
	 */
	attachments?: ModelAttachment[];
}

export interface ModelAttachment {
	/** MIME type — "application/pdf", "image/png", "image/jpeg". */
	mediaType: string;
	/** Base64, without the `data:` prefix. */
	data: string;
	/** Only for error messages, never sent. */
	filename?: string;
}

/** Sends one request down whichever transport is configured and returns the raw reply text. */
export async function callModel(request: ModelRequest, settings: AiSettings): Promise<{ raw: string; model: string; provider: AiProviderId }> {
	const provider = settings.provider ?? "api";
	const model = settings.model ?? DEFAULT_AI_MODEL;
	const raw = provider === "cli" ? await callClaudeCli(request, settings) : await callAnthropicApi(request, model, settings);
	return { raw, model, provider };
}

/**
 * Sends one batch of merchant names for classification.
 *
 * Only the merchant strings and your category tree go over the wire — no amounts, dates, account
 * names, IBANs or balances. `buildUserPrompt` is a pure function, so the settings panel can render
 * the exact payload before anything is sent, and a test can assert what isn't in it.
 */
export async function classifyMerchants(
	merchants: (string | MerchantRequest)[],
	categories: Category[],
	settings: AiSettings
): Promise<ClassifyResult> {
	if (merchants.length === 0) {
		return { assignments: [], rejected: [], model: settings.model ?? DEFAULT_AI_MODEL, provider: settings.provider ?? "api" };
	}

	const { raw, model, provider } = await callModel(
		{ system: SYSTEM_PROMPT, user: buildUserPrompt(merchants, categories), schema: responseSchema() },
		settings
	);

	const validated = validateAssignments(extractJson(raw), merchants, categories);
	return { ...validated, model, provider };
}

/**
 * The Anthropic Messages API over Obsidian's own `requestUrl`.
 *
 * `requestUrl` rather than the Anthropic SDK deliberately: Obsidian plugins run in a renderer where
 * a direct `fetch` to api.anthropic.com is a cross-origin request, `requestUrl` is the API Obsidian
 * provides to avoid that, it is the only HTTP path that works unchanged on mobile (this plugin is
 * not desktop-only), and it keeps the SDK's bundle out of a plugin that currently ships ~280 KB
 * total. The existing exchange-rate fetch in fx.ts uses the same call for the same reasons.
 */
async function callAnthropicApi(request: ModelRequest, model: string, settings: AiSettings): Promise<string> {
	const apiKey = (settings.apiKey ?? "").trim();
	if (!apiKey) throw new Error("No Claude API key set — add one in Settings → AI.");

	const response = await requestUrl({
		url: "https://api.anthropic.com/v1/messages",
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		// Obsidian's requestUrl rejects non-2xx by default; handling it ourselves turns Anthropic's
		// own error body (bad key, rate limit) into a message worth showing instead of a bare status.
		throw: false,
		body: JSON.stringify({
			model,
			max_tokens: 8000,
			system: request.system,
			// Judging a short list of names is exactly the "short, scoped task" that low effort is for;
			// it keeps latency and token spend down without hurting the answer.
			output_config: {
				effort: "low",
				format: { type: "json_schema", schema: request.schema },
			},
			messages: [{ role: "user", content: userContent(request) }],
		}),
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(describeApiError(response.status, response.text));
	}

	const body = response.json as {
		content?: { type: string; text?: string }[];
		stop_reason?: string;
	};

	// A safety classifier can decline with a normal 200 and an empty content array; reading
	// content[0] without checking would surface as an unrelated "cannot read property" error.
	if (body?.stop_reason === "refusal") {
		throw new Error("Claude declined to answer this request. Nothing was categorized.");
	}

	const text = (body?.content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
	if (!text) throw new Error("Claude returned an empty response.");
	return text;
}

/**
 * The user turn, as a plain string when there is nothing but words and as content blocks when there
 * is a file to show.
 *
 * Kept conditional rather than always sending blocks so the two existing passes' payloads are
 * byte-for-byte what they were before receipts existed — a categorization request is not the place to
 * discover a transport change.
 *
 * The document comes before the question: a model reading a receipt does better when it has seen the
 * receipt before it is told what to look for, and this is the order Anthropic's own guidance gives.
 */
function userContent(request: ModelRequest): unknown {
	if (!request.attachments?.length) return request.user;
	return [
		...request.attachments.map((attachment) => ({
			type: attachment.mediaType === "application/pdf" ? "document" : "image",
			source: { type: "base64", media_type: attachment.mediaType, data: attachment.data },
		})),
		{ type: "text", text: request.user },
	];
}

function describeApiError(status: number, text: string): string {
	let detail = "";
	try {
		detail = (JSON.parse(text) as { error?: { message?: string } })?.error?.message ?? "";
	} catch {
		detail = text.slice(0, 200);
	}
	switch (status) {
		case 401:
			return "That API key was rejected. Check it in Settings → AI.";
		case 403:
			return `That API key isn't allowed to use this model. ${detail}`;
		case 429:
			return "Rate limited by the Claude API — wait a moment and try again.";
		case 529:
			return "The Claude API is overloaded right now — try again shortly.";
		default:
			return `Claude API error ${status}${detail ? `: ${detail}` : ""}`;
	}
}

/**
 * The Claude Code CLI in print mode, so the work rides an existing Max subscription instead of
 * per-token API billing.
 *
 * Desktop only, and structurally so: it spawns a subprocess, which the mobile app has no ability to
 * do. There is also no structured-output mode here, which is why the reply goes through
 * extractJson() — the CLI happily wraps its answer in a code fence or a sentence of preamble.
 */
async function callClaudeCli(request: ModelRequest, settings: AiSettings): Promise<string> {
	if (!cliAvailable()) {
		throw new Error("The Claude CLI needs the desktop app — switch to the API key provider on mobile.");
	}
	const binary = (settings.cliPath ?? "").trim() || "claude";

	// The CLI cannot be handed bytes, but it can open a path. Writing the document to the OS temp
	// directory and naming it in the prompt is the only way to show it a receipt at all — and it stays
	// outside the vault throughout, so a document the user has not confirmed never lands in their notes.
	const staged = await stageAttachments(request.attachments);
	const prompt = staged.paths.length
		? `${request.system}\n\nRead ${staged.paths.length === 1 ? "this file" : "these files"} before answering: ${staged.paths.join(", ")}\n\n${request.user}`
		: `${request.system}\n\n${request.user}`;

	try {
		return await runCli(binary, prompt);
	} finally {
		// Deleted whatever happened. A receipt left in /tmp is a copy the user never asked for.
		await staged.cleanup();
	}
}

/** A document the CLI can open, written outside the vault and removed as soon as the call returns. */
async function stageAttachments(attachments: ModelAttachment[] | undefined): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
	if (!attachments?.length) return { paths: [], cleanup: async () => undefined };

	let fs: typeof import("fs/promises");
	let os: typeof import("os");
	let path: typeof import("path");
	try {
		const req = (window as unknown as { require: (m: string) => unknown }).require;
		fs = req("fs/promises") as typeof import("fs/promises");
		os = req("os") as typeof import("os");
		path = req("path") as typeof import("path");
	} catch {
		throw new Error("Couldn't reach Node's filesystem — the Claude CLI provider can't read documents here.");
	}

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mmf-receipt-"));
	const paths: string[] = [];
	for (const [i, attachment] of attachments.entries()) {
		// The original filename is not reused: it can carry anything the OS allowed, and the model is
		// being asked to read the contents, not to be told what the file was called.
		const file = path.join(dir, `document-${i + 1}${EXTENSIONS[attachment.mediaType] ?? ""}`);
		await fs.writeFile(file, Buffer.from(attachment.data, "base64"));
		paths.push(file);
	}
	return {
		paths,
		cleanup: async () => {
			try {
				await fs.rm(dir, { recursive: true, force: true });
			} catch {
				// A temp file we could not remove is not worth failing the user's match over.
			}
		},
	};
}

const EXTENSIONS: Record<string, string> = {
	"application/pdf": ".pdf",
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/heic": ".heic",
};

function runCli(binary: string, prompt: string): Promise<string> {
	let spawn: typeof import("child_process").spawn;
	try {
		spawn = (window as unknown as { require: (m: string) => typeof import("child_process") }).require("child_process").spawn;
	} catch {
		throw new Error("Couldn't reach Node's child_process — the Claude CLI provider isn't available here.");
	}

	return new Promise<string>((resolve, reject) => {
		const child = spawn(binary, ["-p", "--output-format", "text"], {
			stdio: ["pipe", "pipe", "pipe"],
			// Inherit the user's environment so the CLI finds its own credentials, exactly as it
			// would if they ran it in a terminal themselves.
			env: process.env,
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		// A CLI that never answers would otherwise hang the whole categorize action with no way out.
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new Error("The Claude CLI didn't respond within 3 minutes."));
		}, 180_000);

		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

		child.on("error", (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(
				new Error(
					`Couldn't run "${binary}". Set the full path to the claude binary in Settings → AI. (${err.message})`
				)
			);
		});

		child.on("close", (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (code !== 0) {
				reject(new Error(`The Claude CLI exited with code ${code}. ${stderr.trim().slice(0, 300)}`));
				return;
			}
			if (!stdout.trim()) {
				reject(new Error("The Claude CLI returned nothing."));
				return;
			}
			resolve(stdout);
		});

		child.stdin.write(prompt);
		child.stdin.end();
	});
}

/** A cheap round-trip that proves the configured provider actually works, for the settings Test button. */
export async function testProvider(settings: AiSettings, categories: Category[]): Promise<string> {
	const probe = categories.find((c) => c.name === "Food") ? "albert heijn" : "netflix";
	const result = await classifyMerchants([probe], categories, settings);
	const hit = result.assignments[0];
	if (!hit) return `Connected to ${result.model}, but it had no answer for "${probe}".`;
	const name = categories.find((c) => c.id === hit.categoryId)?.name ?? hit.categoryId;
	return `Connected. ${result.model} filed "${probe}" as ${name} (${Math.round(hit.confidence * 100)}% sure).`;
}
