import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { ACCOUNT_TYPE_META, VIEW_TYPE_SETUP } from "../constants";
import type FinancePlugin from "../main";
import type { Account, AccountType } from "../types";
import { icon, typewriter } from "../ui/dom";

interface SetupStep {
	id: string;
	render: (container: HTMLElement) => void;
	canGoNext?: () => boolean;
	onNext?: () => void | Promise<void>;
	nextLabel?: string;
}

/**
 * First-run setup, opened as its own workspace tab rather than a dialog — a full-pane hero
 * moment (huge greeting, soft glow, typewriter intro) instead of a boxed wizard.
 */
export class SetupView extends ItemView {
	private stepIndex = 0;
	private contentEl2!: HTMLElement;
	private navEl!: HTMLElement;
	private cancelTypewriter?: () => void;
	private steps: SetupStep[];

	constructor(leaf: WorkspaceLeaf, private plugin: FinancePlugin) {
		super(leaf);
		this.steps = buildSteps(plugin, (cancel) => (this.cancelTypewriter = cancel));
	}

	getViewType(): string {
		return VIEW_TYPE_SETUP;
	}
	getDisplayText(): string {
		return "Setup";
	}
	getIcon(): string {
		return "check-circle-2";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("fp-setup");
		root.createDiv({ cls: "fp-setup-glow" });
		root.createDiv({ cls: "fp-setup-glow fp-setup-glow-2" });
		this.contentEl2 = root.createDiv({ cls: "fp-setup-content" });
		this.navEl = root.createDiv({ cls: "fp-setup-nav" });
		this.renderStep();
	}

	onClose(): Promise<void> {
		this.cancelTypewriter?.();
		return Promise.resolve();
	}

	private renderStep(): void {
		this.cancelTypewriter?.();
		this.cancelTypewriter = undefined;
		this.contentEl2.empty();
		this.steps[this.stepIndex].render(this.contentEl2);
		this.renderNav();
	}

	private renderNav(): void {
		this.navEl.empty();
		const step = this.steps[this.stepIndex];
		const isLast = this.stepIndex === this.steps.length - 1;

		if (this.stepIndex > 0) {
			const back = this.navEl.createEl("button", { cls: "fp-setup-link", text: "← Back" });
			back.addEventListener("click", () => {
				this.stepIndex--;
				this.renderStep();
			});
		}

		const next = this.navEl.createEl("button", {
			cls: "fp-setup-link fp-setup-link-primary",
			text: step.nextLabel ?? (isLast ? "Open Finance →" : "Continue →"),
		});
		next.addEventListener("click", async () => {
			if (step.canGoNext && !step.canGoNext()) return;
			if (step.onNext) await step.onNext();
			if (isLast) {
				this.leaf.detach();
			} else {
				this.stepIndex++;
				this.renderStep();
			}
		});
	}

}

export async function openSetupView(plugin: FinancePlugin): Promise<void> {
	const existing = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_SETUP);
	if (existing.length > 0) {
		await plugin.app.workspace.revealLeaf(existing[0]);
		return;
	}
	const leaf = plugin.app.workspace.getLeaf("tab");
	await leaf.setViewState({ type: VIEW_TYPE_SETUP, active: true });
	await plugin.app.workspace.revealLeaf(leaf);
}

