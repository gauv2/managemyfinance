import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeOutcome, runDueSchedules, runSchedule, sendTestReport } from "./scheduleRunner";
import type { ReportSchedule } from "./schedule";
import type FinancePlugin from "../main";
import type { Account, Category, Transaction } from "../types";

const sendEmail = vi.fn();
const sendTelegram = vi.fn();
const htmlToPdf = vi.fn();
const canExportPdf = vi.fn();

vi.mock("../delivery/channels", () => ({
	sendEmail: (...a: unknown[]) => sendEmail(...a),
	sendTelegram: (...a: unknown[]) => sendTelegram(...a),
}));
vi.mock("./pdf", () => ({
	renderHtmlToPdf: (...a: unknown[]) => htmlToPdf(...a),
	canExportPdf: () => canExportPdf(),
}));

const food: Category = { id: "food", name: "Food", color: "#1", icon: "u", aliases: [] };
const accounts: Account[] = [{ id: "acc", name: "Checking", type: "debit", currency: "EUR" }];

function tx(date: string, amount: number): Transaction {
	return { id: `t${date}${amount}`, date, accountId: "acc", description: "Row", amount, currency: "EUR", source: "manual", categoryId: "food" } as Transaction;
}

const saveSettings = vi.fn();

function plugin(schedules: ReportSchedule[], transactions: Transaction[] = [tx("2025-02-10", -50)]): FinancePlugin {
	return {
		app: {},
		manifest: { version: "1.4.0" },
		activePortfolio: { id: "p", name: "Iwan", folder: "Finance" },
		store: { transactions, categories: [food], accounts, fx: { baseCurrency: "EUR" } },
		settings: { dataFolder: "Finance", reportSchedules: schedules, delivery: {} },
		saveSettings,
	} as unknown as FinancePlugin;
}

function schedule(over: Partial<ReportSchedule> = {}): ReportSchedule {
	return {
		id: "s1",
		name: "Monthly spending",
		enabled: true,
		cadence: "monthly",
		query: { direction: "out" },
		attachments: ["csv"],
		channels: { email: ["me@example.com"] },
		lastPeriodKey: "2024-12",
		...over,
	};
}

const NOW = new Date(2025, 2, 3, 9);

beforeEach(() => {
	sendEmail.mockReset().mockResolvedValue({ channel: "email", ok: true, detail: "Sent to 1 recipient" });
	sendTelegram.mockReset().mockResolvedValue({ channel: "telegram", ok: true, detail: "Sent with 1 file" });
	htmlToPdf.mockReset().mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
	canExportPdf.mockReset().mockReturnValue(true);
	saveSettings.mockReset().mockResolvedValue(undefined);
});

