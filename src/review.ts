import type { Account, Transaction } from "./types";

/**
 * How far a review pass has got, per account.
 *
 * The Review page's own counters read the whole ledger, which is right for one account and misleading
 * for several: importing a second account made "3,950 approved, 0 to review" the answer no matter
 * which account was selected, so the page said the work was finished while a freshly imported account
 * sat entirely unreviewed inside the same number.
 */
export interface ReviewCounts {
	total: number;
	toReview: number;
	approved: number;
	flagged: number;
	/** Counted regardless of review state — a row can be approved and still have no category. */
	uncategorized: number;
}

export function reviewCounts(transactions: Transaction[]): ReviewCounts {
	const counts: ReviewCounts = { total: transactions.length, toReview: 0, approved: 0, flagged: 0, uncategorized: 0 };
	for (const tx of transactions) {
		if (tx.review === "approved") counts.approved++;
		else if (tx.review === "flagged") counts.flagged++;
		// Absent means "new" — the implicit state of anything that arrived from an import.
		else counts.toReview++;
		if (!tx.categoryId) counts.uncategorized++;
	}
	return counts;
}

export interface AccountReviewProgress {
	account: Account;
	counts: ReviewCounts;
}

/**
 * Per-account progress, accounts with something left to do first.
 *
 * Ordered by what still needs attention rather than alphabetically, because the question this answers
 * is "where is the work" — an account that is entirely approved can wait at the bottom, and an empty
 * account has no work at all so it sits below both.
 */
export function accountReviewProgress(transactions: Transaction[], accounts: Account[]): AccountReviewProgress[] {
	const byAccount = new Map<string, Transaction[]>();
	for (const tx of transactions) {
		const bucket = byAccount.get(tx.accountId);
		if (bucket) bucket.push(tx);
		else byAccount.set(tx.accountId, [tx]);
	}

	return accounts
		.map((account) => ({ account, counts: reviewCounts(byAccount.get(account.id) ?? []) }))
		.sort((a, b) => {
			const outstandingA = a.counts.toReview + a.counts.flagged;
			const outstandingB = b.counts.toReview + b.counts.flagged;
			if (outstandingA !== outstandingB) return outstandingB - outstandingA;
			if (a.counts.uncategorized !== b.counts.uncategorized) return b.counts.uncategorized - a.counts.uncategorized;
			return b.counts.total - a.counts.total;
		});
}

export interface ReviewMilestone {
	title: string;
	detail: string;
	/** Both piles empty — a bigger event than either one, and thrown as such. */
	big: boolean;
}

/**
 * Whether a change to the ledger just finished something worth marking.
 *
 * Pure, and decided from the tallies alone rather than from which button was pressed. The first
 * version of this hung off the review page's own approve/categorize functions, which meant it only
 * fired for two of the fifteen places in the app that write a transaction: clearing your last two
 * flagged rows through the "approve the rest of these too?" sheet finished the whole review and
 * threw nothing. Reading the counts either side of any write catches every path and cannot be
 * forgotten by the next one added.
 *
 * The progress guard is what keeps it honest without knowing the action. Flagging your last
 * unreviewed row empties the review queue, and marking your last flagged row "new" empties the
 * flagged pile — both leave the outstanding total exactly where it was, because nothing was
 * finished, only moved. Requiring the total to fall means a celebration always follows real
 * progress, whatever route the change came in by.
 */
export function reviewMilestone(before: ReviewCounts, after: ReviewCounts): ReviewMilestone | undefined {
	const outstandingBefore = before.toReview + before.flagged;
	const outstandingAfter = after.toReview + after.flagged;
	if (outstandingAfter >= outstandingBefore) return undefined;

	const clearedQueue = before.toReview > 0 && after.toReview === 0;
	const clearedFlags = before.flagged > 0 && after.flagged === 0;
	if (!clearedQueue && !clearedFlags) return undefined;

	const everything = after.toReview === 0 && after.flagged === 0;
	const detail: string[] = [`${after.approved.toLocaleString()} approved`];
	// Said plainly rather than left out. A pile you deliberately parked is still a pile, and a card
	// that implied otherwise would be the one thing here that lies to you.
	if (after.toReview > 0) detail.push(`${after.toReview.toLocaleString()} still waiting for review`);
	if (after.flagged > 0) detail.push(`${after.flagged.toLocaleString()} still flagged for a decision`);
	if (after.uncategorized > 0) detail.push(`${after.uncategorized.toLocaleString()} still without a category`);

	return {
		title: everything ? "Everything is reviewed" : clearedQueue ? "Review complete" : "Flagged pile cleared",
		detail: detail.join(" \u00b7 "),
		big: everything,
	};
}
