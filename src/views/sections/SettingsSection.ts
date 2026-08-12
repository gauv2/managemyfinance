import { Notice, Platform } from "obsidian";
import type FinancePlugin from "../../main";
import { formatMoney, NUMBER_FORMAT_LABEL, setNumberFormatPreference, type NumberFormatPreference } from "../../money";
import { icon } from "../../ui/dom";

const NUMBER_FORMATS: NumberFormatPreference[] = ["auto", "dot", "comma", "space"];

const MOBILE_LAYOUT_OPTIONS: { value: "auto" | "on" | "off"; label: string }[] = [
	{ value: "auto", label: "Auto" },
	{ value: "on", label: "Always on" },
	{ value: "off", label: "Always off" },
];

const SUBSCRIPTION_VIEW_OPTIONS: { value: "monthly" | "yearly" | "per-subscription"; label: string }[] = [
	{ value: "monthly", label: "Per month" },
	{ value: "yearly", label: "Per year" },
	{ value: "per-subscription", label: "Per subscription" },
];

/** The same panel shape the vault settings tab uses (`fp-sgroup`), so the two settings surfaces read
 *  as one design rather than two — an icon, a title, a subtitle, and an optional status chip. */
function settingsCard(
	parent: HTMLElement,
	opts: { icon: string; title: string; desc: string; chip?: { text: string; tone: "ok" | "warn" | "pending" } }
): HTMLElement {
	const box = parent.createDiv({ cls: "fp-sgroup" });
	const head = box.createDiv({ cls: "fp-sgroup-head" });
	icon(head.createDiv({ cls: "fp-sgroup-icon" }), opts.icon);
	const titles = head.createDiv({ cls: "fp-sgroup-titles" });
	titles.createDiv({ cls: "fp-sgroup-title", text: opts.title });
	titles.createDiv({ cls: "fp-sgroup-sub", text: opts.desc });
	if (opts.chip) head.createSpan({ cls: `fp-chip fp-chip-${opts.chip.tone}`, text: opts.chip.text });
	return box.createDiv({ cls: "fp-sgroup-body" });
}

/** One labelled row with its control on the right — the in-app equivalent of Obsidian's `Setting`. */
function settingRow(parent: HTMLElement, name: string, desc: string): HTMLElement {
	const row = parent.createDiv({ cls: "fp-app-setting-row" });
	const info = row.createDiv({ cls: "fp-app-setting-info" });
	info.createDiv({ cls: "fp-app-setting-name", text: name });
	info.createDiv({ cls: "fp-app-setting-desc", text: desc });
	return row.createDiv({ cls: "fp-app-setting-control" });
}

/** A segmented button group — the choice and its current state readable without opening anything. */
function segmented<T extends string>(
	parent: HTMLElement,
	options: { value: T; label: string }[],
	current: T,
	onPick: (value: T) => void
): void {
	const group = parent.createDiv({ cls: "fp-segmented" });
	options.forEach((opt) => {
		const btn = group.createEl("button", {
			cls: "fp-segmented-btn" + (opt.value === current ? " is-active" : ""),
			text: opt.label,
		});
		btn.addEventListener("click", () => {
			if (opt.value === current) return;
			onPick(opt.value);
		});
	});
}

function toggle(parent: HTMLElement, on: boolean, onChange: (next: boolean) => void): void {
	const btn = parent.createEl("button", { cls: "fp-toggle" + (on ? " is-on" : "") });
	btn.setAttribute("role", "switch");
	btn.setAttribute("aria-checked", String(on));
	btn.createSpan({ cls: "fp-toggle-knob" });
	btn.addEventListener("click", () => onChange(!on));
}

/**
 * The app's own settings page — the "how this looks while I work" half of the split.
 *
 * The other half lives in Obsidian's settings modal (Settings → Manage My Finance) and holds what the
 * plugin *knows*: the data folder, accounts, categories, exchange rates, import, and backup/restore.
 * Anything on this page changes only presentation, takes effect immediately, and is safe to fiddle
 * with — which is exactly why "Hide amounts" belongs here rather than buried in the sidebar's tab
 * list, where it read as a page you could navigate to.
 */
