import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { categoryChain } from "../categories";
import { applyRules, resolveRuleMatch } from "../import/categorize";
import { describeAmountCondition } from "../rules";
import { CreateCategoryRuleModal } from "./CreateCategoryRuleModal";
import type FinancePlugin from "../main";
import type { CategoryRule, CategoryRuleMatch } from "../types";
import { categoryChainChip, icon, renderCategoryPicker, type CategoryPickerValue } from "../ui/dom";

const RULE_MATCH_BADGE: Record<CategoryRuleMatch, string> = {
	contains: "CONTAINS",
	exact: "EXACT",
	"starts-with": "STARTS WITH",
	regex: "REGEX",
};

/**
 * "IF description/counterparty contains X THEN category = Y" — the same CategoryRule model the
 * plugin's built-in keyword set and auto-categorize-on-import already run on, just user-editable now.
 * Rules are tried top to bottom (first match wins, same as applyRules), so reordering matters —
 * hence the up/down buttons rather than a plain list.
 */
export class ManageRulesModal extends FinanceModal {
	private newPattern = "";
	private newIsRegex = false;
	private newCategoryValue: CategoryPickerValue = {};

	constructor(app: App, private plugin: FinancePlugin, private onChange?: () => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal", "fp-rules-modal");
		this.render();
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();

		const head = c.createDiv({ cls: "fp-detail-header" });
		const headText = head.createDiv();
		headText.createDiv({ cls: "fp-detail-desc", text: "Categorization rules" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: "Matched against a transaction's description + counterparty (case-insensitive). First match wins, top to bottom.",
		});

		const store = this.plugin.store;
		const uncategorized = store.transactions.filter((t) => !t.categoryId);
		const applyBar = c.createDiv({ cls: "fp-rules-apply-bar" });
		applyBar.createDiv({
			cls: "fp-rules-apply-count",
			text: `${uncategorized.length} uncategorized transaction${uncategorized.length === 1 ? "" : "s"}`,
		});
		const applyBtn = applyBar.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(applyBtn, "wand-2");
		applyBtn.createSpan({ text: "Apply rules to uncategorized" });
		if (uncategorized.length === 0 || store.rules.length === 0) applyBtn.setAttr("disabled", "true");
		applyBtn.addEventListener("click", () => void this.applyToUncategorized());

		// Re-filing rows that already have a category.
		//
		// Rules could only ever fill blanks: `applyToUncategorized` skips anything already categorized,
		// so writing a rule to correct a merchant you had filed wrongly did nothing to the rows that were
		// already there — it only affected future imports. That makes rules useless for the thing people
		// reach for them for, which is bulk-fixing a mistake across years of ledger.
		//
		// Kept as a separate button, and it says how many rows it would MOVE rather than how many it
		// matches: a rule matching 400 rows that are already filed correctly changes nothing, and the
		// number that matters before pressing this is the number that would end up somewhere new.
		const wouldMove = this.countWouldMove();
		const reapplyBtn = applyBar.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(reapplyBtn, "refresh-cw");
		reapplyBtn.createSpan({ text: wouldMove === 0 ? "Re-file categorized rows" : `Re-file ${wouldMove} categorized row${wouldMove === 1 ? "" : "s"}` });
		if (wouldMove === 0 || store.rules.length === 0) {
			reapplyBtn.setAttr("disabled", "true");
			reapplyBtn.setAttribute(
				"title",
				store.rules.length === 0
					? "Add a rule first."
					: "Every categorized row already matches what the rules say — there is nothing to move."
			);
		} else {
			reapplyBtn.setAttribute(
				"title",
				`Applies the rules to rows that already have a category, moving the ${wouldMove} whose current category disagrees with a rule. Rows no rule matches are left alone.`
			);
			reapplyBtn.addEventListener("click", () => void this.reapplyToCategorized(wouldMove));
		}

		const addRow = c.createDiv({ cls: "fp-rule-add-row" });
		const patternWrap = addRow.createDiv({ cls: "fp-rule-pattern-wrap" });
		const patternInput = patternWrap.createEl("input", {
			type: "text",
			cls: "fp-rule-pattern-input",
			attr: { placeholder: "Search your transactions — e.g. Q-Park", autocomplete: "off" },
		});
		patternInput.value = this.newPattern;

		// Suggestions and the live match count are both rendered below the field: typing a rule
		// blind and hoping it matches something is how a rules list fills up with rules that never
		// fire. See renderSuggestions.
		const suggestionsEl = patternWrap.createDiv({ cls: "fp-rule-suggestions" });
		const matchCountEl = patternWrap.createDiv({ cls: "fp-rule-match-count" });

		const refreshSuggestions = (): void => {
			this.renderSuggestions(suggestionsEl, matchCountEl, (value) => {
				this.newPattern = value;
				patternInput.value = value;
				refreshSuggestions();
			});
		};
		patternInput.addEventListener("input", () => {
			this.newPattern = patternInput.value;
			refreshSuggestions();
		});
		patternInput.addEventListener("focus", () => refreshSuggestions());
		refreshSuggestions();

		const regexLabel = addRow.createEl("label", { cls: "fp-rule-regex-label" });
		const regexCheckbox = regexLabel.createEl("input", { type: "checkbox" });
		regexCheckbox.checked = this.newIsRegex;
		regexCheckbox.addEventListener("change", () => (this.newIsRegex = regexCheckbox.checked));
		regexLabel.createSpan({ text: "Regex" });

		const pickerWrap = addRow.createDiv({ cls: "fp-rule-add-picker" });
		renderCategoryPicker(pickerWrap, {
			categories: store.categories,
			primaryPlaceholder: "Category…",
			onChange: (value) => (this.newCategoryValue = value),
		});

		const addBtn = addRow.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(addBtn, "plus");
		addBtn.createSpan({ text: "Add rule" });
		addBtn.addEventListener("click", () => void this.addRule());

		if (store.rules.length === 0) {
			c.createEl("p", {
				cls: "fp-step-desc",
				text: "No rules yet — add one above, or run “Install default categories & auto-categorize transactions” from the command palette for a starter set.",
			});
		} else {
			const list = c.createDiv({ cls: "fp-rule-list" });
			store.rules.forEach((rule, idx) => {
				const row = list.createDiv({ cls: "fp-rule-row" });
				const patternCol = row.createDiv({ cls: "fp-rule-row-pattern" });
				patternCol.createEl("code", { text: rule.pattern });
				// Not just REGEX any more: an "exact" rule and a "contains" rule with the same pattern
				// behave very differently, and a list that showed them identically would be lying.
				const mode = resolveRuleMatch(rule);
				if (mode !== "contains") {
					patternCol.createSpan({ cls: "fp-badge fp-tone-neutral", text: RULE_MATCH_BADGE[mode] });
				}
				// An amount condition changes which rows a rule reaches every bit as much as the pattern
				// does, so a list that showed only the pattern would misrepresent the rule.
				if (rule.amount) patternCol.createSpan({ cls: "fp-badge fp-tone-neutral", text: describeAmountCondition(rule.amount, (v) => v.toFixed(2)) });

				icon(row, "arrow-right", "fp-rule-row-arrow");

				const chain = categoryChain(store.categories, rule.categoryId);
				categoryChainChip(row.createDiv({ cls: "fp-rule-row-category" }), chain.primary, chain.secondary);

				const actions = row.createDiv({ cls: "fp-rule-row-actions" });
				const upBtn = actions.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
				icon(upBtn, "chevron-up");
				if (idx === 0) upBtn.setAttr("disabled", "true");
				upBtn.addEventListener("click", () => void this.move(idx, -1));

				const downBtn = actions.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
				icon(downBtn, "chevron-down");
				if (idx === store.rules.length - 1) downBtn.setAttr("disabled", "true");
				downBtn.addEventListener("click", () => void this.move(idx, 1));

				// The same dialog the rule was written in, so a rule's match mode and amount condition are
				// editable by the controls that created them rather than by a second, lesser form.
				const editBtn = actions.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
				icon(editBtn, "pencil");
				editBtn.setAttribute("aria-label", `Edit rule "${rule.pattern}"`);
				editBtn.addEventListener("click", () => {
					new CreateCategoryRuleModal(this.app, this.plugin, {
						rule,
						onDone: () => {
							this.render();
							this.onChange?.();
						},
					}).open();
				});

				const deleteBtn = actions.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
				icon(deleteBtn, "trash-2");
				deleteBtn.addEventListener("click", () => void this.deleteRule(rule.id));
			});
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const closeBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(closeBtn, "check");
		closeBtn.createSpan({ text: "Done" });
		closeBtn.addEventListener("click", () => this.close());
	}

	/**
	 * What a rule could be written against, taken from the ledger itself.
	 *
	 * Writing a rule used to mean guessing at how a merchant is spelled in the export — and bank
	 * descriptions are full of prefixes, terminal ids and reference numbers that make guessing wrong
	 * more often than right. These are the actual counterparties in your own data, ranked by how many
	 * transactions each covers, so a rule is chosen from what exists rather than typed from memory.
	 *
	 * The live match count underneath answers the other half: does this pattern hit anything, and how
	 * much of the ledger would it claim.
	 */
	private renderSuggestions(container: HTMLElement, countEl: HTMLElement, onPick: (value: string) => void): void {
		container.empty();
		countEl.empty();

		const store = this.plugin.store;
		const query = this.newPattern.trim().toLowerCase();

		// Counted across every transaction, not only uncategorized ones: a rule is just as often
		// written to re-file something that's already categorized wrongly.
		const counts = new Map<string, { label: string; count: number; uncategorized: number }>();
		for (const tx of store.transactions) {
			const label = (tx.counterparty || tx.description || "").trim();
			if (label.length < 3) continue;
			const key = label.toLowerCase();
			const entry = counts.get(key) ?? { label, count: 0, uncategorized: 0 };
			entry.count++;
			if (!tx.categoryId) entry.uncategorized++;
			counts.set(key, entry);
		}

		if (query) {
			const matching = store.transactions.filter((tx) =>
				`${tx.description ?? ""} ${tx.counterparty ?? ""}`.toLowerCase().includes(query)
			);
			const uncategorized = matching.filter((tx) => !tx.categoryId).length;
			countEl.setText(
				matching.length === 0
					? "No transactions contain that text — the rule would never fire."
					: `Matches ${matching.length} transaction${matching.length === 1 ? "" : "s"} (${uncategorized} uncategorized).`
			);
			countEl.toggleClass("is-empty", matching.length === 0);
		}

		const ranked = Array.from(counts.values())
			.filter((entry) => !query || entry.label.toLowerCase().includes(query))
			// Uncategorized rows first at equal frequency: those are the ones a new rule actually helps.
			.sort((a, b) => b.uncategorized - a.uncategorized || b.count - a.count)
			.slice(0, 8);

		if (ranked.length === 0) return;

		container.createDiv({ cls: "fp-rule-suggestions-label", text: query ? "Matching counterparties" : "Most common counterparties" });
		ranked.forEach((entry) => {
			const chip = container.createEl("button", { cls: "fp-rule-suggestion" });
			chip.createSpan({ cls: "fp-rule-suggestion-label", text: entry.label });
			chip.createSpan({ cls: "fp-rule-suggestion-count", text: `${entry.count}` });
			chip.setAttribute("title", `${entry.count} transactions, ${entry.uncategorized} of them uncategorized`);
			chip.addEventListener("click", () => onPick(entry.label));
		});
	}

	private async addRule(): Promise<void> {
		const pattern = this.newPattern.trim();
		if (!pattern) {
			new Notice("Enter a pattern to match against");
			return;
		}
		const categoryId = this.newCategoryValue.secondaryId ?? this.newCategoryValue.primaryId;
		if (!categoryId) {
			new Notice("Choose a category for this rule");
			return;
		}
		if (this.newIsRegex) {
			try {
				new RegExp(pattern, "i");
			} catch {
				new Notice("That regex is invalid");
				return;
			}
		}

		const rule: CategoryRule = {
			id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			pattern,
			isRegex: this.newIsRegex || undefined,
			categoryId,
		};
		this.plugin.store.rules.push(rule);
		await this.plugin.store.saveRules();

		this.newPattern = "";
		this.newIsRegex = false;
		this.newCategoryValue = {};
		new Notice(`Rule added — "${pattern}" → category set`);
		this.render();
		this.onChange?.();
	}

	private async move(index: number, delta: number): Promise<void> {
		const rules = this.plugin.store.rules;
		const target = index + delta;
		if (target < 0 || target >= rules.length) return;
		[rules[index], rules[target]] = [rules[target], rules[index]];
		await this.plugin.store.saveRules();
		this.render();
	}

	private async deleteRule(id: string): Promise<void> {
		this.plugin.store.rules = this.plugin.store.rules.filter((r) => r.id !== id);
		await this.plugin.store.saveRules();
		new Notice("Rule removed");
		this.render();
		this.onChange?.();
	}

	/** Categorized rows a rule would move somewhere else. The number worth showing before pressing. */
	private countWouldMove(): number {
		const store = this.plugin.store;
		let n = 0;
		for (const tx of store.transactions) {
			if (!tx.categoryId) continue;
			const match = applyRules(tx, store.rules);
			if (match && match !== tx.categoryId) n++;
		}
		return n;
	}

	/**
	 * Re-files already-categorized rows that a rule disagrees with.
	 *
	 * Confirmed first, because this is the one action here that can overwrite decisions made by hand,
	 * and the count is of rows that actually change rather than rows that match.
	 */
	private async reapplyToCategorized(expected: number): Promise<void> {
		const store = this.plugin.store;
		const ok = confirm(
			`Re-file ${expected} transaction${expected === 1 ? "" : "s"} that already have a category, using your rules?\n\n` +
				"This overwrites categories on rows a rule disagrees with, including any you set by hand. Rows no rule matches are untouched."
		);
		if (!ok) return;

		const patches = new Map<string, string>();
		for (const tx of store.transactions) {
			if (!tx.categoryId) continue;
			const match = applyRules(tx, store.rules);
			if (match && match !== tx.categoryId) patches.set(tx.id, match);
		}
		if (patches.size === 0) {
			new Notice("Nothing to move — every categorized row already agrees with the rules");
			return;
		}
		const count = await store.recategorize(patches);
		// The merchants involved are now known for good, so the next import lands the same way.
		await this.plugin.rememberMerchantsForRules(patches);
		new Notice(`Re-filed ${count} transaction${count === 1 ? "" : "s"}`);
		this.plugin.refreshViews();
		this.render();
		this.onChange?.();
	}

	private async applyToUncategorized(): Promise<void> {
		const store = this.plugin.store;
		const patches = new Map<string, string>();
		for (const tx of store.transactions) {
			if (tx.categoryId) continue;
			const match = applyRules(tx, store.rules);
			if (match) patches.set(tx.id, match);
		}
		if (patches.size === 0) {
			new Notice("No uncategorized transactions matched a rule");
			return;
		}
		const count = await store.recategorize(patches);
		new Notice(`Categorized ${count} transaction${count === 1 ? "" : "s"}`);
		this.plugin.refreshViews();
		this.render();
		this.onChange?.();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
