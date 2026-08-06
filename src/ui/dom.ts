import { setIcon } from "obsidian";

export type Tone = "good" | "warn" | "bad" | "neutral";

export function icon(parent: HTMLElement, name: string, cls?: string): HTMLElement {
	const span = parent.createSpan({ cls: ["fp-icon", cls].filter(Boolean).join(" ") });
	setIcon(span, name);
	return span;
}

export function statTile(
	parent: HTMLElement,
	opts: { label: string; value: string; sub?: string; iconName: string; tone?: Tone }
): HTMLElement {
	const tile = parent.createDiv({ cls: `fp-stat-tile fp-tone-${opts.tone ?? "neutral"}` });
	const head = tile.createDiv({ cls: "fp-stat-head" });
	icon(head, opts.iconName, "fp-stat-icon");
	head.createSpan({ cls: "fp-stat-label", text: opts.label });
	tile.createDiv({ cls: "fp-stat-value", text: opts.value });
	if (opts.sub) tile.createDiv({ cls: "fp-stat-sub", text: opts.sub });
	return tile;
}

export function badge(parent: HTMLElement, text: string, tone: Tone = "neutral"): HTMLElement {
	return parent.createSpan({ cls: `fp-badge fp-tone-${tone}`, text });
}

export function categoryChip(parent: HTMLElement, name: string, color: string, iconName?: string): HTMLElement {
	const chip = parent.createSpan({ cls: "fp-chip" });
	chip.style.setProperty("--fp-chip-color", color);
	if (iconName) icon(chip, iconName, "fp-chip-icon");
	chip.createSpan({ text: name });
	return chip;
}

/**
 * Reveals `text` into `el` one character at a time with a blinking block cursor at the end,
 * matching the Setup view's hero intro lines. Returns a cancel function — callers must invoke it
 * when navigating away mid-animation so no orphaned timer keeps firing.
 */
export function typewriter(el: HTMLElement, text: string, speedMs = 16): () => void {
	el.empty();
	const textSpan = el.createSpan();
	const cursor = el.createSpan({ cls: "fp-setup-cursor" });
	let i = 0;
	let cancelled = false;
	let timer: number | undefined;

	const tick = () => {
		if (cancelled) return;
		i++;
		textSpan.setText(text.slice(0, i));
		if (i < text.length) {
			timer = window.setTimeout(tick, speedMs);
		} else {
			cursor.remove();
		}
	};
	tick();

	return () => {
		cancelled = true;
		if (timer !== undefined) window.clearTimeout(timer);
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
