import { Notice } from "obsidian";
import { sendEmail, sendTelegram, type Attachment, type ChannelResult } from "../delivery/channels";
import type FinancePlugin from "../main";
import { formatMoney } from "../money";
import { buildReportCsv, buildReportHtml, buildReportXml, type ExportContext } from "./export";
import { canExportPdf, renderHtmlToPdf } from "./pdf";
import { describePeriod, describeQuery, reportSlug, runReport, type ReportQuery, type ReportResult, type ReportSource } from "./query";
import {
	completedPeriod,
	currentPeriod,
	DETAIL_ROW_LIMIT,
	isDue,
	periodsMissed,
	type AttachmentKind,
	type Cadence,
	type Period,
	type ReportDetail,
	type ReportSchedule,
	type ScheduleChannels,
} from "./schedule";

/**
 * Running a schedule: build the report for its period, render the attachments, send them, and record
 * what happened.
 *
 * The recording is the part that makes the whole thing trustworthy. Every run writes a `lastRun`
 * carrying the outcome per channel, so the settings panel can say "Telegram sent, email failed: that
 * API key was rejected" instead of leaving you to discover months later that nothing ever arrived.
 * And `lastPeriodKey` is only advanced when at least one channel actually accepted the report — a
 * failed send stays due, so the next launch retries rather than skipping the period forever.
 */

const CONTENT_TYPES: Record<string, string> = {
	pdf: "application/pdf",
	csv: "text/csv",
	xls: "application/vnd.ms-excel",
	html: "text/html",
};

export interface RunOutcome {
	/** What the delivery was called — a schedule's name, or a one-off test's. */
	name: string;
	/** The schedule this came from, absent for an ad-hoc send. */
	schedule?: ReportSchedule;
	period: Period;
	result: ReportResult;
	channels: ChannelResult[];
	/** Formats that were asked for but couldn't be produced, with the reason. */
	skippedAttachments: { kind: string; reason: string }[];
	ok: boolean;
}

/**
 * One delivery, fully specified.
 *
 * A schedule firing and a "send it to me now" test button are the same operation over a different
 * period, so they share this and the function below rather than each growing their own copy of the
 * attachment-rendering and PDF-fallback logic — which is exactly the code you want exercised when
 * you press a test button, and therefore exactly the code a second copy would fail to test.
 */
export interface DeliveryRequest {
	name: string;
	period: Period;
	query: Omit<ReportQuery, "from" | "to">;
	/** How much of the transaction list the PDF carries. Defaults to "standard". */
	detail?: ReportDetail;
	attachments: AttachmentKind[];
	channels: ScheduleChannels;
	/** Periods missed before this one, for the "generated late" note. Zero for an ad-hoc send. */
	late?: number;
}

function source(plugin: FinancePlugin): ReportSource {
	const store = plugin.store;
	return { transactions: store.transactions, categories: store.categories, accounts: store.accounts, fx: store.fx };
}

/** The summary paragraph that goes in the email body and the Telegram message. */
function summaryHtml(result: ReportResult, ctx: ExportContext, period: Period, late: number): string {
	const money = (n: number): string => formatMoney(n, { currency: result.baseCurrency });
	const rows = [
		["Transactions", String(result.count)],
		["Total out", money(result.spent)],
		["Total in", money(result.received)],
		["Net", money(result.net)],
	];
	const table = rows.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#5b6472">${k}</td><td style="padding:2px 0"><b>${v}</b></td></tr>`).join("");
	const lateNote =
		late > 0
			? `<p style="color:#8a929e;font-size:12px">Generated ${late} period${late === 1 ? "" : "s"} late — Obsidian wasn't running when this fell due.</p>`
			: "";
	return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1d23">
<h2 style="margin:0 0 2px">${ctx.title}</h2>
<p style="margin:0 0 12px;color:#5b6472">${period.label}</p>
<table style="border-collapse:collapse;font-size:14px">${table}</table>
${lateNote}
<p style="color:#8a929e;font-size:12px">Sent by Manage My Finance for Obsidian.</p>
</div>`;
}

function summaryText(result: ReportResult, ctx: ExportContext, period: Period, late: number): string {
	const money = (n: number): string => formatMoney(n, { currency: result.baseCurrency });
	const lines = [
		`<b>${escapeHtml(ctx.title)}</b>`,
		escapeHtml(period.label),
		"",
		`Transactions: ${result.count}`,
		`Out: ${escapeHtml(money(result.spent))}`,
		`In: ${escapeHtml(money(result.received))}`,
		`Net: ${escapeHtml(money(result.net))}`,
	];
	if (late > 0) lines.push("", `Generated ${late} period${late === 1 ? "" : "s"} late — Obsidian wasn't running when it fell due.`);
	return lines.join("\n");
}

