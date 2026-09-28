import { App } from "obsidian";
import { PIN_LENGTH } from "../censor";
import { icon } from "../ui/dom";
import { FinanceModal } from "../ui/modalStaysOpen";

/**
 * The keypad Censor mode asks for before it shows amounts again. Takes the digits by click or by
 * keyboard (digits, Backspace, Escape), checks as soon as the fourth one lands, and on a wrong PIN
 * shakes and clears rather than explaining — there's nothing to explain.
 */
export class PinPadModal extends FinanceModal {
	private entered = "";
	private dotsEl!: HTMLElement;
	private readonly onKey = (ev: KeyboardEvent): void => {
		if (/^\d$/.test(ev.key)) this.press(ev.key);
		else if (ev.key === "Backspace") this.backspace();
		else return;
		ev.preventDefault();
	};

	constructor(app: App, private expected: string, private onUnlock: () => void, private title = "Reveal amounts") {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-pin-modal");
		const c = this.contentEl;
		c.createDiv({ cls: "fp-pin-title", text: this.title });
		this.dotsEl = c.createDiv({ cls: "fp-pin-dots" });
		this.renderDots();

		const pad = c.createDiv({ cls: "fp-pin-pad" });
		const key = (label: string, run: () => void, cls = "", face?: { text?: string; icon?: string }) => {
			const btn = pad.createEl("button", { cls: `fp-pin-key ${cls}`.trim() });
			if (face?.icon) icon(btn, face.icon);
			else btn.setText(face?.text ?? label);
			btn.setAttribute("aria-label", label);
			btn.addEventListener("click", run);
		};
		for (const d of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) key(d, () => this.press(d));
		key("Clear", () => this.clear(), "fp-pin-key-fn", { text: "C" });
		key("0", () => this.press("0"));
		key("Delete", () => this.backspace(), "fp-pin-key-fn", { icon: "delete" });

		const cancel = c.createEl("button", { cls: "fp-pin-cancel", text: "Cancel" });
		cancel.addEventListener("click", () => this.close());

		document.addEventListener("keydown", this.onKey);
	}

	onClose(): void {
		document.removeEventListener("keydown", this.onKey);
		this.contentEl.empty();
	}

	private renderDots(): void {
		this.dotsEl.empty();
		for (let i = 0; i < PIN_LENGTH; i++) this.dotsEl.createSpan({ cls: "fp-pin-dot" + (i < this.entered.length ? " is-filled" : "") });
	}

	private press(digit: string): void {
		if (this.entered.length >= PIN_LENGTH) return;
		this.entered += digit;
		this.renderDots();
		if (this.entered.length < PIN_LENGTH) return;
		if (this.entered === this.expected) {
			this.close();
			this.onUnlock();
			return;
		}
		this.modalEl.removeClass("is-wrong");
		// Reflow so the shake replays on a second wrong attempt in a row.
		void this.modalEl.offsetWidth;
		this.modalEl.addClass("is-wrong");
		window.setTimeout(() => this.clear(), 350);
	}

	private backspace(): void {
		this.entered = this.entered.slice(0, -1);
		this.renderDots();
	}

	private clear(): void {
		this.entered = "";
		this.renderDots();
	}
}
