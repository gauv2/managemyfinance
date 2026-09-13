import { Notice } from "obsidian";
import type FinancePlugin from "../../main";
import {
	BILLING_CYCLE_LABEL,
	DISPLAY_CYCLE_LABEL,
	DISPLAY_CYCLE_SUFFIX,
	type DisplayCycle,
	SUBSCRIPTION_CATEGORIES,
	type SubscriptionViewMode,
	costForCycle,
	daysUntil,
	effectiveDisplayCycle,
	type ExchangeRates,
	formatSubMoney,
	isActive,
	latestPriceIncrease,
	monthlyCostInBase,
	nextOccurrence,
	spendOn,
	scaleMonthly,
	subCurrency,
	subscriptionTotals,
	totalsByBillingCycle,
	totalsByCategory,
	totalsByPaidVia,
	upcomingPayments,
} from "../../subscriptions";
import { formatMoney } from "../../money";
import { DetectedSubscriptionsModal, SubscriptionPaymentsModal } from "../../modals/SubscriptionLinkModal";
import type { Subscription } from "../../types";
import { barChart, stackedShareBar } from "../../ui/charts";
import { badge, emptyState, icon, initialsAvatar, statTile } from "../../ui/dom";
import { openSubscriptionWizard } from "../../wizards/SubscriptionWizard";

/** Ten slots, not the palette's first five: there are twelve subscription categories, and a legend
 *  that shows six of them cannot say which band is which if two share a colour. */
const CAT_COLORS = [
	"var(--fp-cat-1)",
	"var(--fp-cat-2)",
	"var(--fp-cat-3)",
	"var(--fp-cat-4)",
	"var(--fp-cat-5)",
	"var(--fp-cat-6)",
	"var(--fp-cat-7)",
	"var(--fp-cat-8)",
	"var(--fp-cat-9)",
	"var(--fp-cat-10)",
];
const DUE_SOON_DAYS = 7;

