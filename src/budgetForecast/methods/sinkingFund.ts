import { descendantIds } from "../../categories";
import { formatMoneyRounded } from "../../money";
import { monthRange } from "../../period";
import { daysBetweenIso } from "../../recurring";
import { baseConfidence, confidenceLabel, type ConfidenceInputs } from "../confidence";
import { detectForecastCommitments } from "../commitments";
import { distributionShape, volatilityLabel } from "../diagnostics";
import { buildCategorySpendHistory } from "../history";
import { detectOutliers } from "../outliers";
import { isIncluded, notForecastable } from "../quantileEngine";
import { quantileR7, relativeIqr } from "../statistics";
import type { BudgetForecastDiagnostics, BudgetForecastRequest, BudgetForecastResult, BudgetForecastScenario, BudgetScenarioKey, ForecastObservation, ForecastStore } from "../types";

/**
 * The sinking-fund method (budget_spec.md §33–34) — car repairs, medical, dentist, electronics,
 * legal, home improvement, large travel: sparse, irregular expenses where a monthly median of raw
 * months is nearly always €0 and tells you nothing. Aggregated by *calendar year* instead, where a
 * year has enough tracked coverage to trust its total, then converted back down to a monthly (or
 * pay-cycle) reserve.
 *
 * A large irregular year is never auto-excluded the way a seasonal outlier is (§23–24) — a €2,800
 * repair is exactly the risk this reserve exists to absorb, so it stays included by default and is
 * surfaced as a *notable* event instead. The user can still exclude one, but the framing is "was this
 * genuinely non-repeatable" (a first car purchase), not "was this unusually large."
 */

/** §16's own coverage bar, reused here for "does this year have enough tracked months to trust its
 *  annual total" — the same "8 of 12" tolerance the seasonal method already established. */
const MIN_YEAR_COVERAGE_MONTHS = 8;
/** §33 — fewer usable years than this and an annual P25/P75 would be reading three data points as a
 *  distribution; fall back to a flat historical average instead. */
const MIN_USABLE_YEARS = 3;
/** Up to this many recent calendar years feed the annual quantiles — deep enough for nearly every
 *  vault, capped the same way the seasonal method caps its own lookback. */
const MAX_LOOKBACK_YEARS = 10;

const AVG_DAYS_PER_MONTH = 365.2425 / 12;

function annualObservations(history: { key: string; economicExpense: number }[]): ForecastObservation[] {
	const byYear = new Map<string, { total: number; trackedMonths: number }>();
	for (const h of history) {
		const year = h.key.slice(0, 4);
		const entry = byYear.get(year) ?? { total: 0, trackedMonths: 0 };
		entry.total += h.economicExpense;
		entry.trackedMonths += 1;
		byYear.set(year, entry);
	}
	const years = Array.from(byYear.keys()).sort();
	const recentYears = years.slice(-MAX_LOOKBACK_YEARS);
	return recentYears
		.filter((year) => byYear.get(year)!.trackedMonths >= MIN_YEAR_COVERAGE_MONTHS)
		.map((year) => ({ id: year, period: year, amount: byYear.get(year)!.total, normalizedValue: byYear.get(year)!.total }));
}

function annualToTarget(annual: number, isCalendarMonth: boolean, targetDays: number): number {
	return isCalendarMonth ? annual / 12 : (annual * targetDays) / 365.2425;
}

function monthlyToTarget(monthly: number, isCalendarMonth: boolean, targetDays: number): number {
	return isCalendarMonth ? monthly : (monthly * targetDays) / AVG_DAYS_PER_MONTH;
}

