import { setIcon } from "obsidian";

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
