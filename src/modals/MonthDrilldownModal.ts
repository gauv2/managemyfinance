import { App } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { summarizeByMonth } from "../kpi";
import type FinancePlugin from "../main";
import { icon } from "../ui/dom";
import { formatEUR, formatPct, metricRow, metricsTable, yearHeaderRow } from "../ui/metricsTable";

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The year → month drill-down: same metrics as the yearly table, one column per month instead. */
export class MonthDrilldownModal extends FinanceModal {
	constructor(app: App, private plugin: FinancePlugin, private year: string, private accountName?: string, private accountId?: string) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		this.modalEl.addClass("fp-drilldown-modal");
		const c = this.contentEl;
		c.addClass("fp-account-modal");

		c.createEl("h3", { text: this.accountName ? `${this.year} by month — ${this.accountName}` : `${this.year} by month` });

		const months = summarizeByMonth(this.plugin.store, this.year, this.accountId);
		const hasActivity = months.some((m) => m.income > 0 || m.expenses > 0);

		if (!hasActivity) {
			c.createEl("p", { cls: "fp-step-desc", text: "No transactions recorded for this year." });
		} else {
			// `metricsTable` brings its own scroll wrapper; a second one around it would nest two
			// scrollers and give the inner one nothing to scroll.
			const table = metricsTable(c);
			yearHeaderRow(table, MONTH_LABELS);
			const tbody = table.createEl("tbody");

			metricRow(tbody, "Total income", months.map((m) => m.income), formatEUR, { heat: "normal" });
			metricRow(tbody, "Total expenses", months.map((m) => m.expenses), formatEUR, { heat: "invert" });
			metricRow(tbody, "Net savings", months.map((m) => m.net), formatEUR, { emphasize: true, heat: "normal" });
			metricRow(tbody, "Savings rate", months.map((m) => m.savingsRate), (n) => formatPct(n), { heat: "normal" });
			metricRow(tbody, "Passive income", months.map((m) => m.passiveIncome), formatEUR, { heat: "normal" });
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const closeBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(closeBtn, "check");
		closeBtn.createSpan({ text: "Close" });
		closeBtn.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
