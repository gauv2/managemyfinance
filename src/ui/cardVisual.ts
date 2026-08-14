import { cardStyle } from "../cards";
import type { Card } from "../types";

const NETWORK_TEXT: Partial<Record<Card["network"], string>> = {
	visa: "VISA",
	amex: "AMEX",
	discover: "DISCOVER",
	vpay: "V PAY",
	other: "CARD",
};

/**
 * `network` already drives the mark shown here (Mastercard's two-circle device vs. a wordmark for
 * everyone else) — this only extends that existing branch with a few more polish touches, it doesn't
 * replace the approach.
 */
function renderNetworkMark(parent: HTMLElement, network: Card["network"]): void {
	const mark = parent.createDiv({ cls: `fp-card-visual-network fp-card-network-${network}` });
	if (network === "mastercard") {
		mark.createDiv({ cls: "fp-card-network-circle fp-card-network-circle-a" });
		mark.createDiv({ cls: "fp-card-network-circle fp-card-network-circle-b" });
	} else {
		mark.createSpan({ text: NETWORK_TEXT[network] ?? "" });
	}
}

export type CardVisualData = Pick<
	Card,
	"name" | "cardholderName" | "product" | "issuer" | "network" | "cardType" | "number" | "last4" | "expiryMonth" | "expiryYear" | "isPrimary"
>;

function expiryLabel(card: CardVisualData): string | undefined {
	if (!card.expiryMonth || !card.expiryYear) return undefined;
	return `${String(card.expiryMonth).padStart(2, "0")}/${String(card.expiryYear % 100).padStart(2, "0")}`;
}

function groupedNumber(digits: string): string {
	return (digits.match(/.{1,4}/g) ?? []).join(" ");
}

function applyTilt(face: HTMLElement): void {
	const shine = face.createDiv({ cls: "fp-card-visual-shine" });
	face.addEventListener("mousemove", (ev: MouseEvent) => {
		const rect = face.getBoundingClientRect();
		const x = (ev.clientX - rect.left) / rect.width;
		const y = (ev.clientY - rect.top) / rect.height;
		const rotateY = (x - 0.5) * 14;
		const rotateX = (0.5 - y) * 10;
		face.style.transform = `perspective(700px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;
		shine.style.background = `radial-gradient(circle at ${x * 100}% ${y * 100}%, rgba(255,255,255,0.35), transparent 55%)`;
	});
	face.addEventListener("mouseleave", () => {
		face.style.transform = "";
		shine.style.background = "";
	});
}

function renderFront(parent: HTMLElement, card: CardVisualData, style: ReturnType<typeof cardStyle>): void {
	const face = parent.createDiv({ cls: "fp-card-visual fp-card-visual-face" + (style.isLight ? " fp-card-visual-light" : "") });
	face.style.setProperty("--fp-card-gradient", style.gradient);
	face.style.setProperty("--fp-card-text", style.textColor);
	applyTilt(face);

	const top = face.createDiv({ cls: "fp-card-visual-top" });
	top.createDiv({ cls: "fp-card-visual-issuer", text: card.issuer || card.product || "" });
	if (card.isPrimary) top.createDiv({ cls: "fp-card-visual-primary", text: "PRIMARY" });

	const chipRow = face.createDiv({ cls: "fp-card-visual-chip-row" });
	const chip = chipRow.createDiv({ cls: "fp-card-visual-chip" });
	chip.createDiv({ cls: "fp-card-visual-chip-lines" });
	chipRow.createDiv({ cls: "fp-card-visual-contactless" });
	face.createDiv({
		cls: "fp-card-visual-number",
		text: card.last4 ? `•••• •••• •••• ${card.last4}` : "•••• •••• •••• ••••",
	});

	const bottom = face.createDiv({ cls: "fp-card-visual-bottom" });
	const nameCol = bottom.createDiv({ cls: "fp-card-visual-name-col" });
	nameCol.createDiv({ cls: "fp-card-visual-label", text: "CARDHOLDER" });
	nameCol.createDiv({ cls: "fp-card-visual-name", text: card.cardholderName || card.name });
	const exp = expiryLabel(card);
	if (exp) {
		const expCol = bottom.createDiv({ cls: "fp-card-visual-exp-col" });
		expCol.createDiv({ cls: "fp-card-visual-label", text: "EXP" });
		expCol.createDiv({ cls: "fp-card-visual-exp", text: exp });
	}
	renderNetworkMark(bottom, card.network);
}

function renderBack(parent: HTMLElement, card: CardVisualData, style: ReturnType<typeof cardStyle>): void {
	const face = parent.createDiv({ cls: "fp-card-visual fp-card-visual-face fp-card-visual-back" + (style.isLight ? " fp-card-visual-light" : "") });
	face.style.setProperty("--fp-card-gradient", style.gradient);
	face.style.setProperty("--fp-card-text", style.textColor);

	face.createDiv({ cls: "fp-card-visual-stripe" });

	const details = face.createDiv({ cls: "fp-card-visual-back-details" });
	const numberRow = details.createDiv({ cls: "fp-card-visual-back-row" });
	numberRow.createDiv({ cls: "fp-card-visual-label", text: "CARD NUMBER" });
	numberRow.createDiv({
		cls: "fp-card-visual-back-number fp-iban",
		text: card.number ? groupedNumber(card.number) : card.last4 ? `•••• •••• •••• ${card.last4}` : "•••• •••• •••• ••••",
	});

	const metaRow = details.createDiv({ cls: "fp-card-visual-back-row fp-card-visual-back-meta" });
	const expCol = metaRow.createDiv();
	expCol.createDiv({ cls: "fp-card-visual-label", text: "EXPIRES" });
	expCol.createDiv({ cls: "fp-card-visual-exp", text: expiryLabel(card) ?? "—" });
	const nameCol = metaRow.createDiv();
	nameCol.createDiv({ cls: "fp-card-visual-label", text: "CARDHOLDER" });
	nameCol.createDiv({ cls: "fp-card-visual-name", text: card.cardholderName || card.name });

	renderNetworkMark(face, card.network);
}

/**
 * A stylized, flippable card — tier/issuer/network-driven art (see cards.ts), not literal bank
 * artwork. Click flips it to the back (card number + expiry — never the CVV, which this app never
 * stores). The front's tilt-on-hover still tracks the cursor for a subtle "physical card" feel.
 */
export function renderCardVisual(parent: HTMLElement, card: CardVisualData, cls?: string): HTMLElement {
	const style = cardStyle(card);
	const flip = parent.createDiv({ cls: ["fp-card-visual-flip", cls].filter(Boolean).join(" ") });
	const inner = flip.createDiv({ cls: "fp-card-visual-flip-inner" });
	renderFront(inner, card, style);
	renderBack(inner, card, style);

	flip.addEventListener("click", (ev) => {
		ev.stopPropagation();
		flip.toggleClass("is-flipped", !flip.hasClass("is-flipped"));
	});

	return flip;
}
