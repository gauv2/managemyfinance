import { Menu, Notice } from "obsidian";
import { ACCOUNT_TYPE_META } from "../../constants";
import {
	CARD_NETWORK_LABEL,
	CARD_TYPE_LABEL,
	cardExpiresWithinMonths,
	cardExpiryDate,
	cardIsExpired,
	monthsUntil,
} from "../../cards";
import type FinancePlugin from "../../main";
import { ManageAccountsModal } from "../../modals/ManageAccountsModal";
import type { Account, Card } from "../../types";
import { renderCardVisual } from "../../ui/cardVisual";
import { badge, emptyState, icon } from "../../ui/dom";
import { openCardWizard } from "../../wizards/CardWizard";

type SortKey = "name" | "account" | "expiry";

/** Selection and sort persist across re-renders within the session, same as every other section's local state. */
const cardsState: { selectedId?: string; sort: SortKey } = { sort: "name" };

function groupedNumber(digits: string): string {
	return (digits.match(/.{1,4}/g) ?? []).join(" ");
}

function detailRow(container: HTMLElement, iconName: string, label: string, value: string, opts?: { sensitive?: boolean }): void {
	const r = container.createDiv({ cls: "fp-detail-row" });
	const labelEl = r.createDiv({ cls: "fp-detail-label" });
	icon(labelEl, iconName, "fp-detail-label-icon");
	labelEl.createSpan({ text: label });
	r.createDiv({ cls: "fp-detail-value" + (opts?.sensitive ? " fp-iban" : ""), text: value });
}

function sortCards(cards: Card[], accountById: Map<string, Account>, sort: SortKey): Card[] {
	const expiryKey = (c: Card): number => cardExpiryDate(c)?.getTime() ?? Infinity;
	return [...cards].sort((a, b) => {
		if (sort === "account") {
			const an = accountById.get(a.accountId)?.name ?? "";
			const bn = accountById.get(b.accountId)?.name ?? "";
			return an.localeCompare(bn) || a.name.localeCompare(b.name);
		}
		if (sort === "expiry") return expiryKey(a) - expiryKey(b);
		return a.name.localeCompare(b.name);
	});
}

