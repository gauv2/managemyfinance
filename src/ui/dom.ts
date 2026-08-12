import { setIcon } from "obsidian";
import { primaryCategories, secondaryCategoriesOf } from "../categories";
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
 *  plus a progress bar beneath it), rather than only against the name's own line. */
export function categoryIconLabel(parent: HTMLElement, name: string, color: string, iconName?: string): HTMLElement {
	const wrap = parent.createDiv({ cls: "fp-cat-label" });
	wrap.style.setProperty("--fp-cat-color", color);
	if (iconName) icon(wrap.createDiv({ cls: "fp-cat-icon-box" }), iconName);
	const col = wrap.createDiv({ cls: "fp-cat-col" });
	col.createSpan({ cls: "fp-cat-name", text: name });
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

	const primaries = primaryCategories(opts.categories);

	function populateSecondary(primaryId: string | undefined, selectedSecondaryId: string | undefined): void {
		secondarySelect.empty();
		const secondaries = primaryId ? secondaryCategoriesOf(opts.categories, primaryId) : [];
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
