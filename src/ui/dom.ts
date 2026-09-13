import { setIcon } from "obsidian";
import { offerableCategories, primaryCategories, secondaryCategoriesOf } from "../categories";
import { decimalSeparator, formatMoney, formatMoneyForInput, parseMoney } from "../money";
import type { Category } from "../types";

export type Tone = "good" | "warn" | "bad" | "neutral";

export function icon(parent: HTMLElement, name: string, cls?: string): HTMLElement {
	const span = parent.createSpan({ cls: ["fp-icon", cls].filter(Boolean).join(" ") });
	setIcon(span, name);
	return span;
}

export function statTile(
	parent: HTMLElement,
	opts: { label: string; value: string; sub?: string; iconName: string; tone?: Tone; money?: boolean }
): HTMLElement {
	const tile = parent.createDiv({ cls: `fp-stat-tile fp-tone-${opts.tone ?? "neutral"}` });
	const head = tile.createDiv({ cls: "fp-stat-head" });
	icon(head, opts.iconName, "fp-stat-icon");
	head.createSpan({ cls: "fp-stat-label", text: opts.label });
	tile.createDiv({ cls: "fp-stat-value" + (opts.money === false ? "" : " fp-money"), text: opts.value });
	if (opts.sub) tile.createDiv({ cls: "fp-stat-sub", text: opts.sub });
	return tile;
}

export function badge(parent: HTMLElement, text: string, tone: Tone = "neutral"): HTMLElement {
	return parent.createSpan({ cls: `fp-badge fp-tone-${tone}`, text });
}

/** A colored square with the label's first letter — a logo stand-in that needs no network fetch. */
export function initialsAvatar(parent: HTMLElement, label: string, color: string, cls?: string): HTMLElement {
	const el = parent.createDiv({ cls: ["fp-avatar", cls].filter(Boolean).join(" ") });
	el.style.setProperty("--fp-avatar-color", color);
	el.setText((label.trim().charAt(0) || "?").toUpperCase());
	return el;
}

export function categoryChip(parent: HTMLElement, name: string, color: string, iconName?: string): HTMLElement {
	const chip = parent.createSpan({ cls: "fp-chip" });
	chip.style.setProperty("--fp-chip-color", color);
	if (iconName) icon(chip, iconName, "fp-chip-icon");
	chip.createSpan({ text: name });
	return chip;
}

/** A category's icon in its own soft-tinted square, plus its name set in that same color — the
 *  "icon badge + colored label" pairing used by the budgets table (as opposed to categoryChip's
 *  pill, which is for compact inline mentions elsewhere). The icon sits in its own flex column
 *  vertically centered against whatever the caller stacks into the returned column (e.g. the name
 *  plus a progress bar beneath it), rather than only against the name's own line.
 *
 *  `nameSuffix` renders into the same row as the name itself — e.g. a rollover toggle — as opposed
 *  to whatever the caller stacks below the returned column, which lands on its own line instead. */
export function categoryIconLabel(
	parent: HTMLElement,
	name: string,
	color: string,
	iconName?: string,
	opts?: { nameSuffix?: (row: HTMLElement) => void }
): HTMLElement {
	const wrap = parent.createDiv({ cls: "fp-cat-label" });
	wrap.style.setProperty("--fp-cat-color", color);
	if (iconName) icon(wrap.createDiv({ cls: "fp-cat-icon-box" }), iconName);
	const col = wrap.createDiv({ cls: "fp-cat-col" });
	const nameRow = col.createDiv({ cls: "fp-cat-name-row" });
	nameRow.createSpan({ cls: "fp-cat-name", text: name });
	opts?.nameSuffix?.(nameRow);
	return col;
}

/** A small donut gauge (percentage as a conic-gradient ring) with the percentage centered inside —
 *  used wherever a single ratio needs a compact, at-a-glance visual (budget KPI cards, per-row "% met"). */
export function ringGauge(parent: HTMLElement, opts: { pct: number; tone?: Tone; size?: number }): HTMLElement {
	const size = opts.size ?? 56;
	const clamped = Math.max(0, Math.min(1, opts.pct));
	const ring = parent.createDiv({ cls: `fp-ring fp-tone-${opts.tone ?? "neutral"}` });
	ring.style.setProperty("--fp-ring-size", `${size}px`);
	ring.style.setProperty("--fp-ring-pct", `${clamped * 100}`);
	ring.createSpan({ cls: "fp-ring-value", text: `${Math.round(opts.pct * 100)}%` });
	return ring;
}

/** The primary category's chip, plus a small "› Secondary" suffix when the transaction is tagged at
 *  the secondary level — the compact display used anywhere a transaction's category is shown. */