function formatEUR(n: number): string {
	return formatMoney(n);
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

/**
 * A category's colour, stable for the life of the category name.
 *
 * Anything the list doesn't recognise used to fall to index 0 and come out as the same blue as "AI".
 * Older labels survive in saved data — a subscription filed under "Cloud" before the option became
 * "Cloud & Storage" keeps the string it was saved with — so one legend could show "AI", "Cloud" and
 * "Other" as three identical dots with no way to tell which band was which. Hashing the name puts an
 * unknown category on its own slot instead of borrowing the first one.
 */
function categoryColor(category: string): string {
	return CAT_COLORS[categorySlot(category)];
}

function categorySlot(category: string): number {
	const idx = SUBSCRIPTION_CATEGORIES.indexOf(category);
	return (idx < 0 ? hashSlot(category) : idx) % CAT_COLORS.length;
}

function hashSlot(text: string): number {
	let h = 0;
	for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
	return h;
}

/**
 * Colours for one legend, guaranteed distinct.
 *
 * categoryColor is stable per name, which is what the avatars and the top-subscriptions bars need so
 * a category looks the same everywhere. Stability on its own doesn't stop two categories in the *same*
 * legend landing on one slot, though — twelve categories over ten slots means some pair always can —
 * and a chart showing "Streaming" and "Other" in identical orange cannot be read at all. Each keeps
 * its own colour where the slot is free and takes the next free one where it isn't, so the common
 * case is unchanged and the unreadable case cannot happen.
 */
function distinctCategoryColors(labels: string[]): (label: string) => string {
	const used = new Set<number>();
	const chosen = new Map<string, string>();
	const displaced: string[] = [];

	// Two passes, so only the category that actually collides moves. Assigning in one pass let a
	// displaced label take the next slot along and evict whichever category that slot belonged to:
	// "Other" pushed off "Streaming"'s orange landed on green, and "Software" — which owns green —
	// was shunted to pink. Everyone keeps their own colour first; the leftovers fill the gaps after.
	for (const label of labels) {
		const slot = categorySlot(label);
		if (used.has(slot)) {
			displaced.push(label);
			continue;
		}
		used.add(slot);
		chosen.set(label, CAT_COLORS[slot]);
	}
	for (const label of displaced) {
		const preferred = categorySlot(label);
		let slot = preferred;
		for (let step = 1; step <= CAT_COLORS.length && used.has(slot); step++) {
			slot = (preferred + step) % CAT_COLORS.length;
		}
		used.add(slot);
		chosen.set(label, CAT_COLORS[slot]);
	}
	return (label) => chosen.get(label) ?? categoryColor(label);
}

/** "MONTHLY SPEND" / "YEARLY SPEND" — the caption every chart and group total carries so a figure is
 *  never ambiguous about which basis it's in, whichever way the page toggle is set. */
function spendCaption(cycle: DisplayCycle): string {
	return cycle === "yearly" ? "YEARLY SPEND" : "MONTHLY SPEND";
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
		const view: SubscriptionViewMode = plugin.settings.subscriptionView ?? "monthly";
		// Aggregates need one shared basis even in "mixed" mode; monthly is the natural one, since every
		// normalisation in subscriptions.ts already goes through it.
		const basis: DisplayCycle = view === "yearly" ? "yearly" : "monthly";

		const header = container.createDiv({ cls: "fp-section-header" });
		const headText = header.createDiv();
		headText.createEl("h2", { text: "Subscriptions" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: "Everything you pay for on repeat — cost per cycle, next payment date and when each one ends. Totals are normalised to a monthly figure.",
		});
		const headerActions = header.createDiv({ cls: "fp-section-header-actions" });

		// The page-level basis. "Mixed" defers to each subscription's own displayCycle, which is why the
		// KPI row keeps showing both a monthly and a yearly total in that mode — with the cards quoted in
		// different units, a single headline number would have nothing to be the total *of*.
		const viewToggle = headerActions.createDiv({ cls: "fp-segmented fp-sub-view-toggle" });
		(
			[
				["monthly", DISPLAY_CYCLE_LABEL.monthly],
				["yearly", DISPLAY_CYCLE_LABEL.yearly],
				["per-subscription", "Mixed"],
			] as [SubscriptionViewMode, string][]
		).forEach(([mode, label]) => {
			const btn = viewToggle.createEl("button", {
				cls: "fp-segmented-btn" + (view === mode ? " is-active" : ""),
				text: label,
			});
			btn.setAttribute(
				"title",
				mode === "per-subscription"
					? "Quote each subscription however it's set individually"
					: `Quote everything ${mode === "yearly" ? "per year" : "per month"}`
			);
			btn.addEventListener("click", async () => {
				if (view === mode) return;
				plugin.settings.subscriptionView = mode;
				await plugin.saveSettings();
				render();
			});
		});

		const refreshBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(refreshBtn, "refresh-cw");
		refreshBtn.createSpan({ text: "Refresh" });
		refreshBtn.addEventListener("click", () => render());

		const detectBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(detectBtn, "search");
		detectBtn.createSpan({ text: "Find recurring" });
		detectBtn.setAttribute("title", "Scan the ledger for regular charges that aren't tracked as subscriptions yet");
		detectBtn.addEventListener("click", () => new DetectedSubscriptionsModal(plugin.app, plugin, () => render()).open());

		const addBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(addBtn, "plus");
		addBtn.createSpan({ text: "Add subscription" });
		addBtn.addEventListener("click", () => openSubscriptionWizard(plugin, undefined, () => render()));

		const totals = subscriptionTotals(subs, rates, today, DUE_SOON_DAYS);
		const suffix = DISPLAY_CYCLE_SUFFIX[basis];
		const kpis = container.createDiv({ cls: "fp-stat-grid" });
		// The headline total leads with whichever basis is selected; the other stays alongside it, since
		// "what does this cost me a year" and "what does it cost me a month" are both always worth seeing.
		if (basis === "yearly") {
			statTile(kpis, { label: "Per year", value: formatEUR(totals.perYear), iconName: "calendar-days" });
			statTile(kpis, { label: "Per month", value: formatEUR(totals.perMonth), iconName: "calendar" });
		} else {
			statTile(kpis, { label: "Per month", value: formatEUR(totals.perMonth), iconName: "calendar" });
			statTile(kpis, { label: "Per year", value: formatEUR(totals.perYear), iconName: "calendar-days" });
		}
		statTile(kpis, {
			label: `Private ${suffix}`,
			value: formatEUR(scaleMonthly(totals.privatePerMonth, basis)),
			iconName: "user",
		});
		statTile(kpis, {
			label: `Business ${suffix}`,
			value: formatEUR(scaleMonthly(totals.businessPerMonth, basis)),
			iconName: "briefcase",
			tone: "warn",
		});
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
			const categoryTotals = totalsByCategory(subs, rates, today);
			renderShareCard(breakdown, "By category", categoryTotals, basis, distinctCategoryColors(categoryTotals.map((r) => r.label)));
			renderShareCard(breakdown, "By billing cycle", totalsByBillingCycle(subs, rates, today), basis);
			renderShareCard(breakdown, "Private vs business", totalsByPaidVia(subs, rates, today), basis);

			const topRows = subs
				.filter((s) => isActive(s, today))
				.map((s) => ({ label: s.name, value: scaleMonthly(monthlyCostInBase(s, rates), basis), color: categoryColor(s.category) }))
				.filter((r) => r.value > 0)
				.sort((a, b) => b.value - a.value)
				.slice(0, 5);
			if (topRows.length > 0) {
				const topCard = container.createDiv({ cls: "fp-card" });
				cardHeadRow(topCard, "Top subscriptions", basis === "yearly" ? "YEARLY COST" : "MONTHLY COST");
				barChart(topCard, topRows);
			}

			const payments = upcomingPayments(subs, today).slice(0, 5);
			const upcomingCard = container.createDiv({ cls: "fp-card" });
			const upcomingHead = cardHeadRow(upcomingCard, "Upcoming payments");
			if (payments.length > 0) {
				const label = upcomingHead.createDiv({ cls: "fp-card-head-label" });
				label.createSpan({ text: `NEXT ${payments.length} · ` });
				label.createSpan({
					cls: "fp-money",
					text: formatEUR(scaleMonthly(payments.reduce((s, p) => s + monthlyCostInBase(p.sub, rates), 0), basis)),
				});
			}
			if (payments.length === 0) {
				upcomingCard.createEl("p", { cls: "fp-step-desc", text: "No upcoming payments." });
			} else {
				const list = upcomingCard.createDiv({ cls: "fp-sub-upcoming-list" });
				payments.forEach((p) => renderUpcomingRow(list, p, view));
			}
		}

		if (subs.length > 0) renderList(container, subs, today, rates, view, basis);
	}

	function renderShareCard(
		parent: HTMLElement,
		title: string,
		rows: { label: string; value: number }[],
		basis: DisplayCycle,
		colorFor?: (label: string) => string
	): void {
		const card = parent.createDiv({ cls: "fp-card fp-sub-share-card" });
		cardHeadRow(card, title, spendCaption(basis));
		// These aggregates all arrive monthly; scaling here keeps subscriptions.ts free of display concerns.
		const scaled = rows.map((r) => ({ ...r, value: scaleMonthly(r.value, basis) }));
		const total = scaled.reduce((s, r) => s + r.value, 0);
		if (total <= 0) {
			card.createEl("p", { cls: "fp-step-desc", text: "No spend yet." });
			return;
		}
		stackedShareBar(
			card,
			scaled.map((r, i) => ({ label: r.label, value: r.value, color: colorFor ? colorFor(r.label) : CAT_COLORS[i % CAT_COLORS.length] })),
			{ formatValue: formatEUR }
		);
	}

	function renderUpcomingRow(
		parent: HTMLElement,
		p: { sub: Subscription; date: string; daysUntil: number },
		view: SubscriptionViewMode
	): void {
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

		const cycle = effectiveDisplayCycle(p.sub, view);
		const amount = row.createDiv({ cls: "fp-sub-upcoming-amount fp-money" });
		amount.createDiv({ text: formatSubMoney(costForCycle(p.sub, cycle), subCurrency(p.sub)) });
		amount.createDiv({ cls: "fp-sub-upcoming-amount-sub", text: DISPLAY_CYCLE_SUFFIX[cycle] });
	}

	function renderList(
		parent: HTMLElement,
		subs: Subscription[],
		today: Date,
		rates: ExchangeRates | undefined,
		view: SubscriptionViewMode,
		basis: DisplayCycle
	): void {
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
			groupLabel.createSpan({ cls: "fp-money", text: `${formatEUR(scaleMonthly(groupTotal, basis))}${DISPLAY_CYCLE_SUFFIX[basis]}` });
			const grid = card.createDiv({ cls: "fp-sub-card-grid" });
			[...items]
				.sort((a, b) => monthlyCostInBase(b, rates) - monthlyCostInBase(a, rates))
				.forEach((sub) => renderSubCard(grid, sub, today, view));
		});
	}

	function renderSubCard(parent: HTMLElement, sub: Subscription, today: Date, view: SubscriptionViewMode): void {
		const card = parent.createDiv({ cls: "fp-sub-card" + (isActive(sub, today) ? "" : " is-inactive") });
		const top = card.createDiv({ cls: "fp-sub-card-top" });
		initialsAvatar(top, sub.name, categoryColor(sub.category), "fp-sub-card-avatar");
		const info = top.createDiv({ cls: "fp-sub-card-info" });
		info.createDiv({ cls: "fp-sub-card-name", text: sub.name });
		if (sub.plan) info.createDiv({ cls: "fp-sub-card-plan", text: sub.plan });

		const cycle = effectiveDisplayCycle(sub, view);
		const amount = top.createDiv({ cls: "fp-sub-card-amount fp-money" });
		amount.createDiv({ text: formatSubMoney(costForCycle(sub, cycle), subCurrency(sub)) });
		amount.createDiv({ cls: "fp-sub-card-amount-sub", text: DISPLAY_CYCLE_SUFFIX[cycle] });
		// The other basis, quietly, so switching the toggle is never needed just to sanity-check a figure.
		amount.createDiv({
			cls: "fp-sub-card-amount-alt",
			text: `${formatSubMoney(costForCycle(sub, cycle === "yearly" ? "monthly" : "yearly"), subCurrency(sub))}${
				DISPLAY_CYCLE_SUFFIX[cycle === "yearly" ? "monthly" : "yearly"]
			}`,
		});

		const meta = card.createDiv({ cls: "fp-sub-card-meta" });
		// Billed-every vs quoted-per are different things, so the card says which cadence it's actually charged on.
		meta.createSpan({ text: `${sub.category} · billed ${BILLING_CYCLE_LABEL[sub.billingCycle].toLowerCase()}` });
		badge(meta, sub.paidVia === "business" ? "BUSINESS" : "PRIVATE", sub.paidVia === "business" ? "warn" : "neutral");
		const accountName = sub.accountId ? plugin.store.accounts.find((a) => a.id === sub.accountId)?.name : undefined;
		if (accountName) badge(meta, accountName.toUpperCase(), "neutral");

		const next = nextOccurrence(sub, today);
		const dueLine = card.createDiv({ cls: "fp-sub-card-due" });
		if (next) dueLine.setText(`Next due ${formatDateLabel(next)} · ${formatRelativeDays(daysUntil(next, today))}`);
		else dueLine.setText(sub.endDate ? `Ended ${formatDateLabel(sub.endDate)}` : "No upcoming payment");

		if (sub.notes) card.createDiv({ cls: "fp-sub-card-notes", text: sub.notes });

		// What this subscription has *actually* cost, from the ledger — and a quiet warning when those
		// payments disagree with the cost on record, which is how a price rise gets noticed at all.
		const spend = spendOn(plugin.store.transactions, sub, plugin.settings.exchangeRates, plugin.settings.baseCurrency);
		const increase = latestPriceIncrease(plugin.store.transactions, sub);
		if (spend.count > 0) {
			const paidLine = card.createDiv({ cls: "fp-sub-card-paid" });
			paidLine.setText(`${spend.count} payment${spend.count === 1 ? "" : "s"} mapped · ${formatSubMoney(spend.total, subCurrency(sub))} paid`);
			if (increase) badge(paidLine, `+${Math.round(increase.delta * 100)}% on ${increase.date}`, "warn");
			else if (spend.lastAmount !== undefined && Math.abs(spend.lastAmount - sub.cost) / Math.max(sub.cost, 0.01) > 0.02) {
				badge(paidLine, `last charge ${formatSubMoney(spend.lastAmount, subCurrency(sub))}`, "warn");
			}
		}

		const actions = card.createDiv({ cls: "fp-sub-card-actions" });
		const paymentsBtn = actions.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
		icon(paymentsBtn, "receipt");
		paymentsBtn.setAttribute("title", "Map ledger transactions to this subscription and see what it has really cost");
		paymentsBtn.addEventListener("click", () => new SubscriptionPaymentsModal(plugin.app, plugin, sub, () => render()).open());
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
