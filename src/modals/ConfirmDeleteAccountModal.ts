import { App } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import { icon } from "../ui/dom";

export interface AccountDeletionImpact {
	transactions: number;
	snapshots: number;
	cards: number;
	subscriptions: number;
	debts: number;
}

/**
 * What deleting an account actually costs, said out loud before it happens.
 *
 * Removing an account used to take no confirmation at all and clean up only its cards, which left
 * every transaction filed against it in the ledger with no account to belong to. Those rows are not
 * inert: they go on counting in spending, budgets, categories and every report, while being
 * unreachable from anywhere in the UI — the account page they'd open from no longer exists. An
 * account is described to the user as "a separate container for this account's transactions", so
 * emptying the container and keeping the contents was never a coherent outcome.
 *
 * Both outcomes are offered rather than one being chosen for them, because both are legitimate: a
 * duplicate account created by mistake should take its rows with it, while an account being retired
 * in favour of another may want its history moved first. What is not offered is doing it silently.
 */
export class ConfirmDeleteAccountModal extends FinanceModal {
	constructor(
		app: App,
		private accountName: string,
		private impact: AccountDeletionImpact,
		private onChoice: (deleteTransactions: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		const c = this.contentEl;
		c.addClass("fp-account-modal");

		c.createEl("h3", { text: `Delete "${this.accountName}"?` });

		const { transactions, snapshots, cards, subscriptions, debts } = this.impact;
		const attached: string[] = [];
		if (transactions > 0) attached.push(`${transactions.toLocaleString()} transaction${transactions === 1 ? "" : "s"}`);
		if (snapshots > 0) attached.push(`${snapshots} recorded balance${snapshots === 1 ? "" : "s"}`);
		if (cards > 0) attached.push(`${cards} card${cards === 1 ? "" : "s"}`);

		if (attached.length === 0) {
			c.createEl("p", { cls: "fp-step-desc", text: "Nothing is filed against this account, so removing it takes nothing with it." });
			this.renderFooter(c, false);
			return;
		}

		c.createEl("p", { cls: "fp-step-desc", text: `This account holds ${listOf(attached)}.` });

		if (transactions > 0) {
			c.createEl("p", {
				cls: "fp-step-desc",
				text: "Keeping them leaves them in the ledger with no account: they go on counting in spending, budgets and every report, but nothing in the app can open them again. Deleting them removes them from the ledger for good.",
			});
		}

		// Mentioned separately: these only *point* at the account, so neither choice destroys them and
		// neither leaves them broken — the reference is simply cleared.
		const referencing: string[] = [];
		if (subscriptions > 0) referencing.push(`${subscriptions} subscription${subscriptions === 1 ? "" : "s"}`);
		if (debts > 0) referencing.push(`${debts} debt${debts === 1 ? "" : "s"}`);
		if (referencing.length > 0) {
			c.createEl("p", {
				cls: "fp-field-hint",
				text: `${capitalize(listOf(referencing))} refer to this account. They are kept — only the reference is cleared.`,
			});
		}

		this.renderFooter(c, transactions > 0 || snapshots > 0);
	}

	private renderFooter(c: HTMLElement, offerKeep: boolean): void {
		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const cancel = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel" });
		cancel.addEventListener("click", () => this.close());

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		if (offerKeep) {
			const keep = right.createEl("button", { cls: "fp-btn fp-btn-secondary", text: "Keep the transactions" });
			keep.addEventListener("click", () => {
				this.onChoice(false);
				this.close();
			});
		}
		const del = right.createEl("button", { cls: "fp-btn fp-btn-danger" });
		icon(del, "trash-2");
		del.createSpan({ text: offerKeep ? "Delete everything" : "Delete account" });
		del.addEventListener("click", () => {
			this.onChoice(true);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function listOf(parts: string[]): string {
	if (parts.length <= 1) return parts[0] ?? "";
	return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
