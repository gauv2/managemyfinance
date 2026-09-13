import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import {
	aiRecheckCategories,
	buildRecheckTargets,
	countUncertain,
	countUnrecognized,
	describeRecheck,
	type CategoryProposal,
	type RecheckResult,
} from "../ai/recheck";
import { categoryChain, secondaryCategoriesOf } from "../categories";
import { markReviewed, remember } from "../import/merchantMemory";
import type FinancePlugin from "../main";
import type { Transaction } from "../types";
import { categoryChainChip, icon, renderCategoryPicker, type CategoryPickerValue } from "../ui/dom";

/**
 * Claude's second opinion on categories you already have, as a list you rule on.
 *
 * Three states, and the messaging matters as much as the list: before (what will be checked and what
 * won't), during (progress, because a few hundred merchants is not instant), and after (what was
 * proposed, what was confirmed as-is, and everything deliberately left out). A pass that reported
 * only its proposals would read as a complete audit of the ledger, which it never is.
 *
 * Accepting and rejecting are both decisions and both are recorded. Rejecting isn't "do nothing" —
 * it marks the merchant confirmed, so the next recheck leaves it alone instead of raising it again.
 */
export class RecheckModal extends FinanceModal {
	private phase: "intro" | "running" | "done" = "intro";
	private result?: RecheckResult;
	/** Proposal keys the user wants applied. Starts empty: nothing is accepted by default. */
	private accepted = new Set<string>();
	private progress = { done: 0, total: 0 };
	private includeReviewed = false;
	/** How many were confirmed while the option was off — the count the label keeps quoting once it is on. */
	private confirmedWhenExcluded = 0;

	constructor(
		app: App,
		private plugin: FinancePlugin,
		/**
		 * `scope` narrows the recheck to a subset of the ledger. Without it the modal examines every
		 * categorized merchant, which is the maintenance job it was built for. With it, the Review page
		 * can ask the same question of just the rows still waiting on you — the case where "have another
		 * look at these" is a review action rather than a spring clean.
		 */
		private opts: { onDone?: () => void; scope?: { transactions: Transaction[]; label: string } } = {}
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		this.modalEl.addClass("fp-recheck-modal");
		this.render();
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();
		c.createEl("h3", { text: this.opts.scope ? `Recheck ${this.opts.scope.label}` : "Recheck categories" });

		if (this.phase === "intro") this.renderIntro(c);
		else if (this.phase === "running") this.renderRunning(c);
		else this.renderDone(c);
	}

	// ─── Before ─────────────────────────────────────────────────────────────────────────────────

