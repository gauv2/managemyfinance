import { summarizeByYear, yearSummaryFor } from "../../kpi";
import type FinancePlugin from "../../main";
import { formatMoney } from "../../money";
import { GoalModal } from "../../modals/GoalModal";
import { debtByAccount, goalCurrentAmount, goalStatus, orderDebtPayoff, reserveStatus } from "../../strategy";
import { badge, emptyState, icon, statTile } from "../../ui/dom";
import { renderMeter } from "../../ui/kpiCard";
import { formatPct } from "../../ui/metricsTable";
import { openStrategyWizard } from "../../wizards/StrategyWizard";

function cardHeadRow(parent: HTMLElement, title: string): HTMLElement {
	const head = parent.createDiv({ cls: "fp-card-head-row" });
	head.createEl("h3", { text: title });
	return head;
}

/** A ratio safe for renderMeter (and for reading) when the target itself might be zero — an untargeted
 *  reserve reads as "met" rather than as a divide-by-zero, since there's nothing left to reach. */
function safeRatio(have: number, target: number): number {
	if (target <= 0) return have > 0 ? 1 : 0;
	return have / target;
}

export function renderStrategySection(container: HTMLElement, plugin: FinancePlugin): void {
	container.addClass("fp-section");
	const store = plugin.store;

	function render(): void {
		container.empty();
		const strategy = store.strategy;

		const header = container.createDiv({ cls: "fp-section-header" });
		const headText = header.createDiv({ cls: "fp-section-header-text" });
		const titleRow = headText.createDiv({ cls: "fp-section-title-row" });
		icon(titleRow.createDiv({ cls: "fp-section-icon-badge" }), "compass");
		titleRow.createEl("h2", { text: "Strategy" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: "The plan your ledger gets checked against — reserve, debt, goals, and how you decided to spend on purpose.",
		});
		const headerActions = header.createDiv({ cls: "fp-section-header-actions" });
		const editBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(editBtn, "pencil");
		editBtn.createSpan({ text: strategy.completedAt ? "Edit strategy" : "Define your strategy" });
		editBtn.addEventListener("click", () => openStrategyWizard(plugin, { onSaved: render }));

		if (!strategy.completedAt) {
			emptyState(container, {
				iconName: "compass",
				title: "No strategy defined yet",
				description: "Walk through six short steps — where you are, what you're aiming for, and how you'll check the plan against reality.",
				actionLabel: "Define your strategy",
				onAction: () => openStrategyWizard(plugin, { onSaved: render }),
			});
			return;
		}

		// --- next review banner ---
		if (strategy.review.nextReviewDate) {
			const todayStr = new Date().toISOString().slice(0, 10);
			const daysUntil = Math.round((Date.parse(strategy.review.nextReviewDate) - Date.parse(todayStr)) / 86_400_000);
			const banner = container.createDiv({ cls: "fp-strategy-review-banner" + (daysUntil <= 0 ? " is-due" : "") });
			banner.createDiv({
				text: daysUntil <= 0 ? `Review overdue since ${strategy.review.nextReviewDate}` : `Next review: ${strategy.review.nextReviewDate} (in ${daysUntil}d)`,
			});
			const reviewBtn = banner.createEl("button", { cls: "fp-btn fp-btn-primary" });
			icon(reviewBtn, "refresh-cw");
			reviewBtn.createSpan({ text: "Review now" });
			reviewBtn.addEventListener("click", () => openStrategyWizard(plugin, { onSaved: render, initialStepId: "cadence" }));
		}

		// --- reserve status ---
		const reserveCard = container.createDiv({ cls: "fp-card" });
		cardHeadRow(reserveCard, "Emergency reserve");
		const status = reserveStatus(store, strategy.reserve);
		renderMeter(reserveCard, {
			label: "Unexpected-expense buffer",
			value: safeRatio(status.bufferHave, strategy.reserve.bufferTarget),
			valueLabel: formatPct(safeRatio(status.bufferHave, strategy.reserve.bufferTarget)),
			sub: `${formatMoney(status.bufferHave)} of ${formatMoney(strategy.reserve.bufferTarget)} target`,
		});
		renderMeter(reserveCard, {
			label: `Income-loss reserve (${strategy.reserve.incomeLossMonths} months)`,
			value: safeRatio(status.incomeLossHave, status.incomeLossTarget),
			valueLabel: formatPct(safeRatio(status.incomeLossHave, status.incomeLossTarget)),
			sub: `${formatMoney(status.incomeLossHave)} of ${formatMoney(status.incomeLossTarget)} target`,
		});

		// --- debt payoff ---
		const debts = debtByAccount(store);
		if (debts.length > 0) {
			const debtCard = container.createDiv({ cls: "fp-card" });
			cardHeadRow(debtCard, `Debt payoff (${strategy.debtPlan.strategy === "avalanche" ? "avalanche" : "snowball"})`);
			const ordered = orderDebtPayoff(debts, strategy.debtPlan.strategy, strategy.debtPlan.includedAccountIds);
			if (ordered.length === 0) {
				debtCard.createDiv({ cls: "fp-step-desc", text: "No debts included in the payoff plan — edit the strategy to add some." });
			} else {
				const list = debtCard.createEl("ol", { cls: "fp-strategy-debt-list" });
				ordered.forEach((d) => {
					const item = list.createEl("li");
					item.createSpan({ cls: "fp-strategy-debt-name", text: d.account.name });
					item.createSpan({
						cls: "fp-money fp-strategy-debt-amount",
						text: `${formatMoney(d.balanceOwed)}${d.account.apr ? ` · ${(d.account.apr * 100).toFixed(1)}% APR` : ""}`,
					});
				});
			}
		}

		// --- goal register ---
		const goalsCard = container.createDiv({ cls: "fp-card" });
		const goalsHead = cardHeadRow(goalsCard, `${strategy.goals.filter((g) => !g.archived).length} goals`);
		const addGoalBtn = goalsHead.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(addGoalBtn, "plus");
		addGoalBtn.createSpan({ text: "Add goal" });
		addGoalBtn.addEventListener("click", () => new GoalModal(plugin.app, plugin, { onSaved: render }).open());

		const activeGoals = strategy.goals.filter((g) => !g.archived).sort((a, b) => a.priority - b.priority);
		if (activeGoals.length === 0) {
			goalsCard.createDiv({ cls: "fp-step-desc", text: "No goals yet." });
		} else {
			const fiYear = yearSummaryFor(summarizeByYear(store));
			const actualMonthlyNet = fiYear ? fiYear.net / 12 : 0;
			const table = goalsCard.createEl("table", { cls: "fp-table" });
			const thead = table.createEl("thead").createEl("tr");
			["Goal", "Target", "Current", "Deadline", "Status", ""].forEach((h) => thead.createEl("th", { text: h }));
			const tbody = table.createEl("tbody");
			activeGoals.forEach((g) => {
				const current = goalCurrentAmount(store, g);
				const status = goalStatus(store, g, actualMonthlyNet);
				const tr = tbody.createEl("tr");
				tr.createEl("td", { text: g.name });
				tr.createEl("td", { text: formatMoney(g.targetAmount), cls: "fp-money" });
				tr.createEl("td", { text: formatMoney(current), cls: "fp-money" });
				tr.createEl("td", { text: g.deadline ?? "—" });
				const statusTd = tr.createEl("td");
				const tone = status === "ahead" ? "good" : status === "behind" ? "bad" : "neutral";
				badge(statusTd, status.replace("-", " "), tone);
				const actionTd = tr.createEl("td");
				const editBtnRow = actionTd.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
				icon(editBtnRow, "pencil");
				editBtnRow.addEventListener("click", () => new GoalModal(plugin.app, plugin, { goal: g, onSaved: render }).open());
			});
		}

		// --- savings rate: target vs actual ---
		const savingsCard = container.createDiv({ cls: "fp-card" });
		cardHeadRow(savingsCard, "Savings rate");
		const actualYear = yearSummaryFor(summarizeByYear(store));
		const savingsGrid = savingsCard.createDiv({ cls: "fp-stat-grid" });
		statTile(savingsGrid, {
			label: "Actual, this year",
			value: formatPct(actualYear?.savingsRate ?? 0),
			iconName: "trending-up",
			money: false,
			tone: (actualYear?.savingsRate ?? 0) * 100 >= strategy.savingsPolicy.targetSavingsRatePct ? "good" : "warn",
		});
		statTile(savingsGrid, {
			label: "Target",
			value: formatPct(strategy.savingsPolicy.targetSavingsRatePct / 100),
			iconName: "target",
			money: false,
		});
		if (strategy.savingsPolicy.horizonNotes) savingsCard.createDiv({ cls: "fp-step-desc", text: strategy.savingsPolicy.horizonNotes });
		if (strategy.savingsPolicy.riskNotes) savingsCard.createDiv({ cls: "fp-step-desc", text: strategy.savingsPolicy.riskNotes });

		// --- rules ---
		if (strategy.rules.length > 0) {
			const rulesCard = container.createDiv({ cls: "fp-card" });
			cardHeadRow(rulesCard, "Personal rules");
			const list = rulesCard.createEl("ul", { cls: "fp-strategy-rules-list" });
			strategy.rules.forEach((rule) => list.createEl("li", { text: rule }));
		}
	}

	render();
}
