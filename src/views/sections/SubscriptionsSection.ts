import { Notice } from "obsidian";
import type FinancePlugin from "../../main";
import {
	BILLING_CYCLE_LABEL,
	SUBSCRIPTION_CATEGORIES,
	daysUntil,
	type ExchangeRates,
	formatMoney,
	isActive,
	monthlyCost,
	monthlyCostInBase,
	nextOccurrence,
	subCurrency,
	subscriptionTotals,
	totalsByBillingCycle,
	totalsByCategory,
	totalsByPaidVia,
	upcomingPayments,
} from "../../subscriptions";
import type { Subscription } from "../../types";
import { barChart, stackedShareBar } from "../../ui/charts";
import { badge, emptyState, icon, initialsAvatar, statTile } from "../../ui/dom";
import { openSubscriptionWizard } from "../../wizards/SubscriptionWizard";

const CAT_COLORS = ["var(--fp-cat-1)", "var(--fp-cat-2)", "var(--fp-cat-3)", "var(--fp-cat-4)", "var(--fp-cat-5)"];
const DUE_SOON_DAYS = 7;

function formatEUR(n: number): string {
	return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(n);
}

function formatDateLabel(iso: string): string {
	const d = new Date(`${iso}T00:00:00`);
	if (isNaN(d.getTime())) return iso;
	return new Intl.DateTimeFormat("en-IE", { day: "numeric", month: "short", year: "numeric" }).format(d);
}

function formatRelativeDays(days: number): string {
	if (days === 0) return "today";
	if (days < 0) return `${-days}d overdue`;
	return `in ${days}d`;
}

function categoryColor(category: string): string {
	const idx = SUBSCRIPTION_CATEGORIES.indexOf(category);
	return CAT_COLORS[(idx < 0 ? 0 : idx) % CAT_COLORS.length];
}

function cardHeadRow(parent: HTMLElement, title: string, label?: string): HTMLElement {
	const head = parent.createDiv({ cls: "fp-card-head-row" });
	head.createEl("h3", { text: title });
	if (label) head.createDiv({ cls: "fp-card-head-label", text: label });
	return head;
}

/**
 * A standalone recurring-payments tracker: not tied to any account or ledger — subscriptions are
 * entered by hand and normalised to a monthly figure so wildly different billing cycles compare
 * cleanly. Everything here persists to data/subscriptions.json via the store, same as accounts/categories.
 */
