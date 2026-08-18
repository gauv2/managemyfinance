import { Notice } from "obsidian";
import { primaryCategories } from "../categories";
import type FinancePlugin from "../main";
import { netWorth, summarizeByYear, yearSummaryFor } from "../kpi";
import { formatMoney } from "../money";
import { GoalModal } from "../modals/GoalModal";
import { debtByAccount, goalCurrentAmount, goalStatus, nextReviewDate, orderDebtPayoff, reserveStatus, suggestReserveMonths } from "../strategy";
import { isActive } from "../subscriptions";
import type { DebtPayoffStrategy, FinancialGoal, ReviewCadence } from "../types";
import { badge, icon, moneyInput, statTile } from "../ui/dom";
import { formatPct } from "../ui/metricsTable";
import { formField, formSelectFieldVL, formTextAreaField } from "./formHelpers";
import { WizardModal, type WizardControls, WizardStep } from "./WizardModal";

const RULE_SUGGESTIONS = [
	"I don't carry a credit-card balance for discretionary purchases.",
	"Purchases above €500 get a 48-hour cooling-off period.",
	"My emergency reserve isn't used for holidays or normal shopping.",
	"Salary increases go partly to saving before lifestyle spending grows.",
	"I don't invest money I'll need within the next few years.",
];

const CADENCE_OPTIONS: { value: ReviewCadence; label: string }[] = [
	{ value: "monthly", label: "Monthly" },
	{ value: "quarterly", label: "Quarterly" },
	{ value: "annual", label: "Annually" },
];

/**
 * Walks the six-step planning cycle (situation, goals, alternatives, evaluation, action, review) once
 * to produce a written Strategy — reserve targets, a debt payoff plan, a goal register, a savings/
 * investing policy, personal rules and a review cadence. Reopening it (e.g. from "Review now") starts
 * from whatever is already saved, same as every other edit-in-place wizard in this app.
 */
