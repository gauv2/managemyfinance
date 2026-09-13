import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { runBudgetForecast } from "../budgetForecast/engine";
import type { BudgetForecastMethod, BudgetForecastRequest, BudgetForecastResult, BudgetScenarioKey, ConfidenceLabel } from "../budgetForecast/types";
import { primaryCategories, secondaryCategoriesOf } from "../categories";
import type { BudgetPeriodResolver } from "../budgets";
import type FinancePlugin from "../main";
import { formatMoney, formatMoneyForInput, parseMoney } from "../money";
import type { Category } from "../types";
import { icon } from "../ui/dom";

/**
 * The Phase H "Suggest Budget" review flow (budget_spec.md §41–43): replaces the old behaviour of
 * writing a chosen percentile straight into every empty category's budget the moment a menu item was
 * clicked. Nothing here is saved until the user presses Apply — every row shows its own P25/P50/P75,
 * confidence, method and diagnostics first, an outlier can be included or excluded live, and a
 * category the model can't sensibly suggest a number for (Transfers, Savings, an unimplemented
 * method) says so instead of being silently skipped without explanation.
 *
 * Laid out as a compact table rather than one big card per category: every row (including the header)
 * shares the exact same `grid-template-columns` via `.fp-suggest-table-row`, so the Lean/Typical/
 * Buffered/Confidence/Custom columns line up precisely no matter how long a category name or method
 * label gets — the thing that broke in the card layout this replaces.
 */

type Selection = BudgetScenarioKey | "custom" | "skip";
type Filter = "all" | "selected" | "low-confidence" | "unselected" | "already-budgeted";

const METHOD_LABEL: Record<BudgetForecastMethod, string> = {
	"seasonal-quantile": "Flexible",
	"fixed-commitment": "Fixed cost",
	"recurring-plus-variable": "Recurring + variable",
	"sinking-fund": "Sinking fund",
	"adaptive-hybrid": "Adaptive",
	"debt-schedule": "Debt schedule",
	"policy-target": "Policy choice",
	"income-target": "Income",
	guardrail: "Guardrail",
	none: "Not budgeted",
};

const CONFIDENCE_TONE: Record<ConfidenceLabel, "good" | "warn" | "bad"> = { high: "good", moderate: "warn", low: "bad" };

const SCENARIO_COLUMNS: { key: BudgetScenarioKey; label: string }[] = [
	{ key: "p25", label: "Lean" },
	{ key: "p50", label: "Typical" },
	{ key: "p75", label: "Buffered" },
];

const POSTURE_OPTIONS: { key: BudgetScenarioKey; label: string }[] = [
	{ key: "p25", label: "Lean" },
	{ key: "p50", label: "Typical" },
	{ key: "p75", label: "Buffered" },
];

/** One short line explaining *why* this method produced this number — not the full diagnostic
 *  explanation (that's still one click away under "Why?"), just enough to read the row at a glance
 *  across a list of 20–40 categories. A low-confidence read always wins regardless of method: "the
 *  model doesn't have much to go on" matters more than which method it still tried. */
function reasonSummary(result: BudgetForecastResult): string {
	if (!result.forecastable) return result.reason ?? "Not enough information to suggest a budget.";
	const d = result.diagnostics;
	if (result.p50?.confidenceLabel === "low" || d.comparableObservations < 6) return "Limited history — newer or variable spending.";
	switch (result.method) {
		case "sinking-fund":
			return "Based on long-term irregular spending.";
		case "fixed-commitment":
			return d.knownCommitments > 0 ? "Stable recurring payment detected." : "Based on your typical recent payment.";
		case "seasonal-quantile":
			return d.seasonalFactorP50 !== undefined ? "Reflects this month's seasonal pattern." : "Based on your recent spending trend.";
		case "recurring-plus-variable":
			return "Combines a known recurring charge with your variable spending.";
		case "guardrail":
			return "Limited to the known mandatory cost, with extras shown separately.";
		case "policy-target":
			return "A policy choice — shown as historical context, not a recommendation.";
		default:
			return "Based on your recent spending pattern.";
	}
}

interface Row {
	category: Category;
	scope: "leaf" | "rollup";
	request: BudgetForecastRequest;
	outlierOverrides: Record<string, "include" | "exclude">;
	result: BudgetForecastResult;
	selection: Selection;
	customAmount?: number;
	/** Whether the user has ever directly interacted with this row's own selection — once true, the
	 *  global "Default posture" control stops touching it. A row still sitting at its own computed
	 *  default hasn't been touched yet, so switching the default posture is free to move it. */
	userTouched: boolean;
	/** What's already on record for this category this period, if anything — shown for comparison
	 *  rather than hiding the row outright, so a category you'd already budgeted (and might want to
	 *  reconsider now that a smarter number exists) is still reviewable, not silently invisible. */
	existingBudget?: number;
	/** The reasoning ("Why?") panel — closed by default. */
	expanded: boolean;
}

