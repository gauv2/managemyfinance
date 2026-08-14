import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { canReparent, primaryCategories, reparentTargets, reparented, secondaryCategoriesOf } from "../categories";
import { ACCOUNT_TYPE_META, CURRENCIES, DEFAULT_DATA_FOLDER } from "../constants";
import {
	AI_MODELS,
	type AiProviderId,
	cliAvailable,
	DEFAULT_AI_MODEL,
	DEFAULT_CONFIDENCE_THRESHOLD,
	testProvider,
} from "../ai/provider";
import { buildMatchPrompt } from "../ai/matchPrompt";
import { buildUserPrompt } from "../ai/prompt";
import { sendEmail, sendTelegram } from "../delivery/channels";
import { canExportPdf } from "../reports/pdf";
import { describeOutcome, runSchedule, sendTestReport } from "../reports/scheduleRunner";
import {
	completedPeriod,
	currentPeriod,
	describeSchedule,
	DETAIL_HINT,
	DETAIL_LABEL,
	isDue,
	nextDueAt,
	type Cadence,
	type ReportDetail,
} from "../reports/schedule";
import { ScheduleEditModal } from "../modals/ScheduleEditModal";
import { buildBackup, serializeBackup, transactionsToCsv, writeExport } from "../data/backup";
import { merchantDisplayName } from "../import/merchantKey";
import { unknownMerchants } from "../import/merchantMemory";
import { fetchLatestRates } from "../fx";
import { decimalSeparator, formatMoneyForInput, parseMoney } from "../money";
import type FinancePlugin from "../main";
import { DeleteAllDataModal } from "../modals/DeleteAllDataModal";
import { DeleteCategoryModal } from "../modals/DeleteCategoryModal";
import { EditAccountModal } from "../modals/EditAccountModal";
import { ImportBackupModal } from "../modals/ImportBackupModal";
import { ManagePortfoliosModal } from "../modals/ManagePortfoliosModal";
import type { AccountType, Category } from "../types";
import { icon } from "../ui/dom";
import { openImportWizard } from "../wizards/ImportWizard";

const BASE_CURRENCY = "EUR";

const FEATURES: { icon: string; title: string; desc: string }[] = [
	{
		icon: "layers",
		title: "Multi-portfolio",
		desc: "Track more than one person or entity's finances separately — each portfolio is its own set of accounts, transactions, categories, and settings.",
	},
	{
		icon: "landmark",
		title: "Accounts",
		desc: "Debit, credit, investing, saving, cash, and crypto accounts, each with its own type-appropriate dashboard: net worth, income/expenses, savings rate, and a financial-independence projection. Name, type, currency, IBAN and balance are all editable after the fact — set the current balance and the opening balance is back-computed to match.",
	},
	{
		icon: "list",
		title: "Ledger",
		desc: "A searchable, filterable, sortable transaction list with category chips, month drill-downs, and file attachments — link a receipt or invoice already in your vault to a transaction.",
	},
	{
		icon: "download",
		title: "Import wizard",
		desc: "Drag in a CSV or Excel export. ING and Trade Republic exports are auto-detected; anything else gets a manual column-mapping step, with auto-guessed defaults, so it can still be imported without a dedicated parser.",
	},
	{
		icon: "wand-2",
		title: "Auto-categorization",
		desc: "A built-in keyword rule set for common merchants (plus your own custom rules) categorizes transactions on import, and flags recurring counterparties whose transactions land in more than one category so miscategorization gets caught early.",
	},
	{
		icon: "target",
		title: "Budgets",
		desc: "Monthly limits per category, kept per month (not overwritten as the calendar rolls forward) so past plans and actuals stay around for year-end review. Set one total per category, or split it across secondary categories (e.g. Car → Fuel, Car Wash) for a per-subcategory breakdown. Progress bars, suggested budgets from recent spending, and a click-through to the transactions behind any total.",
	},
	{
		icon: "repeat",
		title: "Subscriptions",
		desc: "Track recurring payments in any billing cycle and currency, optionally linked to the account they're paid from — normalized so wildly different cycles compare cleanly. One toggle quotes every total, chart and card per month or per year, and individual subscriptions can carry their own preference.",
	},
	{
		icon: "credit-card",
		title: "Cards",
		desc: "A card manager with tier/issuer/network-driven visual styling (CSS/SVG only, no external logos or images) — click a card to flip it and see its number and expiry. The CVV is never asked for or stored.",
	},
	{
		icon: "check-check",
		title: "Review queue",
		desc: "A page for working through imported transactions: fix the category inline, select rows in bulk, then approve. Anything you can't decide on yet gets flagged and parked, so the queue can actually reach empty instead of silently accumulating guesses.",
	},
	{
		icon: "calculator",
		title: "Flexible amount entry",
		desc: "\"1.234,56\", \"1,234.56\", \"1234.56\" and \"€ 1 234,56\" all read as the same number wherever an amount is typed or imported, and every field echoes back the value it understood. How amounts are written back out follows its own setting.",
	},
	{
		icon: "database",
		title: "Backup, restore & reset",
		desc: "Export a whole portfolio as one JSON file (or the ledger as a flat CSV), restore a backup by merging or replacing, and clear a portfolio outright behind a typed confirmation and an offered backup.",
	},
	{
		icon: "sparkles",
		title: "AI categorization",
		desc: "Optional, off by default, and asked about merchants rather than transactions: the distinct shops your own history and the built-in rules both failed on — usually 60-100 for a year of data, not one request per row. Confident answers apply, uncertain ones wait in the review queue. Runs on a Claude API key, or on the Claude CLI so it rides an existing subscription. Only merchant names and your category tree are ever sent.",
	},
	{
		icon: "brain",
		title: "Merchant memory",
		desc: "Categorize a shop once and every other transaction from it follows — backwards through the ledger and forwards through future imports. Built from the categories you have already assigned, so it works on your existing data rather than only on what you touch from now on.",
	},
	{
		icon: "eye-off",
		title: "Privacy mode",
		desc: "Blur every displayed amount, IBAN, and card number at a click — for demoing the plugin, or working with the vault open, without exposing real numbers.",
	},
	{
		icon: "coins",
		title: "Currency & exchange rates",
		desc: "Subscriptions can use any currency. A manual rate table converts them into EUR for combined totals — edit rates yourself, or fetch the day's ECB reference rates on demand (the only network request this plugin ever makes).",
	},
	{
		icon: "smartphone",
		title: "Mobile-friendly layout",
		desc: "Auto-detects Obsidian's mobile mode and stacks the sidebar above the page, or force it on/off manually to preview the layout on desktop.",
	},
];

const MOBILE_LAYOUT_LABEL: Record<"auto" | "on" | "off", string> = {
	auto: "Auto",
	on: "Always on",
	off: "Always off",
};

type ChipTone = "ok" | "warn" | "pending";

interface GroupHandle {
	content: HTMLElement;
	/** Updates the panel's status chip in place, without repainting the whole page — so a chip can
	 *  answer "is this set up?" the moment the control next to it changes. */
	setChip(text: string, tone: ChipTone): void;
}

interface SettingsSection {
	id: string;
	label: string;
	icon: string;
	render: (content: HTMLElement) => void;
}

/**
 * Settings, laid out as a left nav over grouped panels.
 *
 * A flat list of rows made it impossible to tell what belonged with what, and the things needing
 * setup — exchange rates, a first account — read the same as the things that never change. Each panel
 * carries a status chip so its state is legible without opening it.
 */
export class FinanceSettingTab extends PluginSettingTab {
	private active = "general";
	private collapsed = new Map<string, boolean>();
	private categoryExpanded = new Map<string, boolean>();
	private navEl!: HTMLElement;
	private bodyEl!: HTMLElement;

	constructor(app: App, private plugin: FinancePlugin) {
		super(app, plugin);
	}

	/** Opens this tab on a particular section — lets the workspace deep-link to e.g. category management
	 *  instead of dropping the user on whichever section they happened to leave open. */
	selectGroup(id: string): void {
		this.active = id;
	}

	private sections(): SettingsSection[] {
		return [
			{ id: "general", label: "General", icon: "settings-2", render: (c) => this.renderGeneral(c) },
			{ id: "accounts", label: "Accounts", icon: "landmark", render: (c) => this.renderAccounts(c) },
			{ id: "categories", label: "Categories", icon: "tag", render: (c) => this.renderCategories(c) },
			{ id: "projections", label: "Projections", icon: "trending-up", render: (c) => this.renderProjections(c) },
			{ id: "currency", label: "Currency", icon: "coins", render: (c) => this.renderCurrency(c) },
			{ id: "import", label: "Import", icon: "download", render: (c) => this.renderImport(c) },
			{ id: "ai", label: "AI", icon: "sparkles", render: (c) => this.renderAi(c) },
			{ id: "schedules", label: "Scheduled reports", icon: "send", render: (c) => this.renderSchedules(c) },
			{ id: "data", label: "Data", icon: "database", render: (c) => this.renderData(c) },
			{ id: "about", label: "About", icon: "info", render: (c) => this.renderAbout(c) },
		];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("fp-settings");

		this.renderScopeBanner(containerEl);

		const shell = containerEl.createDiv({ cls: "fp-settings-shell-row" });
		this.navEl = shell.createDiv({ cls: "fp-settings-nav" });
		this.bodyEl = shell.createDiv({ cls: "fp-settings-body" });

		const sections = this.sections();
		if (!sections.some((s) => s.id === this.active)) this.active = sections[0].id;

		for (const section of sections) {
			const btn = this.navEl.createEl("button", { cls: "fp-settings-nav-item" });
			icon(btn.createSpan({ cls: "fp-settings-nav-icon" }), section.icon);
			btn.createSpan({ text: section.label });
			btn.toggleClass("is-active", section.id === this.active);
			btn.onclick = () => {
				this.active = section.id;
				this.navEl.findAll(".fp-settings-nav-item").forEach((el) => el.removeClass("is-active"));
				btn.addClass("is-active");
				this.renderBody();
			};
		}

		this.renderBody();
	}

