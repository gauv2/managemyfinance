import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { merchantKey } from "../import/merchantKey";
import type FinancePlugin from "../main";
import { formatMoney } from "../money";
import {
	detectRecurring,
	formatSubMoney,
	isActive,
	latestPriceIncrease,
	paymentsFor,
	subCurrency,
	suggestPaymentsFor,
	upcomingPayments,
} from "../subscriptions";
import type { Subscription, Transaction } from "../types";
import { badge, icon } from "../ui/dom";

/**
 * The two halves of connecting a subscription to what you actually pay for it.
 *
 * `LinkSubscriptionModal` starts from a transaction ("this charge is my Netflix"); the payments modal
 * starts from a subscription ("show me every Netflix charge and let me claim the ones that are mine").
 * Both write the same link — `Transaction.subscriptionId` — and both set a match pattern the first
 * time, so the next charge from that merchant is suggested rather than hunted for.
 */

/** The text a subscription should recognize future charges by, taken from a real one. */
function patternFrom(tx: Transaction): string {
	const merchant = merchantKey(tx);
	const raw = (merchant || tx.counterparty || tx.description || "").trim();
	// Trimmed to something short enough to survive the reference numbers banks staple onto each charge.
	return raw.slice(0, 24).trim();
}

async function linkTransaction(plugin: FinancePlugin, tx: Transaction, sub: Subscription): Promise<void> {
	const store = plugin.store;
	await store.updateTransaction(tx.id, { subscriptionId: sub.id });
	if (!sub.matchPattern) {
		sub.matchPattern = patternFrom(tx);
		await store.saveSubscriptions();
	}
}

/** Starts from a transaction: pick the subscription it belongs to, or create one prefilled from it. */
export class LinkSubscriptionModal extends FinanceModal {
	private query = "";

	constructor(app: App, private plugin: FinancePlugin, private tx: Transaction, private onDone?: () => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		this.contentEl.addClass("fp-account-modal");
		this.render();
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();
		const store = this.plugin.store;

		c.createEl("h3", { text: "Link to a subscription" });
		c.createDiv({
			cls: "fp-step-desc",
			text: `${this.tx.date} · ${this.tx.description || "(no description)"} · ${formatMoney(this.tx.amount, {
				currency: this.tx.currency || "EUR",
			})}`,
		});

		const current = this.tx.subscriptionId ? store.subscriptions.find((s) => s.id === this.tx.subscriptionId) : undefined;
		if (current) {
			const row = c.createDiv({ cls: "fp-linked-row" });
			icon(row, "link", "fp-linked-icon");
			row.createSpan({ text: `Currently linked to ${current.name}` });
			const unlinkBtn = row.createEl("button", { cls: "fp-btn fp-btn-ghost" });
			icon(unlinkBtn, "unlink");
			unlinkBtn.createSpan({ text: "Unlink" });
			unlinkBtn.addEventListener("click", async () => {
				await store.updateTransaction(this.tx.id, { subscriptionId: undefined });
				this.tx.subscriptionId = undefined;
				new Notice("Unlinked");
				this.plugin.refreshViews();
				this.onDone?.();
				this.render();
			});
		}

		const search = c.createEl("input", {
			type: "text",
			cls: "fp-search",
			attr: { placeholder: "Search your subscriptions…" },
		});
		search.value = this.query;
		search.addEventListener("input", () => {
			this.query = search.value;
			renderList();
		});

		const listWrap = c.createDiv({ cls: "fp-link-list" });
		const renderList = (): void => {
			listWrap.empty();
			const q = this.query.trim().toLowerCase();
			const matches = store.subscriptions
				.filter((s) => !s.archived)
				.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.category ?? "").toLowerCase().includes(q))
				// The likeliest answer first: whatever this merchant's text already resembles.
				.sort((a, b) => Number(nameMatches(b, this.tx)) - Number(nameMatches(a, this.tx)));

			if (matches.length === 0) {
				listWrap.createDiv({ cls: "fp-block-empty", text: "No subscriptions match. Create one below." });
				return;
			}