describe("runSchedule", () => {
	it("reports on the last completed period, not a partial current one", async () => {
		const outcome = await runSchedule(plugin([]), schedule(), NOW);
		expect(outcome.period.key).toBe("2025-02");
		expect(outcome.period.from).toBe("2025-02-01");
		// The February row is in; nothing from March is.
		expect(outcome.result.count).toBe(1);
	});

	it("sends to every enabled channel", async () => {
		await runSchedule(plugin([]), schedule({ channels: { email: ["a@b.c"], telegram: true } }), NOW);
		expect(sendEmail).toHaveBeenCalledTimes(1);
		expect(sendTelegram).toHaveBeenCalledTimes(1);
	});

	it("skips a channel that isn't enabled", async () => {
		await runSchedule(plugin([]), schedule({ channels: { telegram: true } }), NOW);
		expect(sendEmail).not.toHaveBeenCalled();
		expect(sendTelegram).toHaveBeenCalledTimes(1);
	});

	it("renders a PDF attachment when asked for one", async () => {
		await runSchedule(plugin([]), schedule({ attachments: ["pdf"] }), NOW);
		const message = sendEmail.mock.calls[0][1] as { attachments: { filename: string }[] };
		expect(htmlToPdf).toHaveBeenCalled();
		expect(message.attachments[0].filename).toMatch(/\.pdf$/);
	});

	// Quietly substituting a format for six months is worse than saying why on every run.
	it("falls back to HTML when PDF can't be rendered, and says so", async () => {
		canExportPdf.mockReturnValue(false);
		const outcome = await runSchedule(plugin([]), schedule({ attachments: ["pdf"] }), NOW);
		const message = sendEmail.mock.calls[0][1] as { attachments: { filename: string }[] };
		expect(message.attachments[0].filename).toMatch(/\.html$/);
		expect(outcome.skippedAttachments[0].kind).toBe("pdf");
		expect(describeOutcome(outcome)).toContain("HTML sent instead");
	});

	it("falls back to HTML when the PDF render throws", async () => {
		htmlToPdf.mockRejectedValue(new Error("Couldn't reach Electron"));
		const outcome = await runSchedule(plugin([]), schedule({ attachments: ["pdf"] }), NOW);
		expect(outcome.skippedAttachments[0].reason).toContain("Electron");
		const message = sendEmail.mock.calls[0][1] as { attachments: { filename: string }[] };
		expect(message.attachments[0].filename).toMatch(/\.html$/);
	});

	it("attaches every format asked for", async () => {
		await runSchedule(plugin([]), schedule({ attachments: ["pdf", "csv", "xls"] }), NOW);
		const message = sendEmail.mock.calls[0][1] as { attachments: { filename: string }[] };
		expect(message.attachments.map((a) => a.filename.split(".").pop())).toEqual(["pdf", "csv", "xls"]);
	});

	it("is ok when any one channel succeeded", async () => {
		sendEmail.mockResolvedValue({ channel: "email", ok: false, detail: "key rejected" });
		const outcome = await runSchedule(plugin([]), schedule({ channels: { email: ["a@b.c"], telegram: true } }), NOW);
		expect(outcome.ok).toBe(true);
		expect(describeOutcome(outcome)).toContain("email: failed");
		expect(describeOutcome(outcome)).toContain("telegram: sent");
	});

	it("is not ok when every channel failed", async () => {
		sendEmail.mockResolvedValue({ channel: "email", ok: false, detail: "key rejected" });
		const outcome = await runSchedule(plugin([]), schedule(), NOW);
		expect(outcome.ok).toBe(false);
	});

	it("puts the period in the subject line", async () => {
		await runSchedule(plugin([]), schedule(), NOW);
		const message = sendEmail.mock.calls[0][1] as { subject: string };
		expect(message.subject).toBe("Monthly spending — February 2025");
	});

	it("tells the reader when it was generated late", async () => {
		await runSchedule(plugin([]), schedule({ lastPeriodKey: "2024-10" }), NOW);
		const message = sendEmail.mock.calls[0][1] as { html: string };
		expect(message.html).toContain("periods late");
	});

	it("says nothing about lateness when it is on time", async () => {
		await runSchedule(plugin([]), schedule({ lastPeriodKey: "2025-01" }), NOW);
		const message = sendEmail.mock.calls[0][1] as { html: string };
		expect(message.html).not.toContain("late");
	});
});

describe("runDueSchedules", () => {
	it("runs only what is due", async () => {
		const due = schedule({ id: "due", lastPeriodKey: "2024-12" });
		const settled = schedule({ id: "settled", lastPeriodKey: "2025-02" });
		const outcomes = await runDueSchedules(plugin([due, settled]), NOW);
		expect(outcomes.map((o) => o.schedule?.id)).toEqual(["due"]);
	});

	it("skips a paused schedule", async () => {
		const outcomes = await runDueSchedules(plugin([schedule({ enabled: false })]), NOW);
		expect(outcomes).toHaveLength(0);
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("marks the period delivered on success, so it does not repeat", async () => {
		const s = schedule();
		await runDueSchedules(plugin([s]), NOW);
		expect(s.lastPeriodKey).toBe("2025-02");
		expect(s.lastRun?.ok).toBe(true);
	});

	// A failed send must not consume the period — otherwise one bad API key silently costs a month.
	it("leaves the period undelivered when every channel failed", async () => {
		sendEmail.mockResolvedValue({ channel: "email", ok: false, detail: "key rejected" });
		const s = schedule();
		await runDueSchedules(plugin([s]), NOW);
		expect(s.lastPeriodKey).toBe("2024-12");
		expect(s.lastRun?.ok).toBe(false);
		expect(s.lastRun?.detail).toContain("key rejected");
	});

	it("records a failure even when the whole run threw", async () => {
		htmlToPdf.mockRejectedValue(new Error("boom"));
		canExportPdf.mockImplementation(() => {
			throw new Error("electron exploded");
		});
		const s = schedule({ attachments: ["pdf"] });
		await runDueSchedules(plugin([s]), NOW);
		expect(s.lastRun?.ok).toBe(false);
		expect(s.lastPeriodKey).toBe("2024-12");
	});

	it("only sends one report after a long closure, for the latest period", async () => {
		const s = schedule({ lastPeriodKey: "2024-08" });
		const outcomes = await runDueSchedules(plugin([s]), NOW);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0].period.key).toBe("2025-02");
		expect(sendEmail).toHaveBeenCalledTimes(1);
	});

	it("persists the outcome", async () => {
		await runDueSchedules(plugin([schedule()]), NOW);
		expect(saveSettings).toHaveBeenCalled();
	});

	it("does nothing at all when nothing is due", async () => {
		await runDueSchedules(plugin([schedule({ lastPeriodKey: "2025-02" })]), NOW);
		expect(saveSettings).not.toHaveBeenCalled();
	});
});

