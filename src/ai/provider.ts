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

	const provider = settings.provider ?? "api";
	const model = settings.model ?? DEFAULT_AI_MODEL;
	const userPrompt = buildUserPrompt(merchants, categories);

	const raw = provider === "cli" ? await callClaudeCli(userPrompt, settings) : await callAnthropicApi(userPrompt, model, settings);

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
async function callAnthropicApi(userPrompt: string, model: string, settings: AiSettings): Promise<string> {
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
			system: SYSTEM_PROMPT,
			// Classification from a short list of names is exactly the "short, scoped task" that low
			// effort is for; it keeps latency and token spend down without hurting the answer.
			output_config: {
				effort: "low",
				format: { type: "json_schema", schema: responseSchema() },
			},
			messages: [{ role: "user", content: userPrompt }],
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
async function callClaudeCli(userPrompt: string, settings: AiSettings): Promise<string> {
	if (!cliAvailable()) {
		throw new Error("The Claude CLI needs the desktop app — switch to the API key provider on mobile.");
	}

	// Required lazily and behind a guard: `child_process` doesn't exist in the mobile runtime, and a
	// top-level import would break loading the plugin there even for users who never enable this.
	let spawn: typeof import("child_process").spawn;
	try {
		spawn = (window as unknown as { require: (m: string) => typeof import("child_process") }).require("child_process").spawn;
	} catch {
		throw new Error("Couldn't reach Node's child_process — the Claude CLI provider isn't available here.");
	}

	const binary = (settings.cliPath ?? "").trim() || "claude";
	const prompt = `${SYSTEM_PROMPT}\n\n${userPrompt}`;

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