	hide(): void {
		this.containerEl.removeClass("fp-settings");
		super.hide();
	}

	private renderBody(): void {
		this.bodyEl.empty();
		const sections = this.sections();
		(sections.find((s) => s.id === this.active) ?? sections[0]).render(this.bodyEl);
	}

	/**
	 * A titled panel with an icon, a subtitle and an optional status chip.
	 *
	 * `collapsibleId` is opt-in and used only where the body is a long grid — the eleven-row currency
	 * table, the feature list — that would otherwise bury every panel beneath it. `headerAction` puts a
	 * button in the head (e.g. "Fetch rates"); it stops its own click from reaching the collapse toggle.
	 */
	private group(
		parent: HTMLElement,
		o: {
			icon: string;
			title: string;
			subtitle: string;
			chip?: { text: string; tone: ChipTone };
			collapsibleId?: string;
			defaultExpanded?: boolean;
			danger?: boolean;
			headerAction?: (right: HTMLElement) => void;
		}
	): GroupHandle {
		const collapsible = !!o.collapsibleId;
		const expanded = collapsible ? this.collapsed.get(o.collapsibleId!) ?? o.defaultExpanded ?? true : true;

		const box = parent.createDiv({
			cls: "fp-sgroup" + (o.danger ? " fp-sgroup-danger" : "") + (collapsible && !expanded ? " is-collapsed" : ""),
		});
		const head = box.createDiv({ cls: "fp-sgroup-head" + (collapsible ? " is-clickable" : "") });
		icon(head.createDiv({ cls: "fp-sgroup-icon" }), o.icon);

		const titles = head.createDiv({ cls: "fp-sgroup-titles" });
		titles.createDiv({ cls: "fp-sgroup-title", text: o.title });
		titles.createDiv({ cls: "fp-sgroup-sub", text: o.subtitle });

		const chip = head.createSpan({ cls: "fp-chip" });
		chip.hide();
		const setChip = (text: string, tone: ChipTone): void => {
			chip.show();
			chip.setText(text);
			chip.removeClass("fp-chip-ok", "fp-chip-warn", "fp-chip-pending");
			chip.addClass(`fp-chip-${tone}`);
		};
		if (o.chip) setChip(o.chip.text, o.chip.tone);

		if (o.headerAction) {
			const wrap = head.createDiv();
			wrap.addEventListener("click", (ev) => ev.stopPropagation());
			o.headerAction(wrap);
		}
		if (collapsible) {
			icon(head.createDiv({ cls: "fp-sgroup-chevron" }), "chevron-down");
			head.addEventListener("click", () => {
				this.collapsed.set(o.collapsibleId!, !expanded);
				this.renderBody();
			});
		}

		return { content: box.createDiv({ cls: "fp-sgroup-body" }), setChip };
	}

	/** A `?` on a row that reveals the longer explanation only when asked. */
	private help(setting: Setting, text: string): void {
		let helpEl: HTMLElement | null = null;
		setting.addExtraButton((b) =>
			b
				.setIcon("help-circle")
				.setTooltip("What does this do?")
				.onClick(() => {
					if (helpEl) {
						helpEl.remove();
						helpEl = null;
						return;
					}
					helpEl = createDiv({ cls: "fp-setting-help", text });
					setting.settingEl.insertAdjacentElement("afterend", helpEl);
				})
		);
	}

	private note(parent: HTMLElement, text: string): void {
		parent.createDiv({ cls: "fp-setting-note", text });
	}

	private renderGeneral(content: HTMLElement): void {
		const where = this.group(content, {
			icon: "folder",
			title: "Where your data lives",
			subtitle: "The vault folder this plugin keeps its ledger and settings in.",
			chip: { text: this.plugin.settings.dataFolder, tone: "ok" },
		});
		const folderSetting = new Setting(where.content)
			.setName("Data folder")
			.setDesc("Folder holding your ledger, accounts, and categories. Can sit anywhere in the vault — give it a path like \"System/Manage My Finance\" to nest it.")
			.addText((t) =>
				t.setValue(this.plugin.settings.dataFolder).onChange(async (v) => {
					this.plugin.settings.dataFolder = v || DEFAULT_DATA_FOLDER;
					await this.plugin.saveSettings();
					where.setChip(this.plugin.settings.dataFolder, "ok");
				})
			);
		this.help(
			folderSetting,
			"Accounts, categories, rules, subscriptions and cards are stored here as JSON; the transaction ledger as CSV, one file per source per year. Changing this points the plugin at a different folder — it does not move the files that are already there. A nested path (e.g. \"System/Manage My Finance\") works fine; parent folders are created automatically if they don't already exist."
		);

		const count = (this.plugin.settings.portfolios ?? []).length;
		const portfolios = this.group(content, {
			icon: "layers",
			title: "Portfolios",
			subtitle: "A separate set of accounts, transactions and categories per person or entity.",
			chip: { text: `${count} portfolio${count === 1 ? "" : "s"}`, tone: "ok" },
		});
		new Setting(portfolios.content)
			.setName("Active portfolio")
			.setDesc(
				`Everything on this settings page applies to "${this.plugin.activePortfolio?.name ?? "the active portfolio"}". Switch or add portfolios from the workspace's own title menu.`
			)
			.addButton((b) =>
				b
					.setButtonText("Manage portfolios")
					.onClick(() => new ManagePortfoliosModal(this.app, this.plugin, () => this.renderBody()).open())
			);

		const appearance = this.group(content, {
			icon: "sliders-horizontal",
			title: "Appearance & display",
			subtitle: "How amounts are written, and whether they're blurred.",
			chip: { text: "in the workspace", tone: "pending" },
		});
		new Setting(appearance.content)
			.setName("Open the app's own settings")
			.setDesc("Number format, \u201Chide amounts\u201D, mobile layout and the subscriptions default view.")
			.addButton((b) =>
				b
					.setButtonText("Open in the workspace")
					.setCta()
					.onClick(() => void this.openInAppSettings())
			);
		this.note(
			appearance.content,
			`These are display preferences, so they sit inside the workspace where the effect is visible as you change them, rather than behind this modal. Mobile layout is currently "${
				MOBILE_LAYOUT_LABEL[this.plugin.settings.mobileLayout ?? "auto"]
			}"; this device is detected as ${Platform.isMobile ? "mobile" : "desktop"}.`
		);
	}

	/** Sends the user to the in-app Settings page and closes this modal, so the two surfaces don't sit
	 *  on top of each other arguing about which one is in front. */
	private async openInAppSettings(): Promise<void> {
		this.plugin.settings.activeView = "settings";
		this.plugin.settings.activeAccountId = undefined;
		await this.plugin.saveSettings();
		await this.plugin.activateView();
		this.plugin.refreshViews();
		(this.app as unknown as { setting?: { close?: () => void } }).setting?.close?.();
	}

	/**
	 * Names the split up front, because "the plugin's settings" is ambiguous once there are two places
	 * to look: this page is what the plugin *knows* (folders, accounts, categories, rates), and the
	 * in-app page is how it *looks* while you work.
	 */
	private renderScopeBanner(container: HTMLElement): void {
		const banner = container.createDiv({ cls: "fp-settings-scope-banner" });
		icon(banner, "database", "fp-settings-scope-icon");
		const text = banner.createDiv();
		text.createDiv({ cls: "fp-settings-scope-title", text: "Vault settings — your data and how it's set up" });
		text.createDiv({
			cls: "fp-settings-scope-desc",
			text: "Data folder, portfolios, accounts, categories, exchange rates, import, and backup/restore. Display preferences — number format, hiding amounts, layout — live in the workspace's own Settings page instead.",
		});
		const btn = banner.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(btn, "panel-right");
		btn.createSpan({ text: "App settings" });
		btn.addEventListener("click", () => void this.openInAppSettings());
	}

