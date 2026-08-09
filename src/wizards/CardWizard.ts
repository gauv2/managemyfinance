import { Notice } from "obsidian";
import { CARD_NETWORK_LABEL, CARD_NETWORKS, CARD_TYPE_LABEL, CARD_TYPES } from "../cards";
import type FinancePlugin from "../main";
import type { Card, CardNetwork, CardType } from "../types";
import { renderCardVisual } from "../ui/cardVisual";
import { WizardModal, WizardStep } from "./WizardModal";

function formField(parent: HTMLElement, label: string, type: string, placeholder?: string, extraAttr?: Record<string, string>) {
	const row = parent.createDiv({ cls: "fp-form-row" });
	row.createEl("label", { text: label });
	const attr = { ...(placeholder ? { placeholder } : {}), ...(extraAttr ?? {}) };
	const input = row.createEl("input", { type, attr: Object.keys(attr).length ? attr : undefined });
	return { row, input };
}

function formSelectField(parent: HTMLElement, label: string, options: { value: string; label: string }[]) {
	const row = parent.createDiv({ cls: "fp-form-row" });
	row.createEl("label", { text: label });
	const select = row.createEl("select");
	options.forEach((opt) => select.createEl("option", { text: opt.label, value: opt.value }));
	return { row, select };
}

/**
 * Add or edit one card, always linked to an existing account. `skippable` powers the two onboarding
 * entry points (first run, new portfolio) — Skip bails out of the whole flow without saving anything.
 */
export function openCardWizard(
	plugin: FinancePlugin,
	opts?: { existing?: Card; skippable?: boolean; skipLabel?: string; onSaved?: (card: Card) => void; onSkip?: () => void }
): void {
	const store = plugin.store;
	const existing = opts?.existing;

	if (store.accounts.length === 0) {
		new Notice("Add an account first — cards always link to one.");
		return;
	}

	let accountId = existing?.accountId ?? store.accounts[0].id;
	let name = existing?.name ?? "";
	let issuer = existing?.issuer ?? "";
	let product = existing?.product ?? "";
	let network: CardNetwork = existing?.network ?? "visa";
	let cardType: CardType = existing?.cardType ?? "debit";
	let last4 = existing?.last4 ?? "";
	let expiry = existing?.expiry ?? "";
	let isPrimary = existing?.isPrimary ?? false;
	let notes = existing?.notes ?? "";

	const steps: WizardStep[] = [
		{
			id: "details",
			title: "Details",
			icon: "credit-card",
			skippable: opts?.skippable,
			skipLabel: opts?.skipLabel ?? "Skip for now",
			onSkip: opts?.onSkip,
			render: (c) => {
				c.createEl("h3", { text: existing ? `Edit "${existing.name}"` : "Add a card" });
				c.createEl("p", {
					cls: "fp-step-desc",
					text: "Every card links to one of your accounts — that's what it draws money from (or borrows against).",
				});
				const grid = c.createDiv({ cls: "fp-sub-form-grid" });

				const accountField = formSelectField(
					grid,
					"Linked account",
					store.accounts.map((a) => ({ value: a.id, label: a.name }))
				);
				accountField.select.value = accountId;
				accountField.select.addEventListener("change", () => (accountId = accountField.select.value));

				const nameField = formField(grid, "Card name", "text", "e.g. Amex Platinum");
				nameField.input.value = name;
				nameField.input.addEventListener("input", () => (name = nameField.input.value));

				const issuerField = formField(grid, "Issuer (optional)", "text", "e.g. American Express");
				issuerField.input.value = issuer;
				issuerField.input.addEventListener("input", () => (issuer = issuerField.input.value));

				const productField = formField(grid, "Product / tier (optional)", "text", "e.g. Platinum");
				productField.input.value = product;
				productField.input.addEventListener("input", () => (product = productField.input.value));

				const networkField = formSelectField(
					grid,
					"Network",
					CARD_NETWORKS.map((n) => ({ value: n, label: CARD_NETWORK_LABEL[n] }))
				);
				networkField.select.value = network;
				networkField.select.addEventListener("change", () => (network = networkField.select.value as CardNetwork));

				const typeField = formSelectField(
					grid,
					"Card type",
					CARD_TYPES.map((t) => ({ value: t, label: CARD_TYPE_LABEL[t] }))
				);
				typeField.select.value = cardType;
				typeField.select.addEventListener("change", () => (cardType = typeField.select.value as CardType));

				const last4Field = formField(grid, "Last 4 digits (optional)", "text", "1234", { maxlength: "4" });
				last4Field.input.value = last4;
				last4Field.input.addEventListener("input", () => (last4 = last4Field.input.value.replace(/\D/g, "").slice(0, 4)));

				const expiryField = formField(grid, "Expiry (optional)", "text", "MM/YY", { maxlength: "5" });
				expiryField.input.value = expiry;
				expiryField.input.addEventListener("input", () => (expiry = expiryField.input.value));

				const notesField = formField(grid, "Notes (optional)", "text", "e.g. shared with family");
				notesField.input.value = notes;
				notesField.input.addEventListener("input", () => (notes = notesField.input.value));

				const primaryRow = c.createDiv({ cls: "fp-type-checkbox-row" });
				const primaryCheckbox = primaryRow.createEl("input", { type: "checkbox", attr: { id: "fp-card-primary" } });
				primaryCheckbox.checked = isPrimary;
				primaryCheckbox.addEventListener("change", () => (isPrimary = primaryCheckbox.checked));
				const primaryLabel = primaryRow.createEl("label", { attr: { for: "fp-card-primary" } });
				primaryLabel.createSpan({ text: "This is the primary card for its account" });

				setTimeout(() => nameField.input.focus(), 0);
			},
			canGoNext: () => !!accountId && name.trim().length > 0,
		},
		{
			id: "preview",
			title: "Preview",
			icon: "eye",
			skippable: opts?.skippable,
			skipLabel: opts?.skipLabel ?? "Skip for now",
			onSkip: opts?.onSkip,
			render: (c) => {
				c.createEl("h3", { text: "This is roughly how it'll look" });
				c.createEl("p", {
					cls: "fp-step-desc",
					text: "A stylized approximation based on the card's tier and network — not your bank's actual card art.",
				});
				const previewWrap = c.createDiv({ cls: "fp-card-preview-wrap" });
				renderCardVisual(previewWrap, { name: name.trim() || "Your card", product, issuer, network, cardType, last4, expiry, isPrimary });
			},
			nextLabel: existing ? "Save changes" : "Add card",
			onNext: async () => {
				const card: Card = {
					id: existing?.id ?? `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
					accountId,
					name: name.trim(),
					issuer: issuer.trim() || undefined,
					product: product.trim() || undefined,
					network,
					cardType,
					last4: last4 || undefined,
					expiry: expiry.trim() || undefined,
					isPrimary,
					notes: notes.trim() || undefined,
				};

				if (existing) {
					const idx = store.cards.findIndex((c) => c.id === existing.id);
					store.cards[idx] = card;
				} else {
					store.cards.push(card);
				}
				await store.saveCards();
				new Notice(existing ? `Updated "${card.name}"` : `Added "${card.name}"`);
				opts?.onSaved?.(card);
			},
		},
	];

	new WizardModal(plugin.app, {
		title: existing ? "Edit card" : "Add a card",
		subtitle: "A payment card, linked to the account it actually draws from.",
		icon: "credit-card",
		steps,
	}).open();
}
