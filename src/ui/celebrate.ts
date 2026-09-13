import { icon } from "./dom";

/** The chart palette plus two festive extras — the page's own colours, not a foreign set. */
const CONFETTI_COLORS = [
	"var(--fp-cat-1)",
	"var(--fp-cat-2)",
	"var(--fp-cat-3)",
	"var(--fp-cat-4)",
	"var(--fp-cat-5)",
	"var(--fp-cat-6)",
	"var(--fp-cat-7)",
	"var(--fp-cat-9)",
	"var(--interactive-accent)",
	"var(--fp-chart-income)",
];

const PIECES_PER_CANNON = 55;
/** Long enough for the arc to land, short enough that nobody waits for it. */
const FLIGHT_MS = 2600;
const CARD_MS = 4200;

function rand(min: number, max: number): number {
	return min + Math.random() * (max - min);
}

/**
 * Two party poppers in the bottom corners, and a card saying what you just finished.
 *
 * Deliberately hand-rolled rather than pulled from a confetti library: this is ~40 lines of DOM and a
 * few keyframes, and a plugin should not ship a dependency — or reach a CDN — to throw paper about.
 *
 * The arc is three nested elements because one element cannot run two transforms at once: the outer
 * carries horizontal travel at a constant rate, the middle the up-then-down of gravity with its own
 * easing on each leg, and the innermost the tumble. Composed, they read as a thrown object rather
 * than something sliding down the screen.
 */
export function celebrate(message: { title: string; detail?: string; big?: boolean }): void {
	// Honoured for the paper, not for the message: someone who has asked the OS to stop things moving
	// still gets told they finished, they just get told quietly.
	const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

	const layer = document.body.createDiv({ cls: "fp-celebrate" });
	if (!reduced) {
		// Clearing both piles is a bigger event than clearing one, and gets a bigger bang. Same effect
		// at a different size rather than a second effect: two celebrations that looked unrelated would
		// read as two different features.
		const pieces = Math.round(PIECES_PER_CANNON * (message.big ? 1.7 : 1));
		for (const side of ["left", "right"] as const) {
			for (let i = 0; i < pieces; i++) fireOne(layer, side);
		}
	}

	const card = layer.createDiv({
		cls: "fp-celebrate-card" + (reduced ? " is-still" : ""),
		attr: { role: "status", "aria-live": "polite" },
	});
	const badge = card.createDiv({ cls: "fp-celebrate-icon" });
	icon(badge, "party-popper");
	card.createDiv({ cls: "fp-celebrate-title", text: message.title });
	if (message.detail) card.createDiv({ cls: "fp-celebrate-detail", text: message.detail });

	const done = (): void => layer.remove();
	card.addEventListener("click", done);
	window.setTimeout(done, reduced ? CARD_MS : Math.max(CARD_MS, FLIGHT_MS + 600));
}

function fireOne(layer: HTMLElement, side: "left" | "right"): void {
	const outward = side === "left" ? 1 : -1;
	const duration = rand(FLIGHT_MS * 0.7, FLIGHT_MS);
	const piece = layer.createDiv({ cls: `fp-confetti is-${side}` });
	// Wide spread with a bias outward and up, so the two cannons cross in the middle of the screen
	// instead of each hugging its own corner.
	piece.style.setProperty("--dx", `${outward * rand(15, 95)}vw`);
	piece.style.setProperty("--dur", `${Math.round(duration)}ms`);
	piece.style.setProperty("--delay", `${Math.round(rand(0, 260))}ms`);

	const arc = piece.createDiv({ cls: "fp-confetti-arc" });
	arc.style.setProperty("--peak", `${-rand(45, 95)}vh`);
	arc.style.setProperty("--end", `${rand(5, 25)}vh`);

	const bit = arc.createDiv({ cls: "fp-confetti-bit" });
	const size = rand(6, 12);
	bit.style.setProperty("--w", `${size.toFixed(1)}px`);
	// A mix of oblongs and circles — same-shaped pieces read as a pattern rather than as paper.
	bit.style.setProperty("--h", `${(size * rand(0.4, 1)).toFixed(1)}px`);
	bit.style.setProperty("--radius", Math.random() < 0.3 ? "50%" : "1px");
	bit.style.setProperty("--color", CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]);
	bit.style.setProperty("--spin", `${Math.round(rand(360, 1080)) * (Math.random() < 0.5 ? -1 : 1)}deg`);
}