			matches.slice(0, 30).forEach((sub) => {
				const row = listWrap.createDiv({ cls: "fp-link-row" });
				const info = row.createDiv({ cls: "fp-link-row-info" });
				info.createDiv({ cls: "fp-link-row-name", text: sub.name });
				info.createDiv({
					cls: "fp-link-row-meta",
					text: `${formatSubMoney(sub.cost, subCurrency(sub))} · ${sub.billingCycle}${sub.category ? ` · ${sub.category}` : ""}`,
				});
				if (nameMatches(sub, this.tx)) badge(row, "likely match", "good");
				const linkBtn = row.createEl("button", { cls: "fp-btn fp-btn-secondary" });
				icon(linkBtn, "link");
				linkBtn.createSpan({ text: "Link" });
				linkBtn.addEventListener("click", async () => {
					await linkTransaction(this.plugin, this.tx, sub);
					this.tx.subscriptionId = sub.id;
					new Notice(`Linked to ${sub.name}`);
					this.plugin.refreshViews();
					this.onDone?.();
					this.close();
				});
			});
		};
		renderList();

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const createBtn = left.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(createBtn, "plus");
		createBtn.createSpan({ text: "Create a subscription from this" });
		createBtn.addEventListener("click", () => void this.createFromTransaction());

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const closeBtn = right.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Close" });
		closeBtn.addEventListener("click", () => this.close());
	}

	/**
	 * Builds a subscription from the transaction in front of you rather than opening an empty form:
	 * the name, cost, currency and account are all right there, and the next due date is a month on
	 * from the charge. Monthly is assumed because one transaction can't reveal a cycle — the
	 * subscription is editable the moment it exists.
	 */
	private async createFromTransaction(): Promise<void> {
		const store = this.plugin.store;
		const name = (this.tx.counterparty || this.tx.description || "New subscription").trim().slice(0, 40);
		const nextDue = new Date(`${this.tx.date}T00:00:00Z`);
		nextDue.setUTCMonth(nextDue.getUTCMonth() + 1);

		const sub: Subscription = {
			id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			name,
			category: "Other",
			cost: Math.abs(this.tx.amount),
			currency: this.tx.currency || "EUR",
			billingCycle: "monthly",
			paidVia: "private",
			accountId: this.tx.accountId,
			nextDueDate: nextDue.toISOString().slice(0, 10),
			matchPattern: patternFrom(this.tx),
		};
		store.subscriptions.push(sub);
		await store.saveSubscriptions();
		await linkTransaction(this.plugin, this.tx, sub);
		this.tx.subscriptionId = sub.id;

		new Notice(`Created "${sub.name}" and linked this payment to it`);
		this.plugin.refreshViews();
		this.onDone?.();
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function nameMatches(sub: Subscription, tx: Transaction): boolean {
	const haystack = `${tx.description ?? ""} ${tx.counterparty ?? ""}`.toLowerCase();
	const needle = (sub.matchPattern || sub.name).toLowerCase().trim();
	return needle.length > 2 && haystack.includes(needle);
}

/**
 * Starts from a subscription: what it has actually cost, and which unclaimed ledger rows look like
 * more of the same.
 *
 * The gap this closes is that a subscription tracker on its own only knows what you *told* it. Once
 * payments are mapped, "€11.99/mo" can be checked against the €13.99 that actually left the account
 * in March — which is exactly how a quiet price rise gets noticed.
 */
export class SubscriptionPaymentsModal extends FinanceModal {
	constructor(app: App, private plugin: FinancePlugin, private sub: Subscription, private onDone?: () => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		this.contentEl.addClass("fp-account-modal");
		this.render();
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();
		const store = this.plugin.store;

		c.createEl("h3", { text: `${this.sub.name} — payments` });

		const linked = paymentsFor(store.transactions, this.sub);
		const increase = latestPriceIncrease(store.transactions, this.sub);

		const summary = c.createDiv({ cls: "fp-map-status" });
		const head = summary.createDiv({ cls: "fp-map-status-head" });
		icon(head, linked.length > 0 ? "check-circle-2" : "alert-triangle", `fp-map-status-icon ${linked.length > 0 ? "is-ok" : "is-warn"}`);
		head.createSpan({
			cls: "fp-map-status-title",
			text:
				linked.length > 0
					? `${linked.length} payment${linked.length === 1 ? "" : "s"} mapped, ${formatMoney(
							linked.reduce((sum, p) => sum + p.amount, 0),
							{ currency: subCurrency(this.sub) }
					  )} paid in total`
					: "No payments mapped yet — claim them below.",
		});
		if (increase) {
			summary.createDiv({
				cls: "fp-map-status-note",
				text: `Price went up ${Math.round(increase.delta * 100)}% on ${increase.date}: ${formatSubMoney(
					increase.from,
					subCurrency(this.sub)
				)} → ${formatSubMoney(increase.to, subCurrency(this.sub))}. The tracked cost is ${formatSubMoney(
					this.sub.cost,
					subCurrency(this.sub)
				)}.`,
			});
		}

		const patternRow = c.createDiv({ cls: "fp-form-row" });
		patternRow.createEl("label", { text: "Match text" });
		const patternControl = patternRow.createDiv({ cls: "fp-field-control" });
		const patternInput = patternControl.createEl("input", {
			type: "text",
			attr: { placeholder: this.sub.name },
		});
		patternInput.value = this.sub.matchPattern ?? "";
		patternControl.createDiv({
			cls: "fp-field-hint",
			text: "What a charge for this subscription looks like in the ledger. Suggestions below are matched against it.",
		});
		patternInput.addEventListener("change", async () => {
			this.sub.matchPattern = patternInput.value.trim() || undefined;
			await store.saveSubscriptions();
			this.render();
		});

		if (linked.length > 0) {
			c.createEl("h4", { text: "Mapped payments" });
			const wrap = c.createDiv({ cls: "fp-table-scroll" });
			const table = wrap.createEl("table", { cls: "fp-table" });
			const headRow = table.createEl("thead").createEl("tr");
			["Date", "Description", "Amount", ""].forEach((h) => headRow.createEl("th", { text: h }));
			const tbody = table.createEl("tbody");
			linked.forEach((payment) => {
				const tr = tbody.createEl("tr");
				tr.createEl("td", { text: payment.date });
				tr.createEl("td", { text: payment.transaction.description || "—" });
				tr.createEl("td", {
					cls: "fp-table-num fp-money",
					text: formatMoney(payment.amount, { currency: payment.transaction.currency || "EUR" }),
				});
				const actions = tr.createEl("td");
				const unlinkBtn = actions.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
				icon(unlinkBtn, "unlink");
				unlinkBtn.setAttribute("title", "Unmap this payment");
				unlinkBtn.addEventListener("click", async () => {
					await store.updateTransaction(payment.transaction.id, { subscriptionId: undefined });
					this.plugin.refreshViews();
					this.onDone?.();
					this.render();
				});
			});
		}

		const suggestions = suggestPaymentsFor(store.transactions, this.sub);
		c.createEl("h4", { text: "Suggested payments" });
		if (suggestions.length === 0) {
			c.createEl("p", {
				cls: "fp-step-desc",
				text: "Nothing unmapped matches that text. Adjust the match text above if the charge appears under a different name.",
			});
		} else {
			const actions = c.createDiv({ cls: "fp-rules-apply-bar" });
			actions.createDiv({ cls: "fp-rules-apply-count", text: `${suggestions.length} unmapped transaction${suggestions.length === 1 ? "" : "s"} match` });
			const allBtn = actions.createEl("button", { cls: "fp-btn fp-btn-primary" });
			icon(allBtn, "link");
			allBtn.createSpan({ text: "Map all" });
			allBtn.addEventListener("click", async () => {
				const patches = new Map(suggestions.map((tx) => [tx.id, { subscriptionId: this.sub.id }] as const));
				await store.updateTransactions(new Map(patches));
				new Notice(`Mapped ${suggestions.length} payment${suggestions.length === 1 ? "" : "s"}`);
				this.plugin.refreshViews();
				this.onDone?.();
				this.render();
			});

			const wrap = c.createDiv({ cls: "fp-table-scroll" });
			const table = wrap.createEl("table", { cls: "fp-table" });
			const headRow = table.createEl("thead").createEl("tr");
			["Date", "Description", "Amount", ""].forEach((h) => headRow.createEl("th", { text: h }));
			const tbody = table.createEl("tbody");
			suggestions.slice(0, 40).forEach((tx) => {
				const tr = tbody.createEl("tr");
				tr.createEl("td", { text: tx.date });
				tr.createEl("td", { text: tx.description || "—" });
				tr.createEl("td", { cls: "fp-table-num fp-money", text: formatMoney(tx.amount, { currency: tx.currency || "EUR" }) });
				const cell = tr.createEl("td");
				const mapBtn = cell.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
				icon(mapBtn, "link");
				mapBtn.setAttribute("title", "Map this payment to the subscription");
				mapBtn.addEventListener("click", async () => {
					await linkTransaction(this.plugin, tx, this.sub);
					this.plugin.refreshViews();
					this.onDone?.();
					this.render();
				});
			});
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const closeBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(closeBtn, "check");
		closeBtn.createSpan({ text: "Done" });
		closeBtn.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Recurring charges in the ledger that aren't tracked yet — offered as ready-made subscriptions. */
export class DetectedSubscriptionsModal extends FinanceModal {
	constructor(app: App, private plugin: FinancePlugin, private onDone?: () => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		this.contentEl.addClass("fp-account-modal");
		this.render();
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();
		const store = this.plugin.store;

		c.createEl("h3", { text: "Recurring payments found" });
		c.createDiv({
			cls: "fp-step-desc",
			text: "Charges that repeat on a regular cycle for a stable amount, and aren't tracked as subscriptions yet. Adding one also maps the payments behind it.",
		});

		const candidates = detectRecurring(store.transactions, store.subscriptions);

		if (candidates.length === 0) {
			c.createEl("p", { cls: "fp-step-desc", text: "Nothing new found. Every regular charge in your ledger is already tracked." });
		} else {
			const wrap = c.createDiv({ cls: "fp-table-scroll" });
			const table = wrap.createEl("table", { cls: "fp-table" });
			const headRow = table.createEl("thead").createEl("tr");
			["Merchant", "Amount", "Cycle", "Seen", "Last", ""].forEach((h) => headRow.createEl("th", { text: h }));
			const tbody = table.createEl("tbody");

			candidates.forEach((candidate) => {
				const tr = tbody.createEl("tr");
				tr.createEl("td", { text: candidate.label });
				tr.createEl("td", { cls: "fp-table-num fp-money", text: formatMoney(candidate.amount, { currency: candidate.currency }) });
				tr.createEl("td", { text: candidate.billingCycle });
				tr.createEl("td", { cls: "fp-table-num", text: `${candidate.occurrences}×` });
				tr.createEl("td", { text: candidate.lastDate });
				const cell = tr.createEl("td");
				const addBtn = cell.createEl("button", { cls: "fp-btn fp-btn-secondary" });
				icon(addBtn, "plus");
				addBtn.createSpan({ text: "Track" });
				addBtn.addEventListener("click", async () => {
					const nextDue = new Date(`${candidate.lastDate}T00:00:00Z`);
					const days = candidate.billingCycle === "weekly" ? 7 : candidate.billingCycle === "quarterly" ? 91 : candidate.billingCycle === "yearly" ? 365 : 30;
					nextDue.setUTCDate(nextDue.getUTCDate() + days);

					const sub: Subscription = {
						id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
						name: candidate.label.slice(0, 40),
						category: "Other",
						cost: candidate.amount,
						currency: candidate.currency,
						billingCycle: candidate.billingCycle,
						paidVia: "private",
						accountId: candidate.accountId,
						nextDueDate: nextDue.toISOString().slice(0, 10),
						matchPattern: candidate.key,
					};
					store.subscriptions.push(sub);
					await store.saveSubscriptions();
					// Every transaction the detection was built from is mapped to it, so the new
					// subscription arrives with its own history rather than starting from empty.
					await store.updateTransactions(new Map(candidate.transactionIds.map((id) => [id, { subscriptionId: sub.id }] as const)));
					new Notice(`Now tracking "${sub.name}" with ${candidate.occurrences} past payments mapped`);
					this.plugin.refreshViews();
					this.onDone?.();
					this.render();
				});
			});
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const closeBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(closeBtn, "check");
		closeBtn.createSpan({ text: "Done" });
		closeBtn.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Subscriptions whose next payment falls within `days` — the renewal reminder feed. */
export function dueSoon(subs: Subscription[], days: number, today = new Date()): { sub: Subscription; date: string; daysUntil: number }[] {
	return upcomingPayments(
		subs.filter((s) => isActive(s, today)),
		today
	).filter((entry) => entry.daysUntil >= 0 && entry.daysUntil <= days);
}