/** Telegram's HTML parse mode accepts a small tag set; everything else has to be escaped. */
function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Builds a report for one period and delivers it to the channels asked for.
 *
 * The single path every delivery goes through — a schedule firing on launch, a "Send now" on a
 * schedule, and the test button in settings. Nothing here knows or cares which of those it is.
 */
export async function deliverReport(plugin: FinancePlugin, req: DeliveryRequest): Promise<RunOutcome> {
	const period = req.period;
	const query = { ...req.query, from: period.from, to: period.to };
	const result = runReport(source(plugin), query);

	const ctx: ExportContext = {
		title: describeQuery(source(plugin), query),
		period: describePeriod(period.from, period.to),
		categories: plugin.store.categories,
		accounts: plugin.store.accounts,
		generatedAt: new Date().toISOString(),
		pluginVersion: plugin.manifest.version,
		portfolioName: plugin.activePortfolio?.name,
		filterSummary: [period.label],
	};

	const slug = reportSlug(`${req.name} ${period.key}`);
	const attachments: Attachment[] = [];
	const skippedAttachments: { kind: string; reason: string }[] = [];
	// CSV and Excel are unaffected below: a data file that silently dropped rows would be wrong,
	// where a document that lists the top 100 and says so is simply shorter.
	const html = buildReportHtml(result, ctx, { maxRows: DETAIL_ROW_LIMIT[req.detail ?? "standard"] });

	for (const kind of req.attachments) {
		if (kind === "pdf") {
			if (!canExportPdf()) {
				// Reported, not silently swapped: a schedule that promised a PDF and quietly sent HTML
				// for six months is worse than one that says on every run why it couldn't.
				skippedAttachments.push({ kind: "pdf", reason: "PDF rendering needs the desktop app" });
				attachments.push({ filename: `${slug}.html`, contentType: CONTENT_TYPES.html, data: new TextEncoder().encode(html) });
				continue;
			}
			try {
				const pdf = await renderHtmlToPdf(html, "finance-schedule");
				attachments.push({ filename: `${slug}.pdf`, contentType: CONTENT_TYPES.pdf, data: pdf });
			} catch (e) {
				skippedAttachments.push({ kind: "pdf", reason: e instanceof Error ? e.message : String(e) });
				attachments.push({ filename: `${slug}.html`, contentType: CONTENT_TYPES.html, data: new TextEncoder().encode(html) });
			}
			continue;
		}
		const content = kind === "csv" ? buildReportCsv(result, ctx, { delimiter: plugin.settings.reportCsvDelimiter ?? "," }) : buildReportXml(result, ctx);
		attachments.push({ filename: `${slug}.${kind}`, contentType: CONTENT_TYPES[kind], data: new TextEncoder().encode(content) });
	}

	const late = req.late ?? 0;
	const channels: ChannelResult[] = [];
	const delivery = plugin.settings.delivery ?? {};

	if ((req.channels.email?.length ?? 0) > 0) {
		channels.push(
			await sendEmail(delivery.email ?? {}, {
				to: req.channels.email!,
				subject: `${req.name} — ${period.label}`,
				html: summaryHtml(result, ctx, period, late),
				attachments,
			})
		);
	}
	if (req.channels.telegram) {
		channels.push(await sendTelegram(delivery.telegram ?? {}, { text: summaryText(result, ctx, period, late), attachments }));
	}

	return { name: req.name, period, result, channels, skippedAttachments, ok: channels.some((c) => c.ok) };
}

/**
 * Builds one schedule's report and delivers it. Does not touch `lastPeriodKey` — see runDueSchedules
 * and the manual send, which decide separately whether an outcome should settle the period.
 */
