import { describe, expect, it } from "vitest";
import { accountReviewProgress, reviewCounts, reviewMilestone, type ReviewCounts } from "./review";
import type { Account, Transaction } from "./types";

let n = 0;
function tx(overrides: Partial<Transaction> = {}): Transaction {
	n++;
	return {
		id: `t-${n}`,
		date: "2026-01-01",
		accountId: "acc-a",
		description: "Shop",
		amount: -10,
		currency: "EUR",
		source: "manual",
		...overrides,
	};
}
function acc(id: string, name = id): Account {
	return { id, name, type: "debit", currency: "EUR" };
}

describe("reviewCounts", () => {
	it("treats an absent review state as still to review", () => {
		// That's the implicit state of everything an import brings in.
		expect(reviewCounts([tx()]).toReview).toBe(1);
	});

	it("separates the three states", () => {
		const c = reviewCounts([tx(), tx({ review: "approved" }), tx({ review: "flagged" })]);
		expect(c).toMatchObject({ total: 3, toReview: 1, approved: 1, flagged: 1 });
	});

	it("counts uncategorized regardless of review state", () => {
		// A row can be approved and still have no category; the Review page shows both.
		const c = reviewCounts([tx({ review: "approved" }), tx({ review: "approved", categoryId: "cat-food" })]);
		expect(c.approved).toBe(2);
		expect(c.uncategorized).toBe(1);
	});

	it("is all zeroes for nothing", () => {
		expect(reviewCounts([])).toEqual({ total: 0, toReview: 0, approved: 0, flagged: 0, uncategorized: 0 });
	});
});

describe("accountReviewProgress", () => {
	it("counts each account separately", () => {
		// The bug this exists for: one fully-approved account made a freshly imported one look done.
		const rows = [
			tx({ accountId: "acc-a", review: "approved" }),
			tx({ accountId: "acc-a", review: "approved" }),
			tx({ accountId: "acc-b" }),
		];
		const progress = accountReviewProgress(rows, [acc("acc-a"), acc("acc-b")]);
		const byId = Object.fromEntries(progress.map((p) => [p.account.id, p.counts]));
		expect(byId["acc-a"]).toMatchObject({ approved: 2, toReview: 0 });
		expect(byId["acc-b"]).toMatchObject({ approved: 0, toReview: 1 });
	});

	it("puts the account with outstanding work first", () => {
		const rows = [tx({ accountId: "acc-a", review: "approved" }), tx({ accountId: "acc-b" })];
		expect(accountReviewProgress(rows, [acc("acc-a"), acc("acc-b")])[0].account.id).toBe("acc-b");
	});

	it("counts a flagged row as outstanding, since it is parked rather than done", () => {
		const rows = [tx({ accountId: "acc-a", review: "approved" }), tx({ accountId: "acc-b", review: "flagged" })];
		expect(accountReviewProgress(rows, [acc("acc-a"), acc("acc-b")])[0].account.id).toBe("acc-b");
	});

	it("breaks a tie on uncategorized rows", () => {
		const rows = [
			tx({ accountId: "acc-a", review: "approved", categoryId: "cat-food" }),
			tx({ accountId: "acc-b", review: "approved" }),
		];
		expect(accountReviewProgress(rows, [acc("acc-a"), acc("acc-b")])[0].account.id).toBe("acc-b");
	});

	it("includes an account with nothing in it, at the bottom", () => {
		const progress = accountReviewProgress([tx({ accountId: "acc-a" })], [acc("acc-empty"), acc("acc-a")]);
		expect(progress.map((p) => p.account.id)).toEqual(["acc-a", "acc-empty"]);
		expect(progress[1].counts.total).toBe(0);
	});

	it("ignores rows whose account is not in the list", () => {
		const progress = accountReviewProgress([tx({ accountId: "acc-gone" })], [acc("acc-a")]);
		expect(progress).toHaveLength(1);
		expect(progress[0].counts.total).toBe(0);
	});
});

describe("reviewMilestone", () => {
	const counts = (toReview: number, flagged: number, approved = 100, uncategorized = 0): ReviewCounts => ({
		total: toReview + flagged + approved,
		toReview,
		approved,
		flagged,
		uncategorized,
	});

	it("fires when the last flagged row is cleared, whatever wrote it", () => {
		const m = reviewMilestone(counts(0, 2), counts(0, 0, 102));
		expect(m?.title).toBe("Everything is reviewed");
		expect(m?.big).toBe(true);
	});

	it("names the flagged pile when the review queue is still going", () => {
		const m = reviewMilestone(counts(40, 5), counts(40, 0, 105));
		expect(m?.title).toBe("Flagged pile cleared");
		expect(m?.detail).toContain("40 still waiting for review");
		expect(m?.big).toBe(false);
	});

	it("names the review queue when rows are still flagged", () => {
		const m = reviewMilestone(counts(5, 3), counts(0, 3, 105));
		expect(m?.title).toBe("Review complete");
		expect(m?.detail).toContain("3 still flagged for a decision");
		expect(m?.big).toBe(false);
	});

	// The guard that replaces knowing which button was pressed: both of these empty a pile without
	// finishing anything, and both leave the outstanding total exactly where it was.
	it("stays quiet when flagged rows are only reset back to the queue", () => {
		expect(reviewMilestone(counts(0, 3), counts(3, 0))).toBeUndefined();
	});

	it("stays quiet when the last unreviewed rows are only flagged", () => {
		expect(reviewMilestone(counts(3, 0), counts(0, 3))).toBeUndefined();
	});

	it("stays quiet when nothing was outstanding to begin with", () => {
		expect(reviewMilestone(counts(0, 0), counts(0, 0))).toBeUndefined();
	});

	it("stays quiet on progress that does not empty a pile", () => {
		expect(reviewMilestone(counts(10, 4), counts(6, 4, 104))).toBeUndefined();
	});

	it("mentions rows left without a category", () => {
		const m = reviewMilestone(counts(0, 2), counts(0, 0, 102, 12));
		expect(m?.detail).toBe("102 approved · 12 still without a category");
	});
});
