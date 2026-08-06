import { emptyState } from "../../ui/dom";

export function renderComingSoon(container: HTMLElement, opts: { icon: string; title: string; description: string }): void {
	container.addClass("fp-section");
	container.createDiv({ cls: "fp-section-header" }).createEl("h2", { text: opts.title });
	emptyState(container, { iconName: opts.icon, title: "Coming soon", description: opts.description });
}