function buildSteps(plugin: FinancePlugin, registerCancel: (cancel: () => void) => void): SetupStep[] {
	const store = plugin.store;
	const draftAccounts: Account[] = store.accounts.map((a) => ({ ...a }));

	return [
		{
			id: "welcome",
			render: (c) => {
				c.createEl("h1", { cls: "fp-setup-hi", text: "Hi," });
				c.createEl("h2", { cls: "fp-setup-thanks", text: "Thanks for trying Finance" });
				const body = c.createDiv({ cls: "fp-setup-body" });
				registerCancel(
					typewriter(
						body,
						"In the following steps, you'll point Finance at a folder in your vault, add the accounts you want to track, and choose which categories to use."
					)
				);
			},
		},
		{
			id: "folder",
			render: (c) => {
				c.createEl("h2", { cls: "fp-setup-thanks", text: "Where should your data live?" });
				c.createDiv({
					cls: "fp-setup-body",
					text: "Ledgers, categories, and rules are stored here as plain CSV/JSON, relative to your vault root.",
				});
				const row = c.createDiv({ cls: "fp-setup-field" });
				row.createSpan({ cls: "fp-setup-field-label", text: "Folder" });
				const input = row.createEl("input", {
					type: "text",
					cls: "fp-setup-input",
					value: plugin.settings.dataFolder,
				});
				input.addEventListener("input", () => (plugin.settings.dataFolder = input.value || "Finance"));
			},
			onNext: async () => {
				await plugin.saveSettings();
			},
		},
		{
			id: "accounts",
			render: (c) => {
				c.createEl("h2", { cls: "fp-setup-thanks", text: "Which accounts do you want to track?" });
				c.createDiv({ cls: "fp-setup-body", text: "Add one row per account — you can add more any time." });

				const list = c.createDiv({ cls: "fp-setup-list" });
				const redraw = () => {
					list.empty();
					draftAccounts.forEach((acc, idx) => {
						const row = list.createDiv({ cls: "fp-setup-account-row" });
						icon(row, ACCOUNT_TYPE_META[acc.type].icon, "fp-setup-row-icon");
						const nameInput = row.createEl("input", {
							type: "text",
							cls: "fp-setup-input fp-setup-input-inline",
							value: acc.name,
							placeholder: "Account name",
						});
						nameInput.addEventListener("input", () => (acc.name = nameInput.value));

						const typeSelect = row.createEl("select", { cls: "fp-setup-select" });
						(Object.keys(ACCOUNT_TYPE_META) as AccountType[]).forEach((t) => {
							const opt = typeSelect.createEl("option", { text: ACCOUNT_TYPE_META[t].label, value: t });
							if (t === acc.type) opt.selected = true;
						});
						typeSelect.addEventListener("change", () => {
							acc.type = typeSelect.value as AccountType;
							redraw();
						});

						const removeBtn = row.createEl("button", { cls: "fp-setup-link" });
						icon(removeBtn, "x");
						removeBtn.addEventListener("click", () => {
							draftAccounts.splice(idx, 1);
							redraw();
						});
					});
					if (draftAccounts.length === 0) {
						list.createDiv({ cls: "fp-setup-body", text: "No accounts yet — add one below." });
					}
				};
				redraw();

				const addRow = c.createDiv({ cls: "fp-setup-add-row" });
				(Object.keys(ACCOUNT_TYPE_META) as AccountType[]).forEach((type) => {
					const meta = ACCOUNT_TYPE_META[type];
					const btn = addRow.createEl("button", { cls: "fp-setup-link" });
					icon(btn, meta.icon);
					btn.createSpan({ text: ` Add ${meta.label}` });
					btn.addEventListener("click", () => {
						draftAccounts.push({
							id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
							name: meta.label,
							type,
							currency: "EUR",
							openingBalance: 0,
						});
						redraw();
					});
				});
			},
			onNext: async () => {
				store.accounts = draftAccounts;
				await store.saveAccounts();
			},
		},
		{
			id: "categories",
			render: (c) => {
				c.createEl("h2", { cls: "fp-setup-thanks", text: "Your category palette" });
				c.createDiv({
					cls: "fp-setup-body",
					text: "A sensible color-coded default set. Turn any off — old spreadsheet category names still get mapped onto the ones you keep, automatically, on import.",
				});
				const list = c.createDiv({ cls: "fp-setup-list" });
				store.categories.forEach((cat) => {
					const row = list.createDiv({ cls: "fp-setup-category-row" });
					const dot = row.createSpan({ cls: "fp-setup-dot" });
					dot.style.setProperty("--fp-dot-color", cat.color);
					row.createSpan({ cls: "fp-setup-category-name", text: cat.name });
					const toggle = row.createEl("input", { type: "checkbox" });
					toggle.checked = !cat.archived;
					toggle.addEventListener("change", () => {
						cat.archived = !toggle.checked;
						row.toggleClass("is-archived", !!cat.archived);
					});
					if (cat.archived) row.addClass("is-archived");
				});
			},
			onNext: async () => {
				await store.saveCategories();
			},
		},
		{
			id: "done",
			render: (c) => {
				c.createEl("h1", { cls: "fp-setup-hi", text: "All set," });
				c.createEl("h2", { cls: "fp-setup-thanks", text: "Your Finance workspace is ready" });
				const body = c.createDiv({ cls: "fp-setup-body" });
				registerCancel(
					typewriter(body, "Open the dashboard to see your numbers, or import your first CSV export whenever you're ready.")
				);
			},
			nextLabel: "Open Finance →",
			onNext: async () => {
				plugin.settings.onboarded = true;
				await plugin.saveSettings();
				await plugin.activateView();
				new Notice("Finance workspace ready");
			},
		},
	];
}
