import { sparkline } from "./charts";
import { icon, ringGauge, type Tone } from "./dom";

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

/** Stat tile with a donut gauge instead of a sparkline: label + icon badge up top, hero value and a
 *  one-line caption on the left, the gauge (and its own caption) on the right. Used by the Budgets
 *  summary row, where "% of budget" is the more natural read than a trend. */
export function renderRingKpiCard(
	container: HTMLElement,
	opts: {
		label: string;
		iconName: string;
		value: string;
		sub: string;
		pct: number;
		gaugeCaption: string;
		tone?: Tone;
		accentColor?: string;
	}
): HTMLElement {
	const card = container.createDiv({ cls: "fp-kpi-ring-card" });
	if (opts.accentColor) card.style.setProperty("--fp-kpi-ring-accent", opts.accentColor);

	const top = card.createDiv({ cls: "fp-kpi-ring-top" });
	const badge = top.createDiv({ cls: "fp-kpi-ring-badge" });
	icon(badge, opts.iconName);
	top.createSpan({ cls: "fp-kpi-label", text: opts.label });

	const body = card.createDiv({ cls: "fp-kpi-ring-body" });
	const main = body.createDiv({ cls: "fp-kpi-ring-main" });
	main.createDiv({ cls: "fp-kpi-value fp-money", text: opts.value });
	main.createDiv({ cls: "fp-kpi-sub", text: opts.sub });

	const gaugeWrap = body.createDiv({ cls: "fp-kpi-ring-gauge" });
	ringGauge(gaugeWrap, { pct: opts.pct, tone: opts.tone, size: 64 });
	gaugeWrap.createDiv({ cls: "fp-kpi-ring-gauge-caption", text: opts.gaugeCaption });

	return card;
}

/** Stat tile with a round icon badge next to the label, a hero value, and a colored one-line caption
 *  underneath (e.g. "/ month", "in 19 days") — no trend/gauge, just the figure and its unit/status.
 *  Used by the Subscriptions summary row. */
export function renderIconStatCard(
	container: HTMLElement,
	opts: {
		label: string;
		iconName: string;
		value: string;
		caption: string;
		accentColor: string;
		captionColor?: string;
		money?: boolean;
	}
): HTMLElement {
	const card = container.createDiv({ cls: "fp-icon-stat-card" });
	card.style.setProperty("--fp-icon-stat-accent", opts.accentColor);

	const head = card.createDiv({ cls: "fp-icon-stat-head" });
	const badge = head.createDiv({ cls: "fp-icon-stat-badge" });
	icon(badge, opts.iconName);
	head.createSpan({ cls: "fp-icon-stat-label", text: opts.label });

	card.createDiv({ cls: "fp-icon-stat-value" + (opts.money === false ? "" : " fp-money"), text: opts.value });
	const caption = card.createDiv({ cls: "fp-icon-stat-caption", text: opts.caption });
	if (opts.captionColor) caption.style.color = opts.captionColor;
	return card;
}
