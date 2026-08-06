import { ItemView, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_FINANCE } from "../constants";
import type FinancePlugin from "../main";
import { icon } from "../ui/dom";
import { openImportWizard } from "../wizards/ImportWizard";
import { renderComingSoon } from "./sections/ComingSoonSection";
import { renderDashboard } from "./sections/DashboardSection";
import { renderLedger } from "./sections/LedgerSection";

type SectionId = "dashboard" | "ledger" | "budget" | "networth" | "investments" | "forecast";

const SECTIONS: { id: SectionId; label: string; icon: string }[] = [
	{ id: "dashboard", label: "Dashboard", icon: "layout-dashboard" },
	{ id: "ledger", label: "Ledger", icon: "list" },
	{ id: "budget", label: "Budget", icon: "pie-chart" },
	{ id: "networth", label: "Net Worth", icon: "trending-up" },
	{ id: "investments", label: "Investments", icon: "candlestick-chart" },
	{ id: "forecast", label: "Forecast", icon: "compass" },
];

/** Single-pane Finance workspace: left nav switches sections in place, like a small app rather than scattered tabs. */
export class FinanceView extends ItemView {
	private active: SectionId = "dashboard";
	private navItemsEl!: HTMLElement;
	private bodyEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private plugin: FinancePlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_FINANCE;
	}
	getDisplayText(): string {
		return "Finance";
	}
	getIcon(): string {
		return "wallet";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("fp-workspace");

		const shell = root.createDiv({ cls: "fp-shell" });
		const nav = shell.createDiv({ cls: "fp-nav" });
		this.bodyEl = shell.createDiv({ cls: "fp-content" });

		nav.createDiv({ cls: "fp-nav-brand" }).createSpan({ text: "Finance" });
		this.navItemsEl = nav.createDiv({ cls: "fp-nav-items" });
		this.renderNav();

		const importBtn = nav.createEl("button", { cls: "fp-btn fp-btn-primary fp-nav-import" });
		icon(importBtn, "download");
		importBtn.createSpan({ text: "Import" });
		importBtn.addEventListener("click", () => openImportWizard(this.plugin));

		this.renderSection();
	}

	refresh(): void {
		this.renderSection();
	}

	private renderNav(): void {
		this.navItemsEl.empty();
		SECTIONS.forEach((s) => {
			const item = this.navItemsEl.createDiv({ cls: "fp-nav-item" + (s.id === this.active ? " is-active" : "") });
			icon(item, s.icon, "fp-nav-icon");
			item.createSpan({ cls: "fp-nav-label", text: s.label });
			item.addEventListener("click", () => {
				this.active = s.id;
				this.navItemsEl.querySelectorAll(".fp-nav-item").forEach((el) => el.removeClass("is-active"));
				item.addClass("is-active");
				this.renderSection();
			});
		});
	}

	private renderSection(): void {
		this.bodyEl.empty();
		switch (this.active) {
			case "dashboard":
				renderDashboard(this.bodyEl, this.plugin);
				break;
			case "ledger":
				renderLedger(this.bodyEl, this.plugin);
				break;
			case "budget":
				renderComingSoon(this.bodyEl, {
					icon: "pie-chart",
					title: "Budget",
					description: "Planned vs. actual per category, month by month — next up after the ledger view settles in.",
				});
				break;
			case "networth":
				renderComingSoon(this.bodyEl, {
					icon: "trending-up",
					title: "Net Worth",
					description: "Account balances over time and allocation vs. your glidepath target.",
				});
				break;
			case "investments":
				renderComingSoon(this.bodyEl, {
					icon: "candlestick-chart",
					title: "Investments",
					description: "Holdings, average cost, and unrealized P/L derived from your broker ledger.",
				});
				break;
			case "forecast":
				renderComingSoon(this.bodyEl, {
					icon: "compass",
					title: "Forecast",
					description: "Percentile-based spending bands and cash-buffer guidance from your full history.",
				});
				break;
		}
	}
}