	private renderIntro(c: HTMLElement): void {
		const store = this.plugin.store;
		const source = this.opts.scope?.transactions ?? store.transactions;
		const prepared = buildRecheckTargets(source, store.merchants, { includeReviewed: this.includeReviewed });

		c.createDiv({
			cls: "fp-step-desc",
			text: "Claude re-classifies merchants you've already categorized, without being told what they're currently filed as, and anything it disagrees with is listed here for you to accept or reject. Nothing is changed until you say so.",
		});

		// One sentence, not a scoreboard. The earlier version put four tiles here — merchants, the
		// transactions behind them, the split-category ones left out, and the already-confirmed ones
		// skipped — which described the machinery rather than the decision. Three of those four are
		// facts about what the recheck *declines* to do, and none of them changes the answer to the
		// only question this dialog asks: shall I look, yes or no.
		const coveredRows = prepared.targets.reduce((sum, t) => sum + t.transactions.length, 0);

		if (prepared.targets.length === 0) {
			c.createDiv({
				cls: "fp-step-desc",
				text: this.includeReviewed
					? "Nothing to re-examine — every merchant here is either confirmed or split across categories on purpose."
					: "Nothing new to re-examine. Every categorized merchant has already been confirmed; tick the box below to go over them again anyway.",
			});
		} else {
			const headline = c.createDiv({ cls: "fp-recheck-headline" });
			headline.createSpan({ cls: "fp-recheck-headline-value", text: String(prepared.targets.length) });
			headline.createSpan({
				cls: "fp-recheck-headline-label",
				text: `merchant${prepared.targets.length === 1 ? "" : "s"} to re-examine, covering ${coveredRows} transaction${
					coveredRows === 1 ? "" : "s"
				}`,
			});
		}

		// What is deliberately left out, as prose and only when it applies — a count of exclusions is
		// reassurance, not a control, and it does not deserve the same weight as the thing being done.
		const excluded: string[] = [];
		if (prepared.skipped.splitAcrossCategories > 0) {
			excluded.push(
				`${prepared.skipped.splitAcrossCategories} merchant${prepared.skipped.splitAcrossCategories === 1 ? " is" : "s are"} split across categories on purpose — a supermarket you buy both groceries and petrol from has no single category to disagree with`
			);
		}
		if (!this.includeReviewed && prepared.skipped.alreadyReviewed > 0) {
			excluded.push(`${prepared.skipped.alreadyReviewed} you have already confirmed`);
		}
		if (prepared.skipped.noReadableName > 0) {
			excluded.push(
				`${prepared.skipped.noReadableName} carry no readable shop name — a bare payment reference gives a classifier nothing to judge`
			);
		}
		if (excluded.length > 0) this.note(c, `Left alone: ${excluded.join("; ")}.`);

		if (prepared.truncated) {
			this.note(
				c,
				`One pass covers ${prepared.targets.length} of ${prepared.available}, busiest first. Run it again afterwards to reach the rest.`
			);
		}

		// Settle them here, without asking Claude anything.
		//
		// The same button existed only on the results screen, which meant the way to stop being asked
		// about a handful of merchants was to run the very query you were trying to stop running. If you
		// are happy with how these are filed, that is a decision you can make now, and this dialog
		// should let you make it and be finished.
		if (prepared.targets.length > 0) {
			const settleRow = c.createDiv({ cls: "fp-recheck-settle" });
			const settleBtn = settleRow.createEl("button", { cls: "fp-btn fp-btn-secondary fp-btn-tiny" });
			icon(settleBtn, "check-check");
			settleBtn.createSpan({
				text: `They're fine — stop asking about these ${prepared.targets.length}`,
			});
			settleBtn.setAttribute(
				"title",
				"Marks them settled with the categories they already have. No AI request, nothing re-filed — they simply stop appearing here."
			);
			settleBtn.addEventListener("click", () =>
				void this.settleAll(prepared.targets.map((t) => ({ key: t.key, categoryId: t.currentCategoryId })))
			);
		}

		// Rendered whenever there is anything confirmed to fold in, OR whenever it is already switched
		// on. Gating solely on `skipped.alreadyReviewed > 0` made the control delete itself: ticking it
		// moves those merchants out of "skipped" and into the run, the count drops to zero, and on the
		// re-render the checkbox vanishes — leaving the option on with no way to turn it back off short
		// of closing the dialog.
		const confirmedCount = prepared.skipped.alreadyReviewed || this.confirmedWhenExcluded;
		if (!this.includeReviewed) this.confirmedWhenExcluded = prepared.skipped.alreadyReviewed;
		if (confirmedCount > 0 || this.includeReviewed) {
			const row = c.createDiv({ cls: "fp-recheck-toggle-row" });
			const box = row.createEl("input", { type: "checkbox", cls: "fp-review-check" });
			box.id = "fp-recheck-include";
			box.checked = this.includeReviewed;
			row.createEl("label", {
				text: `Also re-examine the ${confirmedCount} merchant${confirmedCount === 1 ? "" : "s"} I have already confirmed`,
				attr: { for: "fp-recheck-include" },
			});
			box.addEventListener("change", () => {
				this.includeReviewed = box.checked;
				this.render();
			});
		}

		const ai = this.plugin.settings.ai;
		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		right.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel" }).addEventListener("click", () => this.close());

		const run = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(run, "sparkles");
		run.createSpan({ text: "Ask Claude" });
		if (!ai?.enabled) {
			run.disabled = true;
			this.note(c, "AI is switched off. Turn it on in Vault settings → AI to run a recheck.");
		} else if (prepared.targets.length === 0) {
			// Disabled, and said out loud. A greyed button with no reason reads as a bug rather than as
			// "there is nothing here to do", and the way to get work back is not guessable from a button
			// that refuses to respond.
			run.disabled = true;
			run.setAttribute(
				"title",
				this.includeReviewed
					? "Nothing left to examine — every merchant is either confirmed or deliberately split across categories."
					: "Nothing new to examine. Tick the box above to go over the merchants you have already confirmed."
			);
		} else {
			run.setAttribute("title", "Sends merchant names and your category tree — no amounts, dates or account details.");
			run.addEventListener("click", () => void this.run(prepared));
		}
	}