export class SuggestBudgetModal extends FinanceModal {
	private rows: Row[] = [];
	private filter: Filter = "all";
	private defaultPosture: BudgetScenarioKey = "p50";

	constructor(
		app: App,
		private plugin: FinancePlugin,
		private opts: { period: string; periodLabel: string; resolver: BudgetPeriodResolver; onApplied?: () => void }
	) {
		super(app);
	}

	onOpen(): void {
		// Both width classes belong on modalEl, same as every other wider-than-default modal in this
		// app (CategoryDrilldownModal, etc.) — putting the width override on contentEl instead makes
		// the content wider than the outer modal box that actually bounds it, overflowing the modal's
		// own right edge rather than ever actually widening it.
		this.modalEl.addClass("fp-wizard-modal");
		this.modalEl.addClass("fp-suggest-budget-modal");
		this.computeRows();
		this.render();
	}

	private computeRows(): void {
		const store = this.plugin.store;
		const { period, periodLabel, resolver } = this.opts;
		const closed = resolver.closedRangeOf(period);
		const target = { from: closed.from, to: closed.to, label: periodLabel };

		const activeCategories = store.categories.filter((c) => !c.archived);
		const primaries = primaryCategories(activeCategories);

		this.rows = [];
		const addRow = (category: Category, scope: "leaf" | "rollup"): void => {
			const request: BudgetForecastRequest = { categoryId: category.id, target, scope };
			const result = runBudgetForecast(store, request);
			const existingBudget = category.budgetHistory?.[period];
			this.rows.push({
				category,
				scope,
				request,
				outlierOverrides: {},
				result,
				// Never auto-select over something already on record — an existing budget only gets
				// replaced if you explicitly pick a scenario for it here.
				selection: existingBudget ? "skip" : (result.recommendedDefault ?? "skip"),
				customAmount: existingBudget ?? result.p50?.amount,
				userTouched: false,
				existingBudget,
				expanded: false,
			});
		};

		for (const p of primaries) {
			if ((p.budgetMode ?? "total") === "breakdown") {
				for (const sub of secondaryCategoriesOf(activeCategories, p.id)) addRow(sub, "leaf");
			} else {
				addRow(p, "rollup");
			}
		}
	}

	private recompute(row: Row): void {
		row.result = runBudgetForecast(this.plugin.store, { ...row.request, outlierOverrides: row.outlierOverrides });
	}

	private visibleRows(): Row[] {
		switch (this.filter) {
			case "selected":
				return this.rows.filter((r) => r.selection !== "skip");
			case "unselected":
				return this.rows.filter((r) => r.selection === "skip");
			case "low-confidence":
				return this.rows.filter((r) => r.result.p50?.confidenceLabel === "low");
			case "already-budgeted":
				return this.rows.filter((r) => r.existingBudget !== undefined);
			default:
				return this.rows;
		}
	}

	/** Re-points every row still sitting at its own untouched default onto the new posture — a row
	 *  the user has already picked a scenario for (or that starts unselected, like an already-budgeted
	 *  or policy-target category) is left exactly as it is. */
	private applyDefaultPosture(posture: BudgetScenarioKey): void {
		this.defaultPosture = posture;
		for (const row of this.rows) {
			if (row.userTouched || row.existingBudget !== undefined) continue;
			if (row.result.recommendedDefault === undefined) continue;
			if (!row.result[posture]) continue;
			row.selection = posture;
		}
		this.render();
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();

		c.createEl("h3", { text: "Plan budget" });
		c.createDiv({ cls: "fp-step-desc", text: "Review suggested budgets before saving." });

		const periodRow = c.createDiv({ cls: "fp-suggest-period-row" });
		icon(periodRow, "calendar");
		periodRow.createSpan({ text: this.opts.periodLabel });

		if (this.rows.length === 0) {
			c.createDiv({
				cls: "fp-empty-note",
				text: "Every category already has a budget set for this period, or none has enough history yet to suggest one.",
			});
			this.renderFooter(c, 0);
			return;
		}

		this.renderStatsBar(c);
		this.renderTableHeader(c);

		const visible = this.visibleRows();
		const list = c.createDiv({ cls: "fp-suggest-list" });
		if (visible.length === 0) {
			list.createDiv({ cls: "fp-empty-note", text: "No categories match this filter." });
		} else {
			for (const row of visible) this.renderRow(list, row);
		}

		const selectedCount = this.rows.filter((r) => r.selection !== "skip").length;
		this.renderFooter(c, selectedCount);
	}

