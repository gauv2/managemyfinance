import { ItemView, Menu, Platform, WorkspaceLeaf } from "obsidian";
import { ACCOUNT_TYPE_META, VIEW_TYPE_FINANCE } from "../constants";
import type FinancePlugin from "../main";
import { CreateAccountModal } from "../modals/CreateAccountModal";
import { ManageAccountsModal } from "../modals/ManageAccountsModal";
import { ManagePortfoliosModal } from "../modals/ManagePortfoliosModal";
import type { Account } from "../types";
import { icon } from "../ui/dom";
import { openCardWizard } from "../wizards/CardWizard";
import { openCreatePortfolioWizard } from "../wizards/PortfolioWizard";
import { renderAccountPage } from "./sections/AccountPage";
import { renderBudgetsSection } from "./sections/BudgetsSection";
import { renderCardsSection } from "./sections/CardsSection";
import { renderSubscriptionsSection } from "./sections/SubscriptionsSection";

/** Checking-like accounts first, then savings, then investing/crypto, then everything else (e.g. cash). */
const TYPE_ORDER: Account["type"][] = ["debit", "credit", "saving", "investing", "crypto", "cash"];

interface NavTabDef {
	id: string;
	label: string;
	icon: string;
	isActive: boolean;
	onClick: () => void;
}

const DEFAULT_NAV_ORDER = ["all-accounts", "budgets", "subscriptions", "cards"];

function possessive(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "";
	return trimmed.endsWith("s") ? `${trimmed}'` : `${trimmed}'s`;
}

/**
 * Account-centric workspace: the sidebar lists "All Accounts" plus every account you have (instead
 * of generic Dashboard/Ledger/... tabs), and picking one shows that account's own dashboard and
 * ledger together on a single page.
 */
export class FinanceView extends ItemView {
	private navItemsEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private brandEl!: HTMLElement;
	private brandTitleEl!: HTMLElement;

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
		this.applyPrivacyClass();
		this.applyMobileClass();

		const shell = root.createDiv({ cls: "fp-shell" });
		const nav = shell.createDiv({ cls: "fp-nav" });
		nav.style.width = `${this.plugin.settings.navWidth ?? 268}px`;
		const resizeHandle = shell.createDiv({ cls: "fp-nav-resize-handle" });
		this.setupNavResize(nav, resizeHandle);
		this.bodyEl = shell.createDiv({ cls: "fp-content" });

		this.brandEl = nav.createDiv({ cls: "fp-nav-brand fp-nav-brand-switcher" });
		icon(this.brandEl, "wallet", "fp-nav-brand-icon");
		const brandText = this.brandEl.createDiv({ cls: "fp-nav-brand-text" });
		this.brandTitleEl = brandText.createDiv({ cls: "fp-nav-brand-title" });
		this.brandEl.addEventListener("click", () => this.openPortfolioMenu());
		this.renderBrandTitle();