	private note(parent: HTMLElement, text: string): void {
		parent.createDiv({ cls: "fp-recheck-note", text });
	}

	/**
	 * A collapsible list of merchants the dialog is about to act on, or has deliberately not acted on.
	 *
	 * Every other decision in this plugin shows its working — the proposals list its transactions, the
	 * match sheet lists its rows — and confirming merchants was the one place that asked for a click
	 * on a bare number. "Mark 6 merchants confirmed" is not something anyone can agree to without
	 * being told which six.
	 */
	private renderMerchantList(
		parent: HTMLElement,
		opts: {
			title: string;
			hint: string;
			open?: boolean;
			/** Offers "stop asking about these" — see the button below. */
			settleable?: boolean;
			items: {
				key: string;
				name: string;
				categoryId: string;
				count: number;
				transactions: Transaction[];
				suggestion?: { categoryId: string; confidence: number };
			}[];
		}
	): void {
		if (opts.items.length === 0) return;
		const store = this.plugin.store;

		const group = parent.createEl("details", { cls: "fp-recheck-group" });
		if (opts.open) group.setAttribute("open", "true");
		const summary = group.createEl("summary", { cls: "fp-recheck-group-summary" });
		summary.createSpan({ cls: "fp-recheck-group-title", text: `${opts.title} (${opts.items.length})` });
		summary.createSpan({ cls: "fp-recheck-group-hint", text: opts.hint });

		// A way to be finished.
		//
		// Merchants the model was unsure about, or could not place, were deliberately never recorded so
		// that "a future run retries these" — which means a run can never reach zero. If it is
		// persistently unsure about twenty shops, those twenty come back on every single pass, forever,
		// and the tool becomes something you stop opening. Saying "leave these alone" is a person's
		// decision about them, so recording it is honest in a way that stamping them silently would not
		// have been: you looked, and you decided nothing needs to change.
		if (opts.settleable && opts.items.length > 0) {
			const settle = group.createDiv({ cls: "fp-recheck-settle" });
			const btn = settle.createEl("button", { cls: "fp-btn fp-btn-secondary fp-btn-tiny" });
			icon(btn, "check-check");
			btn.createSpan({ text: `Stop asking about these ${opts.items.length}` });
			btn.setAttribute(
				"title",
				"Keeps their current categories and marks them settled, so future rechecks skip them. Re-tick \"also re-examine confirmed\" to revisit."
			);
			btn.addEventListener("click", () => void this.settleAll(opts.items));
		}

		const list = group.createDiv({ cls: "fp-recheck-list" });
		for (const item of opts.items) {
			const row = list.createDiv({ cls: "fp-recheck-row" });
			const main = row.createDiv({ cls: "fp-recheck-row-main" });

			const head = main.createDiv({ cls: "fp-recheck-row-head" });
			head.createSpan({ cls: "fp-recheck-name fp-sensitive", text: item.name });
			head.createSpan({ cls: "fp-recheck-count", text: `${item.count} transaction${item.count === 1 ? "" : "s"}` });
			if (item.suggestion) {
				head.createSpan({ cls: "fp-match-score", text: `${Math.round(item.suggestion.confidence * 100)}% sure` });
			}

			const change = main.createDiv({ cls: "fp-recheck-change" });
			const current = categoryChain(store.categories, item.categoryId);
			categoryChainChip(change.createDiv({ cls: item.suggestion ? "fp-recheck-from" : "" }), current.primary, current.secondary);
			// A withheld near-miss is shown as the change it would have been, greyed as "not applied".
			if (item.suggestion) {
				icon(change, "arrow-right", "fp-recheck-arrow");
				const suggested = categoryChain(store.categories, item.suggestion.categoryId);
				const wrap = change.createDiv({ cls: "fp-recheck-withheld" });
				categoryChainChip(wrap, suggested.primary, suggested.secondary);
				change.createSpan({ cls: "fp-recheck-withheld-tag", text: "below the bar — not proposed" });
			}

			// Every row can be overridden here.
			//
			// Without this the dialog was read-only unless Claude happened to raise a proposal above the
			// bar: a merchant it agreed with could not be corrected, and a near-miss it showed you the
			// exact answer for — "Ring → Shopping › Electronics, 55% sure" — could not be taken. Both
			// left the same dead end, closing the dialog and hunting the merchant down in the ledger.
			//
			// Anything set here is written as a person's decision (source "user", reviewedAt stamped), so
			// it outranks a rule or a model on any later pass and the merchant stops being re-asked.
			const actions = row.createDiv({ cls: "fp-recheck-row-actions" });

			if (item.suggestion) {
				const take = actions.createEl("button", { cls: "fp-btn fp-btn-secondary fp-btn-tiny" });
				icon(take, "check");
				take.createSpan({ text: "Use this" });
				take.setAttribute("title", `Apply ${categoryChain(store.categories, item.suggestion.categoryId).primary?.name ?? "the suggestion"} to all ${item.count}`);
				take.addEventListener("click", () => void this.applyToMerchant(item, item.suggestion!.categoryId));
			}

			// Choosing stages; the button commits. Applying on the picker's change event re-filed every
			// row of the merchant the instant a category was selected — including the moment a primary
			// with subcategories was picked, before its subcategory could be reached.
			let staged: string | undefined;
			const pickWrap = actions.createDiv({ cls: "fp-recheck-row-picker" });
			const confirm = actions.createEl("button", { cls: "fp-btn fp-btn-primary fp-btn-tiny" });
			confirm.hide();

			const paint = (): void => {
				confirm.empty();
				if (!staged) {
					confirm.hide();
					return;
				}
				const chain = categoryChain(store.categories, staged);
				const label = `Confirm: ${chain.secondary?.name ?? chain.primary?.name ?? "category"} for all ${item.count}`;
				icon(confirm, "check");
				confirm.createSpan({ text: label });
				confirm.setAttribute("title", label);
				confirm.show();
			};

			renderCategoryPicker(pickWrap, {
				categories: store.categories,
				primaryPlaceholder: "Change to…",
				onChange: (value: CategoryPickerValue) => {
					const chosen = value.secondaryId ?? value.primaryId;
					// A primary that has subcategories is half a choice — wait for the rest rather than
					// staging the parent and having the button change under the cursor.
					staged =
						!chosen || (!value.secondaryId && secondaryCategoriesOf(store.categories, value.primaryId ?? "").length > 0)
							? undefined
							: chosen;
					paint();
				},
			});
			confirm.addEventListener("click", () => {
				if (staged) void this.applyToMerchant(item, staged);
			});
		}
	}

