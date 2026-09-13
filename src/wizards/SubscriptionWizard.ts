import { Notice } from "obsidian";
import { activeAccounts } from "../accounts";
import type FinancePlugin from "../main";
import { CURRENCIES } from "../constants";
import {
	BILLING_CYCLE_LABEL,
	DISPLAY_CYCLE_LABEL,
	type DisplayCycle,
	SUBSCRIPTION_CATEGORIES,
	formatSubMoney,
	monthlyCost,
	subCurrency,
} from "../subscriptions";
import type { Subscription, SubscriptionBillingCycle, SubscriptionPaidVia } from "../types";
import { WizardModal, WizardStep } from "./WizardModal";
import { formField, formMoneyField, formSelectField, formSelectFieldVL } from "./formHelpers";

const BILLING_CYCLES: SubscriptionBillingCycle[] = ["monthly", "yearly", "quarterly", "weekly"];

function billingCycleFromLabel(label: string): SubscriptionBillingCycle {
	return BILLING_CYCLES.find((c) => BILLING_CYCLE_LABEL[c] === label) ?? "monthly";
}

/** Add or edit one subscription over two quick steps: what it is, then when it renews — same fields as before, just off the page. */
export function openSubscriptionWizard(plugin: FinancePlugin, existing?: Subscription, onSaved?: (sub: Subscription) => void): void {
	const store = plugin.store;

	let name = existing?.name ?? "";
	let plan = existing?.plan ?? "";
	let website = existing?.website ?? "";
	let category = existing?.category ?? SUBSCRIPTION_CATEGORIES[0];
	let cost: number | undefined = existing?.cost;
	let currency = existing ? subCurrency(existing) : "EUR";
	let billingCycle: SubscriptionBillingCycle = existing?.billingCycle ?? "monthly";
	let paidVia: SubscriptionPaidVia = existing?.paidVia ?? "private";
	let kind = existing?.kind ?? "Not SaaS";
	let accountId = existing?.accountId ?? "";
	let nextDueDate = existing?.nextDueDate ?? "";
	let endDate = existing?.endDate ?? "";
	let cancelUrl = existing?.cancelUrl ?? "";
	let notes = existing?.notes ?? "";
	let displayCycle: DisplayCycle | "" = existing?.displayCycle ?? "";

	const steps: WizardStep[] = [
		{
			id: "details",
			title: "Details",
			icon: "repeat",
			render: (c, wizard) => {
				c.createEl("h3", { text: existing ? `Edit "${existing.name}"` : "What are you subscribing to?" });
				const grid = c.createDiv({ cls: "fp-sub-form-grid" });

				const nameField = formField(grid, "Name (company)", "text", "e.g. Suno");
				nameField.input.value = name;
				nameField.input.addEventListener("input", () => { name = nameField.input.value; wizard.refreshFooter(); });

				const planField = formField(grid, "Plan / tier (optional)", "text", "e.g. Premier plan");
				planField.input.value = plan;
				planField.input.addEventListener("input", () => (plan = planField.input.value));

				const websiteField = formField(grid, "Website (optional)", "text", "e.g. suno.com");
				websiteField.input.value = website;
				websiteField.input.addEventListener("input", () => (website = websiteField.input.value));

				const categoryField = formSelectField(grid, "Category", SUBSCRIPTION_CATEGORIES);
				categoryField.select.value = category;
				categoryField.select.addEventListener("change", () => (category = categoryField.select.value));

				const costField = formMoneyField(grid, "Cost", CURRENCIES, {
					value: cost,
					currency,
					onChange: (v) => { cost = v; wizard.refreshFooter(); },
				});
				costField.select.value = currency;
				costField.select.addEventListener("change", () => {
					currency = costField.select.value;
					costField.money.setCurrency(currency);
				});

				const cycleField = formSelectField(
					grid,
					"Billing cycle",
					BILLING_CYCLES.map((cy) => BILLING_CYCLE_LABEL[cy])
				);
				cycleField.select.value = BILLING_CYCLE_LABEL[billingCycle];
				cycleField.select.addEventListener("change", () => (billingCycle = billingCycleFromLabel(cycleField.select.value)));

				const paidViaField = formSelectField(grid, "Paid via", ["Private account", "Business account"]);
				paidViaField.select.value = paidVia === "business" ? "Business account" : "Private account";
				paidViaField.select.addEventListener("change", () => (paidVia = paidViaField.select.value === "Business account" ? "business" : "private"));

				const kindField = formSelectField(grid, "Type", ["Not SaaS", "SaaS"]);
				kindField.select.value = kind;
				kindField.select.addEventListener("change", () => (kind = kindField.select.value));

				const accountField = formSelectFieldVL(grid, "Paid from account (optional)", [
					{ value: "", label: "None" },
					...activeAccounts(store.accounts, accountId).map((a) => ({ value: a.id, label: a.name })),
				]);
				accountField.select.value = accountId;
				accountField.select.addEventListener("change", () => (accountId = accountField.select.value));

				// Distinct from the billing cycle above: that's how often it's charged, this is only how you
				// prefer to think about the number. Applies when the Subscriptions page is set to "Mixed".
				const quoteField = formSelectFieldVL(grid, "Quote as", [
					{ value: "", label: "Follow the page setting" },
					{ value: "monthly", label: DISPLAY_CYCLE_LABEL.monthly },
					{ value: "yearly", label: DISPLAY_CYCLE_LABEL.yearly },
				]);
				quoteField.select.value = displayCycle;
				quoteField.select.addEventListener("change", () => (displayCycle = quoteField.select.value as DisplayCycle | ""));

				setTimeout(() => nameField.input.focus(), 0);
			},
			canGoNext: () => name.trim().length > 0 && cost !== undefined && cost >= 0,
		},
		{
			id: "schedule",
			title: "Schedule",
			icon: "calendar",
			render: (c, wizard) => {
				c.createEl("h3", { text: "When does it renew?" });
				const grid = c.createDiv({ cls: "fp-sub-form-grid" });

				const nextDueField = formField(grid, "Next due date", "date");
				nextDueField.input.value = nextDueDate;
				nextDueField.input.addEventListener("input", () => { nextDueDate = nextDueField.input.value; wizard.refreshFooter(); });

				const endDateField = formField(grid, "End date (optional)", "date");
				endDateField.input.value = endDate;
				endDateField.input.addEventListener("input", () => (endDate = endDateField.input.value));

				const cancelLinkField = formField(grid, "Cancel / manage link (optional)", "text", "https://…/account/cancel");
				cancelLinkField.input.value = cancelUrl;
				cancelLinkField.input.addEventListener("input", () => (cancelUrl = cancelLinkField.input.value));

				const notesField = formField(grid, "Notes (optional)", "text", "e.g. shared with family");
				notesField.input.value = notes;
				notesField.input.addEventListener("input", () => (notes = notesField.input.value));

				const monthly = monthlyCost({ cost: cost ?? 0, billingCycle } as Subscription);
				c.createDiv({
					cls: "fp-sub-form-preview fp-money",
					text: `≈ ${formatSubMoney(monthly, currency)}/mo · ${formatSubMoney(monthly * 12, currency)}/yr`,
				});

				setTimeout(() => nextDueField.input.focus(), 0);
			},
			canGoNext: () => !!nextDueDate,
			nextLabel: existing ? "Save changes" : "Add subscription",
			onNext: async () => {
				const sub: Subscription = {
					id: existing?.id ?? `sub-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
					name: name.trim(),
					plan: plan.trim() || undefined,
					website: website.trim() || undefined,
					category,
					cost: cost ?? 0,
					currency,
					billingCycle,
					paidVia,
					kind,
					accountId: accountId || undefined,
					nextDueDate,
					endDate: endDate || undefined,
					cancelUrl: cancelUrl.trim() || undefined,
					notes: notes.trim() || undefined,
					displayCycle: displayCycle || undefined,
				};

				if (existing) {
					const idx = store.subscriptions.findIndex((s) => s.id === existing.id);
					store.subscriptions[idx] = sub;
				} else {
					store.subscriptions.push(sub);
				}
				await store.saveSubscriptions();
				new Notice(existing ? `Updated "${sub.name}"` : `Added "${sub.name}"`);
				onSaved?.(sub);
			},
		},
	];

	new WizardModal(plugin.app, {
		title: existing ? "Edit subscription" : "Add a subscription",
		subtitle: "Track a recurring payment — cost, cadence, and when it renews.",
		icon: "repeat",
		steps,
	}).open();
}
