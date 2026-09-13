import { descendantIds } from "../../categories";
import { formatMoneyRounded } from "../../money";
import { baseConfidence, confidenceLabel, type ConfidenceInputs } from "../confidence";
import { detectForecastCommitments, recurringAttributedMonthlySpend } from "../commitments";
import { distributionShape, volatilityLabel } from "../diagnostics";
import { buildCategorySpendHistory } from "../history";
import { notForecastable } from "../quantileEngine";
import { relativeIqr } from "../statistics";
import type { BudgetForecastDiagnostics, BudgetForecastRequest, BudgetForecastResult, BudgetForecastScenario, BudgetScenarioKey, ForecastStore } from "../types";

/**
 * The fixed-commitment method (budget_spec.md §31) — rent, insurance, internet, a stable gym
 * membership, childcare: categories where a real budget answer is one number, not a spread. Returning
 * an artificially different P25/P50/P75 for a truly fixed cost would be inventing uncertainty that
 * isn't there, so all three scenarios carry the exact same amount and the exact same confidence.
 *
 * Priority cascade (§31):
 * 1. a known future commitment for the target period (an explicit subscription or a stable recurring
 *    series that `detectForecastCommitments` already projects forward);
 * 2. the latest tracked non-zero month's amount, when nothing projects into the target itself
 *    (a rent that hasn't yet built up 3 occurrences as a detected series, say);
 *
 * There is deliberately no third rung below those two. A category with tracked months but not one
 * payment of its own has no fixed cost to state, so it comes back not-forecastable rather than as a
 * confident €0 (see the `nonZero` branch below).
 *
 * Confidence is read off the same formula every method uses (§26), fed the amounts actually backing
 * whichever rung of the cascade produced the number — a rent paid identically for three years reads
 * as genuinely high confidence because the sample says so, not because "fixed-commitment" hardcodes a
 * label. Unlike the quantile methods, no P25/P75 tail penalty applies here: there's no tail, since
 * every scenario reads the same fixed number, not three different quantiles of a distribution.
 */
export function forecastFixedCommitment(store: ForecastStore, request: BudgetForecastRequest): BudgetForecastResult {
	const { categoryId, target, scope } = request;
	if (!target.from || !target.to) {
		return notForecastable(request, "fixed-commitment", "This forecast needs a concrete date range.");
	}

	const commitmentCategoryIds = scope === "rollup" ? descendantIds(store.categories, categoryId) : [categoryId];
	const commitments = commitmentCategoryIds.flatMap((id) => detectForecastCommitments(store, id, target));
	const history = buildCategorySpendHistory(store, categoryId, scope);

	let amount: number;
	let sampleAmounts: number[];
	let basis: string;

	if (commitments.length > 0) {
		amount = commitments.reduce((sum, c) => sum + c.amount, 0);
		const attributed = new Map<string, number>();
		for (const id of commitmentCategoryIds) {
			for (const [month, value] of recurringAttributedMonthlySpend(store, id)) {
				attributed.set(month, (attributed.get(month) ?? 0) + value);
			}
		}
		const attributedAmounts = Array.from(attributed.values());
		sampleAmounts = attributedAmounts.length > 0 ? attributedAmounts : [amount];
		basis = `a known ${commitments.every((c) => c.source === "subscription") ? "subscription" : "recurring"} charge`;
	} else {
		const nonZero = history.filter((h) => h.economicExpense > 0);
		if (nonZero.length > 0) {
			amount = nonZero[nonZero.length - 1].economicExpense;
			sampleAmounts = nonZero.slice(-24).map((h) => h.economicExpense);
			basis = "your most recent payment";
		} else if (history.length > 0) {
			// Tracked months exist, but not one of them carries a payment for *this* category. The
			// median of an all-zero series is zero, so the old "historical average" rung could only
			// ever answer €0 — and then reported the empty month buckets as if they were payments
			// ("79 historical payments back this estimate" for a category with none), at a confidence
			// score the all-zero `sparseMonthRatio` never got to penalise. A fixed cost nobody has
			// ever been charged isn't a €0 budget; it's an absence of evidence.
			return notForecastable(
				request,
				"fixed-commitment",
				"No payments recorded for this category yet, so there's no fixed cost to base a budget on."
			);
		} else {
			return notForecastable(request, "fixed-commitment", "No spending history for this category yet.");
		}
	}

	const relIqr = relativeIqr(sampleAmounts);
	const sparseMonthRatio = history.length > 0 ? history.filter((h) => h.economicExpense === 0).length / history.length : 0;
	const confidenceInputs: ConfidenceInputs = {
		comparableObservations: sampleAmounts.length,
		recentCompleteMonths: Math.min(sampleAmounts.length, 24),
		coverageRatio: Math.min(sampleAmounts.length / 24, 1),
		relativeIqr: relIqr,
		outlierRatio: 0,
		sparseMonthRatio,
	};
	const score = Math.max(0, Math.min(100, baseConfidence(confidenceInputs)));
	const label = confidenceLabel(score);

	function scenario(key: BudgetScenarioKey, labelText: "Lean" | "Typical" | "Buffered"): BudgetForecastScenario {
		return { key, label: labelText, amount: Math.max(0, amount), confidenceScore: score, confidenceLabel: label };
	}
	const p25 = scenario("p25", "Lean");
	const p50 = scenario("p50", "Typical");
	const p75 = scenario("p75", "Buffered");

	const categoryLabel = store.categories.find((c) => c.id === categoryId)?.name ?? categoryId;
	const explanation: string[] = [`${categoryLabel} is treated as a fixed cost of about ${formatMoneyRounded(amount)}, based on ${basis}.`];
	explanation.push(`${sampleAmounts.length} historical payment${sampleAmounts.length === 1 ? "" : "s"} back${sampleAmounts.length === 1 ? "s" : ""} this estimate.`);
	if (relIqr > 0.05) {
		explanation.push(`This category isn't perfectly stable — recent amounts vary by about ${Math.round(relIqr * 100)}%.`);
	}

	const diagnostics: BudgetForecastDiagnostics = {
		method: "fixed-commitment",
		targetPeriod: { from: target.from, to: target.to, label: target.label },
		comparableObservations: sampleAmounts.length,
		recentMonthsUsed: Math.min(sampleAmounts.length, 24),
		baseline: amount,
		knownCommitments: commitments.length > 0 ? amount : 0,
		relativeIqr: relIqr,
		volatility: volatilityLabel(relIqr),
		distribution: distributionShape(sampleAmounts, sparseMonthRatio),
		seasonality: "none",
		outlierCount: 0,
		sparseMonthRatio,
		explanation,
	};

	return { categoryId, method: "fixed-commitment", forecastable: true, p25, p50, p75, recommendedDefault: "p50", outliers: [], diagnostics };
}
