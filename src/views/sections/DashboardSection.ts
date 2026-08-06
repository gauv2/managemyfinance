import { categoryTotals, fiProjection, netWorth, summarizeByYear } from "../../kpi";
import type FinancePlugin from "../../main";
import { badge, categoryChip, emptyState, statTile } from "../../ui/dom";
import { openImportWizard } from "../../wizards/ImportWizard";
import { openOnboardingWizard } from "../../wizards/OnboardingWizard";

function formatEUR(n: number): string {
	return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}

export function renderDashboard(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;
	container.addClass("fp-section");

	if (store.accounts.length === 0) {
		emptyState(container, {
			iconName: "wallet",
			title: "Let's set up your accounts",
			description: "Run the setup wizard to add accounts and pick your category palette.",
			actionLabel: "Run setup wizard",
			onAction: () => openOnboardingWizard(plugin),
		});
		return;
	}

	container.createDiv({ cls: "fp-section-header" }).createEl("h2", { text: "Dashboard" });

	if (store.transactions.length === 0) {
		emptyState(container, {
			iconName: "inbox",
			title: "No transactions yet",
			description: "Import a bank or broker CSV export to see your numbers here.",
			actionLabel: "Import transactions",
			onAction: () => openImportWizard(plugin),
		});
		return;
	}

	const years = summarizeByYear(store);
	const currentYear = years[years.length - 1];
	const worth = netWorth(store);

	const fiNumber = currentYear ? currentYear.expenses * plugin.settings.fiMultiplier : 0;
	const fiRatio = fiNumber > 0 ? worth / fiNumber : 0;
	const monthlyNet = currentYear ? currentYear.net / 12 : 0;
	const yearsToFi = fiNumber > 0 ? fiProjection(worth, monthlyNet, plugin.settings.expectedReturn, fiNumber) : undefined;

	const tiles = container.createDiv({ cls: "fp-stat-grid" });
	statTile(tiles, { label: "Net worth", value: formatEUR(worth), iconName: "landmark" });
	statTile(tiles, {
		label: "Savings rate (this year)",
		value: currentYear ? `${(currentYear.savingsRate * 100).toFixed(1)}%` : "—",
		iconName: "piggy-bank",
		tone: !currentYear ? "neutral" : currentYear.savingsRate >= 0.4 ? "good" : currentYear.savingsRate >= 0.15 ? "warn" : "bad",
	});
	statTile(tiles, {
		label: "FI ratio",
		value: `${(fiRatio * 100).toFixed(1)}%`,
		sub: `FI number ${formatEUR(fiNumber)}`,
		iconName: "compass",
		tone: fiRatio >= 1 ? "good" : "neutral",
	});
	statTile(tiles, {
		label: "Years to FI",
		value: yearsToFi === undefined ? "—" : yearsToFi.toFixed(1),
		sub: `@ ${(plugin.settings.expectedReturn * 100).toFixed(0)}% return`,
		iconName: "hourglass",
	});

	const historyCard = container.createDiv({ cls: "fp-card" });
	historyCard.createEl("h3", { text: "Historical performance" });
	const table = historyCard.createEl("table", { cls: "fp-table" });
	const thead = table.createEl("thead").createEl("tr");
	["Year", "Income", "Expenses", "Net", "Savings rate"].forEach((h) => thead.createEl("th", { text: h }));
	const tbody = table.createEl("tbody");
	years.forEach((y) => {
		const tr = tbody.createEl("tr");
		tr.createEl("td", { text: y.year });
		tr.createEl("td", { text: formatEUR(y.income) });
		tr.createEl("td", { text: formatEUR(y.expenses) });
		tr.createEl("td", { text: formatEUR(y.net) });
		const rateCell = tr.createEl("td");
		badge(rateCell, `${(y.savingsRate * 100).toFixed(0)}%`, y.savingsRate >= 0.4 ? "good" : y.savingsRate >= 0.15 ? "warn" : "bad");
	});

	const totals = categoryTotals(store, currentYear?.year);
	if (totals.size > 0) {
		const catCard = container.createDiv({ cls: "fp-card" });
		catCard.createEl("h3", { text: `Spending by category — ${currentYear?.year}` });
		const categoryById = new Map(store.categories.map((c) => [c.id, c]));
		const rows = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
		const list = catCard.createDiv({ cls: "fp-review-list" });
		rows.forEach(([catId, amount]) => {
			const cat = categoryById.get(catId);
			const row = list.createDiv({ cls: "fp-review-row" });
			if (cat) categoryChip(row, cat.name, cat.color, cat.icon);
			else badge(row, "Uncategorized", "warn");
			row.createSpan({ text: formatEUR(amount) });
		});
	}
}
