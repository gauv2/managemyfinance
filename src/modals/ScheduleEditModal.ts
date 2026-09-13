import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import type FinancePlugin from "../main";
import { describeOutcome, runSchedule } from "../reports/scheduleRunner";
import {
	CADENCE_LABEL,
	DETAIL_HINT,
	DETAIL_LABEL,
	completedPeriod,
	initialPeriodKey,
	nextDueAt,
	type AttachmentKind,
	type Cadence,
	type ReportDetail,
	type ReportSchedule,
} from "../reports/schedule";
import { renderCategoryPicker } from "../ui/categoryPicker";
import { icon } from "../ui/dom";

/**
 * Create or edit one recurring report.
 *
 * The form is deliberately the same shape as the Reports tab's query builder, minus the dates — the
 * period supplies those. Anyone who has built a report on that page already knows this dialog.
 */
export class ScheduleEditModal extends FinanceModal {
	private draft: ReportSchedule;
	private readonly isNew: boolean;

	constructor(app: App, private plugin: FinancePlugin, existing: ReportSchedule | undefined, private onSaved: () => void) {
		super(app);
		this.isNew = !existing;
		this.draft = existing
			? JSON.parse(JSON.stringify(existing))
			: {
					id: `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
					name: "Monthly spending",
					enabled: true,
					cadence: "monthly",
					query: { direction: "out", categoryIds: [], excludeCategoryIds: [], accountIds: [], includeTransfers: false },
					detail: "standard",
					attachments: ["pdf"],
					channels: {},
					// Starts settled, so saving a schedule doesn't itself fire a report for last month.
					lastPeriodKey: initialPeriodKey("monthly"),
			  };
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		this.modalEl.addClass("fp-schedule-modal");
		this.render();
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();
		c.createEl("h3", { text: this.isNew ? "New scheduled report" : "Edit scheduled report" });
		c.createDiv({
			cls: "fp-step-desc",
			text: "A report built from these filters, for each completed period, sent wherever you choose.",
		});

		const form = c.createDiv({ cls: "fp-form" });
		this.renderName(form);
		this.renderCadence(form);
		this.renderFilters(form);
		this.renderDetail(form);
		this.renderAttachments(form);
		this.renderChannels(form);
		this.renderSchedulingNote(c);
		this.renderFooter(c);
	}

	private row(parent: HTMLElement, label: string, hint?: string): HTMLElement {
		const row = parent.createDiv({ cls: "fp-form-row" });
		const left = row.createDiv({ cls: "fp-form-row-label" });
		left.createEl("label", { text: label });
		if (hint) left.createDiv({ cls: "fp-report-row-hint", text: hint });
		return row.createDiv({ cls: "fp-field-control" });
	}

	private renderName(form: HTMLElement): void {
		const control = this.row(form, "Name", "Used as the subject line and the filename");
		const input = control.createEl("input", { type: "text" });
		input.value = this.draft.name;
		input.addEventListener("input", () => (this.draft.name = input.value));
	}

	private renderCadence(form: HTMLElement): void {
		const control = this.row(form, "How often");
		const group = control.createDiv({ cls: "fp-segmented" });
		(["weekly", "monthly", "quarterly", "yearly"] as Cadence[]).forEach((value) => {
			const btn = group.createEl("button", {
				cls: "fp-segmented-btn" + (this.draft.cadence === value ? " is-active" : ""),
				text: CADENCE_LABEL[value],
			});
			btn.addEventListener("click", () => {
				this.draft.cadence = value;
				// The settled marker is per-cadence, so switching must re-settle or the new cadence
				// looks overdue and fires the moment the dialog is saved.
				this.draft.lastPeriodKey = initialPeriodKey(value);
				this.render();
			});
		});
	}

	private renderFilters(form: HTMLElement): void {
		const store = this.plugin.store;
		const query = this.draft.query;

		const catControl = this.row(form, "Categories", "Empty means everything. A primary includes its subcategories.");
		renderCategoryPicker(catControl, {
			categories: store.categories,
			chosen: query.categoryIds ?? [],
			emptyText: "All categories",
			removeLabel: "Remove this category",
			onChange: (next) => {
				query.categoryIds = next;
				this.render();
			},
		});

		const excludeControl = this.row(form, "Exclude", "Left out even if \"all categories\" or the list above would otherwise include them.");
		renderCategoryPicker(excludeControl, {
			categories: store.categories,
			chosen: query.excludeCategoryIds ?? [],
			emptyText: "Nothing excluded",
			removeLabel: "Stop excluding this category",
			tone: "exclude",
			onChange: (next) => {
				query.excludeCategoryIds = next;
				this.render();
			},
		});

		const scopeControl = this.row(form, "Scope");
		const line = scopeControl.createDiv({ cls: "fp-report-scope" });
		const accountSelect = line.createEl("select", { cls: "fp-filter-select" });
		accountSelect.createEl("option", { text: "All accounts", value: "" });
		store.accounts.forEach((a) => accountSelect.createEl("option", { text: a.name, value: a.id }));
		accountSelect.value = (query.accountIds ?? [])[0] ?? "";
		accountSelect.addEventListener("change", () => {
			query.accountIds = accountSelect.value ? [accountSelect.value] : [];
		});

		const dirGroup = line.createDiv({ cls: "fp-segmented" });
		(
			[
				["out", "Money out"],
				["in", "Money in"],
				["all", "Both"],
			] as const
		).forEach(([value, label]) => {
			const btn = dirGroup.createEl("button", {
				cls: "fp-segmented-btn" + ((query.direction ?? "out") === value ? " is-active" : ""),
				text: label,
			});
			btn.addEventListener("click", () => {
				query.direction = value;
				this.render();
			});
		});
	}

	/** Same choice the test button offers, because a scheduled PDF has the same length problem. */
	private renderDetail(form: HTMLElement): void {
		const control = this.row(form, "Detail", "Only affects the PDF — CSV and Excel always carry every row");
		const current = this.draft.detail ?? "standard";
		const group = control.createDiv({ cls: "fp-segmented" });
		(["summary", "standard", "full"] as ReportDetail[]).forEach((value) => {
			const btn = group.createEl("button", {
				cls: "fp-segmented-btn" + (current === value ? " is-active" : ""),
				text: DETAIL_LABEL[value],
			});
			btn.setAttribute("title", DETAIL_HINT[value]);
			btn.addEventListener("click", () => {
				this.draft.detail = value;
				this.render();
			});
		});
		control.createDiv({ cls: "fp-report-row-hint", text: DETAIL_HINT[current] });
	}

	private renderAttachments(form: HTMLElement): void {
		const control = this.row(form, "Attach", "PDF renders exactly as the Save-as-PDF button does");
		const group = control.createDiv({ cls: "fp-schedule-checks" });
		(
			[
				["pdf", "PDF"],
				["csv", "CSV"],
				["xls", "Excel"],
			] as [AttachmentKind, string][]
		).forEach(([kind, label]) => {
			const wrap = group.createDiv({ cls: "fp-report-toggle" });
			const box = wrap.createEl("input", { type: "checkbox", cls: "fp-review-check" });
			box.id = `fp-attach-${kind}`;
			box.checked = this.draft.attachments.includes(kind);
			wrap.createEl("label", { text: label, attr: { for: `fp-attach-${kind}` } });
			box.addEventListener("change", () => {
				this.draft.attachments = box.checked
					? [...this.draft.attachments, kind]
					: this.draft.attachments.filter((a) => a !== kind);
			});
		});
	}

	private renderChannels(form: HTMLElement): void {
		const delivery = this.plugin.settings.delivery ?? {};

		const emailControl = this.row(form, "Email to", "One address per line. Leave empty to skip email.");
		const emails = emailControl.createEl("textarea", { attr: { rows: "3", placeholder: "you@example.com" } });
		emails.value = (this.draft.channels.email ?? []).join("\n");
		emails.addEventListener("input", () => {
			this.draft.channels.email = emails.value
				.split(/[\n,;]/)
				.map((e) => e.trim())
				.filter(Boolean);
		});
		if (!delivery.email?.apiKey) {
			emailControl.createDiv({ cls: "fp-recheck-note", text: "No Resend API key set yet — add one below in Scheduled reports before this can send." });
		}

		const tgControl = this.row(form, "Telegram");
		const wrap = tgControl.createDiv({ cls: "fp-report-toggle" });
		const box = wrap.createEl("input", { type: "checkbox", cls: "fp-review-check" });
		box.id = "fp-schedule-telegram";
		box.checked = !!this.draft.channels.telegram;
		wrap.createEl("label", { text: "Send to the configured Telegram chat", attr: { for: "fp-schedule-telegram" } });
		box.addEventListener("change", () => (this.draft.channels.telegram = box.checked));
		if (!delivery.telegram?.botToken) {
			tgControl.createDiv({ cls: "fp-recheck-note", text: "No bot token set yet — add one below in Scheduled reports before this can send." });
		}
	}

	/** The honest description of when this actually fires. */
	private renderSchedulingNote(c: HTMLElement): void {
		const period = completedPeriod(this.draft.cadence);
		const next = nextDueAt(this.draft.cadence);
		c.createDiv({
			cls: "fp-recheck-note",
			text: `Each run reports on the last completed ${
				this.draft.cadence === "weekly" ? "week" : this.draft.cadence === "monthly" ? "month" : this.draft.cadence === "quarterly" ? "quarter" : "year"
			} — right now that would be ${period.label}. The next one completes on ${next.toLocaleDateString()}, and the report is sent the first time Obsidian is running on or after that date. Nothing is sent while Obsidian is closed.`,
		});
	}

	private renderFooter(c: HTMLElement): void {
		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });

		// The escape hatch from "starts settled": if you want last month's report now, ask for it.
		const sendNow = left.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(sendNow, "send");
		sendNow.createSpan({ text: "Send now" });
		sendNow.setAttribute("title", "Build and deliver this report immediately for the last completed period, without changing the schedule.");
		sendNow.addEventListener("click", async () => {
			if (!this.validate()) return;
			sendNow.disabled = true;
			sendNow.setText("Sending…");
			try {
				const outcome = await runSchedule(this.plugin, this.draft);
				new Notice(`${outcome.ok ? "Sent" : "Failed"}: ${describeOutcome(outcome)}`, outcome.ok ? 8000 : 15000);
			} catch (e) {
				new Notice(`Couldn't send: ${e instanceof Error ? e.message : String(e)}`, 12000);
			} finally {
				sendNow.disabled = false;
				sendNow.empty();
				icon(sendNow, "send");
				sendNow.createSpan({ text: "Send now" });
			}
		});

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		right.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel" }).addEventListener("click", () => this.close());
		const save = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(save, "check");
		save.createSpan({ text: this.isNew ? "Create schedule" : "Save changes" });
		save.addEventListener("click", () => void this.save());
	}

	private validate(): boolean {
		if (!this.draft.name.trim()) {
			new Notice("Give the schedule a name — it becomes the subject line.");
			return false;
		}
		if (this.draft.attachments.length === 0) {
			new Notice("Pick at least one attachment format.");
			return false;
		}
		const emails = this.draft.channels.email ?? [];
		const bad = emails.find((e) => !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e));
		if (bad) {
			new Notice(`"${bad}" doesn't look like an email address.`);
			return false;
		}
		if (emails.length === 0 && !this.draft.channels.telegram) {
			new Notice("Add a recipient or switch on Telegram — a schedule with nowhere to send never fires.");
			return false;
		}
		return true;
	}

	private async save(): Promise<void> {
		if (!this.validate()) return;
		const settings = this.plugin.settings;
		settings.reportSchedules ??= [];
		const index = settings.reportSchedules.findIndex((s) => s.id === this.draft.id);
		if (index === -1) settings.reportSchedules.push(this.draft);
		else settings.reportSchedules[index] = this.draft;

		await this.plugin.saveSettings();
		new Notice(this.isNew ? `Schedule "${this.draft.name}" created.` : "Schedule saved.");
		this.onSaved();
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