/** One card, per your bank/card issuer: always linked to an account, counted and shown completely separately from it. */
export function renderCardsSection(container: HTMLElement, plugin: FinancePlugin): void {
	container.addClass("fp-section");
	const store = plugin.store;

	async function goToAccount(accountId: string): Promise<void> {
		plugin.settings.activeAccountId = accountId;
		plugin.settings.activeView = undefined;
		await plugin.saveSettings();
		plugin.refreshViews();
	}

	async function removeCard(card: Card): Promise<void> {
		store.cards = store.cards.filter((c) => c.id !== card.id);
		await store.saveCards();
		new Notice(`Removed "${card.name}"`);
		if (cardsState.selectedId === card.id) cardsState.selectedId = undefined;
		render();
	}

	async function togglePrimary(card: Card): Promise<void> {
		card.isPrimary = !card.isPrimary;
		await store.saveCards();
		render();
	}

	function openAddCard(defaultAccountId?: string): void {
		openCardWizard(plugin, {
			defaultAccountId,
			onSaved: (card) => {
				cardsState.selectedId = card.id;
				render();
			},
		});
	}

	function render(): void {
		container.empty();
		const cards = store.cards;

		const header = container.createDiv({ cls: "fp-section-header" });
		const headText = header.createDiv({ cls: "fp-section-header-text" });
		const titleRow = headText.createDiv({ cls: "fp-section-title-row" });
		icon(titleRow.createDiv({ cls: "fp-section-icon-badge" }), "credit-card");
		titleRow.createEl("h2", { text: "Cards" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: "Every payment card you carry, linked to the account it actually draws money from or borrows against.",
		});
		const addBtn = header.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(addBtn, "plus");
		addBtn.createSpan({ text: "Add card" });
		addBtn.addEventListener("click", () => openAddCard());

		if (store.accounts.length === 0) {
			emptyState(container, {
				iconName: "credit-card",
				title: "Add an account first",
				description: "Cards always link to an account — set one up, then come back to add its cards.",
			});
			return;
		}

		const accountById = new Map(store.accounts.map((a) => [a.id, a]));
		const linkedAccountIds = new Set(cards.map((c) => c.accountId));
		const unlinkedAccounts = store.accounts.filter((a) => !linkedAccountIds.has(a.id));

		if (cards.length === 0) {
			emptyState(container, {
				iconName: "credit-card",
				title: "No cards tracked yet",
				description: "Add your first card and link it to one of your accounts.",
				actionLabel: "Add card",
				onAction: () => openAddCard(),
			});
			return;
		}

		if (!cardsState.selectedId || !cards.some((c) => c.id === cardsState.selectedId)) {
			cardsState.selectedId = cards[0].id;
		}

		const layout = container.createDiv({ cls: "fp-cards-layout" });
		const listCol = layout.createDiv({ cls: "fp-cards-list-col" });
		renderCardList(listCol, cards, accountById);
		if (unlinkedAccounts.length > 0) renderUnlinkedAccounts(listCol, unlinkedAccounts);

		const detailCol = layout.createDiv({ cls: "fp-cards-detail-col" });
		const selected = cards.find((c) => c.id === cardsState.selectedId);
		if (selected) renderCardDetail(detailCol, selected, accountById.get(selected.accountId));
	}

	function renderCardList(parent: HTMLElement, cards: Card[], accountById: Map<string, Account>): void {
		const card = parent.createDiv({ cls: "fp-card" });
		const head = card.createDiv({ cls: "fp-card-head-row" });
		head.createEl("h3", { text: "Your cards" });
		const sortRow = head.createDiv({ cls: "fp-cards-sort" });
		sortRow.createSpan({ cls: "fp-filter-label", text: "Sort by:" });
		const sortSelect = sortRow.createEl("select", { cls: "fp-filter-select" });
		(
			[
				["name", "Name"],
				["account", "Account"],
				["expiry", "Expiry"],
			] as [SortKey, string][]
		).forEach(([value, label]) => sortSelect.createEl("option", { text: label, value }));
		sortSelect.value = cardsState.sort;
		sortSelect.addEventListener("change", () => {
			cardsState.sort = sortSelect.value as SortKey;
			render();
		});

		const list = card.createDiv({ cls: "fp-cards-row-list" });
		sortCards(cards, accountById, cardsState.sort).forEach((c) => renderCardRow(list, c));

		const addMore = card.createEl("button", { cls: "fp-cards-add-more" });
		icon(addMore, "plus");
		addMore.createSpan({ text: "Add another card" });
		addMore.addEventListener("click", () => openAddCard());
	}

	function renderCardRow(parent: HTMLElement, card: Card): void {
		const isSelected = cardsState.selectedId === card.id;
		const row = parent.createDiv({ cls: "fp-card-row" + (isSelected ? " is-selected" : "") });
		row.setAttribute("role", "button");
		row.setAttribute("tabindex", "0");

		const visualWrap = row.createDiv({ cls: "fp-card-row-visual-wrap" });
		renderCardVisual(visualWrap, card, "fp-card-row-visual");
		if (isSelected) icon(visualWrap.createDiv({ cls: "fp-card-row-check" }), "check");

		const info = row.createDiv({ cls: "fp-card-row-info" });
		info.createDiv({ cls: "fp-card-row-name", text: card.name });
		const badges = info.createDiv({ cls: "fp-card-row-badges" });
		badge(badges, CARD_TYPE_LABEL[card.cardType], "neutral");
		const expired = cardIsExpired(card);
		badge(badges, expired ? "Expired" : "Active", expired ? "bad" : "good");

		const meta = info.createDiv({ cls: "fp-card-row-meta" });
		meta.createSpan({ text: card.last4 ? `•••• ${card.last4}` : "no number saved" });
		const expDate = cardExpiryDate(card);
		if (expDate) {
			meta.createSpan({ text: ` · Expires ${expDate.toLocaleDateString(undefined, { month: "short", year: "numeric" })}` });
			if (!expired && cardExpiresWithinMonths(card, 3)) badge(meta, "Expiring soon", "warn");
		}

		const menuBtn = row.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon fp-card-row-menu", attr: { "aria-label": "Card actions" } });
		icon(menuBtn, "more-vertical");
		menuBtn.addEventListener("click", (ev) => {
			ev.stopPropagation();
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle("Edit card")
					.setIcon("pencil")
					.onClick(() => openCardWizard(plugin, { existing: card, onSaved: () => render() }))
			);
			menu.addItem((item) =>
				item
					.setTitle(card.isPrimary ? "Unset as primary" : "Set as primary")
					.setIcon(card.isPrimary ? "star-off" : "star")
					.onClick(() => void togglePrimary(card))
			);
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Delete card")
					.setIcon("trash-2")
					.onClick(() => void removeCard(card))
			);
			const rect = menuBtn.getBoundingClientRect();
			menu.showAtPosition({ x: rect.right, y: rect.bottom + 4 });
		});

		const select = (): void => {
			cardsState.selectedId = card.id;
			render();
		};
		row.addEventListener("click", select);
		row.addEventListener("keydown", (ev: KeyboardEvent) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				select();
			}
		});
	}

	function renderUnlinkedAccounts(parent: HTMLElement, accounts: Account[]): void {
		const card = parent.createDiv({ cls: "fp-card" });
		const head = card.createDiv({ cls: "fp-card-head-row" });
		head.createEl("h3", { text: "Accounts without cards" });
		badge(head, String(accounts.length), "warn");

		const list = card.createDiv({ cls: "fp-account-list" });
		accounts.forEach((acc) => {
			const row = list.createDiv({ cls: "fp-account-row fp-account-row-clickable" });
			row.setAttribute("role", "button");
			row.setAttribute("tabindex", "0");
			icon(row, ACCOUNT_TYPE_META[acc.type].icon, "fp-account-row-icon");

			const info = row.createDiv({ cls: "fp-account-row-info" });
			info.createDiv({ cls: "fp-account-row-name", text: acc.name });
			info.createDiv({ cls: "fp-account-row-meta", text: ACCOUNT_TYPE_META[acc.type].label });

			badge(row, "No card linked", "bad");

			const addAccBtn = row.createEl("button", { cls: "fp-btn fp-btn-secondary fp-btn-tiny" });
			icon(addAccBtn, "plus");
			addAccBtn.createSpan({ text: "Add card" });
			addAccBtn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				openAddCard(acc.id);
			});

			icon(row, "chevron-right", "fp-account-row-chevron");

			const goto = (): void => void goToAccount(acc.id);
			row.addEventListener("click", goto);
			row.addEventListener("keydown", (ev: KeyboardEvent) => {
				if (ev.key === "Enter" || ev.key === " ") {
					ev.preventDefault();
					goto();
				}
			});
		});

		const viewAll = card.createEl("button", { cls: "fp-btn fp-btn-ghost fp-cards-view-all", text: "View all accounts" });
		viewAll.addEventListener("click", () => new ManageAccountsModal(plugin.app, plugin, () => render()).open());
	}

	function renderCardDetail(parent: HTMLElement, card: Card, account: Account | undefined): void {
		const box = parent.createDiv({ cls: "fp-card" });
		box.createDiv({ cls: "fp-card-head-label", text: "Card details" });

		const head = box.createDiv({ cls: "fp-card-detail-head" });
		renderCardVisual(head, card);

		const info = head.createDiv({ cls: "fp-card-detail-info" });
		const nameRow = info.createDiv({ cls: "fp-card-detail-name-row" });
		nameRow.createEl("h3", { text: card.name });
		const expired = cardIsExpired(card);
		badge(nameRow, expired ? "Expired" : "Active", expired ? "bad" : "good");
		info.createDiv({ cls: "fp-card-detail-sub", text: `${CARD_TYPE_LABEL[card.cardType]} · ${CARD_NETWORK_LABEL[card.network]}` });

		if (account) {
			info.createDiv({ cls: "fp-sgroup-label", text: "Linked account" });
			const acctRow = info.createDiv({ cls: "fp-account-row fp-account-row-clickable" });
			acctRow.setAttribute("role", "button");
			acctRow.setAttribute("tabindex", "0");
			icon(acctRow, ACCOUNT_TYPE_META[account.type].icon, "fp-account-row-icon");
			const acctInfo = acctRow.createDiv({ cls: "fp-account-row-info" });
			acctInfo.createDiv({ cls: "fp-account-row-name", text: account.name });
			acctInfo.createDiv({ cls: "fp-account-row-meta", text: `${ACCOUNT_TYPE_META[account.type].label} · ${account.currency}` });
			icon(acctRow, "chevron-right", "fp-account-row-chevron");
			const goto = (): void => void goToAccount(account.id);
			acctRow.addEventListener("click", goto);
			acctRow.addEventListener("keydown", (ev: KeyboardEvent) => {
				if (ev.key === "Enter" || ev.key === " ") {
					ev.preventDefault();
					goto();
				}
			});
		}

		const body = box.createDiv({ cls: "fp-detail-body" });
		detailRow(body, "credit-card", "Card type", CARD_TYPE_LABEL[card.cardType]);
		const expDate = cardExpiryDate(card);
		if (expDate) {
			const months = monthsUntil(expDate);
			const soonLabel = months < 0 ? "expired" : months === 0 ? "this month" : `in ${months} month${months === 1 ? "" : "s"}`;
			detailRow(body, "calendar", "Expires", `${expDate.toLocaleDateString(undefined, { month: "short", year: "numeric" })} (${soonLabel})`);
		}
		if (card.cardholderName) detailRow(body, "user", "Cardholder", card.cardholderName);
		detailRow(body, "shield", "Status", expired ? "Expired" : "Active");
		if (card.number) detailRow(body, "hash", "Card number", groupedNumber(card.number), { sensitive: true });
		else if (card.last4) detailRow(body, "hash", "Card number", `•••• •••• •••• ${card.last4}`, { sensitive: true });
		detailRow(body, "wifi", "Network", CARD_NETWORK_LABEL[card.network]);
		if (card.notes) detailRow(body, "sticky-note", "Notes", card.notes);

		const footer = box.createDiv({ cls: "fp-card-detail-footer" });
		const editBtn = footer.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(editBtn, "pencil");
		editBtn.createSpan({ text: "Edit card" });
		editBtn.addEventListener("click", () => openCardWizard(plugin, { existing: card, onSaved: () => render() }));

		const right = footer.createDiv({ cls: "fp-card-detail-footer-right" });
		const moreBtn = right.createEl("button", { cls: "fp-btn fp-btn-ghost" });
		icon(moreBtn, "more-horizontal");
		moreBtn.createSpan({ text: "More" });
		moreBtn.addEventListener("click", () => {
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle(card.isPrimary ? "Unset as primary" : "Set as primary")
					.setIcon(card.isPrimary ? "star-off" : "star")
					.onClick(() => void togglePrimary(card))
			);
			const rect = moreBtn.getBoundingClientRect();
			menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
		});
		const deleteBtn = right.createEl("button", { cls: "fp-btn fp-btn-danger" });
		icon(deleteBtn, "trash-2");
		deleteBtn.createSpan({ text: "Delete card" });
		deleteBtn.addEventListener("click", () => void removeCard(card));
	}

	render();
}
