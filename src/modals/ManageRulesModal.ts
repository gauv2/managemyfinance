import { App, Modal, Notice } from "obsidian";
import { categoryChain } from "../categories";
import { applyRules } from "../import/categorize";
import type FinancePlugin from "../main";
import type { CategoryRule } from "../types";
import { categoryChainChip, icon, renderCategoryPicker, type CategoryPickerValue } from "../ui/dom";

/**
 * "IF description/counterparty contains X THEN category = Y" — the same CategoryRule model the
 * plugin's built-in keyword set and auto-categorize-on-import already run on, just user-editable now.
 * Rules are tried top to bottom (first match wins, same as applyRules), so reordering matters —
 * hence the up/down buttons rather than a plain list.
 */
export class ManageRulesModal extends Modal {
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

		const addRow = c.createDiv({ cls: "fp-rule-add-row" });
		const patternInput = addRow.createEl("input", {
			type: "text",
			cls: "fp-rule-pattern-input",
			attr: { placeholder: "e.g. Q-Park" },
		});
		patternInput.value = this.newPattern;
		patternInput.addEventListener("input", () => (this.newPattern = patternInput.value));

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
				if (rule.isRegex) patternCol.createSpan({ cls: "fp-badge fp-tone-neutral", text: "REGEX" });

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