	private renderStatsBar(c: HTMLElement): void {
		const bar = c.createDiv({ cls: "fp-suggest-stats-bar" });

		const countStat = bar.createDiv({ cls: "fp-suggest-stat" });
		icon(countStat, "layout-grid");
		countStat.createSpan({ text: `${this.rows.length} categor${this.rows.length === 1 ? "y" : "ies"}` });

		const filterWrap = bar.createDiv({ cls: "fp-suggest-filter" });
		icon(filterWrap, "filter");
		const filterSelect = filterWrap.createEl("select", { cls: "fp-suggest-filter-select" });
		const filterOptions: { value: Filter; label: string }[] = [
			{ value: "all", label: "All categories" },
			{ value: "selected", label: "Selected only" },
			{ value: "unselected", label: "Unselected only" },
			{ value: "low-confidence", label: "Low confidence only" },
			{ value: "already-budgeted", label: "Already budgeted" },
		];
		for (const opt of filterOptions) {
			const el = filterSelect.createEl("option", { text: opt.label, value: opt.value });
			if (opt.value === this.filter) el.selected = true;
		}
		filterSelect.addEventListener("change", () => {
			this.filter = filterSelect.value as Filter;
			this.render();
		});

		const postureWrap = bar.createDiv({ cls: "fp-suggest-posture" });
		icon(postureWrap, "target");
		postureWrap.createSpan({ cls: "fp-suggest-posture-label", text: "Default:" });
		const postureSelect = postureWrap.createEl("select", { cls: "fp-suggest-posture-select" });
		for (const opt of POSTURE_OPTIONS) {
			const el = postureSelect.createEl("option", { text: opt.label, value: opt.key });
			if (opt.key === this.defaultPosture) el.selected = true;
		}
		postureSelect.addEventListener("change", () => {
			this.applyDefaultPosture(postureSelect.value as BudgetScenarioKey);
		});
	}

	private renderTableHeader(c: HTMLElement): void {
		const header = c.createDiv({ cls: "fp-suggest-table-row fp-suggest-table-header" });
		header.createDiv();
		header.createDiv({ text: "Category" });
		header.createDiv({ cls: "fp-suggest-col-span3", text: "Suggested budget" });
		header.createDiv({ text: "Confidence" });
		header.createDiv({ text: "Custom" });
		header.createDiv();
	}

	private renderRow(list: HTMLElement, row: Row): void {
		const { category, result } = row;
		const wrap = list.createDiv({ cls: "fp-suggest-row-wrap" });
		const line = wrap.createDiv({ cls: "fp-suggest-table-row" });

		const iconBox = line.createDiv({ cls: "fp-suggest-row-icon" });
		iconBox.style.setProperty("--fp-cat-color", category.color);
		icon(iconBox, category.icon);

		const catCell = line.createDiv({ cls: "fp-suggest-cell-category" });
		catCell.createSpan({ cls: "fp-suggest-row-name", text: category.name });
		catCell.createSpan({ cls: "fp-suggest-method-badge", text: METHOD_LABEL[result.method] });
		if (row.existingBudget !== undefined) {
			catCell.createDiv({ cls: "fp-suggest-existing-note", text: `Currently ${formatMoney(row.existingBudget)}` });
		}

		if (!result.forecastable) {
			// Fills the remaining 6 tracks (Lean/Typical/Buffered/Confidence/Custom/Why) as one cell —
			// there's nothing to put in any of those columns for a category that isn't forecastable.
			const reasonCell = line.createDiv({ cls: "fp-suggest-reason-cell" });
			reasonCell.createSpan({ text: result.reason ?? "Not enough information to suggest a budget." });
			return;
		}

		for (const { key, label } of SCENARIO_COLUMNS) {
			const scenario = result[key];
			const cell = line.createDiv({ cls: "fp-suggest-scenario-cell" + (row.selection === key ? " is-active" : "") });
			if (!scenario) {
				cell.addClass("is-empty");
				continue;
			}
			cell.createDiv({ cls: "fp-suggest-scenario-label", text: label });
			cell.createDiv({ cls: "fp-suggest-scenario-amount", text: formatMoney(scenario.amount) });
			cell.addEventListener("click", () => {
				row.userTouched = true;
				row.selection = row.selection === key ? "skip" : key;
				this.render();
			});
		}

		const activeScenario = row.selection !== "custom" && row.selection !== "skip" ? result[row.selection] : result.p50;
		const confidenceCell = line.createDiv({ cls: "fp-suggest-confidence-cell" });
		if (activeScenario) {
			confidenceCell.createSpan({
				cls: `fp-suggest-confidence-badge fp-tone-${CONFIDENCE_TONE[activeScenario.confidenceLabel]}`,
				text: activeScenario.confidenceLabel.charAt(0).toUpperCase() + activeScenario.confidenceLabel.slice(1),
			});
		}

		this.renderCustomCell(line, row);

		const whyCell = line.createDiv({ cls: "fp-suggest-why-cell" });
		const whyLink = whyCell.createEl("button", { cls: "fp-suggest-why-link", text: row.expanded ? "Hide" : "Why?" });
		whyLink.addEventListener("click", () => {
			row.expanded = !row.expanded;
			this.render();
		});

		if (row.expanded) this.renderDetails(wrap, row);
	}

