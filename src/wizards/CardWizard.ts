import { Notice } from "obsidian";
import { activeAccounts } from "../accounts";
import { CARD_NETWORK_LABEL, CARD_NETWORKS, CARD_TYPE_LABEL, CARD_TYPES } from "../cards";
import type FinancePlugin from "../main";
import type { Card, CardNetwork, CardType } from "../types";
import { renderCardVisual } from "../ui/cardVisual";
import { WizardModal, WizardStep } from "./WizardModal";
import { formField, formSelectFieldVL as formSelectField } from "./formHelpers";

const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
const now = new Date();
const YEARS = Array.from({ length: 16 }, (_, i) => now.getFullYear() + i);

/**
 * Add or edit one card, always linked to an existing account. `skippable` powers the two onboarding
 * entry points (first run, new portfolio) — Skip bails out of the whole flow without saving anything.
 * The CVV is never asked for and never stored — it exists only to prove physical possession of the
 * card at the moment of a transaction, and this app has no legitimate reason to hold onto it.
 */
export function openCardWizard(
	plugin: FinancePlugin,
	opts?: {
		existing?: Card;
		/** Preselects "Linked account" — e.g. the account a card was added from. Ignored when editing. */
		defaultAccountId?: string;
		skippable?: boolean;
		skipLabel?: string;
		onSaved?: (card: Card) => void;
		onSkip?: () => void;
	}
): void {
	const store = plugin.store;
	const existing = opts?.existing;

	if (store.accounts.length === 0) {
		new Notice("Add an account first — cards always link to one.");
		return;
	}

	let accountId = existing?.accountId ?? opts?.defaultAccountId ?? store.accounts[0].id;
	let name = existing?.name ?? "";
	let cardholderName = existing?.cardholderName ?? "";
	let issuer = existing?.issuer ?? "";
	let product = existing?.product ?? "";
	let network: CardNetwork = existing?.network ?? "visa";
	let cardType: CardType = existing?.cardType ?? "debit";
	let number = existing?.number ?? "";
	let expiryMonth = existing?.expiryMonth ?? now.getMonth() + 1;
	let expiryYear = existing?.expiryYear ?? now.getFullYear();
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
			render: (c, wizard) => {
				c.createEl("h3", { text: existing ? `Edit "${existing.name}"` : "Add a card" });
				c.createEl("p", {
					cls: "fp-step-desc",
					text: "Every card links to one of your accounts — that's what it draws money from (or borrows against). The CVV is never asked for and never stored.",
				});
				const grid = c.createDiv({ cls: "fp-sub-form-grid" });

				const accountField = formSelectField(
					grid,
					"Linked account",
					activeAccounts(store.accounts, accountId).map((a) => ({ value: a.id, label: a.name }))
				);
				accountField.select.value = accountId;
				accountField.select.addEventListener("change", () => {
					accountId = accountField.select.value;
					wizard.refreshFooter();
				});

				const nameField = formField(grid, "Card name", "text", "e.g. Amex Platinum");
				nameField.input.value = name;
				nameField.input.addEventListener("input", () => {
					name = nameField.input.value;
					wizard.refreshFooter();
				});

				const cardholderField = formField(grid, "Cardholder name", "text", "e.g. Gaurav Mahadew");
				cardholderField.input.value = cardholderName;
				cardholderField.input.addEventListener("input", () => {
					cardholderName = cardholderField.input.value;
					wizard.refreshFooter();
				});

				const numberField = formField(grid, "Card number", "text", "•••• •••• •••• ••••", { maxlength: "19", inputmode: "numeric" });
				numberField.input.value = number;
				numberField.input.addEventListener("input", () => {
					number = numberField.input.value.replace(/\D/g, "").slice(0, 19);
					wizard.refreshFooter();
				});

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

				const expMonthField = formSelectField(
					grid,
					"Expiry month",
					MONTHS.map((m) => ({ value: m, label: m }))
				);
				expMonthField.select.value = String(expiryMonth).padStart(2, "0");
				expMonthField.select.addEventListener("change", () => (expiryMonth = parseInt(expMonthField.select.value, 10)));

				const expYearField = formSelectField(
					grid,
					"Expiry year",
					YEARS.map((y) => ({ value: String(y), label: String(y) }))
				);
				expYearField.select.value = String(expiryYear);
				expYearField.select.addEventListener("change", () => (expiryYear = parseInt(expYearField.select.value, 10)));

				const notesField = formField(grid, "Notes (optional)", "text", "e.g. shared with family");
				notesField.input.value = notes;
				notesField.input.addEventListener("input", () => (notes = notesField.input.value));

				const primaryRow = c.createDiv({ cls: "fp-checkbox-field" });
				const primaryCheckbox = primaryRow.createEl("input", { type: "checkbox", attr: { id: "fp-card-primary" } });
				primaryCheckbox.checked = isPrimary;
				primaryCheckbox.addEventListener("change", () => (isPrimary = primaryCheckbox.checked));
				const primaryLabel = primaryRow.createEl("label", { attr: { for: "fp-card-primary" } });
				primaryLabel.createSpan({ text: "This is the primary card for its account" });

				setTimeout(() => nameField.input.focus(), 0);
			},
			canGoNext: () => !!accountId && name.trim().length > 0 && cardholderName.trim().length > 0 && number.length >= 8,
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
					text: "A stylized approximation based on the card's tier and network — not your bank's actual card art. Click it to see the back.",
				});
				const previewWrap = c.createDiv({ cls: "fp-card-preview-wrap" });
				renderCardVisual(previewWrap, {
					name: name.trim() || "Your card",
					cardholderName: cardholderName.trim(),
					product,
					issuer,
					network,
					cardType,
					number,
					last4: number.slice(-4),
					expiryMonth,
					expiryYear,
					isPrimary,
				});
			},
			nextLabel: existing ? "Save changes" : "Add card",
			onNext: async () => {
				const card: Card = {
					id: existing?.id ?? `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
					accountId,
					name: name.trim(),
					cardholderName: cardholderName.trim() || undefined,
					issuer: issuer.trim() || undefined,
					product: product.trim() || undefined,
					network,
					cardType,
					number: number || undefined,
					last4: number ? number.slice(-4) : existing?.last4,
					expiryMonth,
					expiryYear,
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
