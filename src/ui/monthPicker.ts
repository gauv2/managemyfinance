import { MONTH_ABBR } from "../period";
import { icon } from "./dom";

/**
 * A year-then-month popover, opened by clicking a month label — the alternative to shifting a month
 * at a time via prev/next, which gets tedious once you're trying to jump back a year or more. Only
 * one instance can be open at a time (any previous popover is removed before a new one opens).
 */
export function openMonthPicker(anchor: HTMLElement, opts: { value: string; onSelect: (month: string) => void }): void {
	document.querySelector(".fp-month-picker")?.remove();

	const [valueYear] = opts.value.split("-").map(Number);
	let viewYear = valueYear;

	const panel = document.body.createDiv({ cls: "fp-month-picker" });
	const rect = anchor.getBoundingClientRect();
	panel.style.top = `${rect.bottom + 6}px`;
	panel.style.left = `${rect.left}px`;

	function renderPanel(): void {
		panel.empty();
		const head = panel.createDiv({ cls: "fp-month-picker-head" });
		const prevYearBtn = head.createEl("button", { cls: "fp-btn-icon fp-month-nav-btn" });
		icon(prevYearBtn, "chevron-left");
		prevYearBtn.setAttr("aria-label", "Previous year");
		prevYearBtn.addEventListener("click", (ev) => {
			ev.stopPropagation();
			viewYear--;
			renderPanel();
		});
		head.createSpan({ cls: "fp-month-picker-year", text: String(viewYear) });
		const nextYearBtn = head.createEl("button", { cls: "fp-btn-icon fp-month-nav-btn" });
		icon(nextYearBtn, "chevron-right");
		nextYearBtn.setAttr("aria-label", "Next year");
		nextYearBtn.addEventListener("click", (ev) => {
			ev.stopPropagation();
			viewYear++;
			renderPanel();
		});

		const grid = panel.createDiv({ cls: "fp-month-picker-grid" });
		MONTH_ABBR.forEach((label, i) => {
			const monthStr = `${viewYear}-${String(i + 1).padStart(2, "0")}`;
			const btn = grid.createEl("button", {
				cls: "fp-month-picker-cell" + (monthStr === opts.value ? " is-active" : ""),
				text: label,
			});
			btn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				close();
				opts.onSelect(monthStr);
			});
		});
	}

	function close(): void {
		panel.remove();
		document.removeEventListener("mousedown", onOutsideClick, true);
		document.removeEventListener("keydown", onKeyDown, true);
	}
	function onOutsideClick(ev: MouseEvent): void {
		const target = ev.target as Node;
		if (!panel.contains(target) && target !== anchor && !anchor.contains(target)) close();
	}
	function onKeyDown(ev: KeyboardEvent): void {
		if (ev.key === "Escape") close();
	}

	renderPanel();
	// Deferred so the click that opened the popover doesn't immediately close it via the same event.
	setTimeout(() => {
		document.addEventListener("mousedown", onOutsideClick, true);
		document.addEventListener("keydown", onKeyDown, true);
	}, 0);
}
