import { netWorth, netWorthAsOf, summarizeByYear } from "../../../kpi";
import type FinancePlugin from "../../../main";
import { cardsForAccount } from "../../../cards";
import { MonthDrilldownModal } from "../../../modals/MonthDrilldownModal";
import { describeRange, type DateRange } from "../../../period";
import type { Account } from "../../../types";
import { badge, statTile } from "../../../ui/dom";
import { renderMeter } from "../../../ui/kpiCard";
import { deltaRow, formatEUR, metricRow, metricsTable, partialYearsNote, yearHeaderRow, yearLabeller } from "../../../ui/metricsTable";
import { renderSpendingByCategoryCard } from "./SpendingByCategoryCard";

/**
 * A credit card is not a checking account with a different icon, which is exactly how it used to be
 * rendered — routed straight into the checking dashboard, where "current balance" is a positive thing
 * and none of what actually matters on a credit line has anywhere to appear.
 *
 * What matters here is what you owe against what you're allowed to owe (utilization), what's due and
 * when, and what carrying the balance costs. Every figure below is derived from the ledger plus the
 * card's own terms — limit, statement day, due day, APR, minimum payment — set on the account.
 */

/** The most recent statement close on or before today, from the card's statement day. */
function lastStatementDate(statementDay: number, today = new Date()): string {
	const year = today.getFullYear();
	const month = today.getMonth();
	// A statement day past the end of a short month closes on its last day instead.
	const clamp = (y: number, m: number): string => {
		const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
		const day = Math.min(statementDay, daysInMonth);
		return `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	};
	const thisMonth = clamp(year, month);
	if (today.toISOString().slice(0, 10) >= thisMonth) return thisMonth;
	return month === 0 ? clamp(year - 1, 11) : clamp(year, month - 1);
}

/** The next payment due date from the card's due day — today's month if it hasn't passed, else next. */
function nextDueDate(dueDay: number, today = new Date()): string {
	const year = today.getFullYear();
	const month = today.getMonth();
	const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
	const format = (y: number, m: number): string =>
		`${y}-${String(m + 1).padStart(2, "0")}-${String(Math.min(dueDay, daysInMonth(y, m))).padStart(2, "0")}`;
	const thisMonth = format(year, month);
	if (today.toISOString().slice(0, 10) <= thisMonth) return thisMonth;
	return month === 11 ? format(year + 1, 0) : format(year, month + 1);
}

function daysBetween(fromISO: string, toISO: string): number {
	const from = Date.parse(`${fromISO}T00:00:00Z`);
	const to = Date.parse(`${toISO}T00:00:00Z`);
	return isNaN(from) || isNaN(to) ? 0 : Math.round((to - from) / 86_400_000);
}

export function renderCreditDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account, range?: DateRange): void {
	const store = plugin.store;
	const periodLabel = describeRange(range);
	const years = summarizeByYear(store, account.id, range);

	// A credit account's balance is negative while you owe: purchases are money out, payments in.
	const balance = netWorth(store, account.id);
	const owed = Math.max(0, -balance);
	const today = new Date().toISOString().slice(0, 10);

	const tiles = container.createDiv({ cls: "fp-stat-grid" });
	statTile(tiles, {
		label: "Current balance",
		value: formatEUR(owed),
		sub: owed > 0 ? "owed" : "nothing owed",
		iconName: "credit-card",
		tone: owed > 0 ? "warn" : "good",
	});

	if (account.creditLimit && account.creditLimit > 0) {
		const available = Math.max(0, account.creditLimit - owed);
		statTile(tiles, { label: "Available credit", value: formatEUR(available), sub: `of ${formatEUR(account.creditLimit)}`, iconName: "wallet" });
	}

	if (account.statementDay) {
		const statementDate = lastStatementDate(account.statementDay);
		const statementBalance = Math.max(0, -netWorthAsOf(store, statementDate, account.id));
		statTile(tiles, {
			label: "Statement balance",
			value: formatEUR(statementBalance),
			sub: `closed ${statementDate}`,
			iconName: "file-text",
		});
		if (account.minPaymentPct && statementBalance > 0) {
			statTile(tiles, {
				label: "Minimum payment",
				value: formatEUR(statementBalance * account.minPaymentPct),
				sub: `${Math.round(account.minPaymentPct * 100)}% of the statement`,
				iconName: "circle-dollar-sign",
			});
		}
	}

	if (account.apr && owed > 0) {
		// A month's interest at the card's own rate — the cost of not clearing it, in money rather
		// than in a percentage nobody converts in their head.
		statTile(tiles, {
			label: "Interest if carried",
			value: formatEUR((owed * account.apr) / 12),
			sub: `${(account.apr * 100).toFixed(2)}% APR, one month`,
			iconName: "percent",
			tone: "bad",
		});
	}

	// --- Utilization -------------------------------------------------------
	if (account.creditLimit && account.creditLimit > 0) {
		const utilization = owed / account.creditLimit;
		const card = container.createDiv({ cls: "fp-card" });
		const head = card.createDiv({ cls: "fp-section-title-row" });
		head.createEl("h3", { text: "Utilization" });
		// 30% is the conventional threshold for credit scoring; it's the only number here with a
		// meaning outside your own finances, so it's worth naming rather than just coloring.
		badge(head, utilization <= 0.3 ? "healthy" : utilization <= 0.5 ? "getting high" : "high", utilization <= 0.3 ? "good" : utilization <= 0.5 ? "warn" : "bad");
		renderMeter(card, {
			label: `${formatEUR(owed)} of ${formatEUR(account.creditLimit)}`,
			value: Math.min(1, utilization),
			valueLabel: `${Math.round(utilization * 100)}%`,
			sub: utilization > 0.3 ? "Staying under 30% is the usual advice where utilization affects credit scoring." : undefined,
		});
	}

	// --- Payment due -------------------------------------------------------
	if (account.paymentDueDay) {
		const due = nextDueDate(account.paymentDueDay);
		const days = daysBetween(today, due);
		const card = container.createDiv({ cls: "fp-card" });
		card.createEl("h3", { text: "Next payment" });
		card.createDiv({
			cls: "fp-step-desc",
			text: `Due ${due}${days === 0 ? " — today" : days === 1 ? " — tomorrow" : ` — in ${days} days`}.`,
		});
	}

	// --- The cards on this account ----------------------------------------
	const cards = cardsForAccount(store.cards, account.id);
	if (cards.length > 0) {
		const card = container.createDiv({ cls: "fp-card" });
		card.createEl("h3", { text: cards.length === 1 ? "Card" : "Cards" });
		cards.forEach((c) => {
			const row = card.createDiv({ cls: "fp-detail-row" });
			row.createDiv({ cls: "fp-detail-label", text: c.name });
			row.createDiv({
				cls: "fp-detail-value fp-sensitive",
				text: [c.last4 ? `•••• ${c.last4}` : "", c.expiryMonth && c.expiryYear ? `exp ${String(c.expiryMonth).padStart(2, "0")}/${c.expiryYear}` : ""]
					.filter(Boolean)
					.join(" · "),
			});
		});
	}

	// --- History -----------------------------------------------------------
	if (years.length > 0) {
		const historyCard = container.createDiv({ cls: "fp-card" });
		historyCard.createEl("h3", { text: "Historical activity" });
		const table = metricsTable(historyCard);
		yearHeaderRow(table, years.map((y) => y.year), {
			onClick: (year) => new MonthDrilldownModal(plugin.app, plugin, year, account.name, account.id).open(),
			labelFor: yearLabeller(years),
		});
		const tbody = table.createEl("tbody");
		metricRow(tbody, "Charged", years.map((y) => y.expenses), formatEUR, { heat: "invert" });
		deltaRow(tbody, years.map((y) => y.expenses), { invert: true });
		// Paid off comes from debt-principal payments specifically (FIN-012) — not `income`, which the
		// shared classifier correctly reads as ~0 for a credit account: a card payment is a balance-sheet
		// movement, not money the account earned. `income` here previously stood in for this figure only
		// because nothing else tracked it; reading it that way also meant a "savings rate" row below
		// looked like a real percentage when a credit account has no income to save a fraction of. That
		// row is gone — see debtPrincipal instead of trying to force this account into an income/expense
		// framing it doesn't have.
		metricRow(tbody, "Paid off", years.map((y) => y.debtPrincipal), formatEUR, { heat: "normal" });
		metricRow(tbody, "Net", years.map((y) => y.debtPrincipal - y.expenses), formatEUR, { emphasize: true, heat: "normal" });
		partialYearsNote(historyCard, years, periodLabel);
	}

	// --- Where it goes -----------------------------------------------------
	renderSpendingByCategoryCard(container, plugin, { accountId: account.id, scopeLabel: account.name, range, periodLabel });
}
