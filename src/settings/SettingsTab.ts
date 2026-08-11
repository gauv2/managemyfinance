import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { ACCOUNT_TYPE_META, CURRENCIES, DEFAULT_DATA_FOLDER } from "../constants";
import { fetchLatestRates } from "../fx";
import type FinancePlugin from "../main";
import type { AccountType } from "../types";
import { badge, icon } from "../ui/dom";
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
		desc: "Debit, credit, investing, saving, cash, and crypto accounts, each with its own type-appropriate dashboard: net worth, income/expenses, savings rate, and a financial-independence projection.",
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
		desc: "Simple monthly limits per category, kept per month (not overwritten as the calendar rolls forward) so past plans and actuals stay around for year-end review. Progress bars, suggested budgets from recent spending, and a click-through to the transactions behind any total.",
	},
	{
		icon: "repeat",
		title: "Subscriptions",
		desc: "Track recurring payments in any billing cycle and currency, optionally linked to the account they're paid from — normalized to a monthly figure so wildly different cycles compare cleanly.",
	},
	{
		icon: "credit-card",
		title: "Cards",
		desc: "A card manager with tier/issuer/network-driven visual styling (CSS/SVG only, no external logos or images) — click a card to flip it and see its number and expiry. The CVV is never asked for or stored.",
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

interface SettingsGroup {
	id: string;
	label: string;
	icon: string;
	render: (content: HTMLElement) => void;
}

export class FinanceSettingTab extends PluginSettingTab {
	private activeGroupId = "general";
	private cardExpanded = new Map<string, boolean>();

	constructor(app: App, private plugin: FinancePlugin) {
		super(app, plugin);
	}

	/** A card is a titled, badged group of native `Setting` rows — the badge surfaces the group's
	 *  current headline value at a glance, without opening it. Pass `collapsibleId` to make the
	 *  whole card toggle open/closed (state remembered per id for the life of the settings tab).
	 *  `headerAction` renders a button into the header (e.g. a fetch/refresh action) — it stops
	 *  its own click from bubbling into the collapse toggle. */
	private card(
		parent: HTMLElement,
		opts: {
			icon: string;
			title: string;
			desc: string;
			badge?: string;
			collapsibleId?: string;
			defaultExpanded?: boolean;
			headerAction?: (right: HTMLElement) => void;
		}
	): HTMLElement {
		const isCollapsible = !!opts.collapsibleId;
		const expanded = isCollapsible ? this.cardExpanded.get(opts.collapsibleId!) ?? opts.defaultExpanded ?? true : true;

		const card = parent.createDiv({ cls: "fp-card fp-settings-card" + (isCollapsible && !expanded ? " is-collapsed" : "") });
		const head = card.createDiv({ cls: "fp-settings-card-head" + (isCollapsible ? " is-clickable" : "") });
		const left = head.createDiv({ cls: "fp-settings-card-head-left" });
		icon(left, opts.icon, "fp-settings-card-icon");
		const text = left.createDiv();
		text.createDiv({ cls: "fp-settings-card-title", text: opts.title });
		text.createDiv({ cls: "fp-settings-card-desc", text: opts.desc });

		const headRight = head.createDiv({ cls: "fp-settings-card-head-right" });
		if (opts.badge) badge(headRight, opts.badge, "neutral");
		if (opts.headerAction) {
			const actionWrap = headRight.createDiv();
			actionWrap.addEventListener("click", (ev) => ev.stopPropagation());
			opts.headerAction(actionWrap);
		}
		if (isCollapsible) {
			icon(headRight, "chevron-down", "fp-settings-card-chevron");
			head.addEventListener("click", () => {
				this.cardExpanded.set(opts.collapsibleId!, !expanded);
				this.display();
			});
		}

		return card.createDiv({ cls: "fp-settings-card-body" });
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("fp-workspace");

		const shell = containerEl.createDiv({ cls: "fp-settings-shell" });
		const nav = shell.createDiv({ cls: "fp-nav fp-settings-nav" });
		const navItems = nav.createDiv({ cls: "fp-nav-items" });
		const content = shell.createDiv({ cls: "fp-settings-content" });

		const groups: SettingsGroup[] = [
			{ id: "general", label: "General", icon: "settings-2", render: (c) => this.renderGeneral(c) },
			{ id: "accounts", label: "Accounts", icon: "landmark", render: (c) => this.renderAccounts(c) },
			{ id: "categories", label: "Categories", icon: "tag", render: (c) => this.renderCategories(c) },
			{ id: "projections", label: "Projections", icon: "trending-up", render: (c) => this.renderProjections(c) },
			{ id: "currency", label: "Currency", icon: "coins", render: (c) => this.renderCurrency(c) },
			{ id: "import", label: "Import", icon: "download", render: (c) => this.renderImport(c) },
			{ id: "about", label: "About", icon: "info", render: (c) => this.renderAbout(c) },
		];
		if (!groups.some((g) => g.id === this.activeGroupId)) this.activeGroupId = groups[0].id;

		groups.forEach((g) => {
			const item = navItems.createDiv({ cls: "fp-nav-item" + (g.id === this.activeGroupId ? " is-active" : "") });
			icon(item, g.icon, "fp-nav-icon");
			item.createSpan({ cls: "fp-nav-label", text: g.label });
			item.addEventListener("click", () => {
				if (this.activeGroupId === g.id) return;
				this.activeGroupId = g.id;
				this.display();
			});
		});

		const active = groups.find((g) => g.id === this.activeGroupId) ?? groups[0];
		active.render(content);
	}

	private renderGeneral(content: HTMLElement): void {
		const folderCard = this.card(content, {
			icon: "folder",
			title: "Where your data lives",
			desc: "The vault folder Finance stores its ledger, categories, and rules in.",
			badge: this.plugin.settings.dataFolder,
		});
		new Setting(folderCard)
			.setName("Data folder")
			.setDesc("Root folder holding your ledger, accounts, and categories.")
			.addText((t) =>
				t.setValue(this.plugin.settings.dataFolder).onChange(async (v) => {
					this.plugin.settings.dataFolder = v || DEFAULT_DATA_FOLDER;
					await this.plugin.saveSettings();
				})
			);

		const layoutCard = this.card(content, {
			icon: "smartphone",
			title: "Layout",
			desc: "How the workspace adapts to your screen.",
			badge: MOBILE_LAYOUT_LABEL[this.plugin.settings.mobileLayout ?? "auto"],
		});
		new Setting(layoutCard)
			.setName("Mobile-friendly layout")
			.setDesc(
				`Stacks the sidebar above the page and simplifies grids for narrow screens. "Auto" follows Obsidian's own mobile detection${
					Platform.isMobile ? " (this device is currently detected as mobile)." : " (this device is currently detected as desktop)."
				}`
			)
			.addDropdown((d) =>
				d
					.addOptions({ auto: "Auto (recommended)", on: "Always on", off: "Always off" })
					.setValue(this.plugin.settings.mobileLayout ?? "auto")
					.onChange(async (v) => {
						this.plugin.settings.mobileLayout = v as "auto" | "on" | "off";
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
						this.display();
					})
			);
	}

	private renderAccounts(content: HTMLElement): void {
		const store = this.plugin.store;
		const card = this.card(content, {
			icon: "landmark",
			title: "Accounts",
			desc: "Bank and broker accounts tracked in your ledger.",
			badge: `${store.accounts.length} account${store.accounts.length === 1 ? "" : "s"}`,
		});

		if (store.accounts.length === 0) {
			card.createEl("p", { cls: "fp-step-desc", text: "No accounts yet — add one below." });
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
				new Setting(card).setName(acc.name).setDesc(desc).addButton((b) =>
					b.setIcon("x").setTooltip("Remove").onClick(async () => {
						store.accounts = store.accounts.filter((a) => a.id !== acc.id);
						await store.saveAccounts();
						this.display();
					})
				);
			});
		}

		let newAccountName = "";
		let newAccountType: AccountType = "debit";
		let newAccountIban = "";
		new Setting(card)
			.setName("Add account")
			.setDesc("IBAN is optional — set it so combined multi-account CSV exports auto-attribute rows to this account.")
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
					this.display();
				})
			);
	}

	private renderCategories(content: HTMLElement): void {
		const store = this.plugin.store;
		const card = this.card(content, {
			icon: "tag",
			title: "Categories",
			desc: "Labels used to classify transactions in the ledger — rename, recolor, or remove any of them.",
			badge: `${store.categories.length} categor${store.categories.length === 1 ? "y" : "ies"}`,
		});

		if (store.categories.length === 0) {
			card.createEl("p", { cls: "fp-step-desc", text: "No categories yet — add one below." });
		} else {
			store.categories.forEach((cat) => {
				new Setting(card)
					.addText((t) => {
						t.setValue(cat.name);
						t.inputEl.addEventListener("blur", async () => {
							const v = t.getValue().trim();
							if (!v || v === cat.name) {
								t.setValue(cat.name);
								return;
							}
							cat.name = v;
							await store.saveCategories();
						});
					})
					.addColorPicker((c) =>
						c.setValue(cat.color).onChange(async (v) => {
							cat.color = v;
							await store.saveCategories();
						})
					)
					.addText((t) => {
						t.setValue(cat.icon).setPlaceholder("Icon");
						t.inputEl.addClass("fp-category-icon-input");
						t.inputEl.addEventListener("blur", async () => {
							cat.icon = t.getValue().trim() || cat.icon;
							await store.saveCategories();
						});
					})
					.addButton((b) =>
						b
							.setIcon("trash-2")
							.setTooltip("Delete")
							.onClick(async () => {
								store.categories = store.categories.filter((c) => c.id !== cat.id);
								await store.saveCategories();
								this.display();
							})
					);
			});
		}

		let newCategoryName = "";
		let newCategoryColor = "#64748b";
		let newCategoryIcon = "tag";
		new Setting(card)
			.setName("Add category")
			.setDesc("Color and icon are used throughout the ledger, budgets, and charts.")
			.addText((t) => t.setPlaceholder("Category name").onChange((v) => (newCategoryName = v)))
			.addColorPicker((c) => c.setValue(newCategoryColor).onChange((v) => (newCategoryColor = v)))
			.addText((t) => {
				t.setPlaceholder("Icon (e.g. tag)").onChange((v) => (newCategoryIcon = v));
				t.inputEl.addClass("fp-category-icon-input");
			})
			.addButton((b) =>
				b.setButtonText("Add").onClick(async () => {
					if (!newCategoryName.trim()) return;
					store.categories.push({
						id: `cat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
						name: newCategoryName.trim(),
						color: newCategoryColor,
						icon: newCategoryIcon.trim() || "tag",
						aliases: [],
					});
					await store.saveCategories();
					this.display();
				})
			);
	}

	private renderProjections(content: HTMLElement): void {
		const card = this.card(content, {
			icon: "trending-up",
			title: "FI projections",
			desc: "Assumptions used to estimate your financial independence number and timeline.",
			badge: `${this.plugin.settings.fiMultiplier}×`,
		});
		new Setting(card)
			.setName("FI expense multiplier")
			.setDesc("Annual expenses × this multiplier = your FI number (25 ≈ a 4% withdrawal rate).")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.fiMultiplier)).onChange(async (v) => {
					const n = parseFloat(v);
					if (!isNaN(n) && n > 0) {
						this.plugin.settings.fiMultiplier = n;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					}
				})
			);

		new Setting(card)
			.setName("Expected annual return")
			.setDesc("Used to project years-to-FI, as a fraction (e.g. 0.07 for 7%).")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.expectedReturn)).onChange(async (v) => {
					const n = parseFloat(v);
					if (!isNaN(n) && n >= 0) {
						this.plugin.settings.expectedReturn = n;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					}
				})
			);
	}

	private renderCurrency(content: HTMLElement): void {
		const rates = this.plugin.settings.exchangeRates ?? {};
		const setCount = Object.keys(rates).filter((code) => CURRENCIES.includes(code) && rates[code] && rates[code] !== 1).length;
		const card = this.card(content, {
			icon: "coins",
			title: "Exchange rates",
			desc: `Manual conversion rates into ${BASE_CURRENCY}, one per currency — used only to combine subscriptions (and other totals) that use a different currency. Type your own, or fetch today's from api.frankfurter.dev: free, no key, no account data sent, the only network request this plugin ever makes.`,
			badge: `${setCount} set`,
			collapsibleId: "currency-rates",
			defaultExpanded: false,
			headerAction: (right) => {
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
						this.display();
					} catch (e) {
						new Notice(`Couldn't fetch exchange rates: ${e instanceof Error ? e.message : String(e)}`);
						label.setText("Fetch");
						btn.removeAttribute("disabled");
					}
				});
			},
		});

		const grid = card.createDiv({ cls: "fp-currency-grid" });
		CURRENCIES.filter((code) => code !== BASE_CURRENCY).forEach((code) => {
			const tile = grid.createDiv({ cls: "fp-currency-tile" });
			const label = tile.createDiv({ cls: "fp-currency-tile-label" });
			label.createDiv({ cls: "fp-currency-tile-code", text: code });
			label.createDiv({ cls: "fp-currency-tile-hint", text: `= ? ${BASE_CURRENCY}` });
			const input = tile.createEl("input", { type: "number", attr: { placeholder: "1.00", step: "any", min: "0" } });
			input.value = rates[code] !== undefined ? String(rates[code]) : "";
			input.addEventListener("blur", async () => {
				const n = parseFloat(input.value);
				const settings = this.plugin.settings;
				settings.exchangeRates ??= {};
				if (input.value.trim() === "" || isNaN(n) || n <= 0) {
					delete settings.exchangeRates[code];
				} else {
					settings.exchangeRates[code] = n;
				}
				await this.plugin.saveSettings();
			});
			input.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") input.blur();
			});
		});
	}

	private renderImport(content: HTMLElement): void {
		const card = this.card(content, {
			icon: "download",
			title: "Import transactions",
			desc: "Bring in a bank or broker CSV or Excel export — auto-detects common formats, with manual column mapping for anything else.",
		});
		new Setting(card)
			.setName("Start import")
			.setDesc("Opens the import wizard.")
			.addButton((b) =>
				b
					.setButtonText("Import")
					.setCta()
					.onClick(() => openImportWizard(this.plugin))
			);
	}

	private renderAbout(content: HTMLElement): void {
		const { manifest } = this.plugin;
		const aboutCard = this.card(content, {
			icon: "info",
			title: "About",
			desc: manifest.description,
			badge: `v${manifest.version}`,
		});
		new Setting(aboutCard).setName("Version").setDesc(manifest.version);
		new Setting(aboutCard).setName("Author").setDesc(manifest.author);

		const featuresCard = this.card(content, {
			icon: "sparkles",
			title: "What this plugin does",
			desc: "Everything currently built, in one place.",
			badge: `${FEATURES.length} features`,
			collapsibleId: "about-features",
			defaultExpanded: true,
		});
		const list = featuresCard.createDiv({ cls: "fp-about-feature-list" });
		FEATURES.forEach((f) => {
			const item = list.createDiv({ cls: "fp-about-feature" });
			icon(item, f.icon, "fp-about-feature-icon");
			const text = item.createDiv();
			text.createDiv({ cls: "fp-about-feature-title", text: f.title });
			text.createDiv({ cls: "fp-about-feature-desc", text: f.desc });
		});

		const dataCard = this.card(content, {
			icon: "folder-lock",
			title: "Where your data lives, and what leaves your vault",
			desc: "Everything is stored locally as plain, human-readable files — nothing is stored anywhere this page doesn't tell you about.",
		});
		const dataList = dataCard.createDiv({ cls: "fp-about-feature-list" });
		[
			{
				icon: "file-json",
				title: "Local JSON & CSV",
				desc: "Accounts, categories, rules, subscriptions, and cards are JSON; the transaction ledger is CSV, one file per source per year — all under a folder in your vault, readable and diffable outside the plugin too.",
			},
			{
				icon: "wifi-off",
				title: "No telemetry, no background network calls",
				desc: 'The one exception: an explicit "Fetch latest rates" button in Settings → Currency, which calls the free Frankfurter API for daily exchange rates. It sends nothing but currency codes, and only runs when you click it.',
			},
			{
				icon: "shield",
				title: "The CVV is never stored",
				desc: "Card numbers and expiry can be entered for the flip-card view, but the CVV is never asked for anywhere in this plugin.",
			},
		].forEach((f) => {
			const item = dataList.createDiv({ cls: "fp-about-feature" });
			icon(item, f.icon, "fp-about-feature-icon");
			const text = item.createDiv();
			text.createDiv({ cls: "fp-about-feature-title", text: f.title });
			text.createDiv({ cls: "fp-about-feature-desc", text: f.desc });
		});

		const startCard = this.card(content, {
			icon: "rocket",
			title: "Getting started",
			desc: "The first few steps, if you're setting this up fresh.",
		});
		const stepsList = startCard.createEl("ol", { cls: "fp-about-steps" });
		[
			"Open the workspace from the ribbon icon, or run “Open Finance workspace” from the command palette.",
			"Add your first account from the sidebar.",
			"Use “Import transactions” (command palette or the in-app Import button) to bring in a bank or broker export.",
			"Optionally run “Install eMoney categories & auto-categorize transactions” from the command palette to seed a standard category set and categorize what it can recognize.",
		].forEach((step) => stepsList.createEl("li", { text: step }));
	}
}