export function renderSettingsSection(container: HTMLElement, plugin: FinancePlugin): void {
	container.addClass("fp-section");

	function render(): void {
		container.empty();
		const settings = plugin.settings;

		const header = container.createDiv({ cls: "fp-section-header" });
		const headText = header.createDiv({ cls: "fp-section-header-text" });
		const titleRow = headText.createDiv({ cls: "fp-section-title-row" });
		const headIcon = titleRow.createDiv({ cls: "fp-section-icon-badge" });
		icon(headIcon, "sliders-horizontal");
		titleRow.createEl("h2", { text: "Settings" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: "How this workspace looks and behaves. Your data, accounts, categories and backups are set up in Obsidian's own settings — there's a button for that at the bottom.",
		});

		const save = async (): Promise<void> => {
			await plugin.saveSettings();
			plugin.refreshViews();
			render();
		};

		// ---- Appearance ------------------------------------------------------
		const appearance = settingsCard(container, {
			icon: "eye",
			title: "Appearance",
			desc: "How amounts are written and whether they're visible at a glance.",
			chip: settings.privacyMode
				? { text: "amounts hidden", tone: "warn" }
				: { text: NUMBER_FORMAT_LABEL[settings.numberFormat ?? "auto"], tone: "ok" },
		});

		const formatControl = settingRow(
			appearance,
			"Number format",
			"Which separators amounts are written with. Typing is always flexible — \"1.234,56\", \"1,234.56\" and \"1234.56\" are all understood wherever you enter an amount, whatever this is set to."
		);
		segmented(
			formatControl,
			NUMBER_FORMATS.map((f) => ({ value: f, label: NUMBER_FORMAT_LABEL[f] })),
			settings.numberFormat ?? "auto",
			(value) => {
				settings.numberFormat = value;
				// Applied before saving so the example below redraws with the new format straight away.
				setNumberFormatPreference(value);
				void save();
			}
		);
		appearance.createDiv({
			cls: "fp-app-setting-example",
			text: `Example: ${formatMoney(1234.56)} · ${formatMoney(-89.05)} · ${formatMoney(0.5)}`,
		});

		const privacyControl = settingRow(
			appearance,
			"Hide amounts",
			"Blurs every amount, IBAN and card number until you hover it. For working with the vault open, screen-sharing, or demoing the plugin."
		);
		toggle(privacyControl, !!settings.privacyMode, (next) => {
			settings.privacyMode = next;
			void save();
		});

		const layoutControl = settingRow(
			appearance,
			"Mobile-friendly layout",
			`Stacks the sidebar above the page and simplifies grids for narrow screens. "Auto" follows Obsidian's own mobile detection — this device is currently detected as ${
				Platform.isMobile ? "mobile" : "desktop"
			}.`
		);
		segmented(layoutControl, MOBILE_LAYOUT_OPTIONS, settings.mobileLayout ?? "auto", (value) => {
			settings.mobileLayout = value;
			void save();
		});

		// ---- Subscriptions ---------------------------------------------------
		const subs = settingsCard(container, {
			icon: "repeat",
			title: "Subscriptions",
			desc: "How recurring costs are quoted on the Subscriptions page.",
			chip: {
				text: SUBSCRIPTION_VIEW_OPTIONS.find((o) => o.value === (settings.subscriptionView ?? "monthly"))?.label ?? "Per month",
				tone: "ok",
			},
		});
		const subControl = settingRow(
			subs,
			"Default view",
			"Whether totals, cards and charts are shown per month or per year. \"Per subscription\" lets each subscription use its own preference, falling back to per month. You can flip this from the Subscriptions page itself at any time."
		);
		segmented(subControl, SUBSCRIPTION_VIEW_OPTIONS, settings.subscriptionView ?? "monthly", (value) => {
			settings.subscriptionView = value;
			void save();
		});

		// ---- Review ----------------------------------------------------------
		const unreviewedCount = plugin.store.transactions.filter((t) => (t.review ?? "new") !== "approved").length;
		const review = settingsCard(container, {
			icon: "check-check",
			title: "Review queue",
			desc: "How the Review page behaves while you work through imported transactions.",
			chip:
				unreviewedCount > 0
					? { text: `${unreviewedCount} to review`, tone: "warn" }
					: { text: "all reviewed", tone: "ok" },
		});
		const reviewControl = settingRow(
			review,
			"Hide approved transactions",
			"Keeps the queue to what still needs attention. Turn this off to browse everything, approved rows included — the status filter on the page overrides it either way."
		);
		toggle(reviewControl, settings.reviewHideApproved !== false, (next) => {
			settings.reviewHideApproved = next;
			void save();
		});

		const reviewLinkControl = settingRow(
			review,
			"Go to the review queue",
			unreviewedCount === 0
				? "Everything imported has been reviewed."
				: `${unreviewedCount} transaction${unreviewedCount === 1 ? "" : "s"} not approved yet.`
		);
		const reviewBtn = reviewLinkControl.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(reviewBtn, "check-check");
		reviewBtn.createSpan({ text: "Open Review" });
		reviewBtn.addEventListener("click", async () => {
			settings.activeView = "review";
			await plugin.saveSettings();
			plugin.refreshViews();
		});

		// ---- Pointer to the other settings surface ---------------------------
		const vault = settingsCard(container, {
			icon: "database",
			title: "Vault settings",
			desc: "The other half: what this plugin knows, rather than how it looks.",
			chip: { text: "in Obsidian settings", tone: "pending" },
		});
		const vaultControl = settingRow(
			vault,
			"Data, accounts, categories and backups",
			"Data folder, portfolios, accounts, category management, FI projection assumptions, exchange rates, importing bank exports, and export / import / delete-all — all in Obsidian's own settings under \"Manage My Finance\"."
		);
		const vaultBtn = vaultControl.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(vaultBtn, "external-link");
		vaultBtn.createSpan({ text: "Open vault settings" });
		vaultBtn.addEventListener("click", () => plugin.openVaultSettings("general"));

		const shortcuts = vault.createDiv({ cls: "fp-app-setting-shortcuts" });
		(
			[
				["Accounts", "landmark", "accounts"],
				["Categories", "tag", "categories"],
				["Currency", "coins", "currency"],
				["Import", "download", "import"],
				["Backup & delete", "database", "data"],
			] as [string, string, string][]
		).forEach(([label, iconName, group]) => {
			const btn = shortcuts.createEl("button", { cls: "fp-btn fp-btn-ghost" });
			icon(btn, iconName);
			btn.createSpan({ text: label });
			btn.addEventListener("click", () => plugin.openVaultSettings(group));
		});

		// ---- Which build is this? -------------------------------------------
		const about = settingsCard(container, {
			icon: "info",
			title: `${plugin.manifest.name} ${plugin.manifest.version}`,
			desc: "Which build you're looking at.",
			chip: { text: `loaded ${plugin.loadedAt}`, tone: "ok" },
		});
		const aboutControl = settingRow(
			about,
			"Version",
			`v${plugin.manifest.version}, loaded at ${plugin.loadedAt}. Obsidian only re-reads a plugin when it's toggled or the app restarts — if that time hasn't moved since your last build, the old bundle is still running.`
		);
		const copyBtn = aboutControl.createEl("button", { cls: "fp-btn fp-btn-secondary" });
		icon(copyBtn, "copy");
		copyBtn.createSpan({ text: "Copy version" });
		copyBtn.addEventListener("click", async () => {
			await navigator.clipboard.writeText(`${plugin.manifest.name} v${plugin.manifest.version} (loaded ${plugin.loadedAt})`);
			new Notice("Version copied — paste it into a bug report.");
		});
	}

	render();
}