export function categoryChainChip(parent: HTMLElement, primary?: Category, secondary?: Category): HTMLElement {
	const wrap = parent.createSpan({ cls: "fp-chip-chain" });
	if (!primary) {
		badge(wrap, "Uncategorized", "warn");
		return wrap;
	}
	categoryChip(wrap, primary.name, primary.color, primary.icon);
	if (secondary) {
		wrap.createSpan({ cls: "fp-chip-chain-sep", text: "›" });
		categoryChip(wrap, secondary.name, secondary.color, secondary.icon);
	}
	return wrap;
}

export interface CategoryPickerValue {
	primaryId?: string;
	secondaryId?: string;
}

/**
 * A primary + secondary category select pair: the secondary select's options are always scoped to
 * whichever primary is currently chosen, and reset whenever the primary changes. Used anywhere a
 * transaction's category is set (transaction detail, import review) — for filtering UI with its own
 * "All"/"Uncategorized" sentinels, wire the two selects directly instead (see LedgerSection).
 */
export function renderCategoryPicker(
	container: HTMLElement,
	opts: {
		categories: Category[];
		value?: CategoryPickerValue;
		primaryPlaceholder: string;
		secondaryPlaceholder?: string;
		onChange: (value: CategoryPickerValue) => void;
	}
): { primarySelect: HTMLSelectElement; secondarySelect: HTMLSelectElement } {
	const wrap = container.createDiv({ cls: "fp-category-picker" });
	const primarySelect = wrap.createEl("select", { cls: "fp-setup-select" });
	const secondarySelect = wrap.createEl("select", { cls: "fp-setup-select" });

	// Archived categories are kept out of the choices without being hidden from the transaction that
	// already carries one — see offerableCategories for why that exception matters.
	const primaries = offerableCategories(primaryCategories(opts.categories), opts.value?.primaryId);

	function populateSecondary(primaryId: string | undefined, selectedSecondaryId: string | undefined): void {
		secondarySelect.empty();
		const secondaries = offerableCategories(primaryId ? secondaryCategoriesOf(opts.categories, primaryId) : [], selectedSecondaryId);
		secondarySelect.disabled = secondaries.length === 0;
		secondarySelect.createEl("option", { text: opts.secondaryPlaceholder ?? "— none —", value: "" });
		secondaries.forEach((cat) => {
			const o = secondarySelect.createEl("option", { text: cat.name, value: cat.id });
			if (cat.id === selectedSecondaryId) o.selected = true;
		});
	}

	primarySelect.createEl("option", { text: opts.primaryPlaceholder, value: "" });
	primaries.forEach((cat) => {
		const o = primarySelect.createEl("option", { text: cat.name, value: cat.id });
		if (cat.id === opts.value?.primaryId) o.selected = true;
	});
	populateSecondary(opts.value?.primaryId, opts.value?.secondaryId);

	primarySelect.addEventListener("change", () => {
		const primaryId = primarySelect.value || undefined;
		populateSecondary(primaryId, undefined);
		opts.onChange({ primaryId, secondaryId: undefined });
	});
	secondarySelect.addEventListener("change", () => {
		opts.onChange({ primaryId: primarySelect.value || undefined, secondaryId: secondarySelect.value || undefined });
	});

	return { primarySelect, secondarySelect };
}

/** A small tab strip switching between panels rendered into the same container — first tab active by default. */
export function tabSwitcher(container: HTMLElement, tabs: { label: string; render: (panel: HTMLElement) => void }[]): void {
	const header = container.createDiv({ cls: "fp-tabs" });
	const panels = container.createDiv({ cls: "fp-tab-panels" });
	tabs.forEach((tab, i) => {
		const btn = header.createDiv({ cls: "fp-tab" + (i === 0 ? " is-active" : "") });
		btn.setText(tab.label);
		const panel = panels.createDiv({ cls: "fp-tab-panel" + (i === 0 ? "" : " is-hidden") });
		tab.render(panel);
		btn.addEventListener("click", () => {
			header.querySelectorAll(".fp-tab").forEach((el) => el.removeClass("is-active"));
			panels.querySelectorAll(".fp-tab-panel").forEach((el) => el.addClass("is-hidden"));
			btn.addClass("is-active");
			panel.removeClass("is-hidden");
		});
	});
}

export interface MoneyInputHandle {
	input: HTMLInputElement;
	/** The parsed amount, or undefined when the field is blank or unreadable. */
	value: () => number | undefined;
	setValue: (amount: number | undefined) => void;
	/** Repoints the echo at a different currency, e.g. after a paired currency dropdown changes. */
	setCurrency: (currency: string) => void;
	/** False only when the field holds text that isn't an amount — a blank field is valid (= unset). */
	isValid: () => boolean;
}

/**
 * A money field that accepts whatever separator convention the user happens to type — "1.234,56",
 * "1,234.56", "1234.56" and "€ 1 234,56" all land on the same number — and echoes the amount it
 * actually read back underneath, so the interpretation is visible before anything is saved.
 *
 * Deliberately `type="text"`, not `type="number"`: a number input silently discards any value its own
 * locale can't read, so typing "1.234,56" into one leaves an empty field and no explanation.
 */
