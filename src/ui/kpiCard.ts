import { sparkline } from "./charts";

/** Stat-tile contract: label · value (hero-sized for the one figure a view leads with) · delta · trend. */
export function renderKpiCard(
	container: HTMLElement,
	opts: {
		label: string;
		value: string;
		hero?: boolean;
		delta?: { value: number; goodIfUp?: boolean };
		sparklineValues?: number[];
		sparklineColor?: string;
		sub?: string;
		money?: boolean;
	}
): HTMLElement {
	const card = container.createDiv({ cls: "fp-kpi-card" + (opts.hero ? " fp-kpi-hero" : "") });

	const head = card.createDiv({ cls: "fp-kpi-head" });
	head.createSpan({ cls: "fp-kpi-label", text: opts.label });
	if (opts.delta) {
		const good = opts.delta.goodIfUp === false ? opts.delta.value <= 0 : opts.delta.value >= 0;
		const deltaEl = head.createSpan({ cls: "fp-kpi-delta " + (good ? "is-good" : "is-bad") });
		deltaEl.setText(`${opts.delta.value >= 0 ? "+" : ""}${(opts.delta.value * 100).toFixed(1)}%`);
	}

	const body = card.createDiv({ cls: "fp-kpi-body" });
	body.createDiv({ cls: "fp-kpi-value" + (opts.money === false ? "" : " fp-money"), text: opts.value });
	if (opts.sparklineValues && opts.sparklineValues.length > 1) {
		const sparkWrap = body.createDiv({ cls: "fp-kpi-spark" });
		sparkline(sparkWrap, opts.sparklineValues, opts.sparklineColor ?? "var(--fp-neutral)");
	}

	if (opts.sub) card.createDiv({ cls: "fp-kpi-sub", text: opts.sub });
	return card;
}

/** Meter contract: a single ratio against a limit — fill in the accent, track a lighter step of the same ramp. */
export function renderMeter(
	container: HTMLElement,
	opts: { label: string; value: number; valueLabel: string; sub?: string; renderSub?: (el: HTMLElement) => void }
): HTMLElement {
	const card = container.createDiv({ cls: "fp-meter-card" });
	const head = card.createDiv({ cls: "fp-meter-head" });
	head.createSpan({ cls: "fp-meter-label", text: opts.label });
	head.createSpan({ cls: "fp-meter-value", text: opts.valueLabel });

	const track = card.createDiv({ cls: "fp-meter-track" });
	const fill = track.createDiv({ cls: "fp-meter-fill" });
	fill.style.width = `${Math.max(0, Math.min(100, opts.value * 100))}%`;

	if (opts.renderSub) opts.renderSub(card.createDiv({ cls: "fp-meter-sub" }));
	else if (opts.sub) card.createDiv({ cls: "fp-meter-sub", text: opts.sub });
	return card;
}