	/**
	 * Files a merchant under a category chosen here, and records that a person chose it.
	 *
	 * Writes all three things a decision needs to stick: the rows themselves, the merchant memory that
	 * future imports read, and the reviewed stamp that keeps the merchant out of the next recheck.
	 * Anything less and the choice survives until the next pass and then quietly asks again.
	 */
	private async applyToMerchant(
		item: { key: string; name: string; transactions: Transaction[] },
		categoryId: string
	): Promise<void> {
		const store = this.plugin.store;
		const patches = new Map<string, Partial<Transaction>>();
		for (const tx of item.transactions) patches.set(tx.id, { categoryId });
		const changed = await store.updateTransactions(patches);

		store.merchants = markReviewed(remember(store.merchants, item.key, categoryId, "user"), item.key, categoryId);
		await store.saveMerchants();

		const name = store.categories.find((c) => c.id === categoryId)?.name ?? "category";
		new Notice(`${item.name} → ${name} (${changed} transaction${changed === 1 ? "" : "s"})`);
		this.plugin.refreshViews();
		this.render();
	}

	/**
	 * Marks a whole group settled without changing a single category.
	 *
	 * The statement being recorded is "I have looked at these and they are fine as they are", which is
	 * exactly what `reviewedAt` means everywhere else. Nothing is re-filed; only the re-asking stops.
	 */
	private async settleAll(items: { key: string; categoryId: string }[]): Promise<void> {
		const store = this.plugin.store;
		let memory = store.merchants;
		for (const item of items) memory = markReviewed(memory, item.key, item.categoryId);
		store.merchants = memory;
		await store.saveMerchants();
		new Notice(`${items.length} merchant${items.length === 1 ? "" : "s"} settled — future rechecks will skip them`);
		this.plugin.refreshViews();
		this.render();
	}

