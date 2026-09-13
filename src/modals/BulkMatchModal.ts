import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { aiFindMatches, buildCandidatePool, describeMatchResult, type AiMatch } from "../ai/matcher";
import { categoryChain } from "../categories";
import { merchantDisplayName, merchantKey, merchantSourceText } from "../import/merchantKey";
import { findMatches, hasMatches, type MatchGroups } from "../import/similarity";
import type FinancePlugin from "../main";
import { formatMoney } from "../money";
import type { ReviewStatus, Transaction } from "../types";
import { categoryChainChip, icon, renderCategoryPicker, type CategoryPickerValue } from "../ui/dom";

/**
 * "You just settled one of these — there are eleven more. Want to do them all?"
 *
 * Reviewing a statement one row at a time is the single most tedious thing this plugin asks of
 * anyone, and almost all of that tedium is repetition: the same supermarket forty times, the same
 * fuel station every fortnight. Categorization already fans out across a merchant automatically. The
 * *review decision* did not, so the queue still made you press approve forty times for a merchant you
 * had already made your mind up about.
 *
 * The two tiers from similarity.ts are kept visibly apart here, because they warrant different
 * levels of trust and the user needs to see which is which:
 *
 *   Same merchant  — merchantKey agrees. Pre-ticked. This is the grouping the whole app already runs on.
 *   Similar        — a string-similarity guess. Listed, collapsed, and ticked by nobody but the user.
 *
 * Nothing is written until a button is pressed, and the button always says how many rows it will
 * touch, so "apply to all of these" is never a leap of faith.
 */
/**
 * Above this, a fuzzy match is treated as certain enough to arrive pre-selected. Chosen well clear of
 * similarity.ts's 0.55 listing threshold: that one decides what is worth showing, this one decides
 * what is worth acting on without being asked twice.
 */
const CONFIDENT_MATCH = 0.85;

/**
 * What to call a transaction on screen: the payee, with the bank's own line kept underneath.
 *
 * Showing `description` alone made this dialog unreviewable for card payments, where that field is
 * the terminal's location and timestamp and the shop is in the counterparty. Every row read
 * "CAPELLE AAN D <date> Pas: 4333" and nothing said which shop it was — while the whole question the
 * dialog asks is whether these are the same merchant.
 */
function payeeName(tx: Pick<Transaction, "description" | "counterparty">): string {
	return merchantDisplayName(merchantSourceText(tx)) || tx.description || tx.counterparty || "(no description)";
}

/** The raw bank line, shown only when it says something the payee name doesn't. */
function bankLine(tx: Pick<Transaction, "description" | "counterparty">): string {
	const raw = (tx.description ?? "").trim();
	return raw && raw !== payeeName(tx) ? raw : "";
}

export class BulkMatchModal extends FinanceModal {
	private groups: MatchGroups;
	private selected = new Set<string>();
	private category: CategoryPickerValue = {};
	/** Collapsed when there are exact matches to read first, open when it is the only thing here —
	 *  a dialog whose entire content is behind a disclosure triangle looks like a dialog with a bug. */
	private similarOpen: boolean;
	private countEl?: HTMLElement;
	private applyBtn?: HTMLButtonElement;
	private categoryBtn?: HTMLButtonElement;
	/** Claude's answers, once asked. Undefined means "not asked yet", empty means "asked, found none". */
	private aiMatches?: AiMatch[];
	private aiSummary = "";
	private aiRunning = false;

