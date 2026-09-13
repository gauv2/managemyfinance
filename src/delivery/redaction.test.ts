import { describe, expect, it, vi } from "vitest";

const requestUrl = vi.fn();
vi.mock("obsidian", () => ({ requestUrl: (...a: unknown[]) => requestUrl(...a) }));

import { sendTelegram, sendEmail } from "./channels";

const TOKEN = "8734733219:AAF_this_is_a_bot_token_value";
const KEY = "re_CnSpRZ3w_realish_resend_key";

describe("a failed delivery never prints the credential", () => {
	it("keeps a bot token out of the error detail", async () => {
		// Telegram carries the token in the URL, and Obsidian's network errors quote the URL they
		// were trying to reach — so a DNS hiccup used to print a live token on screen.
		requestUrl.mockRejectedValue(new Error(`net::ERR_NAME_NOT_RESOLVED https://api.telegram.org/bot${TOKEN}/sendMessage`));
		const result = await sendTelegram({ botToken: TOKEN, chatId: "123" } as never, {
			text: "hello",
			attachments: [],
		} as never);

		expect(result.ok).toBe(false);
		expect(result.detail).not.toContain(TOKEN);
		expect(result.detail).toContain("[redacted]");
	});

	it("keeps an API key out of the error detail", async () => {
		requestUrl.mockRejectedValue(new Error(`request failed with authorization Bearer ${KEY}`));
		const result = await sendEmail({ apiKey: KEY, from: "a@b.c" } as never, {
			to: ["x@y.z"],
			subject: "s",
			html: "<p>h</p>",
			attachments: [],
		} as never);

		expect(result.ok).toBe(false);
		expect(result.detail).not.toContain(KEY);
	});

	it("leaves an ordinary error message intact", async () => {
		requestUrl.mockRejectedValue(new Error("net::ERR_INTERNET_DISCONNECTED"));
		const result = await sendTelegram({ botToken: TOKEN, chatId: "123" } as never, {
			text: "hello",
			attachments: [],
		} as never);

		expect(result.detail).toContain("ERR_INTERNET_DISCONNECTED");
	});
});