export function renderSubscriptionsSection(container: HTMLElement, plugin: FinancePlugin): void {
	container.addClass("fp-section");

	function render(): void {
		container.empty();
		const store = plugin.store;
		const subs = store.subscriptions;
		const today = new Date();
		const rates = plugin.settings.exchangeRates;

		const header = container.createDiv({ cls: "fp-section-header" });
		const headText = header.createDiv();
		headText.createEl("h2", { text: "Subscriptions" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: "Everything you pay for on repeat — cost per cycle, next payment date and when each one ends. Totals are normalised to a monthly figure.",
		});
		const headerActions = header.createDiv({ cls: "fp-section-header-actions" });
		const refreshBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(refreshBtn, "refresh-cw");
		refreshBtn.createSpan({ text: "Refresh" });
		refreshBtn.addEventListener("click", () => render());

		const addBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(addBtn, "plus");
		addBtn.createSpan({ text: "Add subscription" });
		addBtn.addEventListener("click", () => openSubscriptionWizard(plugin, undefined, () => render()));

		const totals = subscriptionTotals(subs, rates, today, DUE_SOON_DAYS);
		const kpis = container.createDiv({ cls: "fp-stat-grid" });
		statTile(kpis, { label: "Per month", value: formatEUR(totals.perMonth), iconName: "calendar" });
		statTile(kpis, { label: "Per year", value: formatEUR(totals.perYear), iconName: "calendar-days" });
		statTile(kpis, { label: "Private /mo", value: formatEUR(totals.privatePerMonth), iconName: "user" });
		statTile(kpis, { label: "Business /mo", value: formatEUR(totals.businessPerMonth), iconName: "briefcase", tone: "warn" });
		statTile(kpis, { label: "Active", value: String(totals.activeCount), iconName: "check-circle", tone: "good", money: false });
		statTile(kpis, {
			label: `Due ≤ ${DUE_SOON_DAYS} days`,
			value: String(totals.dueSoonCount),
			iconName: "alarm-clock",
			tone: totals.dueSoonCount > 0 ? "bad" : "neutral",
			money: false,
		});

		if (subs.length === 0) {
			emptyState(container, {
				iconName: "repeat",
				title: "No subscriptions tracked yet",
				description: "Add your first recurring payment to start tracking monthly spend.",
				actionLabel: "Add subscription",
				onAction: () => openSubscriptionWizard(plugin, undefined, () => render()),
			});
		} else {
			const breakdown = container.createDiv({ cls: "fp-sub-breakdown-grid" });
			renderShareCard(breakdown, "By category", totalsByCategory(subs, rates, today), categoryColor);
			renderShareCard(breakdown, "By billing cycle", totalsByBillingCycle(subs, rates, today));
			renderShareCard(breakdown, "Private vs business", totalsByPaidVia(subs, rates, today));

			const topRows = subs
				.filter((s) => isActive(s, today))
				.map((s) => ({ label: s.name, value: monthlyCostInBase(s, rates), color: categoryColor(s.category) }))
				.filter((r) => r.value > 0)
				.sort((a, b) => b.value - a.value)
				.slice(0, 5);
			if (topRows.length > 0) {
				const topCard = container.createDiv({ cls: "fp-card" });
				cardHeadRow(topCard, "Top subscriptions", "MONTHLY COST");
				barChart(topCard, topRows);
			}

			const payments = upcomingPayments(subs, today).slice(0, 5);
			const upcomingCard = container.createDiv({ cls: "fp-card" });
			const upcomingHead = cardHeadRow(upcomingCard, "Upcoming payments");
			if (payments.length > 0) {
				const label = upcomingHead.createDiv({ cls: "fp-card-head-label" });
				label.createSpan({ text: `NEXT ${payments.length} · ` });
				label.createSpan({ cls: "fp-money", text: formatEUR(payments.reduce((s, p) => s + monthlyCostInBase(p.sub, rates), 0)) });
			}
			if (payments.length === 0) {
				upcomingCard.createEl("p", { cls: "fp-step-desc", text: "No upcoming payments." });
			} else {
				const list = upcomingCard.createDiv({ cls: "fp-sub-upcoming-list" });
				payments.forEach((p) => renderUpcomingRow(list, p));
			}
		}

		if (subs.length > 0) renderList(container, subs, today, rates);
	}

	function renderShareCard(
		parent: HTMLElement,
		title: string,
		rows: { label: string; value: number }[],
		colorFor?: (label: string) => string
	): void {
		const card = parent.createDiv({ cls: "fp-card fp-sub-share-card" });
		cardHeadRow(card, title, "MONTHLY SPEND");
		const total = rows.reduce((s, r) => s + r.value, 0);
		if (total <= 0) {
			card.createEl("p", { cls: "fp-step-desc", text: "No spend yet." });
			return;
		}
		stackedShareBar(
			card,
			rows.map((r, i) => ({ label: r.label, value: r.value, color: colorFor ? colorFor(r.label) : CAT_COLORS[i % CAT_COLORS.length] })),
			{ formatValue: formatEUR }
		);
	}

	function renderUpcomingRow(parent: HTMLElement, p: { sub: Subscription; date: string; daysUntil: number }): void {
		const row = parent.createDiv({ cls: "fp-sub-upcoming-row" });
		const dateCol = row.createDiv({ cls: "fp-sub-upcoming-date" });
		dateCol.createDiv({ text: formatDateLabel(p.date) });
		dateCol.createDiv({ cls: "fp-sub-upcoming-relative" + (p.daysUntil <= 0 ? " is-due" : ""), text: formatRelativeDays(p.daysUntil) });

		initialsAvatar(row, p.sub.name, categoryColor(p.sub.category), "fp-sub-upcoming-avatar");

		const info = row.createDiv({ cls: "fp-sub-upcoming-info" });
		const nameLine = info.createDiv({ cls: "fp-sub-upcoming-name-line" });
		nameLine.createSpan({ cls: "fp-sub-upcoming-name", text: p.sub.name });
		badge(nameLine, p.sub.paidVia === "business" ? "BUSINESS" : "PRIVATE", p.sub.paidVia === "business" ? "warn" : "neutral");
		info.createDiv({ cls: "fp-sub-upcoming-meta", text: `${p.sub.category}${p.sub.plan ? " · " + p.sub.plan : ""}` });

		const amount = row.createDiv({ cls: "fp-sub-upcoming-amount fp-money" });
		amount.createDiv({ text: formatMoney(monthlyCost(p.sub), subCurrency(p.sub)) });
		amount.createDiv({ cls: "fp-sub-upcoming-amount-sub", text: "/mo" });
	}

	function renderList(parent: HTMLElement, subs: Subscription[], today: Date, rates: ExchangeRates | undefined): void {
		const card = parent.createDiv({ cls: "fp-card" });
		cardHeadRow(card, `${subs.length} subscription${subs.length === 1 ? "" : "s"}`);

		const groups = new Map<string, Subscription[]>();
		for (const s of subs) {
			if (!groups.has(s.category)) groups.set(s.category, []);
			groups.get(s.category)!.push(s);
		}
		const sortedGroups = Array.from(groups.entries()).sort(
			(a, b) =>
				b[1].reduce((sum, s) => sum + monthlyCostInBase(s, rates), 0) - a[1].reduce((sum, s) => sum + monthlyCostInBase(s, rates), 0)
		);

		sortedGroups.forEach(([category, items]) => {
			const groupTotal = items.reduce((sum, s) => sum + monthlyCostInBase(s, rates), 0);
			const groupLabel = card.createDiv({ cls: "fp-sub-group-label" });
			groupLabel.createSpan({ text: `${category.toUpperCase()} · ` });
			groupLabel.createSpan({ cls: "fp-money", text: `${formatEUR(groupTotal)}/mo` });
			const grid = card.createDiv({ cls: "fp-sub-card-grid" });
			[...items].sort((a, b) => monthlyCostInBase(b, rates) - monthlyCostInBase(a, rates)).forEach((sub) => renderSubCard(grid, sub, today));
		});
	}

	function renderSubCard(parent: HTMLElement, sub: Subscription, today: Date): void {
		const card = parent.createDiv({ cls: "fp-sub-card" + (isActive(sub, today) ? "" : " is-inactive") });
		const top = card.createDiv({ cls: "fp-sub-card-top" });
		initialsAvatar(top, sub.name, categoryColor(sub.category), "fp-sub-card-avatar");
		const info = top.createDiv({ cls: "fp-sub-card-info" });
		info.createDiv({ cls: "fp-sub-card-name", text: sub.name });
		if (sub.plan) info.createDiv({ cls: "fp-sub-card-plan", text: sub.plan });

		const amount = top.createDiv({ cls: "fp-sub-card-amount fp-money" });
		amount.createDiv({ text: formatMoney(monthlyCost(sub), subCurrency(sub)) });
		amount.createDiv({ cls: "fp-sub-card-amount-sub", text: "/mo" });

		const meta = card.createDiv({ cls: "fp-sub-card-meta" });
		meta.createSpan({ text: `${sub.category} · ${BILLING_CYCLE_LABEL[sub.billingCycle]}` });
		badge(meta, sub.paidVia === "business" ? "BUSINESS" : "PRIVATE", sub.paidVia === "business" ? "warn" : "neutral");
		const accountName = sub.accountId ? plugin.store.accounts.find((a) => a.id === sub.accountId)?.name : undefined;
		if (accountName) badge(meta, accountName.toUpperCase(), "neutral");

		const next = nextOccurrence(sub, today);
		const dueLine = card.createDiv({ cls: "fp-sub-card-due" });
		if (next) dueLine.setText(`Next due ${formatDateLabel(next)} · ${formatRelativeDays(daysUntil(next, today))}`);
		else dueLine.setText(sub.endDate ? `Ended ${formatDateLabel(sub.endDate)}` : "No upcoming payment");

		if (sub.notes) card.createDiv({ cls: "fp-sub-card-notes", text: sub.notes });

		const actions = card.createDiv({ cls: "fp-sub-card-actions" });
		if (sub.cancelUrl) {
			const linkBtn = actions.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
			icon(linkBtn, "external-link");
			linkBtn.addEventListener("click", () => window.open(sub.cancelUrl, "_blank"));
		}
		const editBtn = actions.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
		icon(editBtn, "pencil");
		editBtn.addEventListener("click", () => openSubscriptionWizard(plugin, sub, () => render()));
		const deleteBtn = actions.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
		icon(deleteBtn, "trash-2");
		deleteBtn.addEventListener("click", () => void remove(sub));
	}

	async function remove(sub: Subscription): Promise<void> {
		plugin.store.subscriptions = plugin.store.subscriptions.filter((s) => s.id !== sub.id);
		await plugin.store.saveSubscriptions();
		new Notice(`Removed "${sub.name}"`);
		render();
	}

	render();
}