	constructor(
		app: App,
		private plugin: FinancePlugin,
		private subject: Transaction,
		private opts: {
			/** The state the matched rows will be moved to — whatever was just done to the subject. */
			status: ReviewStatus;
			/** True when the click that opened this sheet is what put the subject into that state. Only
			 *  affects wording, but "already approved" one second after you approved it reads as a bug. */
			justActed?: boolean;
			onDone?: () => void;
		}
	) {
		super(app);
		this.groups = findMatches(plugin.store.transactions, subject, {
			// Rows already in the target state have nothing to gain from this, and listing them makes
			// "12 more" read as a lie when nine of them were already approved.
			filter: (t) => (t.review ?? "new") !== opts.status,
		});
		// The exact tier starts ticked. So does anything the fuzzy tier is nearly certain about: a 96%
		// match on the payee text is not a guess in any sense the user cares about, and leaving it
		// unticked made "apply to all of these" work on some openings of this sheet and not others,
		// with nothing on screen explaining which kind you had. Everything below that line still waits
		// for a human, and every row shows its score, so the boundary is visible rather than felt.
		for (const tx of this.groups.sameMerchant) this.selected.add(tx.id);
		for (const m of this.groups.similar) if (m.score >= CONFIDENT_MATCH) this.selected.add(m.tx.id);
		this.similarOpen =
			(this.groups.sameMerchant.length === 0 && this.groups.similar.length > 0) ||
			this.groups.similar.some((m) => m.score >= CONFIDENT_MATCH);

		/**
		 * Whether the row this was opened from is itself part of the action.
		 *
		 * It depends entirely on how the sheet was reached, which is why it has to be derived rather
		 * than assumed. Opened automatically after you approve a row, the subject is already approved
		 * and includes itself would be a no-op. Opened from the button on an unreviewed row, it is not
		 * — and leaving it out meant "Approve" settled every match while the row you actually clicked
		 * stayed in the queue, which is exactly as broken as it sounds.
		 */
		this.includeSubject = (subject.review ?? "new") !== opts.status;
	}

	private readonly includeSubject: boolean;

	/** Everything the buttons will act on: the ticked matches, plus the subject when it still needs it. */
	private targetIds(): string[] {
		const ids = Array.from(this.selected);
		if (this.includeSubject) ids.push(this.subject.id);
		return ids;
	}

	/**
	 * Whether this modal has anything to show. Checked by the caller *after* constructing it, because
	 * finding the matches is the expensive part and a static pre-check would just do the same full
	 * scan of the ledger twice for every approval.
	 */
	get hasAnything(): boolean {
		return hasMatches(this.groups);
	}

	private get statusVerb(): string {
		return this.opts.status === "approved" ? "Approve" : this.opts.status === "flagged" ? "Flag" : "Reset";
	}

	/** Past tense, spelled out — "Flag" + "d" gives "flagd", which is how that shortcut announces itself. */
	private get statusPast(): string {
		return this.opts.status === "approved" ? "approved" : this.opts.status === "flagged" ? "flagged" : "reset";
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		this.modalEl.addClass("fp-match-modal");
		const c = this.contentEl;

		/**
		 * The heading has to match what was actually found, because the three cases ask for very
		 * different things. Exact merchant matches are pre-ticked and one click away — "the rest of
		 * these" is fair. A lone fuzzy guess is not: nothing is selected, the button is disabled until
		 * you tick something, and promising "the rest" above a disabled button reads as broken. And an
		 * empty search is an answer, not an offer.
		 */
		const exact = this.groups.sameMerchant.length;
		const similar = this.groups.similar.length;
		const subjectName = payeeName(this.subject);

		c.createEl("h3", {
			text: exact > 0 ? `${this.statusVerb} the rest of these too?` : similar > 0 ? `${similar} possible match${similar === 1 ? "" : "es"}` : "No obvious matches",
		});
		c.createDiv({
			cls: "fp-step-desc",
			text:
				exact > 0
					? `These other transactions look like “${subjectName}”. Tick what belongs and settle them in one go.`
					: similar > 0
						? `Nothing else shares a merchant with “${subjectName}”, but ${
								similar === 1 ? "one transaction reads" : `${similar} transactions read`
						  } a bit like it. Have a look and tick anything that belongs.`
						: `Nothing else in the ledger reads like “${subjectName}”. Claude can still check for the same shop written a way no text comparison would catch${
								this.includeSubject ? `, or ${this.statusVerb} just this row on its own` : ""
						  }.`,
		});

		this.renderSubject(c);
		this.renderExactGroup(c);
		this.renderSimilarGroup(c);
		this.renderAiGroup(c);
		this.renderCategoryRow(c);
		this.renderFooter(c);
		this.syncButtons();
	}