		this.navItemsEl = nav.createDiv({ cls: "fp-nav-items" });
		this.renderNav();
		this.renderBody();
		this.maybeShowCardsIntro();
	}

	/** Auto-prompts once, ever, across every portfolio, and only when the user truly has zero cards. Marked
	 *  seen the moment the wizard is opened (not from onSkip/onSaved) so dismissing it any other way —
	 *  Escape, backdrop click — also counts and it never nags again. */
	private maybeShowCardsIntro(): void {
		if (this.plugin.settings.cardsIntroShown) return;
		if (this.plugin.store.accounts.length === 0) return;
		if (this.plugin.store.cards.length > 0) return;
		this.plugin.settings.cardsIntroShown = true;
		void this.plugin.saveSettings();
		openCardWizard(this.plugin, {
			skippable: true,
			skipLabel: "Skip for now",
			onSaved: () => this.refresh(),
		});
	}

	private static readonly MIN_NAV_WIDTH = 200;
	private static readonly MAX_NAV_WIDTH = 420;

	/** Drag the handle at the sidebar's right edge to resize it; width is clamped and persisted per-vault
	 *  (not per-portfolio) so it stays put across restarts. No-ops on mobile, where the sidebar stacks above the page. */
	private setupNavResize(nav: HTMLElement, handle: HTMLElement): void {
		handle.addEventListener("mousedown", (down: MouseEvent) => {
			if (this.contentEl.hasClass("fp-mobile")) return;
			down.preventDefault();
			const startX = down.clientX;
			const startWidth = nav.getBoundingClientRect().width;
			handle.addClass("is-dragging");
			document.body.style.cursor = "col-resize";

			const onMove = (move: MouseEvent): void => {
				const width = Math.min(
					FinanceView.MAX_NAV_WIDTH,
					Math.max(FinanceView.MIN_NAV_WIDTH, startWidth + (move.clientX - startX))
				);
				nav.style.width = `${width}px`;
			};
			const onUp = async (): Promise<void> => {
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
				handle.removeClass("is-dragging");
				document.body.style.cursor = "";
				this.plugin.settings.navWidth = Math.round(nav.getBoundingClientRect().width);
				await this.plugin.saveSettings();
			};
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
		});
	}

	refresh(): void {
		this.applyMobileClass();
		this.renderBrandTitle();
		this.renderNav();
		this.renderBody();
	}

	/** "auto" (default) follows Obsidian's own Platform.isMobile; the setting can force it on/off regardless of device,
	 *  e.g. to preview the layout on desktop. Applied to the view root so styles.css can scope rules under `.fp-mobile`. */
	private applyMobileClass(): void {
		const mode = this.plugin.settings.mobileLayout ?? "auto";
		const isMobile = mode === "on" || (mode !== "off" && Platform.isMobile);
		this.contentEl.toggleClass("fp-mobile", isMobile);
	}

	private renderBrandTitle(): void {
		this.brandTitleEl.empty();
		const name = this.plugin.activePortfolio?.name;
		this.brandTitleEl.createSpan({
			cls: "fp-nav-brand-title-text",
			text: name ? `${possessive(name)} Finances` : "Finances",
		});
		icon(this.brandTitleEl, "chevron-down", "fp-nav-brand-chevron");
	}

	private openPortfolioMenu(): void {
		const menu = new Menu();
		const portfolios = this.plugin.settings.portfolios ?? [];
		portfolios.forEach((p) => {
			menu.addItem((item) =>
				item
					.setTitle(p.name)
					.setIcon(p.id === this.plugin.settings.activePortfolioId ? "check" : "briefcase")
					.onClick(() => void this.plugin.switchPortfolio(p.id))
			);
		});
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle("New portfolio…").setIcon("plus").onClick(() => openCreatePortfolioWizard(this.plugin))
		);
		menu.addItem((item) =>
			item
				.setTitle("Manage portfolios…")
				.setIcon("settings")
				.onClick(() => new ManagePortfoliosModal(this.app, this.plugin, () => this.refresh()).open())
		);
		const rect = this.brandEl.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
	}

	private async selectAccount(accountId: string | undefined): Promise<void> {
		this.plugin.settings.activeAccountId = accountId;
		this.plugin.settings.activeView = undefined;
		await this.plugin.saveSettings();
		this.renderNav();
		this.renderBody();
	}

	private async selectView(view: "budgets" | "subscriptions" | "cards"): Promise<void> {
		this.plugin.settings.activeView = view;
		await this.plugin.saveSettings();
		this.renderNav();
		this.renderBody();
	}

	/** Toggled on <body>, not the workspace root — modals (e.g. transaction/month detail) mount outside
	 *  the view's own DOM subtree, so they only pick up privacy mode via a class shared that high up. */
	private applyPrivacyClass(): void {
		document.body.toggleClass("fp-privacy", !!this.plugin.settings.privacyMode);
	}

	private async togglePrivacy(): Promise<void> {
		this.plugin.settings.privacyMode = !this.plugin.settings.privacyMode;
		await this.plugin.saveSettings();
		this.applyPrivacyClass();
		this.renderNav();
	}

	/** Saved order, filtered to known tabs, then any tab missing from it (e.g. newly added) appended in default order. */
	private navTabOrder(): string[] {
		const saved = (this.plugin.settings.navOrder ?? []).filter((id) => DEFAULT_NAV_ORDER.includes(id));
		return [...saved, ...DEFAULT_NAV_ORDER.filter((id) => !saved.includes(id))];
	}

	private async reorderNavTabs(draggedId: string, targetId: string): Promise<void> {
		const order = this.navTabOrder();
		const from = order.indexOf(draggedId);
		const to = order.indexOf(targetId);
		if (from === -1 || to === -1 || from === to) return;
		order.splice(from, 1);
		order.splice(to, 0, draggedId);
		this.plugin.settings.navOrder = order;
		await this.plugin.saveSettings();
		this.renderNav();
	}

	/** Wires up HTML5 drag-and-drop reordering onto an already-built nav item (a drag handle + `draggable` attr must already be on it). */
	private wireDrag(item: HTMLElement, id: string, onDrop: (draggedId: string, targetId: string) => void): void {
		item.addEventListener("dragstart", (ev) => {
			ev.dataTransfer?.setData("text/plain", id);
			setTimeout(() => item.addClass("is-dragging"), 0);
		});
		item.addEventListener("dragend", () => item.removeClass("is-dragging"));
		item.addEventListener("dragover", (ev) => {
			ev.preventDefault();
			item.addClass("is-drag-over");
		});
		item.addEventListener("dragleave", () => item.removeClass("is-drag-over"));
		item.addEventListener("drop", (ev) => {
			ev.preventDefault();
			item.removeClass("is-drag-over");
			const draggedId = ev.dataTransfer?.getData("text/plain");
			if (draggedId) onDrop(draggedId, id);
		});
	}

	private renderDraggableTab(def: NavTabDef): void {
		const item = this.navItemsEl.createDiv({
			cls: "fp-nav-item fp-nav-item-draggable" + (def.isActive ? " is-active" : ""),
			attr: { draggable: "true" },
		});
		icon(item, def.icon, "fp-nav-icon");
		item.createSpan({ cls: "fp-nav-label", text: def.label });
		icon(item, "grip-vertical", "fp-nav-drag-handle");
		item.addEventListener("click", () => def.onClick());
		this.wireDrag(item, def.id, (draggedId, targetId) => void this.reorderNavTabs(draggedId, targetId));
	}

	/** Saved order, filtered to accounts that still exist in this portfolio, then any new/unordered accounts appended by type. */
	private accountOrder(): string[] {
		const accounts = this.plugin.store.accounts;
		const ids = new Set(accounts.map((a) => a.id));
		const saved = (this.plugin.settings.accountOrder ?? []).filter((id) => ids.has(id));
		const defaultOrder = [...accounts].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)).map((a) => a.id);
		return [...saved, ...defaultOrder.filter((id) => !saved.includes(id))];
	}

	private async reorderAccounts(draggedId: string, targetId: string): Promise<void> {
		const order = this.accountOrder();
		const from = order.indexOf(draggedId);
		const to = order.indexOf(targetId);
		if (from === -1 || to === -1 || from === to) return;
		order.splice(from, 1);
		order.splice(to, 0, draggedId);
		this.plugin.settings.accountOrder = order;
		await this.plugin.saveSettings();
		this.renderNav();
	}

	private renderNav(): void {
		this.navItemsEl.empty();
		const activeAccountId = this.plugin.settings.activeAccountId;
		const activeView = this.plugin.settings.activeView;

		const tabDefs: Record<string, NavTabDef> = {
			"all-accounts": {
				id: "all-accounts",
				label: "All Accounts",
				icon: "layers",
				isActive: !activeAccountId && !activeView,
				onClick: () => void this.selectAccount(undefined),
			},
			budgets: {
				id: "budgets",
				label: "Budgets",
				icon: "piggy-bank",
				isActive: activeView === "budgets",
				onClick: () => void this.selectView("budgets"),
			},
			subscriptions: {
				id: "subscriptions",
				label: "Subscriptions",
				icon: "repeat",
				isActive: activeView === "subscriptions",
				onClick: () => void this.selectView("subscriptions"),
			},
			cards: {
				id: "cards",
				label: "Cards",
				icon: "credit-card",
				isActive: activeView === "cards",
				onClick: () => void this.selectView("cards"),
			},
		};
		this.navTabOrder().forEach((id) => this.renderDraggableTab(tabDefs[id]));

		const privacyOn = !!this.plugin.settings.privacyMode;
		const privacyItem = this.navItemsEl.createDiv({ cls: "fp-nav-item fp-nav-item-ghost" + (privacyOn ? " is-privacy-on" : "") });
		icon(privacyItem, privacyOn ? "eye-off" : "eye", "fp-nav-icon");
		privacyItem.createSpan({ cls: "fp-nav-label", text: privacyOn ? "Amounts hidden" : "Hide amounts" });
		privacyItem.setAttribute("title", "Blur every amount — hover one to peek. Useful when demoing the plugin.");
		privacyItem.addEventListener("click", () => void this.togglePrivacy());

		const accountById = new Map(this.plugin.store.accounts.map((a) => [a.id, a]));
		const accounts = this.accountOrder()
			.map((id) => accountById.get(id))
			.filter((a): a is Account => !!a);
		if (accounts.length > 0) {
			this.navItemsEl.createDiv({ cls: "fp-nav-section-label", text: "Accounts" });
		}
		accounts.forEach((acc) => {
			const item = this.navItemsEl.createDiv({
				cls: "fp-nav-item fp-nav-item-draggable" + (!activeView && activeAccountId === acc.id ? " is-active" : ""),
				attr: { draggable: "true" },
			});
			icon(item, ACCOUNT_TYPE_META[acc.type].icon, "fp-nav-icon");
			const textCol = item.createDiv({ cls: "fp-nav-item-text" });
			textCol.createDiv({ cls: "fp-nav-label", text: acc.name });
			textCol.createDiv({ cls: "fp-nav-item-type", text: ACCOUNT_TYPE_META[acc.type].label });
			icon(item, "grip-vertical", "fp-nav-drag-handle");
			item.addEventListener("click", () => void this.selectAccount(acc.id));
			this.wireDrag(item, acc.id, (draggedId, targetId) => void this.reorderAccounts(draggedId, targetId));
		});

		const addItem = this.navItemsEl.createDiv({ cls: "fp-nav-item fp-nav-item-ghost" });
		icon(addItem, "plus", "fp-nav-icon");
		addItem.createSpan({ cls: "fp-nav-label", text: "Add account" });
		addItem.addEventListener("click", () => {
			new CreateAccountModal(this.app, this.plugin, (account) => void this.selectAccount(account.id)).open();
		});

		const manageItem = this.navItemsEl.createDiv({ cls: "fp-nav-item fp-nav-item-ghost" });
		icon(manageItem, "settings", "fp-nav-icon");
		manageItem.createSpan({ cls: "fp-nav-label", text: "Manage accounts…" });
		manageItem.addEventListener("click", () => {
			new ManageAccountsModal(this.app, this.plugin, () => {
				this.renderNav();
				this.renderBody();
			}).open();
		});
	}

	private renderBody(): void {
		this.bodyEl.empty();
		if (this.plugin.settings.activeView === "budgets") {
			renderBudgetsSection(this.bodyEl, this.plugin);
		} else if (this.plugin.settings.activeView === "subscriptions") {
			renderSubscriptionsSection(this.bodyEl, this.plugin);
		} else if (this.plugin.settings.activeView === "cards") {
			renderCardsSection(this.bodyEl, this.plugin);
		} else {
			renderAccountPage(this.bodyEl, this.plugin);
		}
	}
}
