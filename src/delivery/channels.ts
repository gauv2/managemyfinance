import { requestUrl } from "obsidian";
import { buildMultipart, randomBoundary, toBase64 } from "./encoding";

/**
 * The two ways a report leaves the vault.
 *
 * Both go through Obsidian's `requestUrl` rather than `fetch`, for the same reasons the AI provider
 * and the exchange-rate fetch do: a plugin runs in a renderer where a direct call to another origin
 * is cross-origin, and `requestUrl` is the API Obsidian provides to avoid that. It is also the only
 * HTTP path that works unchanged on mobile.
 *
 * Every function here returns a result rather than throwing, because a delivery with two channels
 * must be able to report "Telegram sent, email failed" — an exception would collapse that into a
 * single failure and lose the half that worked.
 */

export interface Attachment {
	filename: string;
	contentType: string;
	data: Uint8Array;
}

export interface ChannelResult {
	channel: "email" | "telegram";
	ok: boolean;
	/** Shown verbatim in the delivery log, so it has to read as an explanation, not a status code. */
	detail: string;
}

export interface EmailSettings {
	/** Resend API key. Stored in this vault's plugin data.json in plain text; the panel says so. */
	apiKey?: string;
	/** Verified sender, e.g. "Finance <reports@yourdomain.com>". */
	from?: string;
	/** Where the settings panel's test report goes. Remembered so it isn't retyped every attempt. */
	testRecipient?: string;
}

/** What the settings panel's test button sends. Remembered so the choice isn't re-made every time. */
export interface TestDeliverySettings {
	cadence?: "monthly" | "quarterly" | "yearly";
	detail?: "summary" | "standard" | "full";
}

export interface TelegramSettings {
	botToken?: string;
	chatId?: string;
}

/** Attachment ceiling for one email. Resend's own limit is 40MB total; this stays well under it. */
const EMAIL_ATTACHMENT_LIMIT = 20 * 1024 * 1024;
/** Telegram's documented limit for a bot uploading a document. */
const TELEGRAM_DOCUMENT_LIMIT = 50 * 1024 * 1024;

function totalBytes(attachments: Attachment[]): number {
	return attachments.reduce((sum, a) => sum + a.data.length, 0);
}

