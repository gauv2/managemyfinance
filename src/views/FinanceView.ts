import { ItemView, Menu, Platform, WorkspaceLeaf } from "obsidian";
import { ACCOUNT_TYPE_META, ACCOUNT_TYPE_ORDER, VIEW_TYPE_FINANCE } from "../constants";
import type FinancePlugin from "../main";
import { CreateAccountModal } from "../modals/CreateAccountModal";
import { ManageAccountsModal } from "../modals/ManageAccountsModal";
import { ManagePortfoliosModal } from "../modals/ManagePortfoliosModal";
import type { FinanceViewId } from "../store";
import type { Account } from "../types";
import { icon } from "../ui/dom";
import { availableTips } from "../ui/tips";
import { openCardWizard } from "../wizards/CardWizard";
import { openCreatePortfolioWizard } from "../wizards/PortfolioWizard";
import { renderAccountPage } from "./sections/AccountPage";
import { renderBudgetsSection } from "./sections/BudgetsSection";
import { renderCardsSection } from "./sections/CardsSection";
import { renderReviewSection } from "./sections/ReviewSection";
import { renderSettingsSection } from "./sections/SettingsSection";
import { renderSubscriptionsSection } from "./sections/SubscriptionsSection";

/** Checking-like accounts first, then savings, investments, cash, and finally the balance-only
 *  accounts (property, pension) and what you owe. Shared with the account-type picker, so the sidebar
 *  and the "add account" list agree on what order these things come in. */
const TYPE_ORDER: Account["type"][] = ACCOUNT_TYPE_ORDER;

interface NavTabDef {
	id: string;
	label: string;
	icon: string;
	isActive: boolean;
	onClick: () => void;
	/** Shown as a count pill on the tab when above zero — currently the unreviewed-transactions backlog. */
	badgeCount?: number;
}