	/**
	 * AI categorization. Off by default and stated plainly, because turning it on changes what this
	 * plugin does with your data — it adds the second outbound request it has ever made, and the
	 * first that carries anything derived from your ledger.
	 */
	private renderAi(content: HTMLElement): void {
		const settings = this.plugin.settings;
		const ai = (settings.ai ??= {});
		const provider: AiProviderId = ai.provider ?? "api";
		const store = this.plugin.store;

		const save = async (): Promise<void> => {
			await this.plugin.saveSettings();
		};

		const group = this.group(content, {
			icon: "sparkles",
			title: "AI categorization",
			subtitle: "Ask Claude about merchants your own history and the built-in rules can't identify.",
			chip: ai.enabled ? { text: provider === "cli" ? "on · CLI" : "on · API", tone: "ok" } : { text: "off", tone: "pending" },
		});

		new Setting(group.content)
			.setName("Enable AI categorization")
			.setDesc("Adds an \u201CAsk Claude\u201D step to the Review page and the command palette.")
			.addToggle((t) =>
				t.setValue(!!ai.enabled).onChange(async (v) => {
					ai.enabled = v;
					await save();
					this.renderBody();
				})
			);

		this.note(
			group.content,
			"It only ever asks about merchants nothing else could identify \u2014 roughly 60\u2013100 distinct shops for a year of transactions, not one request per row. Every answer is remembered, so a merchant costs one classification ever."
		);

		if (!ai.enabled) return;

		// ---- provider ---------------------------------------------------------
		const providerSetting = new Setting(group.content).setName("Provider").addDropdown((d) => {
			d.addOption("api", "Claude API key");
			if (cliAvailable()) d.addOption("cli", "Claude CLI (your Max subscription)");
			d.setValue(cliAvailable() ? provider : "api");
			d.onChange(async (v) => {
				ai.provider = v as AiProviderId;
				await save();
				this.renderBody();
			});
		});
		this.help(
			providerSetting,
			cliAvailable()
				? "The API key is billed per token \u2014 a full pass over a year of transactions costs a few cents. The CLI rides your existing Max subscription at no extra cost, but only works in the desktop app, because it has to start a subprocess."
				: "Only the API key provider works here. The Claude CLI needs to start a subprocess, which the mobile app cannot do."
		);

		if (provider === "cli") {
			const cliSetting = new Setting(group.content)
				.setName("Claude binary")
				.setDesc("Leave blank to find `claude` on your PATH.")
				.addText((t) =>
					t
						.setPlaceholder("/usr/local/bin/claude")
						.setValue(ai.cliPath ?? "")
						.onChange(async (v) => {
							ai.cliPath = v.trim();
							await save();
						})
				);
			this.help(
				cliSetting,
				"Obsidian doesn't inherit your shell's PATH on macOS, so `claude` often isn't found even though it works in a terminal. If the test below fails, run `which claude` and paste the full path here."
			);
		} else {
			const keyRow = group.content.createDiv({ cls: "fp-keyrow" });
			const input = keyRow.createEl("input", {
				cls: "fp-key-input",
				type: "password",
				attr: { placeholder: "sk-ant-\u2026", spellcheck: "false", autocomplete: "off" },
			});
			input.value = ai.apiKey ?? "";
			// Debounced: a 100-character key would otherwise fire a write to data.json per keystroke.
			let timer: number | null = null;
			input.addEventListener("input", () => {
				ai.apiKey = input.value.trim();
				if (timer !== null) window.clearTimeout(timer);
				timer = window.setTimeout(() => {
					timer = null;
					void save();
				}, 500);
			});
			input.addEventListener("blur", () => {
				if (timer === null) return;
				window.clearTimeout(timer);
				timer = null;
				void save();
			});

			const eye = keyRow.createEl("button", { cls: "fp-key-btn", attr: { "aria-label": "Show or hide the key" } });
			icon(eye, "eye");
			eye.addEventListener("click", () => {
				const hidden = input.type === "password";
				input.type = hidden ? "text" : "password";
				eye.empty();
				icon(eye, hidden ? "eye-off" : "eye");
			});

			const warn = group.content.createDiv({ cls: "fp-key-warning" });
			icon(warn, "alert-triangle", "fp-key-warning-icon");
			warn.createSpan({
				text: "The key is stored in plain text in this vault's plugin data.json. Anyone, or anything, with access to your vault files can read it \u2014 including sync services.",
			});

			const links = group.content.createDiv({ cls: "fp-setting-links" });
			links.createEl("a", { text: "Get an API key", href: "https://console.anthropic.com/settings/keys" });
		}

		new Setting(group.content)
			.setName("Model")
			.setDesc("Opus is the most accurate; the smaller models are cheaper and quicker on a long list.")
			.addDropdown((d) => {
				AI_MODELS.forEach((m) => d.addOption(m.id, m.label));
				d.setValue(ai.model ?? DEFAULT_AI_MODEL);
				d.onChange(async (v) => {
					ai.model = v;
					await save();
				});
			});

		const threshold = ai.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
		const thresholdSetting = new Setting(group.content)
			.setName("Auto-apply above")
			.setDesc(`${Math.round(threshold * 100)}% confident. Below this, answers wait in the Review queue instead.`)
			.addSlider((s) =>
				s
					.setLimits(50, 100, 5)
					.setValue(Math.round(threshold * 100))
					.setDynamicTooltip()
					.onChange(async (v) => {
						ai.confidenceThreshold = v / 100;
						await save();
					})
			);
		this.help(
			thresholdSetting,
			"This is the dial that decides how much you trust the model. Lower it and more gets categorized without you looking; raise it and more lands in the review queue as a suggestion you accept or reject. Nothing below the bar is ever written to a transaction."
		);

		const applyLowSetting = new Setting(group.content)
			.setName("Apply uncertain answers too")
			.setDesc("Categorize below-threshold answers as well, marked flagged, instead of holding them back for approval.")
			.addToggle((t) =>
				t.setValue(ai.applyLowConfidence !== false).onChange(async (v) => {
					ai.applyLowConfidence = v;
					await save();
				})
			);
		this.help(
			applyLowSetting,
			"On by default. An uncategorized row is worse than a categorized-but-flagged one: the flagged row shows up in every total and is easy to find and correct in Review, while the uncategorized row is invisible everywhere and has to be handled by hand. Turn this off only if you'd rather approve every uncertain answer yourself."
		);

		const autoSetting = new Setting(group.content)
			.setName("Run automatically on import")
			.setDesc("Ask Claude as soon as the Categorize step opens, instead of waiting for the button.")
			.addToggle((t) =>
				t.setValue(!!ai.autoOnImport).onChange(async (v) => {
					ai.autoOnImport = v;
					await save();
				})
			);
		this.help(
			autoSetting,
			"Off by default because an import shouldn't fire a network request you didn't ask for. With it on, a typical import arrives fully categorized in one pass — and because every answer is remembered, later imports of the same merchants cost nothing at all."
		);

		// ---- test -------------------------------------------------------------
		new Setting(group.content)
			.setName("Test the connection")
			.setDesc("Classifies one well-known merchant, so a broken key or path shows up here rather than mid-import.")
			.addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					b.setButtonText("Testing\u2026").setDisabled(true);
					try {
						new Notice(await testProvider(ai, store.categories), 10000);
					} catch (err) {
						new Notice(`Test failed: ${err instanceof Error ? err.message : String(err)}`, 12000);
					} finally {
						b.setButtonText("Test").setDisabled(false);
					}
				})
			);

		// ---- exactly what leaves the vault ------------------------------------
		const pending = unknownMerchants(store.transactions, store.merchants);
		const preview = this.group(content, {
			icon: "shield",
			title: "What gets sent — categorizing",
			subtitle: "Merchant names and your category tree. Nothing else.",
			chip:
				pending.length > 0
					? { text: `${pending.length} merchant${pending.length === 1 ? "" : "s"} pending`, tone: "warn" }
					: { text: "nothing pending", tone: "ok" },
			collapsibleId: "ai-payload",
			defaultExpanded: false,
		});
		this.note(
			preview.content,
			"No amounts, dates, account names, IBANs, card numbers or balances are included \u2014 not for context, not for accuracy. This is the exact text that would be sent for the merchants still unidentified in this portfolio."
		);
		const sample = pending.slice(0, 25).map((m) => m.key);
		const box = preview.content.createEl("pre", { cls: "fp-ai-payload" });
		box.setText(
			sample.length === 0
				? "Nothing to send \u2014 every merchant in this portfolio is already identified."
				: buildUserPrompt(sample, store.categories)
		);
		if (pending.length > sample.length) {
			this.note(preview.content, `Showing the first ${sample.length} of ${pending.length}; the rest go in later batches of the same shape.`);
		}

		// The second AI feature sends a different payload, so it gets its own panel rather than being
		// covered by implication. A promise about what leaves the vault is only worth making if every
		// request that leaves it is shown.
		const matchPreview = this.group(content, {
			icon: "shield",
			title: "What gets sent — matching transactions",
			subtitle: "Merchant names only. Not even your category tree.",
			collapsibleId: "ai-match-payload",
			defaultExpanded: false,
		});
		this.note(
			matchPreview.content,
			"Sent when you press “Ask Claude” on the match sheet in Review, and only then. It asks which of your other merchants are the same shop as the one you're reviewing — the question that finds “AH to go” for “Albert Heijn”, which no text comparison can. No amounts, dates, account names, IBANs or balances."
		);
		const merchantNames = Array.from(
			new Set(
				store.transactions
					.map((t) => merchantDisplayName(t.description || t.counterparty || ""))
					.filter((name): name is string => !!name)
			)
		);
		const matchBox = matchPreview.content.createEl("pre", { cls: "fp-ai-payload" });
		matchBox.setText(
			merchantNames.length < 2
				? "Nothing to show — this portfolio has no merchants to compare yet."
				: buildMatchPrompt(
						merchantNames[0],
						merchantNames.slice(1, 21).map((name) => ({ key: name, name, count: 1 }))
				  )
		);
	}

	/**
	 * Recurring report delivery: the credentials, the schedules, and an honest account of when any of
	 * it actually runs.
	 *
	 * The "no background process" caveat is stated at the top rather than buried, because a user who
	 * believes this is a cron job will conclude the feature is broken the first time they leave
	 * Obsidian closed over a weekend — and they'd be right to, given what they were told.
	 */
	private renderSchedules(content: HTMLElement): void {
		const settings = this.plugin.settings;
		settings.delivery ??= {};
		const schedules = settings.reportSchedules ?? [];

		const listGroup = this.group(content, {
			icon: "send",
			title: "Schedules",
			subtitle: "Reports built and delivered for each completed period.",
			chip:
				schedules.length === 0
					? { text: "none yet", tone: "pending" }
					: { text: `${schedules.filter((s) => s.enabled).length} of ${schedules.length} active`, tone: "ok" },
			headerAction: (right: HTMLElement) => {
				const btn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
				icon(btn, "plus");
				btn.createSpan({ text: "New schedule" });
				btn.addEventListener("click", () => new ScheduleEditModal(this.app, this.plugin, undefined, () => this.renderBody()).open());
			},
		});

		this.note(
			listGroup.content,
			"Obsidian has no background process, so nothing is sent while it is closed. A report that falls due is delivered the first time Obsidian runs on or after that date, and says in its own body that it was generated late. One launch produces one report per schedule — never a burst of back-filled ones."
		);
		if (!canExportPdf()) {
			this.note(listGroup.content, "PDF rendering needs the desktop app. On mobile, a schedule asking for PDF sends the report as HTML instead and says so in its delivery log.");
		}

		if (schedules.length === 0) {
			this.note(listGroup.content, "No schedules yet. Build the report you want on the Reports tab first to see what the filters produce, then recreate it here as a recurring one.");
		}

		for (const schedule of schedules) {
			const card = listGroup.content.createDiv({ cls: "fp-schedule-card" + (schedule.enabled ? "" : " is-off") });

			const head = card.createDiv({ cls: "fp-schedule-head" });
			const title = head.createDiv({ cls: "fp-schedule-title" });
			title.createSpan({ cls: "fp-schedule-name", text: schedule.name });
			title.createDiv({ cls: "fp-schedule-sub", text: describeSchedule(schedule) });

			const actions = head.createDiv({ cls: "fp-schedule-actions" });
			const toggle = actions.createEl("button", { cls: "fp-toggle" + (schedule.enabled ? " is-on" : "") });
			toggle.setAttribute("role", "switch");
			toggle.setAttribute("aria-checked", String(schedule.enabled));
			toggle.setAttribute("aria-label", schedule.enabled ? "Pause this schedule" : "Resume this schedule");
			toggle.createSpan({ cls: "fp-toggle-knob" });
			toggle.addEventListener("click", async () => {
				schedule.enabled = !schedule.enabled;
				await this.plugin.saveSettings();
				this.renderBody();
			});

			const edit = actions.createEl("button", { cls: "fp-btn fp-btn-secondary fp-btn-tiny", text: "Edit" });
			edit.addEventListener("click", () => new ScheduleEditModal(this.app, this.plugin, schedule, () => this.renderBody()).open());

			const send = actions.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-tiny", text: "Send now" });
			send.addEventListener("click", async () => {
				send.disabled = true;
				send.setText("Sending…");
				try {
					const outcome = await runSchedule(this.plugin, schedule);
					// A manual send records its outcome but never advances the period — otherwise testing
					// a schedule would silently consume the delivery it was meant to be testing.
					schedule.lastRun = { at: new Date().toISOString(), periodKey: outcome.period.key, ok: outcome.ok, detail: describeOutcome(outcome) };
					await this.plugin.saveSettings();
					new Notice(`${outcome.ok ? "Sent" : "Failed"}: ${describeOutcome(outcome)}`, outcome.ok ? 8000 : 15000);
				} catch (e) {
					new Notice(`Couldn't send: ${e instanceof Error ? e.message : String(e)}`, 12000);
				} finally {
					this.renderBody();
				}
			});

			const remove = actions.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-tiny fp-btn-danger-text", text: "Delete" });
			remove.addEventListener("click", async () => {
				settings.reportSchedules = (settings.reportSchedules ?? []).filter((s) => s.id !== schedule.id);
				await this.plugin.saveSettings();
				new Notice(`Schedule "${schedule.name}" deleted.`);
				this.renderBody();
			});

			// The status line. Without this, a schedule whose API key was revoked in March looks
			// identical to one that has been working perfectly all year.
			const status = card.createDiv({ cls: "fp-schedule-status" });
			const next = nextDueAt(schedule.cadence);
			if (!schedule.enabled) {
				status.createDiv({ cls: "fp-schedule-status-line", text: "Paused — nothing will be sent." });
			} else if (isDue(schedule)) {
				status.createDiv({
					cls: "fp-schedule-status-line is-due",
					text: `Due now for ${completedPeriod(schedule.cadence).label} — it will go out on the next launch, or press Send now.`,
				});
			} else {
				status.createDiv({
					cls: "fp-schedule-status-line",
					text: `Next report covers ${completedPeriod(schedule.cadence, next).label}, once ${next.toLocaleDateString()} has passed.`,
				});
			}
			if (schedule.lastRun) {
				const run = schedule.lastRun;
				status.createDiv({
					cls: "fp-schedule-status-line " + (run.ok ? "is-ok" : "is-bad"),
					text: `Last run ${new Date(run.at).toLocaleString()} for ${run.periodKey} — ${run.detail}`,
				});
			} else {
				status.createDiv({ cls: "fp-schedule-status-line", text: "Never run yet." });
			}
		}

		// ---- credentials -----------------------------------------------------
		const emailGroup = this.group(content, {
			icon: "mail",
			title: "Email (Resend)",
			subtitle: "Delivery over the Resend HTTP API.",
			chip: settings.delivery.email?.apiKey ? { text: "key set", tone: "ok" } : { text: "not set up", tone: "pending" },
			collapsibleId: "delivery-email",
			defaultExpanded: !settings.delivery.email?.apiKey,
		});
		this.note(
			emailGroup.content,
			"Resend needs a free account and a verified sender domain. The API key is stored in this vault's plugin data.json in plain text, exactly like the Claude key — anyone with the vault can read it."
		);
		new Setting(emailGroup.content)
			.setName("API key")
			.setDesc("From resend.com → API Keys. Sending permission is enough.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("re_...")
					.setValue(settings.delivery?.email?.apiKey ?? "")
					.onChange(async (value) => {
						settings.delivery!.email = { ...settings.delivery!.email, apiKey: value.trim() };
						await this.plugin.saveSettings();
					});
			});
		new Setting(emailGroup.content)
			.setName("From address")
			.setDesc('Must be on a domain verified with Resend, e.g. "Finance <reports@yourdomain.com>".')
			.addText((t) =>
				t
					.setPlaceholder("Finance <reports@yourdomain.com>")
					.setValue(settings.delivery?.email?.from ?? "")
					.onChange(async (value) => {
						settings.delivery!.email = { ...settings.delivery!.email, from: value.trim() };
						await this.plugin.saveSettings();
					})
			);
		// Lives with the email credentials rather than down in the test-report panel: it is a property
		// of this channel, and both tests need it.
		new Setting(emailGroup.content)
			.setName("Test recipient")
			.setDesc("Where the two test buttons send. Remembered, so it isn't retyped every attempt.")
			.addText((t) =>
				t
					.setPlaceholder("you@example.com")
					.setValue(settings.delivery?.email?.testRecipient ?? "")
					.onChange(async (value) => {
						settings.delivery!.email = { ...settings.delivery!.email, testRecipient: value.trim() };
						await this.plugin.saveSettings();
					})
			);
		// The counterpart to Telegram's ping, which email was missing. Worth having separately from the
		// full report send: a rejected key or an unverified sender domain are the two things that go
		// wrong first, and finding them shouldn't cost a PDF render and a multi-megabyte attachment.
		new Setting(emailGroup.content)
			.setName("Test the connection")
			.setDesc("Sends a short email with no attachment. Proves the key, the sender domain and the address — and nothing else.")
			.addButton((b) =>
				b.setButtonText("Send test").onClick(async () => {
					const to = (this.plugin.settings.delivery?.email?.testRecipient ?? "").trim();
					if (!to) {
						new Notice("Add a test recipient above first.");
						return;
					}
					b.setButtonText("Sending…").setDisabled(true);
					const result = await sendEmail(this.plugin.settings.delivery?.email ?? {}, {
						to: [to],
						subject: "Manage My Finance — connection test",
						html: "<p>Manage My Finance is connected. Scheduled reports will arrive at this address.</p>",
						attachments: [],
					});
					new Notice(result.ok ? `Email connected — sent to ${to}.` : `Email test failed: ${result.detail}`, result.ok ? 6000 : 14000);
					b.setButtonText("Send test").setDisabled(false);
				})
			);
		const tgGroup = this.group(content, {
			icon: "send",
			title: "Telegram",
			subtitle: "Delivery to a chat via your own bot.",
			chip: settings.delivery.telegram?.botToken ? { text: "bot set", tone: "ok" } : { text: "not set up", tone: "pending" },
			collapsibleId: "delivery-telegram",
			defaultExpanded: !settings.delivery.telegram?.botToken,
		});
		this.note(
			tgGroup.content,
			"Create a bot by messaging @BotFather on Telegram; it gives you a token. Then send your new bot any message and open https://api.telegram.org/bot<TOKEN>/getUpdates in a browser to find your chat id. Both are stored in plain text in this vault's data.json."
		);
		new Setting(tgGroup.content)
			.setName("Bot token")
			.setDesc("From @BotFather.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("123456:ABC-DEF...")
					.setValue(settings.delivery?.telegram?.botToken ?? "")
					.onChange(async (value) => {
						settings.delivery!.telegram = { ...settings.delivery!.telegram, botToken: value.trim() };
						await this.plugin.saveSettings();
					});
			});
		new Setting(tgGroup.content)
			.setName("Chat id")
			.setDesc("Your own user id for a direct message, or a negative number for a group.")
			.addText((t) =>
				t
					.setPlaceholder("123456789")
					.setValue(settings.delivery?.telegram?.chatId ?? "")
					.onChange(async (value) => {
						settings.delivery!.telegram = { ...settings.delivery!.telegram, chatId: value.trim() };
						await this.plugin.saveSettings();
					})
			);
		new Setting(tgGroup.content)
			.setName("Test the connection")
			.setDesc("Sends a short text message to the chat above. Proves the token and chat id, and nothing else.")
			.addButton((b) =>
				b.setButtonText("Send test").onClick(async () => {
					b.setButtonText("Sending…").setDisabled(true);
					const result = await sendTelegram(settings.delivery?.telegram ?? {}, {
						text: "Manage My Finance is connected. Scheduled reports will arrive here.",
						attachments: [],
					});
					new Notice(result.ok ? "Telegram connected." : `Telegram test failed: ${result.detail}`, result.ok ? 6000 : 12000);
					b.setButtonText("Send test").setDisabled(false);
				})
			);

		this.renderTestDelivery(content);
	}

	/**
	 * One place to send a real report on demand, to either channel, at a size you choose.
	 *
	 * Shared rather than a button per channel: the two pickers are the same question both times, and
	 * the thing being tested — build, render, attach, transmit — is identical up to the last step.
	 */
	private renderTestDelivery(content: HTMLElement): void {
		const settings = this.plugin.settings;
		settings.delivery ??= {};
		const test = (settings.delivery.test ??= {});
		const cadence: Exclude<Cadence, "weekly"> = test.cadence ?? "monthly";
		const detail: ReportDetail = test.detail ?? "summary";

		const group = this.group(content, {
			icon: "flask-conical",
			title: "Send a test report",
			subtitle: "Runs the whole pipeline — report, PDF, attachment, transport — right now.",
			collapsibleId: "delivery-test",
			defaultExpanded: true,
		});
		this.note(
			group.content,
			"Uses a period that is still in progress, so the numbers are ones you'll recognise. Nothing about your schedules is touched — no period is consumed, no run is recorded."
		);

		const period = currentPeriod(cadence);
		new Setting(group.content)
			.setName("Period")
			.setDesc(`Currently ${period.label} — ${period.from} to ${period.to}.`)
			.addDropdown((d) => {
				d.addOption("monthly", "This month");
				d.addOption("quarterly", "This quarter");
				d.addOption("yearly", "This year");
				d.setValue(cadence).onChange(async (value) => {
					settings.delivery!.test = { ...settings.delivery!.test, cadence: value as Exclude<Cadence, "weekly"> };
					await this.plugin.saveSettings();
					this.renderBody();
				});
			});

		new Setting(group.content)
			.setName("Detail")
			.setDesc(DETAIL_HINT[detail])
			.addDropdown((d) => {
				(["summary", "standard", "full"] as ReportDetail[]).forEach((value) => d.addOption(value, DETAIL_LABEL[value]));
				d.setValue(detail).onChange(async (value) => {
					settings.delivery!.test = { ...settings.delivery!.test, detail: value as ReportDetail };
					await this.plugin.saveSettings();
					this.renderBody();
				});
			});

		const to = (settings.delivery.email?.testRecipient ?? "").trim();
		const emailReady = !!settings.delivery.email?.apiKey && !!settings.delivery.email?.from && !!to;
		new Setting(group.content)
			.setName("Send to email")
			.setDesc(emailReady ? `Goes to ${to}.` : "Needs a Resend API key, a sender address and a test recipient — all above.")
			.addButton((b) => {
				b.setButtonText("Send").setDisabled(!emailReady);
				b.onClick(async () => {
					b.setButtonText("Sending…").setDisabled(true);
					await this.runTestReport({ email: [to] }, cadence, detail);
					b.setButtonText("Send").setDisabled(false);
				});
			});

		const telegramReady = !!settings.delivery.telegram?.botToken && !!settings.delivery.telegram?.chatId;
		new Setting(group.content)
			.setName("Send to Telegram")
			.setDesc(telegramReady ? "Goes to the chat configured above." : "Add a bot token and chat id above first.")
			.addButton((b) => {
				b.setButtonText("Send").setDisabled(!telegramReady);
				b.onClick(async () => {
					b.setButtonText("Sending…").setDisabled(true);
					await this.runTestReport({ telegram: true }, cadence, detail);
					b.setButtonText("Send").setDisabled(false);
				});
			});
	}

	/**
	 * Runs the full delivery pipeline once, now, and reports exactly what happened.
	 *
	 * Goes through the same deliverReport() a schedule does rather than a simplified version, because
	 * the point of a test button is to fail in the same places the real thing would — an unverified
	 * sender domain, a wrong chat id, an Electron render that doesn't work on this machine. A test
	 * that takes a shortcut past those is a test that passes and tells you nothing.
	 */
	private async runTestReport(
		channels: { email?: string[]; telegram?: boolean },
		cadence: Exclude<Cadence, "weekly">,
		detail: ReportDetail
	): Promise<void> {
		try {
			const outcome = await sendTestReport(this.plugin, channels, { cadence, detail });
			const rows = outcome.result.count;
			new Notice(
				`${outcome.ok ? "Sent" : "Failed"} — ${outcome.period.label}, ${rows} transaction${rows === 1 ? "" : "s"}.\n${describeOutcome(outcome)}`,
				outcome.ok ? 10000 : 15000
			);
			// The outcome is worth keeping visible: a schedule list that shows every real run and
			// nothing about the test you just ran makes the test the one result you have to remember.
			if (!outcome.ok) console.error("[Manage My Finance] test report failed", outcome);
		} catch (e) {
			new Notice(`Couldn't send the test report: ${e instanceof Error ? e.message : String(e)}`, 15000);
		}
	}

	private renderData(content: HTMLElement): void {
		const store = this.plugin.store;
		const exports = this.group(content, {
			icon: "hard-drive-download",
			title: "Export",
			subtitle: "Write a copy of this portfolio into your vault.",
			chip: {
				text: `${store.transactions.length} transaction${store.transactions.length === 1 ? "" : "s"}`,
				tone: store.transactions.length > 0 ? "ok" : "pending",
			},
		});

		new Setting(exports.content)
			.setName("Full backup (.json)")
			.setDesc("Everything — accounts, categories, rules, subscriptions, cards, budgets and every transaction — in one file that can be imported back.")
			.addButton((b) =>
				b
					.setButtonText("Export backup")
					.setCta()
					.onClick(async () => {
						try {
							const path = await writeExport(
								this.app,
								this.plugin.settings.dataFolder,
								"backup",
								"json",
								serializeBackup(buildBackup(this.plugin))
							);
							new Notice(`Backup written to ${path}`);
						} catch (err) {
							new Notice(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
						}
					})
			);

		new Setting(exports.content)
			.setName("Transactions (.csv)")
			.setDesc("The ledger as one flat spreadsheet, with account and category names resolved. For Excel or Numbers — import it back with the import wizard, not the backup importer.")
			.addButton((b) =>
				b.setButtonText("Export CSV").onClick(async () => {
					try {
						const path = await writeExport(this.app, this.plugin.settings.dataFolder, "transactions", "csv", transactionsToCsv(this.plugin));
						new Notice(`Transactions written to ${path}`);
					} catch (err) {
						new Notice(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
					}
				})
			);

		this.note(
			exports.content,
			"Exports are written to an \u201Cexports\u201D folder beside your data, so they sync and back up with the rest of the vault rather than landing outside it."
		);

		const restore = this.group(content, {
			icon: "hard-drive-upload",
			title: "Import a backup",
			subtitle: "Restore a .json backup into this portfolio.",
		});
		new Setting(restore.content)
			.setName("Restore from backup")
			.setDesc("You'll see what's in the file, and pick merge or replace, before anything is written.")
			.addButton((b) =>
				b
					.setButtonText("Import backup")
					.setCta()
					.onClick(() => new ImportBackupModal(this.app, this.plugin, () => this.renderBody()).open())
			);
		this.note(
			restore.content,
			"Merge adds only what this portfolio doesn't already have, matched on id — existing records win, so a restore never quietly overwrites something you've since edited. Replace discards everything here first."
		);

		const danger = this.group(content, {
			icon: "alert-triangle",
			title: "Danger zone",
			subtitle: "Clears this portfolio completely. Other portfolios are not affected.",
			danger: true,
		});
		new Setting(danger.content)
			.setName("Delete all data")
			.setDesc("Every account, transaction, subscription, card and rule in this portfolio.")
			.addButton((b) =>
				b
					.setButtonText("Delete all data")
					.setWarning()
					.onClick(() => new DeleteAllDataModal(this.app, this.plugin, () => this.renderBody()).open())
			);
		this.note(
			danger.content,
			"You'll be offered a backup first and asked to type the portfolio's name. Categories are reset to the built-in defaults rather than emptied, so the portfolio still works afterwards."
		);
	}

	private renderAccounts(content: HTMLElement): void {
		const store = this.plugin.store;
		const accounts = this.group(content, {
			icon: "landmark",
			title: "Accounts",
			subtitle: "Bank and broker accounts tracked in your ledger.",
			// No accounts means nothing can be imported, so an empty roster is a warning, not a neutral state.
			chip:
				store.accounts.length > 0
					? { text: `${store.accounts.length} account${store.accounts.length === 1 ? "" : "s"}`, tone: "ok" }
					: { text: "none yet", tone: "warn" },
		});
		const card = accounts.content;

		if (store.accounts.length === 0) {
			this.note(card, "No accounts yet — add one below. An import needs somewhere to put its rows.");
		} else {
			store.accounts.forEach((acc) => {
				const desc = document.createDocumentFragment();
				desc.append(`${ACCOUNT_TYPE_META[acc.type].label} · ${acc.currency}`);
				if (acc.iban) {
					desc.append(" · ");
					const ibanSpan = document.createElement("span");
					ibanSpan.addClass("fp-iban");
					ibanSpan.setText(acc.iban);
					desc.append(ibanSpan);
				}
				new Setting(card)
					.setName(acc.name)
					.setDesc(desc)
					.addButton((b) =>
						b
							.setIcon("pencil")
							.setTooltip("Edit name, type, currency, IBAN and balance")
							.onClick(() => new EditAccountModal(this.app, this.plugin, acc, () => this.renderBody()).open())
					)
					.addButton((b) =>
						b.setIcon("x").setTooltip("Remove").onClick(async () => {
							store.accounts = store.accounts.filter((a) => a.id !== acc.id);
							await store.saveAccounts();
							this.renderBody();
						})
					);
			});
		}

		card.createDiv({ cls: "fp-sgroup-label", text: "Add an account" });
		let newAccountName = "";
		let newAccountType: AccountType = "debit";
		let newAccountIban = "";
		const addAccount = new Setting(card)
			.setName("Add account")
			.setDesc("Name, IBAN and type.")
			.addText((t) => t.setPlaceholder("Account name").onChange((v) => (newAccountName = v)))
			.addText((t) => t.setPlaceholder("IBAN (optional)").onChange((v) => (newAccountIban = v)))
			.addDropdown((d) => {
				(Object.keys(ACCOUNT_TYPE_META) as AccountType[]).forEach((type) => d.addOption(type, ACCOUNT_TYPE_META[type].label));
				d.onChange((v) => (newAccountType = v as AccountType));
			})
			.addButton((b) =>
				b.setButtonText("Add").onClick(async () => {
					if (!newAccountName.trim()) return;
					store.accounts.push({
						id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
						name: newAccountName.trim(),
						type: newAccountType,
						currency: "EUR",
						openingBalance: 0,
						iban: newAccountIban.trim() || undefined,
					});
					await store.saveAccounts();
					this.renderBody();
				})
			);
		this.help(
			addAccount,
			"IBAN is optional. Set it and a combined multi-account CSV or Excel export attributes each row to the right account by itself, instead of dumping everything into one."
		);
	}

	/**
	 * One category row, laid out as an explicit grid: expand · name · colour · icon · move · delete · count.
	 *
	 * Built by hand rather than with Obsidian's `Setting`, because `Setting` right-aligns whatever
	 * controls you give it — so a row with a move dropdown and a row without ended up different widths
	 * and no two columns lined up. Every row here emits every cell, empty where a control doesn't
	 * apply, which is what actually guarantees the columns align.
	 */
	private renderCategoryRow(parent: HTMLElement, cat: Category, opts: { expanded?: boolean; childCount?: number } = {}): void {
		const store = this.plugin.store;
		const isSub = !!cat.parentId;
		const childCount = opts.childCount ?? 0;

		const row = parent.createDiv({ cls: "fp-cat-row" + (isSub ? " is-sub" : "") });

		// 1 — expand. Always present so the following columns start at the same x on every row.
		const expand = row.createDiv({ cls: "fp-cat-cell fp-cat-expand" + (childCount === 0 ? " is-empty" : "") });
		if (childCount > 0) {
			icon(expand, opts.expanded ? "chevron-down" : "chevron-right");
			expand.setAttribute("aria-label", opts.expanded ? "Collapse" : "Expand");
			expand.addEventListener("click", () => {
				this.categoryExpanded.set(cat.id, !opts.expanded);
				this.renderBody();
			});
		}

		// 2 — name
		const name = row.createEl("input", { cls: "fp-cat-name", type: "text" });
		name.value = cat.name;
		name.addEventListener("blur", async () => {
			const v = name.value.trim();
			if (!v || v === cat.name) {
				name.value = cat.name;
				return;
			}
			cat.name = v;
			await store.saveCategories();
		});

		// 3 — colour
		const colour = row.createEl("input", { cls: "fp-cat-colour", type: "color" });
		colour.value = cat.color;
		colour.setAttribute("aria-label", `Colour for ${cat.name}`);
		colour.addEventListener("change", async () => {
			cat.color = colour.value;
			await store.saveCategories();
		});

		// 4 — icon
		const iconInput = row.createEl("input", { cls: "fp-cat-icon-input", type: "text", attr: { placeholder: "Icon" } });
		iconInput.value = cat.icon;
		iconInput.addEventListener("blur", async () => {
			cat.icon = iconInput.value.trim() || cat.icon;
			await store.saveCategories();
		});

		// 5 — move. Only offered where there's somewhere legal to go: a primary that already has
		// subcategories can't itself become one without making the tree three levels deep (canReparent).
		// The cell is emitted either way so the delete button stays in its column.
		const targets = reparentTargets(store.categories, cat.id);
		const canPromote = canReparent(store.categories, cat.id, undefined);
		const moveCell = row.createDiv({ cls: "fp-cat-cell fp-cat-move" });
		if (targets.length > 0 || canPromote) {
			const select = moveCell.createEl("select");
			select.createEl("option", { text: isSub ? "Move under…" : "Nest under…", value: "" });
			if (canPromote) select.createEl("option", { text: "↑ Make top-level", value: "__top" });
			targets.forEach((p) => select.createEl("option", { text: `→ ${p.name}`, value: p.id }));
			select.value = "";
			select.addEventListener("change", async () => {
				if (!select.value) return;
				const newParentId = select.value === "__top" ? undefined : select.value;
				store.categories = reparented(store.categories, cat.id, newParentId);
				await store.saveCategories();
				const target = newParentId ? store.categories.find((c) => c.id === newParentId) : undefined;
				new Notice(target ? `Moved "${cat.name}" under "${target.name}"` : `"${cat.name}" is now a top-level category`);
				this.plugin.refreshViews();
				this.renderBody();
			});
		}

		// 6 — kind. Only offered on primaries: a budget's direction is a property of the whole
		// envelope, and a subcategory that disagreed with its parent would make the rollup nonsense.
		// Income categories read their budget as a target to reach rather than a ceiling to stay under.
		if (!isSub) {
			const kindBtn = row.createEl("button", { cls: "fp-cat-kind" + (cat.kind === "income" ? " is-income" : "") });
			icon(kindBtn, cat.kind === "income" ? "trending-up" : "trending-down");
			kindBtn.setAttribute(
				"title",
				cat.kind === "income"
					? "Income category — its budget is a target to reach. Click to make it an expense category."
					: "Expense category — its budget is a limit to stay under. Click to make it an income category."
			);
			kindBtn.addEventListener("click", async () => {
				cat.kind = cat.kind === "income" ? undefined : "income";
				await store.saveCategories();
				this.plugin.refreshViews();
				this.renderBody();
			});
		}

		// 7 — delete
		const del = row.createEl("button", { cls: "fp-cat-delete", attr: { "aria-label": `Delete ${cat.name}` } });
		icon(del, "trash-2");
		del.setAttribute("title", "Delete");
		del.addEventListener("click", () =>
			new DeleteCategoryModal(this.app, this.plugin, cat, () => {
				this.plugin.refreshViews();
				this.renderBody();
			}).open()
		);

		// 8 — subcategory count
		const count = row.createDiv({ cls: "fp-cat-cell fp-cat-count" });
		if (childCount > 0) count.createSpan({ cls: "fp-chip", text: String(childCount) });
	}

	/** The "add" row, sharing the same grid so its fields sit under the columns they add to. */
	private renderAddCategoryRow(
		parent: HTMLElement,
		opts: { placeholder: string; defaultColour: string; defaultIcon: string; onAdd: (v: { name: string; colour: string; icon: string }) => Promise<void> }
	): void {
		const row = parent.createDiv({ cls: "fp-cat-row is-add" });
		row.createDiv({ cls: "fp-cat-cell fp-cat-expand is-empty" });

		const name = row.createEl("input", { cls: "fp-cat-name", type: "text", attr: { placeholder: opts.placeholder } });
		const colour = row.createEl("input", { cls: "fp-cat-colour", type: "color" });
		colour.value = opts.defaultColour;
		const iconInput = row.createEl("input", { cls: "fp-cat-icon-input", type: "text", attr: { placeholder: "Icon" } });
		iconInput.value = opts.defaultIcon;

		const addCell = row.createDiv({ cls: "fp-cat-cell fp-cat-move" });
		const addBtn = addCell.createEl("button", { cls: "fp-btn fp-btn-primary", text: "Add" });
		const submit = async (): Promise<void> => {
			if (!name.value.trim()) return;
			await opts.onAdd({ name: name.value.trim(), colour: colour.value, icon: iconInput.value.trim() || opts.defaultIcon });
		};
		addBtn.addEventListener("click", () => void submit());
		name.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") void submit();
		});

		row.createDiv({ cls: "fp-cat-cell" });
		row.createDiv({ cls: "fp-cat-cell" });
	}

	private renderCategories(content: HTMLElement): void {
		const store = this.plugin.store;
		const primaries = primaryCategories(store.categories);
		const secondaryCount = store.categories.length - primaries.length;
		const group = this.group(content, {
			icon: "tag",
			title: "Categories",
			subtitle: "Labels used to classify transactions in the ledger.",
			chip:
				primaries.length > 0
					? {
							text: `${primaries.length} categor${primaries.length === 1 ? "y" : "ies"}${secondaryCount ? `, ${secondaryCount} sub` : ""}`,
							tone: "ok",
					  }
					: { text: "none yet", tone: "warn" },
		});
		const card = group.content;
		this.note(
			card,
			"Each category can have its own secondary categories underneath it — Car → Fuel, Parking, Car Wash — for finer-grained insight without cluttering the top level. Use the move dropdown on a row to nest it under a different parent, or promote it back to the top."
		);

		if (primaries.length === 0) {
			this.note(card, "No categories yet — add one below.");
		} else {
			const table = card.createDiv({ cls: "fp-cat-table" });
			const head = table.createDiv({ cls: "fp-cat-row is-head" });
			["", "Name", "", "Icon", "Move", "", ""].forEach((label) =>
				head.createDiv({ cls: "fp-cat-cell fp-cat-head-cell", text: label })
			);

			primaries.forEach((cat) => {
				const secondaries = secondaryCategoriesOf(store.categories, cat.id);
				const expanded = this.categoryExpanded.get(cat.id) ?? false;
				this.renderCategoryRow(table, cat, { expanded, childCount: secondaries.length });

				if (!expanded) return;
				// Subcategories share the same grid, so every column still lines up; the nesting is
				// shown with a left accent rather than an indent that would shift the columns.
				secondaries.forEach((sub) => this.renderCategoryRow(table, sub));
				this.renderAddCategoryRow(table, {
					placeholder: `New subcategory under ${cat.name}`,
					defaultColour: cat.color,
					defaultIcon: cat.icon,
					onAdd: async ({ name, colour, icon: iconName }) => {
						store.categories.push({
							id: `cat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
							name,
							color: colour,
							icon: iconName,
							aliases: [],
							parentId: cat.id,
						});
						await store.saveCategories();
						this.renderBody();
					},
				});
			});
		}

		card.createDiv({ cls: "fp-sgroup-label", text: "Add a category" });
		const addTable = card.createDiv({ cls: "fp-cat-table" });
		this.renderAddCategoryRow(addTable, {
			placeholder: "New category name",
			defaultColour: "#64748b",
			defaultIcon: "tag",
			onAdd: async ({ name, colour, icon: iconName }) => {
				store.categories.push({
					id: `cat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
					name,
					color: colour,
					icon: iconName,
					aliases: [],
				});
				await store.saveCategories();
				this.renderBody();
			},
		});
	}

	/** Budget warnings, renewal reminders, and writing reports into the vault. */
	private renderNotificationsAndReports(content: HTMLElement): void {
		const settings = this.plugin.settings;

		const alerts = this.group(content, {
			icon: "bell",
			title: "Alerts",
			subtitle: "What this plugin will interrupt you about, and when.",
			chip: settings.budgetAlerts === false ? { text: "budget alerts off", tone: "pending" } : { text: "on", tone: "ok" },
		});

		new Setting(alerts.content)
			.setName("Warn about budgets")
			.setDesc("One notice when you open the vault, listing the categories closest to (or past) their limit this month.")
			.addToggle((t) =>
				t.setValue(settings.budgetAlerts !== false).onChange(async (value) => {
					settings.budgetAlerts = value;
					await this.plugin.saveSettings();
					this.renderBody();
				})
			);

		new Setting(alerts.content)
			.setName("Warn at")
			.setDesc("How much of a budget has to be spent before it's worth mentioning. 0.9 means 90%.")
			.addText((t) =>
				t.setValue(String(settings.budgetAlertThreshold ?? 0.9)).onChange(async (v) => {
					const n = parseMoney(v);
					if (n !== undefined && n > 0 && n <= 2) {
						settings.budgetAlertThreshold = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(alerts.content)
			.setName("Remind about renewals")
			.setDesc("Notifies about subscriptions renewing in the next few days — the whole point of tracking a due date.")
			.addToggle((t) =>
				t.setValue(settings.subscriptionReminders !== false).onChange(async (value) => {
					settings.subscriptionReminders = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(alerts.content)
			.setName("Days ahead")
			.setDesc("How far in advance a renewal reminder fires.")
			.addText((t) =>
				t.setValue(String(settings.subscriptionReminderDays ?? 3)).onChange(async (v) => {
					const n = parseMoney(v);
					if (n !== undefined && n >= 0) {
						settings.subscriptionReminderDays = n;
						await this.plugin.saveSettings();
					}
				})
			);

		const reports = this.group(content, {
			icon: "file-text",
			title: "Reports",
			subtitle: "Write your figures into the vault as ordinary notes.",
		});

		new Setting(reports.content)
			.setName("This month")
			.setDesc("Income, expenses, spending by category and budget performance, with frontmatter Dataview can query.")
			.addButton((b) => b.setButtonText("Write it").setCta().onClick(() => void this.plugin.writeMonthlyReport()));

		new Setting(reports.content)
			.setName("This year")
			.setDesc("The same figures for the year, month by month, plus planned-vs-actual for every category.")
			.addButton((b) => b.setButtonText("Write it").onClick(() => void this.plugin.writeYearlyReport()));

		new Setting(reports.content)
			.setName("Net worth")
			.setDesc("Current net worth, the year-by-year walk behind it, and every account's balance.")
			.addButton((b) => b.setButtonText("Write it").onClick(() => void this.plugin.writeNetWorthReport()));

		this.note(
			reports.content,
			"Reports are written to the reports/ folder inside this portfolio's data folder, one note per period, overwritten on regeneration. To embed live figures in a note of your own instead, use a ```finance code block — see the README."
		);
	}

	private renderProjections(content: HTMLElement): void {
		this.renderNotificationsAndReports(content);
		const fi = this.group(content, {
			icon: "trending-up",
			title: "FI projections",
			subtitle: "Assumptions behind your financial-independence number and timeline.",
			chip: { text: `${this.plugin.settings.fiMultiplier}×`, tone: "ok" },
		});

		const multiplier = new Setting(fi.content)
			.setName("FI expense multiplier")
			.setDesc("Annual expenses × this = your FI number.")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.fiMultiplier)).onChange(async (v) => {
					const n = parseMoney(v);
					if (n !== undefined && n > 0) {
						this.plugin.settings.fiMultiplier = n;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
						fi.setChip(`${n}×`, "ok");
					}
				})
			);
		this.help(
			multiplier,
			"25 corresponds to a 4% withdrawal rate — the rate the Trinity study found a portfolio could sustain over a 30-year retirement. A lower multiplier assumes you can safely withdraw more each year, a higher one less."
		);

		const returns = new Setting(fi.content)
			.setName("Expected annual return")
			.setDesc("A fraction, not a percentage — 0.07 means 7%.")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.expectedReturn)).onChange(async (v) => {
					const n = parseMoney(v);
					if (n !== undefined && n >= 0) {
						this.plugin.settings.expectedReturn = n;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					}
				})
			);
		this.help(
			returns,
			"Used only to project years-to-FI, by compounding your current net worth and monthly contributions forward. It is an assumption you supply, not a forecast this plugin makes."
		);
	}

	private renderCurrency(content: HTMLElement): void {
		this.renderBaseCurrency(content);
		const rates = this.plugin.settings.exchangeRates ?? {};
		const setCount = Object.keys(rates).filter((code) => CURRENCIES.includes(code) && rates[code] && rates[code] !== 1).length;
		const rateGroup = this.group(content, {
			icon: "coins",
			title: "Exchange rates",
			subtitle: `Manual conversion rates into ${BASE_CURRENCY}, one per currency.`,
			chip: setCount > 0 ? { text: `${setCount} set`, tone: "ok" } : { text: "none set", tone: "pending" },
			collapsibleId: "currency-rates",
			defaultExpanded: false,
			headerAction: (right: HTMLElement) => {
				const btn = right.createEl("button", { cls: "fp-btn fp-btn-secondary" });
				icon(btn, "download-cloud");
				const label = btn.createSpan({ text: "Fetch" });
				btn.addEventListener("click", async () => {
					label.setText("Fetching…");
					btn.setAttribute("disabled", "true");
					try {
						const fetched = await fetchLatestRates();
						this.plugin.settings.exchangeRates = { ...this.plugin.settings.exchangeRates, ...fetched };
						await this.plugin.saveSettings();
						new Notice("Exchange rates updated.");
						this.renderBody();
					} catch (e) {
						new Notice(`Couldn't fetch exchange rates: ${e instanceof Error ? e.message : String(e)}`);
						label.setText("Fetch");
						btn.removeAttribute("disabled");
					}
				});
			},
		});

		const card = rateGroup.content;
		this.note(
			card,
			`Used only to combine subscriptions and totals that aren't already in ${BASE_CURRENCY}. Type your own, or fetch today's from api.frankfurter.dev — free, no key, no account data sent, and the only network request this plugin ever makes.`
		);

		const grid = card.createDiv({ cls: "fp-currency-grid" });
		CURRENCIES.filter((code) => code !== BASE_CURRENCY).forEach((code) => {
			const tile = grid.createDiv({ cls: "fp-currency-tile" });
			const label = tile.createDiv({ cls: "fp-currency-tile-label" });
			label.createDiv({ cls: "fp-currency-tile-code", text: code });
			label.createDiv({ cls: "fp-currency-tile-hint", text: `= ? ${BASE_CURRENCY}` });
			const input = tile.createEl("input", {
				type: "text",
				attr: { placeholder: `1${decimalSeparator()}00`, inputmode: "decimal", autocomplete: "off" },
			});
			input.value = formatMoneyForInput(rates[code]);
			input.addEventListener("blur", async () => {
				const n = parseMoney(input.value);
				const settings = this.plugin.settings;
				settings.exchangeRates ??= {};
				if (input.value.trim() === "" || n === undefined || n <= 0) {
					delete settings.exchangeRates[code];
				} else {
					settings.exchangeRates[code] = n;
				}
				input.value = formatMoneyForInput(settings.exchangeRates[code]);
				await this.plugin.saveSettings();
				// Repaint the chip rather than the panel: a full re-render mid-edit would collapse the
				// grid the user is still tabbing through.
				const nowSet = Object.keys(settings.exchangeRates).filter(
					(c) => CURRENCIES.includes(c) && settings.exchangeRates![c] && settings.exchangeRates![c] !== 1
				).length;
				rateGroup.setChip(nowSet > 0 ? `${nowSet} set` : "none set", nowSet > 0 ? "ok" : "pending");
			});
			input.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") input.blur();
			});
		});
	}

	/**
	 * Which currency every total is expressed in.
	 *
	 * Until this existed, EUR wasn't a setting so much as an assumption baked through the whole app —
	 * and worse, transactions in other currencies were summed into euro totals unconverted, as if a
	 * dollar were a euro. Both halves are fixed together: this picks the currency you read everything
	 * in, and the rate table below converts everything else into it.
	 */
	private renderBaseCurrency(content: HTMLElement): void {
		const settings = this.plugin.settings;
		const current = settings.baseCurrency ?? BASE_CURRENCY;
		const foreign = new Set(
			this.plugin.store.transactions.map((t) => (t.currency || current).toUpperCase()).filter((code) => code !== current)
		);

		const group = this.group(content, {
			icon: "globe",
			title: "Base currency",
			subtitle: "The currency net worth, budgets and every total are shown in.",
			chip: { text: current, tone: "ok" },
		});

		new Setting(group.content)
			.setName("Base currency")
			.setDesc("Amounts in any other currency are converted into this one using the rates below.")
			.addDropdown((d) => {
				CURRENCIES.forEach((code) => d.addOption(code, code));
				d.setValue(current).onChange(async (value) => {
					settings.baseCurrency = value;
					await this.plugin.saveSettings();
					this.plugin.refreshViews();
					this.renderBody();
				});
			});

		if (foreign.size > 0) {
			const missing = Array.from(foreign).filter((code) => {
				const rate = settings.exchangeRates?.[code];
				return !(typeof rate === "number" && rate > 0);
			});
			this.note(
				group.content,
				missing.length > 0
					? `Your ledger holds transactions in ${Array.from(foreign).join(", ")}. No rate is set for ${missing.join(
							", "
					  )}, so those amounts are currently counted one-for-one — set a rate below to convert them properly.`
					: `Your ledger holds transactions in ${Array.from(foreign).join(", ")}, all of which have a rate set.`
			);
		}
	}

	private renderImport(content: HTMLElement): void {
		const imports = this.group(content, {
			icon: "download",
			title: "Import transactions",
			subtitle: "Bring in a bank or broker CSV or Excel export.",
		});
		new Setting(imports.content)
			.setName("Start import")
			.setDesc("Opens the import wizard.")
			.addButton((b) =>
				b
					.setButtonText("Import")
					.setCta()
					.onClick(() => openImportWizard(this.plugin))
			);
		this.note(
			imports.content,
			"ING, Trade Republic, Revolut, bunq and N26 exports are recognised automatically, as are CAMT.053, MT940, OFX/QFX and QIF statement files. Anything else gets a column-mapping step with auto-guessed defaults, so it imports without needing a dedicated parser. Rows already in the ledger are skipped, so re-importing an overlapping export is safe."
		);

		this.renderImportHistory(content);
	}

	/**
	 * Every import run, newest first, each undoable.
	 *
	 * Importing the wrong file used to be permanent: the rows landed in the ledger indistinguishable
	 * from everything else, and unpicking them meant finding them by hand. Each run now carries a
	 * batch id, which makes "undo that" a single, exact operation.
	 */
	private renderImportHistory(content: HTMLElement): void {
		const store = this.plugin.store;
		const batches = [...store.batches].sort((a, b) => b.importedAt.localeCompare(a.importedAt));

		const group = this.group(content, {
			icon: "history",
			title: "Import history",
			subtitle: "Every import, and a way to undo one.",
			chip: batches.length > 0 ? { text: `${batches.length} run${batches.length === 1 ? "" : "s"}`, tone: "ok" } : { text: "none yet", tone: "pending" },
			collapsibleId: "import-history",
			defaultExpanded: batches.length > 0,
		});

		if (batches.length === 0) {
			this.note(group.content, "Imports run before this version aren't listed — batches are only recorded from now on.");
			return;
		}

		batches.forEach((batch) => {
			const remaining = store.transactionsInBatch(batch.id).length;
			const when = batch.importedAt.slice(0, 16).replace("T", " ");
			const setting = new Setting(group.content)
				.setName(batch.fileName || batch.format || batch.source)
				.setDesc(`${when} · ${batch.count} imported · ${remaining} still in the ledger`);

			setting.addButton((b) =>
				b
					.setButtonText(remaining === 0 ? "Forget" : "Undo import")
					.setWarning()
					.onClick(async () => {
						const removed = await store.undoImportBatch(batch.id);
						new Notice(removed > 0 ? `Removed ${removed} transaction${removed === 1 ? "" : "s"} from that import` : "That import had nothing left to remove");
						this.plugin.refreshViews();
						this.renderBody();
					})
			);
		});

		this.note(
			group.content,
			"Undoing an import deletes every transaction it created — including any you've since edited or categorized. Re-importing the same file brings them back, minus those edits."
		);
	}

	private renderAbout(content: HTMLElement): void {
		const { manifest } = this.plugin;
		const store = this.plugin.store;

		const about = this.group(content, {
			icon: "info",
			title: `${manifest.name} ${manifest.version}`,
			subtitle: manifest.description,
			chip: { text: `loaded ${this.plugin.loadedAt}`, tone: "ok" },
		});
		this.note(
			about.content,
			`By ${manifest.author}. Obsidian only re-reads a plugin when it's toggled or the app restarts, so the load time above is how to tell whether a rebuild is actually running yet.`
		);

		const facts: [string, string][] = [
			["Transactions", String(store.transactions.length)],
			["Accounts", String(store.accounts.length)],
			[
				"Categories",
				`${primaryCategories(store.categories).length} primary, ${store.categories.length - primaryCategories(store.categories).length} secondary`,
			],
			["Subscriptions", String(store.subscriptions.length)],
			["Cards", String(store.cards.length)],
			["Portfolios", String((this.plugin.settings.portfolios ?? []).length)],
		];
		for (const [label, value] of facts) new Setting(about.content).setName(label).setDesc(value);

		const features = this.group(content, {
			icon: "sparkles",
			title: "What this plugin does",
			subtitle: "Everything currently built, in one place.",
			chip: { text: `${FEATURES.length} features`, tone: "ok" },
			collapsibleId: "about-features",
			defaultExpanded: false,
		});
		const list = features.content.createDiv({ cls: "fp-about-feature-list" });
		FEATURES.forEach((f) => {
			const item = list.createDiv({ cls: "fp-about-feature" });
			icon(item, f.icon, "fp-about-feature-icon");
			const text = item.createDiv();
			text.createDiv({ cls: "fp-about-feature-title", text: f.title });
			text.createDiv({ cls: "fp-about-feature-desc", text: f.desc });
		});

		const privacy = this.group(content, {
			icon: "folder-lock",
			title: "Where your data lives, and what leaves your vault",
			subtitle: "Everything is stored locally as plain, human-readable files.",
			chip: { text: "local only", tone: "ok" },
		});
		this.note(
			privacy.content,
			"Accounts, categories, rules, subscriptions and cards are JSON; the transaction ledger is CSV, one file per source per year. All of it sits under a folder in your vault, readable and diffable outside the plugin too."
		);
		this.note(
			privacy.content,
			'There is no telemetry and no background network call. Two things can leave the vault, both only when you press a button. The "Fetch latest rates" button under Currency asks the free Frankfurter API for the day\'s exchange rates, sending nothing but currency codes.'
		);
		this.note(
			privacy.content,
			"The second is AI categorization, which is off until you turn it on and give it a key. It sends normalized merchant names and your category tree to Anthropic — no amounts, dates, account names, IBANs, card numbers or balances. Settings → AI shows the exact text before you send it, and the Claude CLI option keeps even that between your machine and your own subscription."
		);
		this.note(
			privacy.content,
			"Card numbers and expiry dates can be entered for the flip-card view. The CVV is never asked for anywhere in this plugin, and so is never stored."
		);

		const start = this.group(content, {
			icon: "rocket",
			title: "Getting started",
			subtitle: "The first few steps, if you're setting this up fresh.",
		});
		const steps = start.content.createEl("ol", { cls: "fp-about-steps" });
		[
			"Open the workspace from the ribbon icon, or run “Open Finance workspace” from the command palette.",
			"Add your first account from the sidebar, or under Accounts on this page.",
			"Use “Import transactions” to bring in a bank or broker export.",
			"Work down the Review queue in the workspace: fix categories, then approve.",
			"Optionally run “Install default categories & auto-categorize transactions” from the command palette to seed a standard category set.",
		].forEach((step) => steps.createEl("li", { text: step }));
	}
}
