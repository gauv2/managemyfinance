import { App, Modal } from "obsidian";
import { icon } from "../ui/dom";

export interface WizardStep {
	id: string;
	title: string;
	icon: string;
	render: (container: HTMLElement) => void | Promise<void>;
	canGoNext?: () => boolean;
	onNext?: () => void | Promise<void>;
	nextLabel?: string;
}

/**
 * Generic multi-step modal shell: numbered/iconed stepper header, swappable body, Back/Next footer.
 * Feature wizards (onboarding, import) supply the steps; this only owns navigation and chrome.
 */
export class WizardModal extends Modal {
	private stepIndex = 0;
	private steps: WizardStep[];
	private stepsEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private footerEl!: HTMLElement;
	private wizTitle: string;
	private wizSubtitle: string;
	private wizIcon: string;

	constructor(app: App, opts: { title: string; subtitle: string; icon: string; steps: WizardStep[] }) {
		super(app);
		this.steps = opts.steps;
		this.wizTitle = opts.title;
		this.wizSubtitle = opts.subtitle;
		this.wizIcon = opts.icon;
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		this.contentEl.addClass("fp-wizard");

		const head = this.contentEl.createDiv({ cls: "fp-wizard-header" });
		icon(head.createDiv({ cls: "fp-wizard-header-icon" }), this.wizIcon);
		const headText = head.createDiv({ cls: "fp-wizard-header-text" });
		headText.createDiv({ cls: "fp-wizard-title", text: this.wizTitle });
		headText.createDiv({ cls: "fp-wizard-subtitle", text: this.wizSubtitle });

		this.stepsEl = this.contentEl.createDiv({ cls: "fp-wizard-steps" });
		this.bodyEl = this.contentEl.createDiv({ cls: "fp-wizard-body" });
		this.footerEl = this.contentEl.createDiv({ cls: "fp-wizard-footer" });

		void this.renderStep();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderStepsIndicator(): void {
		this.stepsEl.empty();
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

	private async renderStep(): Promise<void> {
		this.renderStepsIndicator();
		this.bodyEl.empty();
		const step = this.steps[this.stepIndex];
		await step.render(this.bodyEl);
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
		const next = right.createEl("button", {
			cls: "fp-btn fp-btn-primary",
			text: step.nextLabel ?? (isLast ? "Finish" : "Next"),
		});
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