describe("sendTestReport", () => {
	// A period in progress, not a completed one — a test should report on data you can recognize.
	it("covers the period currently in progress", async () => {
		const year = await sendTestReport(plugin([]), { telegram: true }, { cadence: "yearly" }, NOW);
		expect([year.period.from, year.period.to, year.period.label]).toEqual(["2025-01-01", "2025-12-31", "2025 so far"]);

		const month = await sendTestReport(plugin([]), { telegram: true }, { cadence: "monthly" }, NOW);
		expect([month.period.from, month.period.to, month.period.label]).toEqual(["2025-03-01", "2025-03-31", "March 2025 so far"]);

		const quarter = await sendTestReport(plugin([]), { telegram: true }, { cadence: "quarterly" }, NOW);
		expect([quarter.period.from, quarter.period.to, quarter.period.label]).toEqual(["2025-01-01", "2025-03-31", "Q1 2025 so far"]);
	});

	// Defaults matter here: the complaint that prompted this was a year at full detail arriving as a
	// fifty-page attachment, which is a slow way to find out a bot token is wrong.
	it("defaults to this month, summary only", async () => {
		const outcome = await sendTestReport(plugin([]), { telegram: true }, {}, NOW);
		expect(outcome.period.key).toBe("2025-03");
	});

	it("goes through the same pipeline a schedule does, PDF and all", async () => {
		await sendTestReport(plugin([]), { telegram: true }, {}, NOW);
		expect(htmlToPdf).toHaveBeenCalled();
		const message = sendTelegram.mock.calls[0][1] as { attachments: { filename: string }[] };
		expect(message.attachments[0].filename).toMatch(/\.pdf$/);
	});

	it("sends only to the channels asked for", async () => {
		await sendTestReport(plugin([]), { telegram: true }, {}, NOW);
		expect(sendEmail).not.toHaveBeenCalled();

		sendTelegram.mockClear();
		await sendTestReport(plugin([]), { email: ["me@example.com"] }, {}, NOW);
		expect(sendTelegram).not.toHaveBeenCalled();
		expect(sendEmail).toHaveBeenCalledTimes(1);
	});

	// A test send is never late by definition, and a "generated late" note on one would be nonsense.
	it("never claims to be late", async () => {
		await sendTestReport(plugin([]), { email: ["me@example.com"] }, {}, NOW);
		const message = sendEmail.mock.calls[0][1] as { html: string };
		expect(message.html).not.toContain("late");
	});

	it("does not touch any schedule's state", async () => {
		const s = schedule();
		await sendTestReport(plugin([s]), { telegram: true }, {}, NOW);
		expect(s.lastPeriodKey).toBe("2024-12");
		expect(s.lastRun).toBeUndefined();
		expect(saveSettings).not.toHaveBeenCalled();
	});
});

describe("describeOutcome", () => {
	it("names a schedule with nowhere to send", async () => {
		const outcome = await runSchedule(plugin([]), schedule({ channels: {} }), NOW);
		expect(describeOutcome(outcome)).toBe("nowhere to send — no channels enabled");
	});
});
