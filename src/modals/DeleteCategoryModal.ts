import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { descendantIds, primaryCategories, secondaryCategoriesOf } from "../categories";
import type FinancePlugin from "../main";
import type { Category, Transaction } from "../types";
import { categoryChip, icon } from "../ui/dom";

/**
 * Deleting a category used to silently orphan every transaction tagged with it — they stayed in the
 * ledger pointing at an id nothing resolves, which reads as "Uncategorized" everywhere but can't be
 * found by filtering for uncategorized, so the spend simply vanishes from every rollup.
 *
 * This asks the one question that avoids that: where should those transactions go? Reassigning is the
 * default; clearing the category outright is available but stated plainly as what it is.
 */
export class DeleteCategoryModal extends FinanceModal {
	private moveToId = "";

	constructor(app: App, private plugin: FinancePlugin, private category: Category, private onDone: () => void) {
		super(app);
	}

	/** Everything tagged with this category or, for a primary, any of its secondaries. */
	private affected(): Transaction[] {
		const ids = new Set(this.category.parentId ? [this.category.id] : descendantIds(this.plugin.store.categories, this.category.id));
		return this.plugin.store.transactions.filter((t) => t.categoryId && ids.has(t.categoryId));
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		const c = this.contentEl;
		c.addClass("fp-account-modal");

		const store = this.plugin.store;
		const secondaries = this.category.parentId ? [] : secondaryCategoriesOf(store.categories, this.category.id);
		const affected = this.affected();

		c.createEl("h3", { text: `Delete "${this.category.name}"?` });

		const summary = c.createDiv({ cls: "fp-step-desc" });
		if (secondaries.length > 0) {
			summary.setText(
				`This also deletes its ${secondaries.length} subcategor${secondaries.length === 1 ? "y" : "ies"} (${secondaries
					.map((s) => s.name)
					.join(", ")}).`
			);
		} else {
			summary.setText("Budgets planned for this category are removed along with it.");
		}

		if (affected.length === 0) {
			c.createEl("p", { cls: "fp-step-desc", text: "No transactions use it, so nothing else changes." });
		} else {
			c.createEl("p", {
				cls: "fp-step-desc",
				text: `${affected.length} transaction${affected.length === 1 ? " is" : "s are"} currently tagged with it. Pick where they should go — otherwise they become uncategorized and drop out of every category total.`,
			});

			const row = c.createDiv({ cls: "fp-form-row" });
			row.createEl("label", { text: "Move those transactions to" });
			const select = row.createEl("select");
			select.createEl("option", { text: "— leave them uncategorized —", value: "" });
			// Both levels are offered: reassigning to a specific subcategory is often what's wanted when
			// a category is being deleted because it duplicated another one.
			primaryCategories(store.categories)
				.filter((p) => p.id !== this.category.id)
				.forEach((primary) => {
					select.createEl("option", { text: primary.name, value: primary.id });
					secondaryCategoriesOf(store.categories, primary.id)
						.filter((s) => s.id !== this.category.id)
						.forEach((sub) => select.createEl("option", { text: `    ${primary.name} › ${sub.name}`, value: sub.id }));
				});
			select.value = this.moveToId;
			select.addEventListener("change", () => {
				this.moveToId = select.value;
				renderPreview();
			});

			const preview = c.createDiv({ cls: "fp-form-hint" });
			const renderPreview = (): void => {
				preview.empty();
				if (!this.moveToId) {
					preview.setText(`${affected.length} transaction${affected.length === 1 ? "" : "s"} will have no category.`);
					return;
				}
				const target = store.categories.find((x) => x.id === this.moveToId);
				if (!target) return;
				preview.createSpan({ text: `${affected.length} transaction${affected.length === 1 ? "" : "s"} → ` });
				categoryChip(preview, target.name, target.color, target.icon);
			};
			renderPreview();
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const cancel = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel" });
		cancel.addEventListener("click", () => this.close());

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const deleteBtn = right.createEl("button", { cls: "fp-btn fp-btn-danger" });
		icon(deleteBtn, "trash-2");
		deleteBtn.createSpan({ text: "Delete category" });
		deleteBtn.addEventListener("click", () => void this.submit());
	}

	private async submit(): Promise<void> {
		const store = this.plugin.store;
		const affected = this.affected();

		if (affected.length > 0) {
			const patches = new Map<string, Partial<Transaction>>();
			for (const tx of affected) patches.set(tx.id, { categoryId: this.moveToId || undefined });
			await store.updateTransactions(patches);
		}

		const doomed = new Set(
			this.category.parentId ? [this.category.id] : descendantIds(store.categories, this.category.id)
		);
		store.categories = store.categories.filter((c) => !doomed.has(c.id));
		await store.saveCategories();

		const target = this.moveToId ? store.categories.find((c) => c.id === this.moveToId) : undefined;
		new Notice(
			affected.length === 0
				? `Deleted "${this.category.name}"`
				: `Deleted "${this.category.name}" — ${affected.length} transaction${affected.length === 1 ? "" : "s"} ${
						target ? `moved to "${target.name}"` : "left uncategorized"
				  }`
		);
		this.onDone();
		this.plugin.refreshViews();
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