	private renderSubject(c: HTMLElement): void {
		const card = c.createDiv({ cls: "fp-match-subject" });
		icon(card, "corner-down-right", "fp-match-subject-icon");
		const text = card.createDiv({ cls: "fp-match-subject-text" });
		text.createDiv({ cls: "fp-match-subject-desc fp-sensitive", text: payeeName(this.subject) });
		const subjectLine = bankLine(this.subject);
		if (subjectLine) text.createDiv({ cls: "fp-match-row-line fp-sensitive", text: subjectLine });
		const meta = text.createDiv({ cls: "fp-match-subject-meta" });
		meta.createSpan({ text: this.subject.date });
		meta.createSpan({ cls: "fp-money", text: formatMoney(this.subject.amount, { currency: this.subject.currency || "EUR" }) });
		const chain = categoryChain(this.plugin.store.categories, this.subject.categoryId);
		categoryChainChip(meta, chain.primary, chain.secondary);

		// Stated on the card rather than left implicit: the count on the button includes this row, and
		// a number that doesn't match the rows you ticked needs to explain itself.
		card.createSpan({
			cls: "fp-match-subject-tag",
			// "already approved" is true but reads as "approved some time ago", which is nonsense one
			// second after the click that opened this dialog did the approving. The two cases are
			// different facts about how you got here and deserve different words.
			text: this.includeSubject
				? `will be ${this.statusPast} too`
				: this.opts.justActed
					? `just ${this.statusPast}`
					: `already ${this.statusPast}`,
		});
	}

	private renderExactGroup(c: HTMLElement): void {
		const rows = this.groups.sameMerchant;
		if (rows.length === 0) return;

		const section = c.createDiv({ cls: "fp-match-section" });
		const head = section.createDiv({ cls: "fp-match-section-head" });
		const all = head.createEl("input", { type: "checkbox", cls: "fp-review-check" });
		// Derived, not assumed. Hardcoding this to true left the header ticked after you had unticked
		// rows underneath it, so the box claimed a selection that the button count contradicted.
		all.checked = rows.every((tx) => this.selected.has(tx.id));
		all.indeterminate = !all.checked && rows.some((tx) => this.selected.has(tx.id));
		all.setAttribute("aria-label", "Select every same-merchant match");
		all.addEventListener("change", () => {
			for (const tx of rows) {
				if (all.checked) this.selected.add(tx.id);
				else this.selected.delete(tx.id);
			}
			this.redraw();
		});
		icon(head, "check-check", "fp-match-section-icon");
		head.createSpan({ cls: "fp-match-section-title", text: `Same merchant (${rows.length})` });
		head.createSpan({
			cls: "fp-match-section-hint",
			text: "Grouped by the same rule your imports and categories already use.",
		});

		this.renderRows(section.createDiv({ cls: "fp-match-list" }), rows.map((tx) => ({ tx })));
	}

	private renderSimilarGroup(c: HTMLElement): void {
		const matches = this.groups.similar;
		if (matches.length === 0) return;

		const confident = matches.filter((m) => m.score >= CONFIDENT_MATCH).length;

		const section = c.createDiv({ cls: "fp-match-section fp-match-section-similar" });
		const head = section.createDiv({ cls: "fp-match-section-head is-toggle" });

		// A select-all here as well: with part of this tier arriving ticked, "take the rest too" is a
		// single decision and should cost a single click, the same as it does for the exact tier.
		const all = head.createEl("input", { type: "checkbox", cls: "fp-review-check" });
		all.checked = matches.every((m) => this.selected.has(m.tx.id));
		all.indeterminate = !all.checked && matches.some((m) => this.selected.has(m.tx.id));
		all.setAttribute("aria-label", "Select every similar match");
		all.addEventListener("click", (ev: MouseEvent) => ev.stopPropagation());
		all.addEventListener("change", () => {
			for (const m of matches) {
				if (all.checked) this.selected.add(m.tx.id);
				else this.selected.delete(m.tx.id);
			}
			this.similarOpen = true;
			this.redraw();
		});

		icon(head, this.similarOpen ? "chevron-down" : "chevron-right", "fp-match-section-icon");
		head.createSpan({ cls: "fp-match-section-title", text: `Similar description (${matches.length})` });
		head.createSpan({
			cls: "fp-match-section-hint",
			text: confident > 0
				? `Matched on the text. The ${confident} above ${Math.round(CONFIDENT_MATCH * 100)}% start selected; the rest are yours to judge.`
				: "A guess from the text alone — nothing here is selected until you say so.",
		});
		head.setAttribute("role", "button");
		head.setAttribute("aria-expanded", String(this.similarOpen));
		head.addEventListener("click", () => {
			this.similarOpen = !this.similarOpen;
			this.redraw();
		});

		if (this.similarOpen) this.renderRows(section.createDiv({ cls: "fp-match-list" }), matches);
	}