	/** The two lists every finished pass can show, in both the proposals and the no-proposals branch. */
	private renderOutcomeLists(c: HTMLElement, result: RecheckResult, opts: { agreedOpen: boolean }): void {
		this.renderMerchantList(c, {
			title: "Confirming as-is",
			hint: "Claude returned the category you already have — marking these confirmed only stops them being re-asked",
			open: opts.agreedOpen,
			items: result.agreed.map((a) => ({ key: a.key, name: a.name, categoryId: a.categoryId, count: a.transactions.length, transactions: a.transactions })),
		});

		const uncertain = result.unsettled.filter((u) => u.reason === "uncertain");
		this.renderMerchantList(c, {
			title: "Left unconfirmed — too uncertain",
			hint: "It disagreed, but below the confidence bar. These come back on every run until you settle them",
			settleable: true,
			items: uncertain.map((u) => ({
				key: u.key,
				name: u.name,
				categoryId: u.currentCategoryId,
				count: u.transactions.length,
				transactions: u.transactions,
				suggestion: u.suggestedCategoryId ? { categoryId: u.suggestedCategoryId, confidence: u.confidence ?? 0 } : undefined,
			})),
		});

		const unrecognized = result.unsettled.filter((u) => u.reason === "unrecognized");
		this.renderMerchantList(c, {
			title: "Left unconfirmed — not recognized",
			hint: "It couldn't place these from the name at all. These come back on every run until you settle them",
			settleable: true,
			items: unrecognized.map((u) => ({ key: u.key, name: u.name, categoryId: u.currentCategoryId, count: u.transactions.length, transactions: u.transactions })),
		});
	}

	// ─── During ─────────────────────────────────────────────────────────────────────────────────

	private renderRunning(c: HTMLElement): void {
		c.createDiv({ cls: "fp-step-desc", text: "Re-classifying merchants. This runs in batches, so partial results survive a hiccup." });
		const bar = c.createDiv({ cls: "fp-recheck-progress" });
		const pct = this.progress.total === 0 ? 0 : (this.progress.done / this.progress.total) * 100;
		bar.createDiv({ cls: "fp-recheck-progress-fill" }).style.width = `${pct}%`;
		c.createDiv({ cls: "fp-recheck-progress-label", text: `${this.progress.done} of ${this.progress.total} merchants checked` });
	}