export async function runSchedule(plugin: FinancePlugin, schedule: ReportSchedule, now = new Date()): Promise<RunOutcome> {
	const outcome = await deliverReport(plugin, {
		name: schedule.name,
		period: completedPeriod(schedule.cadence, now),
		query: schedule.query,
		detail: schedule.detail,
		attachments: schedule.attachments,
		channels: schedule.channels,
		late: periodsMissed(schedule, now),
	});
	return { ...outcome, schedule };
}

/**
 * Sends a report for a period in progress, right now, to whichever channels are named.
 *
 * The test button behind the delivery settings. It runs the whole pipeline the real thing does —
 * report, PDF render, attachment, transport — because the failures worth catching before you trust
 * a schedule are an unverified sender domain, a wrong chat id, and an Electron render that doesn't
 * work on this machine, and none of those show up in a plain "is the token valid" ping.
 *
 * The period and detail are the caller's choice: a year at full detail is a fifty-page attachment,
 * which is a slow and annoying way to discover your bot token is wrong.
 */
export async function sendTestReport(
	plugin: FinancePlugin,
	channels: ScheduleChannels,
	opts: { cadence?: Exclude<Cadence, "weekly">; detail?: ReportDetail; attachments?: AttachmentKind[] } = {},
	now = new Date()
): Promise<RunOutcome> {
	const period = currentPeriod(opts.cadence ?? "monthly", now);
	return deliverReport(plugin, {
		name: `${period.label} — test report`,
		period,
		query: { direction: "out" },
		detail: opts.detail ?? "summary",
		attachments: opts.attachments ?? ["pdf"],
		channels,
	});
}

/** One line per channel, plus anything that couldn't be attached — what `lastRun.detail` holds. */
export function describeOutcome(outcome: RunOutcome): string {
	const parts = outcome.channels.map((c) => `${c.channel}: ${c.ok ? "sent" : "failed"} — ${c.detail}`);
	for (const skipped of outcome.skippedAttachments) parts.push(`${skipped.kind} not attached — ${skipped.reason}; HTML sent instead`);
	if (parts.length === 0) parts.push("nowhere to send — no channels enabled");
	return parts.join(" · ");
}

/**
 * Runs everything due and records the results. Called once on startup.
 *
 * Sequential rather than parallel: two schedules both rendering a PDF means two Electron windows,
 * and a launch that spawns six of them at once is a visible stall on the one occasion the user is
 * definitely watching.
 */
export async function runDueSchedules(plugin: FinancePlugin, now = new Date()): Promise<RunOutcome[]> {
	const schedules = plugin.settings.reportSchedules ?? [];
	const due = schedules.filter((s) => isDue(s, now));
	if (due.length === 0) return [];

	const outcomes: RunOutcome[] = [];
	for (const schedule of due) {
		let outcome: RunOutcome;
		try {
			outcome = await runSchedule(plugin, schedule, now);
		} catch (e) {
			const detail = e instanceof Error ? e.message : String(e);
			schedule.lastRun = { at: new Date().toISOString(), periodKey: completedPeriod(schedule.cadence, now).key, ok: false, detail };
			new Notice(`Scheduled report "${schedule.name}" failed: ${detail}`, 10000);
			continue;
		}

		schedule.lastRun = {
			at: new Date().toISOString(),
			periodKey: outcome.period.key,
			ok: outcome.ok,
			detail: describeOutcome(outcome),
		};
		// Only a delivery that actually landed somewhere settles the period. A failed send stays due,
		// so the next launch retries instead of the period being skipped for good.
		if (outcome.ok) schedule.lastPeriodKey = outcome.period.key;
		outcomes.push(outcome);

		new Notice(
			outcome.ok
				? `Sent "${schedule.name}" for ${outcome.period.label}.\n${describeOutcome(outcome)}`
				: `Couldn't send "${schedule.name}" for ${outcome.period.label}.\n${describeOutcome(outcome)}\nIt stays due and will be retried.`,
			outcome.ok ? 8000 : 15000
		);
	}

	await plugin.saveSettings();
	return outcomes;
}