	private renderCustomCell(line: HTMLElement, row: Row): void {
		const active = row.selection === "custom";
		const cell = line.createDiv({ cls: "fp-suggest-custom-cell" + (active ? " is-active" : "") });

		if (active) {
			const inputRow = cell.createDiv({ cls: "fp-suggest-custom-input-row" });
			inputRow.createSpan({ cls: "fp-suggest-custom-currency", text: "€" });
			const input = inputRow.createEl("input", { type: "text", cls: "fp-suggest-custom-input" });
			input.value = formatMoneyForInput(row.customAmount);
			input.addEventListener("input", () => {
				row.customAmount = parseMoney(input.value);
			});
			window.setTimeout(() => {
				input.focus();
				input.select();
			}, 0);
		} else {
			const link = cell.createEl("button", { cls: "fp-suggest-set-amount", text: row.customAmount !== undefined ? formatMoney(row.customAmount) : "Set amount" });
			link.addEventListener("click", () => {
				row.userTouched = true;
				row.selection = "custom";
				this.render();
			});
		}
	}

	private renderDetails(wrap: HTMLElement, row: Row): void {
		const { result } = row;
		const details = wrap.createDiv({ cls: "fp-suggest-details" });
		for (const line of result.diagnostics.explanation) {
			details.createDiv({ cls: "fp-suggest-explanation-line", text: line });
		}
		if (result.outliers.length > 0) {
			const outlierList = details.createDiv({ cls: "fp-suggest-outliers" });
			outlierList.createDiv({ cls: "fp-suggest-outliers-title", text: "Unusual historical periods:" });
			for (const outlier of result.outliers) {
				const included = row.outlierOverrides[outlier.id] === "include" || (row.outlierOverrides[outlier.id] !== "exclude" && outlier.includedByDefault);
				const outlierRow = outlierList.createDiv({ cls: "fp-suggest-outlier-row" });
				outlierRow.createSpan({ text: `${outlier.period}: ${formatMoney(outlier.amount)} — ${included ? "included" : "excluded"}` });
				const toggle = outlierRow.createEl("button", { cls: "fp-btn fp-btn-ghost fp-suggest-outlier-toggle", text: included ? "Exclude" : "Include" });
				toggle.addEventListener("click", () => {
					row.outlierOverrides = { ...row.outlierOverrides, [outlier.id]: included ? "exclude" : "include" };
					this.recompute(row);
					this.render();
				});
			}
		}
	}

	private renderFooter(c: HTMLElement, selectedCount: number): void {
		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		left.createSpan({ cls: "fp-suggest-selected-count", text: `${selectedCount} categor${selectedCount === 1 ? "y" : "ies"} selected` });

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const cancelBtn = right.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const applyBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary", text: "Apply budgets" });
		applyBtn.disabled = selectedCount === 0;
		applyBtn.addEventListener("click", () => void this.apply());
	}

	private async apply(): Promise<void> {
		const store = this.plugin.store;
		let applied = 0;

		for (const row of this.rows) {
			if (row.selection === "skip") continue;
			const amount = row.selection === "custom" ? row.customAmount : row.result[row.selection]?.amount;
			if (amount === undefined || amount <= 0) continue;
			row.category.budgetHistory = { ...row.category.budgetHistory, [this.opts.period]: amount };
			applied++;
		}

		if (applied === 0) {
			new Notice("Nothing selected to apply.");
			return;
		}

		await store.saveCategories();
		new Notice(`Applied a budget to ${applied} categor${applied === 1 ? "y" : "ies"}.`);
		this.plugin.refreshViews();
		this.opts.onApplied?.();
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