	private async run(prepared: ReturnType<typeof buildRecheckTargets>): Promise<void> {
		this.phase = "running";
		this.progress = { done: 0, total: prepared.targets.length };
		this.render();

		try {
			this.result = await aiRecheckCategories(prepared, this.plugin.store.categories, this.plugin.settings.ai ?? {}, (done, total) => {
				this.progress = { done, total };
				this.render();
			});
			this.phase = "done";
		} catch (e) {
			this.phase = "intro";
			new Notice(`Recheck failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		this.render();
	}

	// ─── After ──────────────────────────────────────────────────────────────────────────────────

	private renderDone(c: HTMLElement): void {
		const result = this.result;
		if (!result) return;

		c.createDiv({ cls: "fp-recheck-summary", text: describeRecheck(result) });

		if (result.proposals.length === 0) {
			const settled = result.agreed.length;
			const unsettled = result.unsettled.length;

			this.note(
				c,
				settled > 0
					? `Claude returned the category you already have for ${settled} merchant${settled === 1 ? "" : "s"} and disagreed with none of them. Nothing needs changing.`
					: "Claude didn't place a single one of these merchants confidently enough to say anything about them."
			);
			if (unsettled > 0) {
				this.note(
					c,
					`The other ${unsettled} — ${countUncertain(result)} it was unsure about and ${countUnrecognized(
						result
					)} it couldn't place at all — are deliberately left unconfirmed, so a future run tries them again. They are why this dialog settles ${settled}, not ${result.checked}.`
				);
			}

			// Open by default here: with no proposals to read, the agreed list *is* the content.
			this.renderOutcomeLists(c, result, { agreedOpen: true });

			const footer = c.createDiv({ cls: "fp-wizard-footer" });
			const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
			right.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Close" }).addEventListener("click", () => this.close());
			// Named with its count, because "them" reads as all 27 when it only ever means the 8.
			if (settled > 0) {
				const done = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
				icon(done, "check");
				done.createSpan({ text: `Mark ${settled} merchant${settled === 1 ? "" : "s"} confirmed` });
				done.setAttribute(
					"title",
					"Records that these merchants' categories have been checked, so the next recheck skips them. No transaction is changed — the categories are already what Claude would have chosen."
				);
				done.addEventListener("click", () => void this.apply());
			}
			return;
		}

		const bar = c.createDiv({ cls: "fp-recheck-select-bar" });
		const all = bar.createEl("input", { type: "checkbox", cls: "fp-review-check" });
		all.checked = result.proposals.length > 0 && result.proposals.every((p) => this.accepted.has(p.key));
		all.indeterminate = !all.checked && result.proposals.some((p) => this.accepted.has(p.key));
		all.setAttribute("aria-label", "Accept every proposal");
		all.addEventListener("change", () => {
			for (const p of result.proposals) {
				if (all.checked) this.accepted.add(p.key);
				else this.accepted.delete(p.key);
			}
			this.render();
		});
		bar.createSpan({
			cls: "fp-recheck-select-count",
			text: this.accepted.size === 0 ? "Nothing accepted yet" : `${this.accepted.size} of ${result.proposals.length} accepted`,
		});

		const list = c.createDiv({ cls: "fp-recheck-list" });
		for (const proposal of result.proposals) this.renderProposal(list, proposal);

		// Collapsed here — the proposals above are what needs reading — but present, because pressing
		// Apply also confirms every agreed merchant, and that shouldn't happen out of sight.
		this.renderOutcomeLists(c, result, { agreedOpen: false });

