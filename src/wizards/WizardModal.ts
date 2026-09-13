import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { icon } from "../ui/dom";

/** Handed to a step's render() so it can tell the shell that its validity has changed. */
export interface WizardControls {
	/** Re-evaluates canGoNext and repaints the footer. Call after a control changes step validity. */
	refreshFooter(): void;
}

export interface WizardStep {
	id: string;
	title: string;
	icon: string;
	render: (container: HTMLElement, wizard: WizardControls) => void | Promise<void>;
	canGoNext?: () => boolean;
	/** Shown beside a disabled Next, saying what is still missing. Without it a blocked step just
	 *  looks like a button that does nothing when pressed. */
	blockedReason?: () => string | undefined;
	onNext?: () => void | Promise<void>;
	nextLabel?: string;
	/** Shows a ghost "Skip" action alongside Next — bypasses canGoNext and onNext, just advances (or closes on the last step). */
	skippable?: boolean;
	skipLabel?: string;
	onSkip?: () => void | Promise<void>;
}

/**
 * Generic multi-step modal shell: numbered/iconed stepper header, swappable body, Back/Next footer.
 * Used for focused, self-contained tasks like importing a file. First-run setup lives in SetupView
 * instead, since that's a full-tab experience rather than a dialog.
 */
export class WizardModal extends FinanceModal {
	/**
	 * The one wizard allowed on screen at a time.
	 *
	 * A wizard holds several steps of work — a parsed file, a column mapping, a set of answers from a
	 * model — and running the command again opened a second one on top of the first. Since the
	 * backdrop stopped swallowing clicks so a dialog could survive a tab switch, that became easy to do
	 * by accident, and the failure looks like the tool losing your work: finishing the import closed
	 * the top wizard and revealed the untouched one underneath, which reads exactly like being sent
	 * back to step one with nothing imported.
	 */
	private static current?: WizardModal;

	private stepIndex = 0;
	private steps: WizardStep[];
	private stepsEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private footerEl!: HTMLElement;
	private wizTitle: string;
	private wizSubtitle: string;
	private wizIcon: string;

	private buildStamp?: string;

	open(): void {
		const existing = WizardModal.current;
		if (existing && existing !== this) {
			// Returned to rather than replaced: the one already open is the one with the work in it.
			new Notice("That wizard is already open.");
			existing.containerEl.removeClass("fp-modal-away");
			return;
		}
		WizardModal.current = this;
		super.open();
	}

	constructor(
		app: App,
		opts: { title: string; subtitle: string; icon: string; steps: WizardStep[]; buildStamp?: string; initialStepId?: string }
	) {
		super(app);
		this.steps = opts.steps;
		this.wizTitle = opts.title;
		this.wizSubtitle = opts.subtitle;
		this.wizIcon = opts.icon;
		this.buildStamp = opts.buildStamp;
		// Lets a caller reopen a long wizard at a specific step (e.g. "Review now" jumping straight to
		// the review-cadence step) instead of always marching back through everything already set.
		// Falls back to the first step rather than throwing if the id doesn't match anything.
		if (opts.initialStepId) {
			const idx = this.steps.findIndex((s) => s.id === opts.initialStepId);
			if (idx >= 0) this.stepIndex = idx;
		}
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		this.contentEl.addClass("fp-wizard");

		const head = this.contentEl.createDiv({ cls: "fp-wizard-header" });
		icon(head.createDiv({ cls: "fp-wizard-header-icon" }), this.wizIcon);
		const headText = head.createDiv({ cls: "fp-wizard-header-text" });
		headText.createDiv({ cls: "fp-wizard-title", text: this.wizTitle });
		headText.createDiv({ cls: "fp-wizard-subtitle", text: this.wizSubtitle });
		// Which build produced this dialog. Obsidian only re-reads a plugin on toggle or restart, so a
		// rebuilt main.js can sit on disk while the old one is still running — and every screenshot of
		// this wizard would otherwise be ambiguous about which code produced it.
		if (this.buildStamp) head.createDiv({ cls: "fp-wizard-build", text: this.buildStamp });

		this.stepsEl = this.contentEl.createDiv({ cls: "fp-wizard-steps" });
		this.bodyEl = this.contentEl.createDiv({ cls: "fp-wizard-body" });
		this.footerEl = this.contentEl.createDiv({ cls: "fp-wizard-footer" });

		void this.renderStep();
	}

	onClose(): void {
		if (WizardModal.current === this) WizardModal.current = undefined;
		this.contentEl.empty();
	}

	private renderStepsIndicator(): void {
		this.stepsEl.empty();
		// A stepper implies steps to step through — one step has nothing to indicate.
		this.stepsEl.toggleClass("is-hidden", this.steps.length <= 1);
		if (this.steps.length <= 1) return;
		this.steps.forEach((step, i) => {
			const cls = ["fp-wizard-step"];
			if (i === this.stepIndex) cls.push("is-active");
			if (i < this.stepIndex) cls.push("is-done");
			const dot = this.stepsEl.createDiv({ cls: cls.join(" ") });
			const circle = dot.createDiv({ cls: "fp-wizard-step-circle" });
			icon(circle, i < this.stepIndex ? "check" : step.icon);
			dot.createDiv({ cls: "fp-wizard-step-label", text: step.title });
			if (i < this.steps.length - 1) {
				this.stepsEl.createDiv({ cls: "fp-wizard-step-line" + (i < this.stepIndex ? " is-done" : "") });
			}
		});
	}

	private readonly controls: WizardControls = {
		refreshFooter: () => this.renderFooter(),
	};

	private async renderStep(): Promise<void> {
		this.renderStepsIndicator();
		this.bodyEl.empty();
		const step = this.steps[this.stepIndex];
		await step.render(this.bodyEl, this.controls);
		this.renderFooter();
	}

	private renderFooter(): void {
		this.footerEl.empty();
		const left = this.footerEl.createDiv({ cls: "fp-wizard-footer-left" });
		const right = this.footerEl.createDiv({ cls: "fp-wizard-footer-right" });

		if (this.stepIndex > 0) {
			const back = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Back" });
			back.addEventListener("click", () => {
				this.stepIndex--;
				void this.renderStep();
			});
		} else {
			const cancel = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel" });
			cancel.addEventListener("click", () => this.close());
		}

		const step = this.steps[this.stepIndex];
		const isLast = this.stepIndex === this.steps.length - 1;

		if (step.skippable) {
			const skip = right.createEl("button", { cls: "fp-btn fp-btn-ghost", text: step.skipLabel ?? "Skip" });
			skip.addEventListener("click", async () => {
				if (step.onSkip) await step.onSkip();
				this.close();
			});
		}

		// A step that can't be advanced now says so, and looks unavailable. It used to render as a
		// normal button that silently did nothing, which reads as the wizard being broken.
		const blocked = !!step.canGoNext && !step.canGoNext();
		const reason = blocked ? step.blockedReason?.() : undefined;
		if (reason) right.createSpan({ cls: "fp-wizard-blocked-reason", text: reason });

		const next = right.createEl("button", {
			cls: "fp-btn fp-btn-primary",
			text: step.nextLabel ?? (isLast ? "Finish" : "Next"),
		});
		next.disabled = blocked;
		if (reason) next.setAttribute("title", reason);
		next.addEventListener("click", async () => {
			if (step.canGoNext && !step.canGoNext()) return;
			if (step.onNext) await step.onNext();
			if (isLast) {
				this.close();
			} else {
				this.stepIndex++;
				await this.renderStep();
			}
		});
	}
}
