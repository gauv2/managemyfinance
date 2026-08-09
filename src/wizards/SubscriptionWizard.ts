import { Notice } from "obsidian";
import type FinancePlugin from "../main";
import { BILLING_CYCLE_LABEL, SUBSCRIPTION_CATEGORIES, monthlyCost } from "../subscriptions";
import type { Subscription, SubscriptionBillingCycle, SubscriptionPaidVia } from "../types";
import { WizardModal, WizardStep } from "./WizardModal";

const BILLING_CYCLES: SubscriptionBillingCycle[] = ["monthly", "yearly", "quarterly", "weekly"];

function formatEUR(n: number): string {
	return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(n);
}

function billingCycleFromLabel(label: string): SubscriptionBillingCycle {
	return BILLING_CYCLES.find((c) => BILLING_CYCLE_LABEL[c] === label) ?? "monthly";
}

function formField(
	parent: HTMLElement,
	label: string,
	type: string,
	placeholder?: string,
	extraAttr?: Record<string, string>
): { row: HTMLElement; input: HTMLInputElement } {
	const row = parent.createDiv({ cls: "fp-form-row" });
	row.createEl("label", { text: label });
	const attr = { ...(placeholder ? { placeholder } : {}), ...(extraAttr ?? {}) };
	const input = row.createEl("input", { type, attr: Object.keys(attr).length ? attr : undefined });
	return { row, input };
}

function formSelectField(parent: HTMLElement, label: string, options: string[]): { row: HTMLElement; select: HTMLSelectElement } {
	const row = parent.createDiv({ cls: "fp-form-row" });
	row.createEl("label", { text: label });
	const select = row.createEl("select");
	options.forEach((opt) => select.createEl("option", { text: opt, value: opt }));
	return { row, select };
}

function formSelectFieldVL(
	parent: HTMLElement,
	label: string,
	options: { value: string; label: string }[]
): { row: HTMLElement; select: HTMLSelectElement } {
	const row = parent.createDiv({ cls: "fp-form-row" });
	row.createEl("label", { text: label });
	const select = row.createEl("select");
	options.forEach((opt) => select.createEl("option", { text: opt.label, value: opt.value }));
	return { row, select };
}

/** Add or edit one subscription over two quick steps: what it is, then when it renews — same fields as before, just off the page. */
export function openSubscriptionWizard(plugin: FinancePlugin, existing?: Subscription, onSaved?: (sub: Subscription) => void): void {
	const store = plugin.store;

	let name = existing?.name ?? "";
	let plan = existing?.plan ?? "";
	let website = existing?.website ?? "";
	let category = existing?.category ?? SUBSCRIPTION_CATEGORIES[0];
	let cost = existing ? String(existing.cost) : "";
	let billingCycle: SubscriptionBillingCycle = existing?.billingCycle ?? "monthly";
	let paidVia: SubscriptionPaidVia = existing?.paidVia ?? "private";
	let kind = existing?.kind ?? "Not SaaS";
	let accountId = existing?.accountId ?? "";
	let nextDueDate = existing?.nextDueDate ?? "";
	let endDate = existing?.endDate ?? "";
	let cancelUrl = existing?.cancelUrl ?? "";
	let notes = existing?.notes ?? "";

	const steps: WizardStep[] = [
		{
			id: "details",
			title: "Details",
			icon: "repeat",
			render: (c) => {
				c.createEl("h3", { text: existing ? `Edit "${existing.name}"` : "What are you subscribing to?" });
				const grid = c.createDiv({ cls: "fp-sub-form-grid" });

				const nameField = formField(grid, "Name (company)", "text", "e.g. Suno");
				nameField.input.value = name;
				nameField.input.addEventListener("input", () => (name = nameField.input.value));

				const planField = formField(grid, "Plan / tier (optional)", "text", "e.g. Premier plan");
				planField.input.value = plan;
				planField.input.addEventListener("input", () => (plan = planField.input.value));

				const websiteField = formField(grid, "Website (optional)", "text", "e.g. suno.com");
				websiteField.input.value = website;
				websiteField.input.addEventListener("input", () => (website = websiteField.input.value));

				const categoryField = formSelectField(grid, "Category", SUBSCRIPTION_CATEGORIES);
				categoryField.select.value = category;
				categoryField.select.addEventListener("change", () => (category = categoryField.select.value));

				const costField = formField(grid, "Cost (€)", "number", "0.00", { step: "0.01", min: "0" });
				costField.input.value = cost;
				costField.input.addEventListener("input", () => (cost = costField.input.value));

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
					...store.accounts.map((a) => ({ value: a.id, label: a.name })),
				]);
				accountField.select.value = accountId;
				accountField.select.addEventListener("change", () => (accountId = accountField.select.value));

				setTimeout(() => nameField.input.focus(), 0);
			},
			canGoNext: () => name.trim().length > 0 && isFinite(parseFloat(cost)) && parseFloat(cost) >= 0,
		},
		{
			id: "schedule",
			title: "Schedule",
			icon: "calendar",
			render: (c) => {
				c.createEl("h3", { text: "When does it renew?" });
				const grid = c.createDiv({ cls: "fp-sub-form-grid" });

				const nextDueField = formField(grid, "Next due date", "date");
				nextDueField.input.value = nextDueDate;
				nextDueField.input.addEventListener("input", () => (nextDueDate = nextDueField.input.value));

				const endDateField = formField(grid, "End date (optional)", "date");
				endDateField.input.value = endDate;
				endDateField.input.addEventListener("input", () => (endDate = endDateField.input.value));

				const cancelLinkField = formField(grid, "Cancel / manage link (optional)", "text", "https://…/account/cancel");
				cancelLinkField.input.value = cancelUrl;
				cancelLinkField.input.addEventListener("input", () => (cancelUrl = cancelLinkField.input.value));

				const notesField = formField(grid, "Notes (optional)", "text", "e.g. shared with family");
				notesField.input.value = notes;
				notesField.input.addEventListener("input", () => (notes = notesField.input.value));

				const monthly = monthlyCost({ cost: parseFloat(cost) || 0, billingCycle } as Subscription);
				c.createDiv({ cls: "fp-sub-form-preview fp-money", text: `≈ ${formatEUR(monthly)}/mo · ${formatEUR(monthly * 12)}/yr` });

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
					cost: parseFloat(cost),
					billingCycle,
					paidVia,
					kind,
					accountId: accountId || undefined,
					nextDueDate,
					endDate: endDate || undefined,
					cancelUrl: cancelUrl.trim() || undefined,
					notes: notes.trim() || undefined,
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
