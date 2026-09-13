import { App, Notice } from "obsidian";
import { FinanceModal } from "../ui/modalStaysOpen";
import type FinancePlugin from "../main";
import { formatMoney } from "../money";
import { findTransferMatches, transferPatches, type TransferPair } from "../transfers";
import { icon } from "../ui/dom";

/**
 * Review and confirm detected transfers between your own accounts.
 *
 * Deliberately not automatic. The matcher is conservative, but "same amount, opposite sign, a few
 * days apart, different accounts" can still describe two unrelated payments — and a wrong link
 * silently removes two real transactions from income and expenses, which is a hard error to ever
 * notice again. So it proposes, you confirm, and every pair shows enough to judge it on.
 */
export class TransferMatchModal extends FinanceModal {
	private pairs: TransferPair[] = [];
	private rejected = new Set<string>();

	constructor(app: App, private plugin: FinancePlugin, private onDone?: () => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal");
		this.contentEl.addClass("fp-account-modal");
		this.pairs = findTransferMatches(this.plugin.store.transactions, { fx: this.plugin.store.fx });
		this.render();
	}

	private accountName(id: string): string {
		return this.plugin.store.accounts.find((a) => a.id === id)?.name ?? id;
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();

		c.createEl("h3", { text: "Transfers between your accounts" });
		c.createDiv({
			cls: "fp-step-desc",
			text: "Moving money between your own accounts is neither income nor expense — but it arrives as two separate rows that nothing connects. Linking them keeps your savings rate, spending and net worth honest.",
		});

		const accepted = this.pairs.filter((p) => !this.rejected.has(p.groupId));

		if (this.pairs.length === 0) {
			c.createEl("p", {
				cls: "fp-step-desc",
				text: "No unlinked transfers found. Either everything is already linked, or both halves of your transfers aren't in the ledger — a transfer to an account this vault doesn't track only ever has one side.",
			});
		} else {
			const bar = c.createDiv({ cls: "fp-rules-apply-bar" });
			bar.createDiv({
				cls: "fp-rules-apply-count",
				text: `${accepted.length} of ${this.pairs.length} pair${this.pairs.length === 1 ? "" : "s"} selected`,
			});
			const applyBtn = bar.createEl("button", { cls: "fp-btn fp-btn-primary" });
			icon(applyBtn, "link");
			applyBtn.createSpan({ text: `Link ${accepted.length} transfer${accepted.length === 1 ? "" : "s"}` });
			if (accepted.length === 0) applyBtn.setAttr("disabled", "true");
			applyBtn.addEventListener("click", () => void this.apply(accepted));

			const wrap = c.createDiv({ cls: "fp-table-scroll" });
			const table = wrap.createEl("table", { cls: "fp-table" });
			const headRow = table.createEl("thead").createEl("tr");
			["", "Out of", "Into", "Amount", "Dates", ""].forEach((h) => headRow.createEl("th", { text: h }));
			const tbody = table.createEl("tbody");

			this.pairs.forEach((pair) => {
				const isRejected = this.rejected.has(pair.groupId);
				const tr = tbody.createEl("tr", { cls: isRejected ? "fp-row-muted" : undefined });

				const checkCell = tr.createEl("td");
				const check = checkCell.createEl("input", { type: "checkbox" });
				check.checked = !isRejected;
				check.addEventListener("change", () => {
					if (check.checked) this.rejected.delete(pair.groupId);
					else this.rejected.add(pair.groupId);
					this.render();
				});

				tr.createEl("td", { text: this.accountName(pair.outflow.accountId) });
				tr.createEl("td", { text: this.accountName(pair.inflow.accountId) });
				tr.createEl("td", {
					cls: "fp-table-num fp-money",
					text: formatMoney(Math.abs(pair.outflow.amount), { currency: pair.outflow.currency || "EUR" }),
				});
				tr.createEl("td", {
					text: pair.daysApart === 0 ? pair.outflow.date : `${pair.outflow.date} → ${pair.inflow.date} (${pair.daysApart}d)`,
				});
				tr.createEl("td", { cls: "fp-transfer-desc", text: pair.outflow.description || "—" });
			});
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const closeBtn = right.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Close" });
		closeBtn.addEventListener("click", () => this.close());
	}

	private async apply(pairs: TransferPair[]): Promise<void> {
		const count = await this.plugin.store.updateTransactions(transferPatches(pairs));
		new Notice(`Linked ${pairs.length} transfer${pairs.length === 1 ? "" : "s"} (${count} rows updated)`);
		this.plugin.refreshViews();
		this.onDone?.();
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