const DEFAULT_NAV_ORDER = ["all-accounts", "budgets", "subscriptions", "cards", "review"];

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
	private navFooterEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private brandEl!: HTMLElement;
	private brandTitleEl!: HTMLElement;
	private privacyToggleEl!: HTMLElement;
	/** Which tip the footer card is currently showing. View state, not settings — it resets per session. */
	private tipIndex = 0;

	constructor(leaf: WorkspaceLeaf, private plugin: FinancePlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_FINANCE;
	}
	getDisplayText(): string {
		return "ManageMyFinance";
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
		this.privacyToggleEl = this.brandEl.createDiv({ cls: "fp-nav-brand-actions" });
		this.brandEl.addEventListener("click", () => this.openPortfolioMenu());
		this.renderBrandTitle();
		this.renderPrivacyToggle();

		this.navItemsEl = nav.createDiv({ cls: "fp-nav-items" });
		this.navFooterEl = nav.createDiv({ cls: "fp-nav-footer" });
		this.renderNav();
		this.renderNavFooter();
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
		this.applyPrivacyClass();
		this.applyMobileClass();
		this.renderBrandTitle();
		this.renderPrivacyToggle();
		this.renderNav();
		this.renderNavFooter();
		this.renderBody();
	}

	/** "auto" (default) follows Obsidian's own Platform.isMobile; the setting can force it on/off regardless of device,
	 *  e.g. to preview the layout on desktop. Applied to the view root so styles.css can scope rules under `.fp-mobile`. */
	private applyMobileClass(): void {
		const mode = this.plugin.settings.mobileLayout ?? "auto";
		const isMobile = mode === "on" || (mode !== "off" && Platform.isMobile);
		this.contentEl.toggleClass("fp-mobile", isMobile);
	}

	/**
	 * The eye button: privacy mode, one click away, wherever you are.
	 *
	 * It lived only in the settings page before, which is the wrong place for it — you reach for this
	 * when someone walks up to your desk or a screen-share starts, and "open settings, find the
	 * Appearance card, flip the toggle" is not a thing you can do in that moment. Small, quiet and
	 * next to the portfolio name, where it's out of the way but always to hand.
	 */
	private renderPrivacyToggle(): void {
		this.privacyToggleEl.empty();
		const on = !!this.plugin.settings.privacyMode;
		const btn = this.privacyToggleEl.createDiv({ cls: "fp-nav-privacy" + (on ? " is-on" : "") });
		icon(btn, on ? "eye-off" : "eye");
		btn.setAttribute("role", "switch");
		btn.setAttribute("aria-checked", String(on));
		btn.setAttribute("aria-label", on ? "Show amounts" : "Hide amounts");
		btn.setAttribute("title", on ? "Amounts are hidden — click to show them" : "Hide every amount, IBAN and card number");
		btn.addEventListener("click", async (ev) => {
			// The button sits inside the brand row, which opens the portfolio menu on click.
			ev.stopPropagation();
			await this.plugin.togglePrivacyMode();
		});
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

	private async selectView(view: FinanceViewId): Promise<void> {
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
		if (def.badgeCount) item.createSpan({ cls: "fp-nav-count", text: String(def.badgeCount) });
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
			review: {
				id: "review",
				label: "Review",
				icon: "check-check",
				isActive: activeView === "review",
				onClick: () => void this.selectView("review"),
				badgeCount: this.plugin.store.transactions.filter((t) => (t.review ?? "new") === "new").length,
			},
		};
		this.navTabOrder().forEach((id) => this.renderDraggableTab(tabDefs[id]));

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

		this.navItemsEl.createDiv({ cls: "fp-nav-divider" });

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

	/** Pinned below the scrollable nav list: a "set a budget" nudge (shown until at least one category
	 *  has a budget planned for the current month) and a link into Obsidian's own settings modal, which
	 *  is otherwise only reachable via the app-wide settings icon. */
	/**
	 * The tip card: one tip at a time, with arrows to page through the rest and an × that retires the
	 * current one for good. Which tips are in the deck depends on the state of the vault — see
	 * src/ui/tips.ts. The whole card disappears once there's nothing relevant left to say.
	 */
	private renderTip(): void {
		const tips = availableTips(this.plugin);
		if (tips.length === 0) return;

		// Clamped rather than stored back: dismissing the last tip in the deck should land on the new
		// last one, not on an index that no longer exists.
		if (this.tipIndex >= tips.length) this.tipIndex = 0;
		const tip = tips[this.tipIndex];

		const card = this.navFooterEl.createDiv({ cls: "fp-nav-tip" });
		const tipHead = card.createDiv({ cls: "fp-nav-tip-head" });
		icon(tipHead, "sparkles", "fp-nav-tip-icon");
		tipHead.createSpan({ cls: "fp-nav-tip-title", text: tip.title });

		// Closes the whole deck, not just this tip. Retiring ten tips one × at a time reads as the card
		// refusing to go away; one click closes it, and Settings turns it back on.
		const dismissBtn = tipHead.createEl("button", { cls: "fp-nav-tip-dismiss" });
		icon(dismissBtn, "x");
		dismissBtn.setAttribute("aria-label", "Hide tips");
		dismissBtn.setAttribute("title", "Hide tips — turn them back on in Settings");
		dismissBtn.addEventListener("click", async () => {
			this.plugin.settings.tipsEnabled = false;
			await this.plugin.saveSettings();
			// Full refresh, not just the footer: the Settings page may be open with the "Show tips"
			// toggle on screen, and a switch still reading ON after you closed the card is a lie.
			this.refresh();
		});

		card.createDiv({ cls: "fp-nav-tip-desc", text: tip.body });

		const actions = card.createDiv({ cls: "fp-nav-tip-actions" });
		if (tip.action) {
			const actionBtn = actions.createEl("button", { cls: "fp-btn fp-btn-primary fp-nav-tip-btn" });
			icon(actionBtn, tip.action.icon);
			actionBtn.createSpan({ text: tip.action.label });
			actionBtn.addEventListener("click", () => tip.action!.run(this.plugin));
		}

		if (tips.length > 1) {
			const pager = actions.createDiv({ cls: "fp-nav-tip-pager" });
			const step = (delta: number): void => {
				this.tipIndex = (this.tipIndex + delta + tips.length) % tips.length;
				this.renderNavFooter();
			};
			const prevBtn = pager.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
			icon(prevBtn, "chevron-left");
			prevBtn.setAttribute("aria-label", "Previous tip");
			prevBtn.addEventListener("click", () => step(-1));

			pager.createSpan({ cls: "fp-nav-tip-count", text: `${this.tipIndex + 1}/${tips.length}` });

			const nextBtn = pager.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
			icon(nextBtn, "chevron-right");
			nextBtn.setAttribute("aria-label", "Next tip");
			nextBtn.addEventListener("click", () => step(1));
		}
	}

	private renderNavFooter(): void {
		this.navFooterEl.empty();
		this.renderTip();

		// Two entries on purpose: this plugin has two distinct settings surfaces, and the footer is where
		// both are found. "Settings" is the app's own display preferences (a page in this workspace);
		// "Vault settings" is Obsidian's modal, holding the data itself.
		const settingsItem = this.navFooterEl.createDiv({
			cls: "fp-nav-item fp-nav-item-settings" + (this.plugin.settings.activeView === "settings" ? " is-active" : ""),
		});
		icon(settingsItem, "sliders-horizontal", "fp-nav-icon");
		settingsItem.createSpan({ cls: "fp-nav-label", text: "Settings" });
		icon(settingsItem, "chevron-right", "fp-nav-item-chevron");
		settingsItem.addEventListener("click", () => void this.selectView("settings"));

		const vaultSettingsItem = this.navFooterEl.createDiv({ cls: "fp-nav-item fp-nav-item-settings fp-nav-item-ghost" });
		icon(vaultSettingsItem, "database", "fp-nav-icon");
		vaultSettingsItem.createSpan({ cls: "fp-nav-label", text: "Vault settings" });
		icon(vaultSettingsItem, "external-link", "fp-nav-item-chevron");
		vaultSettingsItem.setAttribute("title", "Data folder, accounts, categories, exchange rates, import, backup and restore");
		vaultSettingsItem.addEventListener("click", () => {
			const appWithSetting = this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } };
			appWithSetting.setting.open();
			appWithSetting.setting.openTabById(this.plugin.manifest.id);
		});

		// Always visible, because the question "which build am I looking at?" comes up while you're
		// using the plugin, not while you're in its settings. The load time is the half that actually
		// answers it — see FinancePlugin.loadedAt.
		const stamp = this.navFooterEl.createDiv({ cls: "fp-nav-version" });
		stamp.createSpan({ cls: "fp-nav-version-num", text: `v${this.plugin.manifest.version}` });
		stamp.createSpan({ cls: "fp-nav-version-time", text: `loaded ${this.plugin.loadedAt}` });
		stamp.setAttribute(
			"title",
			`${this.plugin.manifest.name} v${this.plugin.manifest.version}, loaded at ${this.plugin.loadedAt}. Obsidian only re-reads a plugin when it's toggled or the app restarts — if this time hasn't moved, your rebuild isn't running yet.`
		);
	}

	private renderBody(): void {
		this.bodyEl.empty();
		switch (this.plugin.settings.activeView) {
			case "budgets":
				renderBudgetsSection(this.bodyEl, this.plugin);
				break;
			case "subscriptions":
				renderSubscriptionsSection(this.bodyEl, this.plugin);
				break;
			case "cards":
				renderCardsSection(this.bodyEl, this.plugin);
				break;
			case "review":
				renderReviewSection(this.bodyEl, this.plugin);
				break;
			case "settings":
				renderSettingsSection(this.bodyEl, this.plugin);
				break;
			default:
				renderAccountPage(this.bodyEl, this.plugin);
		}
	}
}