function humanSize(bytes: number): string {
	return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Email (Resend) ─────────────────────────────────────────────────────────────────────────────

export async function sendEmail(
	settings: EmailSettings,
	message: { to: string[]; subject: string; html: string; attachments: Attachment[] }
): Promise<ChannelResult> {
	const apiKey = (settings.apiKey ?? "").trim();
	const from = (settings.from ?? "").trim();

	if (!apiKey) return { channel: "email", ok: false, detail: "No Resend API key set — add one in Vault settings → Scheduled reports." };
	if (!from) return { channel: "email", ok: false, detail: "No sender address set. Resend requires a verified domain." };
	if (message.to.length === 0) return { channel: "email", ok: false, detail: "No recipients on this schedule." };

	const size = totalBytes(message.attachments);
	if (size > EMAIL_ATTACHMENT_LIMIT) {
		return {
			channel: "email",
			ok: false,
			detail: `Attachments total ${humanSize(size)}, over the ${humanSize(EMAIL_ATTACHMENT_LIMIT)} limit. Narrow the report's filters or drop an attachment format.`,
		};
	}

	try {
		const response = await requestUrl({
			url: "https://api.resend.com/emails",
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
			// Handled here rather than thrown, so Resend's own error text reaches the delivery log
			// instead of a bare status nobody can act on.
			throw: false,
			body: JSON.stringify({
				from,
				to: message.to,
				subject: message.subject,
				html: message.html,
				attachments: message.attachments.map((a) => ({ filename: a.filename, content: toBase64(a.data) })),
			}),
		});

		if (response.status < 200 || response.status >= 300) {
			return { channel: "email", ok: false, detail: describeEmailError(response.status, response.text) };
		}
		return {
			channel: "email",
			ok: true,
			detail: `Sent to ${message.to.length} recipient${message.to.length === 1 ? "" : "s"} (${humanSize(size)} attached)`,
		};
	} catch (e) {
		const message = withoutSecrets(e instanceof Error ? e.message : String(e), apiKey);
		return { channel: "email", ok: false, detail: `Couldn't reach Resend: ${message}` };
	}
}

/**
 * An error message with the credential taken out of it.
 *
 * Telegram's API carries the bot token in the URL path, and a network failure inside `requestUrl`
 * produces an error whose message quotes the URL it was trying to reach. That message was passed
 * straight back to the user as the failure detail, so a DNS hiccup was enough to print a live bot
 * token on screen — into a Notice, a delivery log, or a screenshot. The key never appears in a
 * *successful* response, only in the one path nobody looks at until it fires.
 *
 * Redacts by value rather than by pattern: the exact secret is known here, and matching on shape
 * would keep missing whichever shape the next provider uses.
 */
function withoutSecrets(text: string, ...secrets: (string | undefined)[]): string {
	let safe = text;
	for (const secret of secrets) {
		// A short or empty "secret" would redact half the message; below this it isn't a credential.
		if (secret && secret.length >= 8) safe = safe.split(secret).join("[redacted]");
	}
	return safe;
}

function describeEmailError(status: number, text: string): string {
	let detail = "";
	try {
		detail = (JSON.parse(text) as { message?: string; error?: string })?.message ?? "";
	} catch {
		detail = text.slice(0, 200);
	}
	switch (status) {
		case 401:
		case 403:
			return "Resend rejected that API key. Check it in Vault settings → Scheduled reports.";
		case 422:
			return `Resend refused the message${detail ? `: ${detail}` : ""}. The sender domain usually has to be verified first.`;
		case 429:
			return "Rate limited by Resend — the next scheduled run will try again.";
		default:
			return `Resend error ${status}${detail ? `: ${detail}` : ""}`;
	}
}

// ─── Telegram ───────────────────────────────────────────────────────────────────────────────────

/**
 * Sends the summary as a message, then each attachment as a document.
 *
 * One call per file because Telegram's sendDocument takes exactly one; sendMediaGroup could batch
 * them but reports the whole group as failed if any single item is rejected, which would lose a
 * successfully-generated PDF over a rejected CSV.
 */
export async function sendTelegram(
	settings: TelegramSettings,
	message: { text: string; attachments: Attachment[] }
): Promise<ChannelResult> {
	const token = (settings.botToken ?? "").trim();
	const chatId = (settings.chatId ?? "").trim();

	if (!token) return { channel: "telegram", ok: false, detail: "No Telegram bot token set — add one in Vault settings → Scheduled reports." };
	if (!chatId) return { channel: "telegram", ok: false, detail: "No Telegram chat id set." };

	const oversized = message.attachments.filter((a) => a.data.length > TELEGRAM_DOCUMENT_LIMIT);
	if (oversized.length > 0) {
		return {
			channel: "telegram",
			ok: false,
			detail: `${oversized[0].filename} is ${humanSize(oversized[0].data.length)}, over Telegram's ${humanSize(TELEGRAM_DOCUMENT_LIMIT)} limit.`,
		};
	}

	try {
		const sentText = await telegramCall(token, "sendMessage", [
			{ name: "chat_id", value: chatId },
			{ name: "text", value: message.text },
			{ name: "parse_mode", value: "HTML" },
		]);
		if (!sentText.ok) return { channel: "telegram", ok: false, detail: sentText.detail };

		for (const attachment of message.attachments) {
			const sentDoc = await telegramCall(token, "sendDocument", [
				{ name: "chat_id", value: chatId },
				{ name: "document", data: attachment.data, filename: attachment.filename, contentType: attachment.contentType },
			]);
			// Reported by name: "the PDF went, the spreadsheet didn't" is actionable, "failed" isn't.
			if (!sentDoc.ok) return { channel: "telegram", ok: false, detail: `${attachment.filename}: ${sentDoc.detail}` };
		}

		const count = message.attachments.length;
		return { channel: "telegram", ok: true, detail: count === 0 ? "Message sent" : `Sent with ${count} file${count === 1 ? "" : "s"}` };
	} catch (e) {
		const message = withoutSecrets(e instanceof Error ? e.message : String(e), token);
		return { channel: "telegram", ok: false, detail: `Couldn't reach Telegram: ${message}` };
	}
}

async function telegramCall(
	token: string,
	method: string,
	fields: Parameters<typeof buildMultipart>[0]
): Promise<{ ok: boolean; detail: string }> {
	const { body, contentType } = buildMultipart(fields, randomBoundary());
	const response = await requestUrl({
		url: `https://api.telegram.org/bot${token}/${method}`,
		method: "POST",
		headers: { "content-type": contentType },
		throw: false,
		body,
	});

	if (response.status >= 200 && response.status < 300) return { ok: true, detail: "" };

	let description = "";
	try {
		description = (JSON.parse(response.text) as { description?: string })?.description ?? "";
	} catch {
		description = response.text.slice(0, 200);
	}
	// Telegram's own descriptions are unusually good ("chat not found", "bot was blocked by the
	// user"), so they're passed through rather than replaced with a generic message.
	if (response.status === 401) return { ok: false, detail: "Telegram rejected that bot token." };
	if (response.status === 400 && /chat not found/i.test(description)) {
		return { ok: false, detail: "Telegram says that chat id doesn't exist. Send your bot a message first, then read the chat id from getUpdates." };
	}
	return { ok: false, detail: description || `Telegram error ${response.status}` };
}