	/**
	 * The third tier: merchants Claude says are the same payee.
	 *
	 * It exists because the first two tiers structurally cannot find these. "AH TO GO" shares no words
	 * and almost no characters with "Albert Heijn", so no threshold on any string metric reaches it
	 * without also dragging in half the ledger. Knowing they are the same shop is knowledge about the
	 * world, not about the text.
	 *
	 * It sits *below* the fuzzy tier and starts unticked for the same reason that one does — more so,
	 * in fact: a model will cheerfully call two branches of a franchise "the same merchant" when you
	 * file them apart on purpose. Every row carries the confidence and the reason it gave, so the
	 * judgement being accepted is visible rather than implied.
	 */
	private renderAiGroup(c: HTMLElement): void {
		const ai = this.plugin.settings.ai;
		// Nothing to ask about. Offering the button anyway would spend a request to be told what
		// merchantDisplayName already established locally: this row carries no payee name at all.
		if (!merchantDisplayName(merchantSourceText(this.subject))) return;

		const section = c.createDiv({ cls: "fp-match-section fp-match-section-ai" });
		const head = section.createDiv({ cls: "fp-match-section-head" });
		icon(head, "sparkles", "fp-match-section-icon");
		head.createSpan({
			cls: "fp-match-section-title",
			text: this.aiMatches === undefined ? "Ask Claude" : `Claude's matches (${this.aiMatches.length})`,
		});

		if (this.aiRunning) {
			head.createSpan({ cls: "fp-match-section-hint", text: "Checking the rest of the ledger…" });
			return;
		}

		if (this.aiMatches === undefined) {
			head.createSpan({
				cls: "fp-match-section-hint",
				text: "Find the same shop written a way no text comparison could match — “AH to go” against “Albert Heijn”.",
			});
			const btn = head.createEl("button", { cls: "fp-btn fp-btn-secondary fp-btn-tiny" });
			icon(btn, "sparkles");
			btn.createSpan({ text: "Ask Claude" });
			if (ai?.enabled) {
				btn.setAttribute("title", "Sends only merchant names — no amounts, dates or account details.");
				btn.addEventListener("click", () => void this.runAi());
			} else {
				btn.addClass("is-muted");
				btn.setAttribute("title", "AI matching is switched off — click to turn it on.");
				btn.addEventListener("click", () => {
					this.close();
					this.plugin.openVaultSettings("ai");
				});
			}
			return;
		}

		if (this.aiSummary) head.createSpan({ cls: "fp-match-section-hint", text: this.aiSummary });

		const again = head.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-tiny", text: "Ask again" });
		again.addEventListener("click", () => void this.runAi());

		if (this.aiMatches.length === 0) return;

		const list = section.createDiv({ cls: "fp-match-list" });
		for (const match of this.aiMatches) {
			// One header per merchant, then its rows: the model judged the *merchant*, and showing forty
			// identical "94% — same chain" badges down a list of rows would misrepresent that as forty
			// separate judgements.
			const header = list.createDiv({ cls: "fp-match-ai-head" });
			const all = header.createEl("input", { type: "checkbox", cls: "fp-review-check" });
			all.checked = match.transactions.every((t) => this.selected.has(t.id));
			all.indeterminate = !all.checked && match.transactions.some((t) => this.selected.has(t.id));
			all.setAttribute("aria-label", `Select every transaction from ${match.name}`);
			all.addEventListener("change", () => {
				for (const tx of match.transactions) {
					if (all.checked) this.selected.add(tx.id);
					else this.selected.delete(tx.id);
				}
				this.redraw();
			});
			const text = header.createDiv({ cls: "fp-match-ai-head-text" });
			text.createSpan({ cls: "fp-match-ai-name", text: match.name });
			text.createSpan({
				cls: "fp-match-ai-count",
				text: `${match.transactions.length} transaction${match.transactions.length === 1 ? "" : "s"}`,
			});
			if (match.reason) text.createDiv({ cls: "fp-match-ai-reason", text: match.reason });
			header.createSpan({ cls: "fp-match-score", text: `${Math.round(match.confidence * 100)}% sure` });

			this.renderRows(list, match.transactions.map((tx) => ({ tx })));
		}
	}