		const unsettled = result.unsettled.length;
		this.note(
			c,
			`Whatever you leave unticked is recorded as confirmed-as-is, not ignored — the next recheck won't raise it again. Everything ticked is applied to the merchant, so future imports follow it too.${
				result.agreed.length > 0
					? ` Applying also confirms the ${result.agreed.length} merchant${result.agreed.length === 1 ? "" : "s"} Claude agreed with — listed above.`
					: ""
			}${
				unsettled > 0
					? ` The ${unsettled} merchant${unsettled === 1 ? "" : "s"} it was unsure about or couldn't place are left unconfirmed on purpose, so running this again will retry them.`
					: ""
			}`
		);

		const changedRows = result.proposals.filter((p) => this.accepted.has(p.key)).reduce((sum, p) => sum + p.transactions.length, 0);
		// Every row in the list, ticked or not — you have just made a review decision about all of
		// them, which is exactly what approving records.
		const allRows = result.proposals.reduce((sum, p) => sum + p.transactions.length, 0);
		const unreviewed = result.proposals
			.flatMap((p) => p.transactions)
			.filter((t) => (t.review ?? "new") !== "approved").length;

		this.note(
			c,
			`Applying a change fixes the category but leaves the transaction's review status alone, so these rows stay in the review queue. ${
				unreviewed === 0
					? "All of the rows here are already approved."
					: `${unreviewed} of the ${allRows} row${allRows === 1 ? "" : "s"} here ${unreviewed === 1 ? "is" : "are"} still unapproved — use “Apply & approve” to settle both at once.`
			}`
		);

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		right.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Close without deciding" }).addEventListener("click", () => this.close());

		const apply = right.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(apply, "check");
		apply.createSpan({
			text:
				this.accepted.size === 0
					? "Confirm all as-is"
					: `Apply ${this.accepted.size} change${this.accepted.size === 1 ? "" : "s"} (${changedRows} row${changedRows === 1 ? "" : "s"})`,
		});
		apply.addEventListener("click", () => void this.apply());

		// The common case, and so the primary one: a recheck pass *is* a review, and having to walk the
		// same rows again in the Review queue to say "yes, still fine" is work the decision already did.
		const applyApprove = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(applyApprove, "check-check");
		applyApprove.createSpan({
			text: this.accepted.size === 0 ? `Confirm & approve (${allRows} row${allRows === 1 ? "" : "s"})` : `Apply & approve (${allRows} row${allRows === 1 ? "" : "s"})`,
		});
		applyApprove.setAttribute(
			"title",
			"Applies the ticked changes, records the rest as confirmed-as-is, and marks every transaction listed here as approved so it leaves the review queue."
		);
		applyApprove.addEventListener("click", () => void this.apply({ approve: true }));
	}

	private renderProposal(list: HTMLElement, proposal: CategoryProposal): void {
		const store = this.plugin.store;
		const row = list.createDiv({ cls: "fp-recheck-row" + (this.accepted.has(proposal.key) ? " is-accepted" : "") });

		const check = row.createEl("input", { type: "checkbox", cls: "fp-review-check" });
		check.checked = this.accepted.has(proposal.key);
		check.setAttribute("aria-label", `Accept the proposed change for ${proposal.name}`);
		check.addEventListener("change", () => {
			if (check.checked) this.accepted.add(proposal.key);
			else this.accepted.delete(proposal.key);
			this.render();
		});

		const main = row.createDiv({ cls: "fp-recheck-row-main" });
		const head = main.createDiv({ cls: "fp-recheck-row-head" });
		head.createSpan({ cls: "fp-recheck-name fp-sensitive", text: proposal.name });
		head.createSpan({
			cls: "fp-recheck-count",
			text: `${proposal.transactions.length} transaction${proposal.transactions.length === 1 ? "" : "s"}`,
		});
		head.createSpan({ cls: "fp-match-score", text: `${Math.round(proposal.confidence * 100)}% sure` });

		const change = main.createDiv({ cls: "fp-recheck-change" });
		const from = categoryChain(store.categories, proposal.currentCategoryId);
		const to = categoryChain(store.categories, proposal.proposedCategoryId);
		const fromWrap = change.createDiv({ cls: "fp-recheck-from" });
		categoryChainChip(fromWrap, from.primary, from.secondary);
		icon(change, "arrow-right", "fp-recheck-arrow");
		const toWrap = change.createDiv({ cls: "fp-recheck-to" });
		categoryChainChip(toWrap, to.primary, to.secondary);

		// The rows themselves, on demand. A proposal is a claim about real transactions, and accepting
		// it without ever being able to see which ones would be asking for trust rather than agreement.
		const details = main.createEl("details", { cls: "fp-recheck-details" });
		details.createEl("summary", { text: "Show the transactions" });
		const inner = details.createDiv({ cls: "fp-recheck-tx-list" });
		for (const tx of proposal.transactions.slice(0, 12)) {
			const line = inner.createDiv({ cls: "fp-recheck-tx" });
			line.createSpan({ cls: "fp-recheck-tx-date", text: tx.date });
			line.createSpan({ cls: "fp-recheck-tx-desc fp-sensitive", text: tx.description || "(no description)" });
		}
		if (proposal.transactions.length > 12) {
			inner.createDiv({ cls: "fp-recheck-tx-more", text: `+${proposal.transactions.length - 12} more` });
		}
	}

	/**
	 * Writes the decisions.
	 *
	 * Every merchant in the pass is marked reviewed, not only the accepted ones — that is what makes a
	 * rejection stick, and what stops the next run raising the same twenty merchants you have already
	 * looked at twice.
	 *
	 * `approve` additionally sets the *transactions'* review status. That is a separate axis from the
	 * category, and from the merchant-level "confirmed" marker: a row can be correctly categorized and
	 * still sit unapproved in the review queue. Deciding a merchant's category here is a review of
	 * those rows, so the option exists to record it as one rather than making you walk the same rows
	 * again in the queue to say "yes, still fine".
	 */
	private async apply(opts: { approve?: boolean } = {}): Promise<void> {
		const result = this.result;
		if (!result) return;
		const store = this.plugin.store;

		const patches = new Map<string, Partial<Transaction>>();
		for (const proposal of result.proposals) {
			const accepted = this.accepted.has(proposal.key);
			// Approving covers every row shown, accepted or not — a rejected proposal is still a
			// decision made about those rows, which is the whole point of having looked at them.
			if (!accepted && !opts.approve) continue;
			for (const tx of proposal.transactions) {
				const patch: Partial<Transaction> = {};
				if (accepted) patch.categoryId = proposal.proposedCategoryId;
				if (opts.approve) patch.review = "approved";
				patches.set(tx.id, patch);
			}
		}

		const approvedRows = opts.approve
			? result.proposals.flatMap((p) => p.transactions).filter((t) => (t.review ?? "new") !== "approved").length
			: 0;
		const changed = patches.size > 0 ? await store.updateTransactions(patches) : 0;

		/**
		 * Only merchants that were genuinely settled get marked confirmed:
		 *
		 *   - a proposal you ruled on, either way — you looked at it and decided;
		 *   - a merchant the model returned the existing category for — a real second opinion.
		 *
		 * The low-confidence disagreements and the ones it couldn't place are deliberately left
		 * unmarked. Stamping those "a human confirmed this" would be false — nobody did, the model
		 * either shrugged or quietly disagreed below the bar — and it would hide them from every
		 * future pass. Left alone, the next run picks them up again, which is exactly what should
		 * happen to the cases this one failed to settle.
		 */
		let memory = store.merchants;
		for (const proposal of result.proposals) {
			const accepted = this.accepted.has(proposal.key);
			memory = markReviewed(memory, proposal.key, accepted ? proposal.proposedCategoryId : proposal.currentCategoryId);
		}
		for (const agreed of result.agreed) memory = markReviewed(memory, agreed.key, agreed.categoryId);
		store.merchants = memory;
		await store.saveMerchants();

		const unsettled = result.unsettled.length;

		const accepted = this.accepted.size;
		const rejected = result.proposals.length - accepted;
		new Notice(
			[
				accepted > 0 ? `${accepted} change${accepted === 1 ? "" : "s"} applied to ${changed} transaction${changed === 1 ? "" : "s"}` : "No changes applied",
				rejected > 0 ? `${rejected} kept as-is` : "",
				opts.approve ? `${approvedRows} row${approvedRows === 1 ? "" : "s"} approved` : "",
				`${result.proposals.length + result.agreed.length} merchant${result.proposals.length + result.agreed.length === 1 ? "" : "s"} marked confirmed`,
				unsettled > 0 ? `${unsettled} left unconfirmed for a future run` : "",
			]
				.filter(Boolean)
				.join(" · "),
			8000
		);

		this.plugin.refreshViews();
		this.opts.onDone?.();
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