export function openStrategyWizard(plugin: FinancePlugin, opts: { onSaved?: () => void; initialStepId?: string } = {}): void {
	const store = plugin.store;
	const strategy = store.strategy;

	let bufferTarget: number | undefined = strategy.reserve.bufferTarget;
	let incomeLossMonths: number | undefined = strategy.reserve.incomeLossMonths;
	let debtStrategy: DebtPayoffStrategy = strategy.debtPlan.strategy;
	// Everything owed is a reasonable default the first time through; a returning user's own choice is
	// respected exactly as saved, including "none" if they deliberately cleared it.
	const includedDebtIds = new Set(
		strategy.debtPlan.includedAccountIds.length > 0 || strategy.completedAt
			? strategy.debtPlan.includedAccountIds
			: debtByAccount(store).map((d) => d.account.id)
	);
	let targetSavingsRatePct: number | undefined = strategy.savingsPolicy.targetSavingsRatePct;
	let horizonNotes = strategy.savingsPolicy.horizonNotes ?? "";
	let riskNotes = strategy.savingsPolicy.riskNotes ?? "";
	const rules = [...strategy.rules];
	let cadence: ReviewCadence = strategy.review.cadence;
	let goalsSeeded = false;

	function renderGoalsStep(container: HTMLElement, wizard: WizardControls): void {
		container.empty();
		container.createEl("h3", { text: "What is this money for?" });
		container.createDiv({
			cls: "fp-step-desc",
			text: "Each goal is a target, a deadline and a required monthly pace — not just a number floating with no purpose.",
		});

		if (!goalsSeeded && store.strategy.goals.length === 0) {
			goalsSeeded = true;
			const starters: FinancialGoal[] = [];
			const now = new Date().toISOString();
			if (bufferTarget && bufferTarget > 0) {
				starters.push({
					id: `goal-${Date.now()}-buf`,
					name: "Unexpected-expense buffer",
					targetAmount: bufferTarget,
					priority: 1,
					trackingMode: "computed",
					kind: "reserve-buffer",
					createdAt: now,
				});
			}
			if (incomeLossMonths && incomeLossMonths > 0) {
				const target = reserveStatus(store, { bufferTarget: bufferTarget ?? 0, incomeLossMonths }).incomeLossTarget;
				if (target > 0) {
					starters.push({
						id: `goal-${Date.now()}-inc`,
						name: "Income-loss reserve",
						targetAmount: target,
						priority: 2,
						trackingMode: "computed",
						kind: "reserve-income-loss",
						createdAt: now,
					});
				}
			}
			const totalOwed = debtByAccount(store).reduce((sum, d) => sum + d.balanceOwed, 0);
			if (includedDebtIds.size > 0 && totalOwed > 0) {
				starters.push({
					id: `goal-${Date.now()}-debt`,
					name: "Debt to zero",
					targetAmount: totalOwed,
					priority: 3,
					trackingMode: "computed",
					kind: "debt-payoff",
					createdAt: now,
				});
			}
			if (starters.length > 0) {
				store.strategy.goals.push(...starters);
				void store.saveStrategy();
			}
		}

		const fiYear = yearSummaryFor(summarizeByYear(store));
		const actualMonthlyNet = fiYear ? fiYear.net / 12 : 0;

		if (store.strategy.goals.length === 0) {
			container.createDiv({ cls: "fp-step-desc", text: "No goals yet — add the first one below." });
		} else {
			const table = container.createEl("table", { cls: "fp-table" });
			const thead = table.createEl("thead").createEl("tr");
			["Goal", "Target", "Current", "Deadline", "Status", ""].forEach((h) => thead.createEl("th", { text: h }));
			const tbody = table.createEl("tbody");
			[...store.strategy.goals]
				.filter((g) => !g.archived)
				.sort((a, b) => a.priority - b.priority)
				.forEach((g) => {
					const current = goalCurrentAmount(store, g);
					const status = goalStatus(store, g, actualMonthlyNet);
					const tr = tbody.createEl("tr");
					tr.createEl("td", { text: g.name });
					tr.createEl("td", { text: formatMoney(g.targetAmount), cls: "fp-money" });
					tr.createEl("td", { text: formatMoney(current), cls: "fp-money" });
					tr.createEl("td", { text: g.deadline ?? "—" });
					const statusTd = tr.createEl("td");
					const tone = status === "ahead" ? "good" : status === "behind" ? "bad" : status === "on-track" ? "neutral" : "neutral";
					badge(statusTd, status.replace("-", " "), tone);
					const actionTd = tr.createEl("td");
					const editBtn = actionTd.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
					icon(editBtn, "pencil");
					editBtn.addEventListener("click", () => new GoalModal(plugin.app, plugin, { goal: g, onSaved: () => renderGoalsStep(container, wizard) }).open());
				});
		}

		const addBtn = container.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(addBtn, "plus");
		addBtn.createSpan({ text: "Add goal" });
		addBtn.addEventListener("click", () => new GoalModal(plugin.app, plugin, { onSaved: () => renderGoalsStep(container, wizard) }).open());
	}

	const steps: WizardStep[] = [
		{
			id: "today",
			title: "Today",
			icon: "layout-dashboard",
			render: (c) => {
				c.createEl("h3", { text: "Where you are today" });
				c.createDiv({ cls: "fp-step-desc", text: "A quick mirror, not a form — nothing here is editable, it's pulled live from your own ledger." });

				const years = summarizeByYear(store);
				const thisYear = yearSummaryFor(years);
				const totalDebt = debtByAccount(store).reduce((sum, d) => sum + d.balanceOwed, 0);
				const activeSubs = store.subscriptions.filter((s) => isActive(s, new Date())).length;

				const grid = c.createDiv({ cls: "fp-stat-grid" });
				statTile(grid, { label: "Net worth", value: formatMoney(netWorth(store)), iconName: "wallet" });
				statTile(grid, { label: "Income this year", value: formatMoney(thisYear?.income ?? 0), iconName: "arrow-up-right" });
				statTile(grid, { label: "Expenses this year", value: formatMoney(thisYear?.expenses ?? 0), iconName: "arrow-down-right" });
				statTile(grid, { label: "Savings rate this year", value: formatPct(thisYear?.savingsRate), iconName: "percent", money: false });
				statTile(grid, { label: "Total debt", value: formatMoney(totalDebt), iconName: "credit-card", tone: totalDebt > 0 ? "warn" : "good" });
				statTile(grid, { label: "Recurring subscriptions", value: String(activeSubs), iconName: "repeat", money: false });
			},
			canGoNext: () => true,
		},
		{
			id: "framing",
			title: "Needs & wants",
			icon: "scale",
			render: (c) => {
				c.createEl("h3", { text: "Needs, wants and goals" });
				c.createDiv({
					cls: "fp-step-desc",
					text:
						"Needs keep life functioning. Wants improve life today. Goals improve life tomorrow. Flag your essential living costs below — the next step uses them to suggest a reserve target.",
				});
				const chips = c.createDiv({ cls: "fp-category-chips" });
				primaryCategories(store.categories.filter((cat) => !cat.archived)).forEach((cat) => {
					const selected = !!cat.essential;
					const chip = chips.createEl("button", { cls: "fp-rule-suggestion" + (selected ? " is-active" : "") });
					chip.style.setProperty("--fp-chip-color", cat.color);
					icon(chip, cat.icon, "fp-chip-icon");
					chip.createSpan({ text: cat.name });
					chip.addEventListener("click", async () => {
						cat.essential = !cat.essential;
						await store.saveCategories();
						plugin.refreshViews();
						chip.toggleClass("is-active", !!cat.essential);
					});
				});
			},
			canGoNext: () => true,
		},
		{
			id: "reserve",
			title: "Reserve",
			icon: "umbrella",
			render: (c, wizard) => {
				c.createEl("h3", { text: "Emergency reserve" });
				const range = suggestReserveMonths(store);
				c.createDiv({
					cls: "fp-step-desc",
					text: `Two different questions: what could a large unplanned bill cost, and how many months could you cover essential spending with no income? Most households land somewhere between ${range.low} and ${range.high} months for the second one.`,
				});

				const grid = c.createDiv({ cls: "fp-sub-form-grid" });
				const bufferRow = grid.createDiv({ cls: "fp-form-row" });
				bufferRow.createEl("label", { text: "Unexpected-expense buffer" });
				moneyInput(bufferRow.createDiv({ cls: "fp-field-control" }), {
					value: bufferTarget,
					currency: plugin.settings.baseCurrency ?? "EUR",
					allowNegative: false,
					onChange: (v) => {
						bufferTarget = v;
						wizard.refreshFooter();
					},
				});

				const monthsField = formField(grid, "Income-loss reserve (months)", "number", undefined, { min: "0", step: "1" });
				monthsField.input.value = incomeLossMonths !== undefined ? String(incomeLossMonths) : "";
				monthsField.input.addEventListener("input", () => {
					incomeLossMonths = monthsField.input.value === "" ? undefined : Number(monthsField.input.value);
					wizard.refreshFooter();
				});

				const have = reserveStatus(store, { bufferTarget: bufferTarget ?? 0, incomeLossMonths: incomeLossMonths ?? 0 }).bufferHave;
				c.createDiv({ cls: "fp-step-desc", text: `You currently hold ${formatMoney(have)} in liquid accounts (checking, savings, cash).` });
			},
			canGoNext: () => bufferTarget !== undefined && bufferTarget >= 0 && incomeLossMonths !== undefined && incomeLossMonths >= 0,
			blockedReason: () => "Enter both reserve numbers (0 is fine) to continue.",
		},
		{
			id: "debt",
			title: "Debt",
			icon: "trending-down",
			render: (c) => {
				c.createEl("h3", { text: "Debt payoff plan" });
				const debts = debtByAccount(store);
				if (debts.length === 0) {
					c.createDiv({ cls: "fp-step-desc", text: "You're debt-free — nothing to plan here." });
					return;
				}
				c.createDiv({
					cls: "fp-step-desc",
					text: "Avalanche pays the highest interest rate first (cheapest overall). Snowball pays the smallest balance first (fastest early wins).",
				});

				const strategyField = formSelectFieldVL(c, "Payoff strategy", [
					{ value: "avalanche", label: "Avalanche — highest APR first" },
					{ value: "snowball", label: "Snowball — smallest balance first" },
				]);
				strategyField.select.value = debtStrategy;

				const list = c.createDiv({ cls: "fp-form" });
				const previewWrap = c.createDiv();

				function renderPreview(): void {
					previewWrap.empty();
					const ordered = orderDebtPayoff(debts, debtStrategy, Array.from(includedDebtIds));
					if (ordered.length === 0) return;
					previewWrap.createEl("h4", { text: "Payoff order" });
					const ol = previewWrap.createEl("ol");
					ordered.forEach((d) => ol.createEl("li", { text: `${d.account.name} — ${formatMoney(d.balanceOwed)}` }));
				}

				strategyField.select.addEventListener("change", () => {
					debtStrategy = strategyField.select.value as DebtPayoffStrategy;
					renderPreview();
				});

				debts.forEach(({ account, balanceOwed }) => {
					const row = list.createDiv({ cls: "fp-form-row" });
					const label = row.createEl("label");
					const checkbox = label.createEl("input", { type: "checkbox" });
					checkbox.checked = includedDebtIds.has(account.id);
					checkbox.addEventListener("change", () => {
						if (checkbox.checked) includedDebtIds.add(account.id);
						else includedDebtIds.delete(account.id);
						renderPreview();
					});
					label.createSpan({
						text: ` ${account.name} — ${formatMoney(balanceOwed)}${account.apr ? ` at ${(account.apr * 100).toFixed(1)}% APR` : ""}`,
					});
				});

				renderPreview();
			},
			canGoNext: () => true,
		},
		{ id: "goals", title: "Goals", icon: "target", render: (c, wizard) => renderGoalsStep(c, wizard), canGoNext: () => true },
		{
			id: "policy",
			title: "Policy",
			icon: "line-chart",
			render: (c, wizard) => {
				c.createEl("h3", { text: "Savings & investing policy" });
				c.createDiv({
					cls: "fp-step-desc",
					text: "Not a portfolio recommendation — just what you're aiming for and why, so the numbers on the Strategy page have a target to compare against.",
				});
				const grid = c.createDiv({ cls: "fp-sub-form-grid" });
				const rateField = formField(grid, "Target savings rate (%)", "number", undefined, { min: "0", max: "100", step: "1" });
				rateField.input.value = targetSavingsRatePct !== undefined ? String(targetSavingsRatePct) : "";
				rateField.input.addEventListener("input", () => {
					targetSavingsRatePct = rateField.input.value === "" ? undefined : Number(rateField.input.value);
					wizard.refreshFooter();
				});

				const horizonField = formTextAreaField(c, "Time horizon — what is this money for, and when?", "e.g. house deposit in 4 years, retirement in 30");
				horizonField.textarea.value = horizonNotes;
				horizonField.textarea.addEventListener("input", () => (horizonNotes = horizonField.textarea.value));

				const riskField = formTextAreaField(c, "Risk tolerance — how much loss could you sit through without abandoning the plan?", "");
				riskField.textarea.value = riskNotes;
				riskField.textarea.addEventListener("input", () => (riskNotes = riskField.textarea.value));
			},
			canGoNext: () => targetSavingsRatePct !== undefined && targetSavingsRatePct >= 0 && targetSavingsRatePct <= 100,
			blockedReason: () => "Enter a target savings rate between 0 and 100.",
		},
		{
			id: "rules",
			title: "Rules",
			icon: "book-open",
			render: (c) => {
				c.createEl("h3", { text: "Personal financial policy" });
				c.createDiv({ cls: "fp-step-desc", text: "Written once, unpressured, so the same decision doesn't get relitigated every time it comes up." });

				const list = c.createDiv({ cls: "fp-form" });
				function renderList(): void {
					list.empty();
					rules.forEach((rule, i) => {
						const row = list.createDiv({ cls: "fp-form-row" });
						row.createSpan({ text: rule });
						const removeBtn = row.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
						icon(removeBtn, "x");
						removeBtn.addEventListener("click", () => {
							rules.splice(i, 1);
							renderList();
						});
					});
				}
				renderList();

				const addRow = c.createDiv({ cls: "fp-form-row" });
				const input = addRow.createEl("input", { type: "text", attr: { placeholder: "Add a rule…" } });
				const addBtn = addRow.createEl("button", { cls: "fp-btn fp-btn-secondary", text: "Add" });
				const addRule = () => {
					if (input.value.trim()) {
						rules.push(input.value.trim());
						input.value = "";
						renderList();
					}
				};
				addBtn.addEventListener("click", addRule);
				input.addEventListener("keydown", (ev) => {
					if (ev.key === "Enter") {
						ev.preventDefault();
						addRule();
					}
				});

				c.createEl("h4", { text: "A few to start from" });
				const chipWrap = c.createDiv({ cls: "fp-rule-suggestions" });
				RULE_SUGGESTIONS.forEach((s) => {
					const chip = chipWrap.createEl("button", { cls: "fp-rule-suggestion" });
					chip.createSpan({ cls: "fp-rule-suggestion-label", text: s });
					chip.addEventListener("click", () => {
						if (!rules.includes(s)) {
							rules.push(s);
							renderList();
						}
					});
				});
			},
			canGoNext: () => true,
		},
		{
			id: "cadence",
			title: "Review",
			icon: "calendar-clock",
			render: (c, wizard) => {
				c.createEl("h3", { text: "How often will you check this against reality?" });
				c.createDiv({
					cls: "fp-step-desc",
					text: "The book's whole point: this isn't a document you write once. It's a loop — review feeds back into where you are today.",
				});
				const cadenceField = formSelectFieldVL(
					c,
					"Review cadence",
					CADENCE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))
				);
				cadenceField.select.value = cadence;
				const nextDateEl = c.createDiv({ cls: "fp-step-desc" });
				const updateNextDate = () => nextDateEl.setText(`Next review: ${nextReviewDate(cadence)}`);
				updateNextDate();
				cadenceField.select.addEventListener("change", () => {
					cadence = cadenceField.select.value as ReviewCadence;
					updateNextDate();
					wizard.refreshFooter();
				});
			},
			canGoNext: () => true,
			nextLabel: "Save strategy",
			onNext: async () => {
				store.strategy.reserve = { bufferTarget: bufferTarget ?? 0, incomeLossMonths: incomeLossMonths ?? 0 };
				store.strategy.debtPlan = { strategy: debtStrategy, includedAccountIds: Array.from(includedDebtIds) };
				store.strategy.savingsPolicy = {
					targetSavingsRatePct: targetSavingsRatePct ?? 0,
					horizonNotes: horizonNotes.trim() || undefined,
					riskNotes: riskNotes.trim() || undefined,
				};
				store.strategy.rules = rules;
				const now = new Date().toISOString();
				store.strategy.review = { cadence, lastReviewedAt: now, nextReviewDate: nextReviewDate(cadence) };
				if (!store.strategy.completedAt) store.strategy.completedAt = now;

				await store.saveStrategy();
				new Notice("Strategy saved.");
				plugin.refreshViews();
				opts.onSaved?.();
			},
		},
	];

	new WizardModal(plugin.app, {
		title: "Define your strategy",
		subtitle: "Where you are, what you're aiming for, and how you'll check the plan against reality.",
		icon: "compass",
		steps,
		initialStepId: opts.initialStepId,
	}).open();
}