export function forecastSinkingFund(store: ForecastStore, request: BudgetForecastRequest): BudgetForecastResult {
	const { categoryId, target, scope } = request;
	if (!target.from || !target.to) {
		return notForecastable(request, "sinking-fund", "This forecast needs a concrete date range.");
	}

	const history = buildCategorySpendHistory(store, categoryId, scope);
	if (history.length === 0) {
		return notForecastable(request, "sinking-fund", "No spending history for this category yet.");
	}

	const commitmentCategoryIds = scope === "rollup" ? descendantIds(store.categories, categoryId) : [categoryId];
	const commitments = commitmentCategoryIds.flatMap((id) => detectForecastCommitments(store, id, target));
	const knownCommitments = commitments.reduce((sum, c) => sum + c.amount, 0);

	const targetMonth = target.from.slice(0, 7);
	const expectedRange = monthRange(targetMonth);
	const isCalendarMonth = !!expectedRange && expectedRange.from === target.from && expectedRange.to === target.to;
	const targetDays = daysBetweenIso(target.from, target.to) + 1;

	const observations = annualObservations(history);
	// Large events stay included by default (§23–24) — `detectOutliers` already knows "sinking-fund"
	// means "flag but don't exclude", so this is the same call every other method makes.
	const outliers = detectOutliers(observations, "sinking-fund");
	const outliersById = new Map(outliers.map((o) => [o.id, o]));
	const included = observations.filter((o) => isIncluded(o, outliersById, request.outlierOverrides));
	const includedTotals = included.map((o) => o.normalizedValue);
	const userExcluded = observations.filter((o) => !included.includes(o));

	// §33 asks whether there are enough data points to read a spread from, so the count that gates it
	// has to be years that actually carry spending. `annualObservations` admits a year on *ledger*
	// coverage alone, so a category charged once in seven years still arrived here with seven
	// "observations" — six of them €0 — and sailed past a bar meant to stop exactly that. The amount
	// still uses every year, zeros included: "six years of nothing" is real evidence for how small a
	// reserve needs to be. It just isn't seven observations' worth of confidence.
	const observationsWithSpend = observations.filter((o) => o.amount > 0).length;
	const usable = observationsWithSpend >= MIN_USABLE_YEARS && includedTotals.length > 0;

	let p25Variable: number;
	let p50Variable: number;
	let p75Variable: number;
	let annualP50: number | undefined;
	let fallbackMonthly = 0;

	if (usable) {
		const annualP25 = quantileR7(includedTotals, 0.25)!;
		annualP50 = quantileR7(includedTotals, 0.5)!;
		const annualP75 = quantileR7(includedTotals, 0.75)!;
		p25Variable = annualToTarget(annualP25, isCalendarMonth, targetDays);
		p50Variable = annualToTarget(annualP50, isCalendarMonth, targetDays);
		p75Variable = annualToTarget(annualP75, isCalendarMonth, targetDays);
	} else {
		// §33's fallback: a flat average across every complete observed month, not a median (three or
		// fewer years is too thin to call a spread), with confidence forced low regardless of formula.
		fallbackMonthly = history.reduce((sum, h) => sum + h.economicExpense, 0) / history.length;
		const target_ = monthlyToTarget(fallbackMonthly, isCalendarMonth, targetDays);
		p25Variable = p50Variable = p75Variable = target_;
	}

	const p25Amount = Math.max(0, knownCommitments + p25Variable);
	const p50Amount = Math.max(0, knownCommitments + p50Variable);
	const p75Amount = Math.max(0, knownCommitments + p75Variable);

	const relIqr = usable ? relativeIqr(includedTotals) : 0;
	const sparseMonthRatio = history.filter((h) => h.economicExpense === 0).length / history.length;
	// `recentDataScore` is asking whether there is enough recent evidence to trust a spending level,
	// and an empty month is not evidence of one — feeding it the tracked-month count awarded full
	// marks to a category charged once in seven years. `comparableObservations` deliberately stays the
	// full annual count: the quantiles above really are computed over all seven annual totals, zeros
	// included, so that is the honest sample size for the statistic being scored.
	const monthsWithSpend = history.filter((h) => h.economicExpense > 0).length;
	const confidenceInputs: ConfidenceInputs = {
		comparableObservations: observations.length,
		recentCompleteMonths: Math.min(monthsWithSpend, 24),
		coverageRatio: Math.min(observations.length / MAX_LOOKBACK_YEARS, 1),
		relativeIqr: relIqr,
		outlierRatio: observations.length > 0 ? outliers.length / observations.length : 0,
		sparseMonthRatio,
	};
	const rawScore = Math.max(0, Math.min(100, baseConfidence(confidenceInputs)));
	// §33: "confidence must be low" on the fallback rung — not merely likely to score low, forced.
	const score = usable ? rawScore : Math.min(rawScore, 49);
	const label = confidenceLabel(score);

	function scenario(key: BudgetScenarioKey, labelText: "Lean" | "Typical" | "Buffered", amount: number): BudgetForecastScenario {
		return { key, label: labelText, amount, confidenceScore: score, confidenceLabel: label };
	}
	const p25 = scenario("p25", "Lean", p25Amount);
	const p50 = scenario("p50", "Typical", p50Amount);
	const p75 = scenario("p75", "Buffered", p75Amount);

	const categoryLabel = store.categories.find((c) => c.id === categoryId)?.name ?? categoryId;
	const explanation: string[] = [];
	if (usable) {
		explanation.push(`${categoryLabel} is irregular, so this reserve is built from ${observations.length} years of annual totals rather than a monthly average.`);
		explanation.push(`A typical year has cost about ${formatMoneyRounded(annualP50!)}, reserving ${formatMoneyRounded(p50Variable)} for ${target.label}.`);
	} else {
		explanation.push(`Not enough separate years of history yet for a reliable annual reserve — using your overall average of ${formatMoneyRounded(fallbackMonthly)}/month instead.`);
	}
	if (outliers.length === 1) {
		explanation.push(`${outliers[0].period}: ${formatMoneyRounded(outliers[0].amount)} was a notable large event, included since irregular large expenses are exactly what this reserve is meant to cover.`);
	} else if (outliers.length > 1) {
		explanation.push(`${outliers.length} notable large events are included, since irregular large expenses are exactly what this reserve is meant to cover.`);
	}
	if (userExcluded.length > 0) {
		explanation.push(`${userExcluded.length} event${userExcluded.length === 1 ? "" : "s"} marked non-repeatable ${userExcluded.length === 1 ? "was" : "were"} excluded from this reserve.`);
	}

	const diagnostics: BudgetForecastDiagnostics = {
		method: "sinking-fund",
		targetPeriod: { from: target.from, to: target.to, label: target.label },
		comparableObservations: observations.length,
		recentMonthsUsed: Math.min(history.length, 24),
		baseline: usable ? annualP50 : fallbackMonthly,
		knownCommitments,
		relativeIqr: relIqr,
		volatility: volatilityLabel(relIqr),
		distribution: distributionShape(usable ? includedTotals : [fallbackMonthly], sparseMonthRatio),
		seasonality: "none",
		outlierCount: outliers.length,
		sparseMonthRatio,
		explanation,
	};

	return { categoryId, method: "sinking-fund", forecastable: true, p25, p50, p75, recommendedDefault: "p50", outliers, diagnostics };
}
