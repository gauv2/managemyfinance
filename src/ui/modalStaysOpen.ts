import { Modal } from "obsidian";
import { VIEW_TYPE_FINANCE } from "../constants";

/**
 * Let a dialog survive a click on the rest of Obsidian, and belong to the tab it was opened from.
 *
 * Two problems, one fix each, and the second only exists because of the first.
 *
 * Obsidian closes a modal when its backdrop is clicked, and that backdrop covers the whole window —
 * so reaching a workspace tab means clicking the backdrop first, and a half-filled form is gone
 * before the tab has switched. Anyone who opens "Add account" to go and copy an IBAN out of a note
 * loses everything they had typed, for having looked something up. Making the backdrop transparent to
 * pointer events fixes both halves at once: no click lands on it, so nothing dismisses the dialog,
 * and the click carries through to what is behind, so the tab switch actually happens.
 *
 * That alone leaves the dialog floating over whichever tab you arrived at, which is worse than it
 * sounds — a Create account form hovering over an unrelated note belongs to nothing and looks broken.
 * So the dialog also follows its own view: hidden while the finance tab is not on screen, back
 * exactly as it was when you return. Hidden, never closed, so nothing typed is lost in either
 * direction.
 *
 * A dialog opened where there is no finance view at all — from the settings tab — has no tab to
 * follow and simply stays put. That is decided once, when the dialog opens, so a view appearing or
 * disappearing later cannot change the rules underneath it.
 *
 * Dismissal is unaffected where it was deliberate: Escape still closes, and so does every one of
 * these dialogs' own Cancel button. What goes away is only the accidental kind.
 */
export function keepOpenWhenClickingAway(modal: Modal): void {
	modal.containerEl.addClass("fp-modal-stays-open");

	const { workspace } = modal.app;
	if (workspace.getLeavesOfType(VIEW_TYPE_FINANCE).length === 0) return;

	const apply = (): void => {
		// `clientHeight` rather than the active leaf: a view sharing a split is on screen without being
		// focused, and a dialog that vanished when you clicked the pane beside it would be its own bug.
		const showing = workspace.getLeavesOfType(VIEW_TYPE_FINANCE).some((leaf) => leaf.view.containerEl.clientHeight > 0);
		modal.containerEl.toggleClass("fp-modal-away", !showing);
	};

	// Measured now and again after the frame settles. Some of these events arrive before the layout
	// they describe has reflowed, and a height read at that moment still reports the pane that is on
	// its way out — which showed up as a dialog that only hid itself once something else happened to
	// nudge it. The second pass costs nothing and makes the result independent of that ordering.
	let queued = 0;
	const sync = (): void => {
		apply();
		if (queued) window.cancelAnimationFrame(queued);
		queued = window.requestAnimationFrame(() => {
			queued = 0;
			apply();
		});
	};

	const refs = [workspace.on("active-leaf-change", sync), workspace.on("layout-change", sync), workspace.on("resize", sync)];
	sync();

	// Wrapped rather than replaced: every one of these dialogs has its own onClose doing real work.
	const onClose = modal.onClose.bind(modal);
	modal.onClose = () => {
		if (queued) window.cancelAnimationFrame(queued);
		for (const ref of refs) workspace.offref(ref);
		onClose();
	};
}

/**
 * The base every dialog in this plugin extends, so none of them can forget.
 *
 * The behaviour above was originally opted into one modal at a time, which lasted exactly until the
 * import wizard — three steps and a file into it — evaporated on a click at a workspace tab. A rule
 * that has to be remembered at thirty call sites is a rule that holds at twenty-nine.
 *
 * Applied in `open()` rather than `onOpen()` because every subclass overrides `onOpen` and none of
 * them override `open`, so there is nothing for a subclass to forget to call. Obsidian has built
 * `containerEl` by this point.
 */
export class FinanceModal extends Modal {
	open(): void {
		super.open();
		keepOpenWhenClickingAway(this);
	}
}