export function moneyInput(
	parent: HTMLElement,
	opts: {
		value?: number;
		currency?: string;
		placeholder?: string;
		/** Rejects negatives (e.g. a subscription cost); defaults to allowing them (e.g. a balance). */
		allowNegative?: boolean;
		cls?: string;
		onChange?: (value: number | undefined) => void;
	} = {}
): MoneyInputHandle {
	const wrap = parent.createDiv({ cls: ["fp-money-input", opts.cls].filter(Boolean).join(" ") });
	let currency = opts.currency;
	const sep = decimalSeparator();
	const input = wrap.createEl("input", {
		type: "text",
		cls: "fp-money-input-field",
		attr: {
			inputmode: "decimal",
			autocomplete: "off",
			placeholder: opts.placeholder ?? `0${sep}00`,
		},
	});
	input.value = formatMoneyForInput(opts.value);
	const echo = wrap.createDiv({ cls: "fp-money-input-echo" });

	function parsed(): number | undefined {
		const raw = input.value.trim();
		if (!raw) return undefined;
		const n = parseMoney(raw);
		if (n === undefined) return undefined;
		return opts.allowNegative === false ? Math.abs(n) : n;
	}

	function unreadable(): boolean {
		return input.value.trim() !== "" && parseMoney(input.value) === undefined;
	}

	function renderEcho(): void {
		echo.empty();
		echo.removeClass("is-error");
		const raw = input.value.trim();
		if (!raw) {
			echo.setText("");
			return;
		}
		if (unreadable()) {
			echo.addClass("is-error");
			echo.setText(`Can't read "${raw}" as an amount`);
			return;
		}
		const n = parsed();
		echo.setText(`= ${formatMoney(n ?? 0, { currency })}`);
	}

	input.addEventListener("input", () => {
		renderEcho();
		opts.onChange?.(parsed());
	});
	// Rewriting the field on blur turns whatever was typed into this vault's own convention, so the
	// same amount doesn't read two different ways depending on which field it was entered in.
	input.addEventListener("blur", () => {
		const n = parsed();
		if (n !== undefined) input.value = formatMoneyForInput(n);
		renderEcho();
	});
	renderEcho();

	return {
		input,
		value: parsed,
		setValue: (amount) => {
			input.value = formatMoneyForInput(amount);
			renderEcho();
		},
		setCurrency: (next) => {
			currency = next;
			renderEcho();
		},
		isValid: () => !unreadable(),
	};
}

export function emptyState(
	parent: HTMLElement,
	opts: { iconName: string; title: string; description: string; actionLabel?: string; onAction?: () => void }
): HTMLElement {
	const wrap = parent.createDiv({ cls: "fp-empty" });
	icon(wrap, opts.iconName, "fp-empty-icon");
	wrap.createDiv({ cls: "fp-empty-title", text: opts.title });
	wrap.createDiv({ cls: "fp-empty-desc", text: opts.description });
	if (opts.actionLabel && opts.onAction) {
		const btn = wrap.createEl("button", { cls: "fp-btn fp-btn-primary", text: opts.actionLabel });
		btn.addEventListener("click", opts.onAction);
	}
	return wrap;
}

/**
 * A search box with a clear button, shown only once there is something to clear.
 *
 * A search that can only be emptied by selecting its text and deleting it is a search people leave
 * filled by accident, and on a filtered list that reads as missing data rather than an active filter.
 *
 * The button deliberately does not take focus (`mousedown` prevented): clicking it should leave the
 * cursor in the field, ready to type the next search, not park it on a button that has just
 * disappeared. `onChange` fires on clear exactly as it does on typing, so the caller needs no
 * separate path for "emptied".
 */
export function searchInput(
	parent: HTMLElement,
	opts: { placeholder: string; value?: string; onChange: (value: string) => void }
): HTMLInputElement {
	const wrap = parent.createDiv({ cls: "fp-search-wrap" });
	const input = wrap.createEl("input", { type: "text", cls: "fp-search", placeholder: opts.placeholder });
	input.value = opts.value ?? "";

	const clear = wrap.createEl("button", { cls: "fp-search-clear", attr: { "aria-label": "Clear search", type: "button" } });
	icon(clear, "x");
	const sync = (): void => clear.toggleClass("is-visible", input.value.length > 0);

	input.addEventListener("input", () => {
		sync();
		opts.onChange(input.value);
	});
	clear.addEventListener("mousedown", (ev) => ev.preventDefault());
	clear.addEventListener("click", () => {
		if (!input.value) return;
		input.value = "";
		sync();
		opts.onChange("");
		input.focus();
	});
	sync();
	return input;
}