	private async runAi(): Promise<void> {
		this.aiRunning = true;
		this.redraw();
		try {
			// Anything the first two tiers already offered is excluded: re-listing a row under a second
			// heading would double-count it in the selection UI and waste tokens judging what's decided.
			const exclude = new Set<string>();
			for (const tx of [...this.groups.sameMerchant, ...this.groups.similar.map((m) => m.tx)]) {
				const key = merchantKey(tx);
				if (key) exclude.add(key);
			}

			const pool = buildCandidatePool(this.plugin.store.transactions, this.subject, {
				exclude,
				eligible: (t) => (t.review ?? "new") !== this.opts.status,
			});
			const result = await aiFindMatches(pool, this.plugin.settings.ai ?? {});
			this.aiMatches = result.matches;
			this.aiSummary = describeMatchResult(result);
			new Notice(this.aiSummary);
		} catch (e) {
			// Left as "not asked" rather than "asked, found none": a failed request has told us nothing,
			// and showing it as an empty result would read as a confident answer.
			this.aiMatches = undefined;
			this.aiSummary = "";
			new Notice(`Couldn't check for matches: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.aiRunning = false;
			this.redraw();
		}
	}

	/** Ticked state lives in `selected`, so the cheapest correct way to reflect a change is to draw the
	 *  sheet again from it — there is no independent DOM state worth reconciling by hand. */
	private redraw(): void {
		this.contentEl.empty();
		this.onOpen();
	}

	private renderRows(list: HTMLElement, matches: { tx: Transaction; score?: number }[]): void {
		const store = this.plugin.store;
		for (const { tx, score } of matches) {
			const row = list.createDiv({ cls: "fp-match-row" });
			const check = row.createEl("input", { type: "checkbox", cls: "fp-review-check" });
			check.checked = this.selected.has(tx.id);
			check.setAttribute("aria-label", `Include ${payeeName(tx)}`);
			check.addEventListener("change", () => {
				if (check.checked) this.selected.add(tx.id);
				else this.selected.delete(tx.id);
				row.toggleClass("is-selected", check.checked);
				this.syncButtons();
			});
			row.toggleClass("is-selected", check.checked);

			const main = row.createDiv({ cls: "fp-match-row-main" });
			main.createDiv({ cls: "fp-match-row-desc fp-sensitive", text: payeeName(tx) });
			const line = bankLine(tx);
			if (line) main.createDiv({ cls: "fp-match-row-line fp-sensitive", text: line });
			const meta = main.createDiv({ cls: "fp-match-row-meta" });
			meta.createSpan({ text: tx.date });
			meta.createSpan({ text: store.accounts.find((a) => a.id === tx.accountId)?.name ?? "—" });
			const chain = categoryChain(store.categories, tx.categoryId);
			if (chain.primary) categoryChainChip(meta, chain.primary, chain.secondary);
			if (score !== undefined) meta.createSpan({ cls: "fp-match-score", text: `${Math.round(score * 100)}% alike` });

			row.createDiv({
				cls: "fp-match-row-amount fp-money " + (tx.amount < 0 ? "is-negative" : "is-positive"),
				text: formatMoney(tx.amount, { currency: tx.currency || "EUR" }),
			});
		}
	}

	/**
	 * Optional, and deliberately *not* prefilled with the subject's own category.
	 *
	 * Prefilling it would mean the plain "Approve" button also rewrote the category of every selected
	 * row — including rows that were already correctly filed as something else — which is precisely
	 * the kind of thing a bulk action must never do quietly. Left blank, "Approve" approves; choosing
	 * a category is an explicit second decision, and the button says so once you have.
	 */
	private renderCategoryRow(c: HTMLElement): void {
		const row = c.createDiv({ cls: "fp-match-category-row" });
		row.createSpan({ cls: "fp-match-category-label", text: "Also set category" });
		renderCategoryPicker(row.createDiv({ cls: "fp-field-control" }), {
			categories: this.plugin.store.categories,
			value: this.category,
			primaryPlaceholder: "Leave unchanged",
			onChange: (value) => {
				this.category = value;
				this.syncButtons();
			},
		});
	}

	private syncButtons(): void {
		const n = this.targetIds().length;
		const categoryId = this.category.secondaryId ?? this.category.primaryId;

		if (this.countEl) {
			this.countEl.setText(
				n === 0
					? "Nothing selected"
					: `${n} transaction${n === 1 ? "" : "s"} selected${this.includeSubject ? ` (including the one you opened this from)` : ""}`
			);
		}
		if (this.applyBtn) {
			this.applyBtn.disabled = n === 0;
			const label = this.applyBtn.querySelector(".fp-btn-label");
			// The button always states exactly what it is about to do, including the category step once
			// one is chosen — a bulk action shouldn't do more than its label admits to.
			if (label) label.setText(`${this.statusVerb}${categoryId ? " & categorize" : ""} ${n || ""}`.trim());
		}
		if (this.categoryBtn) {
			this.categoryBtn.disabled = n === 0 || !categoryId;
		}
	}

	private renderFooter(c: HTMLElement): void {
		const bar = c.createDiv({ cls: "fp-match-count-bar" });
		this.countEl = bar.createSpan({ cls: "fp-match-count" });

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const never = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Don't ask again" });
		never.setAttribute("title", "Stop offering this after every approval. The link button on each row still opens it on demand — and Settings turns it back on.");
		never.addEventListener("click", async () => {
			this.plugin.settings.reviewMatchPrompt = false;
			await this.plugin.saveSettings();
			new Notice("Won't offer matches automatically. Use the link button on a row, or turn it back on in Settings.");
			this.close();
		});

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		// "Just this one" has to mean the same thing whichever way the sheet was reached. Coming from an
		// approval it already is just this one, so closing is right; coming from the row button nothing
		// has happened yet, so closing would leave the row exactly as it was and the label would lie.
		const skip = right.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Just this one" });
		if (this.includeSubject) {
			skip.addEventListener("click", () => {
				this.selected.clear();
				void this.apply({ setStatus: true });
			});
		}
		skip.addEventListener("click", () => this.close());

		this.categoryBtn = right.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(this.categoryBtn, "tag");
		this.categoryBtn.createSpan({ cls: "fp-btn-label", text: "Set category only" });
		this.categoryBtn.addEventListener("click", () => void this.apply({ setStatus: false }));

		this.applyBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(this.applyBtn, this.opts.status === "flagged" ? "flag" : "check");
		this.applyBtn.createSpan({ cls: "fp-btn-label", text: this.statusVerb });
		this.applyBtn.addEventListener("click", () => void this.apply({ setStatus: true }));
	}

	private async apply(opts: { setStatus: boolean }): Promise<void> {
		const ids = this.targetIds();
		if (ids.length === 0) return;

		const categoryId = this.category.secondaryId ?? this.category.primaryId;
		const patch: Partial<Transaction> = {};
		// "new" is stored as an absent value, matching how the review queue writes it everywhere else.
		if (opts.setStatus) patch.review = this.opts.status === "new" ? undefined : this.opts.status;
		if (categoryId) patch.categoryId = categoryId;

		const patches = new Map<string, Partial<Transaction>>();
		for (const id of ids) patches.set(id, { ...patch });
		const changed = await this.plugin.store.updateTransactions(patches);

		// Setting a category by hand is a decision worth remembering, exactly as it is anywhere else in
		// the app — so a future import of the same merchant lands categorized instead of in the queue.
		if (categoryId) await this.plugin.rememberMerchantsFor(ids, categoryId);

		new Notice(
			opts.setStatus
				? `${this.statusVerb}d ${changed} transaction${changed === 1 ? "" : "s"}${categoryId ? " and set the category" : ""}.`
				: `Set the category on ${changed} transaction${changed === 1 ? "" : "s"}.`
		);
		this.plugin.refreshViews();
		this.opts.onDone?.();
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
