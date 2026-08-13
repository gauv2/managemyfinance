import {
	monthOptions,
	periodOptions,
	resolvePeriodRange,
	transactionYears,
	weekOptions,
	PERIOD_ALL,
	PERIOD_CUSTOM,
	type PeriodSelection,
} from "../period";

export interface PeriodFilterOptions {
	/** The dates in scope. Every level is populated from these, so no choice can select an empty view. */
	dates: (string | undefined)[];
	/** Owned by the caller (module scope, so a re-render doesn't lose it) and written in place. */
	selection: PeriodSelection;
	/** Defaults to "Period"; "" for the callers whose own row label already says it. */
	label?: string;
	/** Fired after `selection` has been brought up to date — redraw whatever the period feeds. */
	onChange: () => void;
}

export interface PeriodFilterHandle {
	/** Back to All time with the dates cleared — what "Clear filters" and "Reset" call. Doesn't fire
	 *  `onChange`; the caller is already redrawing. */
	reset(): void;
}

/**
 * The one period control: a year (or a relative preset), then a month inside that year, then a week
 * inside that month, with a raw from/to pair behind "Custom range…" for the windows no preset names.
 *
 * There is deliberately only one of these. The ledger, the reports builder and the dashboards all
 * mount this same function rather than each growing their own idea of what "this month" means — the
 * maths lives in src/period.ts, the markup lives here, and neither is copied anywhere.
 */
export function renderPeriodFilter(container: HTMLElement, opts: PeriodFilterOptions): PeriodFilterHandle {
	const { selection, dates } = opts;

	const group = container.createDiv({ cls: "fp-period-filter" });
	const label = opts.label ?? "Period";
	if (label) group.createSpan({ cls: "fp-filter-label", text: label });

	const periodSelect = group.createEl("select", { cls: "fp-filter-select" });
	periodSelect.setAttribute("aria-label", "Period");
	const periodChoices = periodOptions(transactionYears(dates));
	periodChoices.forEach((o) => periodSelect.createEl("option", { text: o.label, value: o.value }));
	periodSelect.value = periodChoices.some((o) => o.value === selection.period) ? selection.period : PERIOD_ALL;
	if (periodSelect.value !== selection.period) {
		// The remembered period named a year this scope has nothing in — switching accounts can do that.
		// Drop the dates with it, so the dropdown can't read "All time" over a range still being applied.
		selection.period = PERIOD_ALL;
		selection.month = "";
		selection.week = "";
		selection.from = "";
		selection.to = "";
	}

	const monthSelect = group.createEl("select", { cls: "fp-filter-select" });
	monthSelect.setAttribute("aria-label", "Month");
	const weekSelect = group.createEl("select", { cls: "fp-filter-select" });
	weekSelect.setAttribute("aria-label", "Week");

	/** Months live under a chosen year only — the relative presets and the manual range own their own
	 *  span, and drilling into them would just be a second way to say the same thing. */
	function populateMonthSelect(year: string, selected: string): void {
		monthSelect.empty();
		const drillable = /^\d{4}$/.test(year);
		monthSelect.disabled = !drillable;
		if (!drillable) {
			monthSelect.createEl("option", { text: "Month", value: "" });
			return;
		}
		const choices = monthOptions(dates, year);
		choices.forEach((o) => monthSelect.createEl("option", { text: o.label, value: o.value }));
		monthSelect.value = choices.some((o) => o.value === selected) ? selected : "";
	}

	function populateWeekSelect(month: string, selected: string): void {
		weekSelect.empty();
		const drillable = !monthSelect.disabled && month !== "";
		weekSelect.disabled = !drillable;
		if (!drillable) {
			weekSelect.createEl("option", { text: "Week", value: "" });
			return;
		}
		const choices = weekOptions(dates, month);
		choices.forEach((o) => weekSelect.createEl("option", { text: o.label, value: o.value }));
		weekSelect.value = choices.some((o) => o.value === selected) ? selected : "";
	}

	populateMonthSelect(periodSelect.value, selection.month);
	populateWeekSelect(monthSelect.value, selection.week);

	// The raw range stays as the escape hatch the presets can't cover, but it only takes up room once
	// you ask for it.
	const customRange = container.createDiv({ cls: "fp-period-filter-custom" });
	customRange.toggleClass("is-hidden", periodSelect.value !== PERIOD_CUSTOM);
	const dateFrom = customRange.createEl("input", { type: "date", cls: "fp-filter-date" });
	dateFrom.setAttribute("aria-label", "From");
	dateFrom.value = selection.from;
	customRange.createSpan({ cls: "fp-filter-date-sep", text: "–" });
	const dateTo = customRange.createEl("input", { type: "date", cls: "fp-filter-date" });
	dateTo.setAttribute("aria-label", "To");
	dateTo.value = selection.to;

	function commit(): void {
		selection.period = periodSelect.value;
		selection.month = monthSelect.disabled ? "" : monthSelect.value;
		selection.week = weekSelect.disabled ? "" : weekSelect.value;
		const range = resolvePeriodRange(selection);
		if (range) {
			dateFrom.value = range.from;
			dateTo.value = range.to;
		} else if (selection.period === PERIOD_ALL) {
			dateFrom.value = "";
			dateTo.value = "";
		}
		// "Custom range…" deliberately leaves the dates alone: it reveals whatever range you were
		// already looking at, ready to be adjusted, rather than making you start from nothing.
		selection.from = dateFrom.value;
		selection.to = dateTo.value;
		opts.onChange();
	}

	periodSelect.addEventListener("change", () => {
		customRange.toggleClass("is-hidden", periodSelect.value !== PERIOD_CUSTOM);
		// A new year means new months, and the week that was showing belonged to the old one.
		populateMonthSelect(periodSelect.value, "");
		populateWeekSelect("", "");
		commit();
	});
	monthSelect.addEventListener("change", () => {
		populateWeekSelect(monthSelect.value, "");
		commit();
	});
	weekSelect.addEventListener("change", commit);
	dateFrom.addEventListener("change", commit);
	dateTo.addEventListener("change", commit);

	return {
		reset(): void {
			selection.period = PERIOD_ALL;
			selection.month = "";
			selection.week = "";
			selection.from = "";
			selection.to = "";
			periodSelect.value = PERIOD_ALL;
			populateMonthSelect(PERIOD_ALL, "");
			populateWeekSelect("", "");
			customRange.addClass("is-hidden");
			dateFrom.value = "";
			dateTo.value = "";
		},
	};
}
