import { convert, type FxContext } from "./currency";
import { stableHash } from "./hash";
import type { Transaction } from "./types";

/**
 * Pairing the two halves of your own money moving between your own accounts.
 *
 * Why this has to exist: a checking → savings move arrives as two independent rows from two separate
 * exports — a debit in one account and a credit in the other. Nothing in a bank export says they are
 * the same event. Summed naively, that one movement inflates income *and* expenses, which then
 * corrupts savings rate, personal inflation, the FI ratio and every year-over-year delta built on
 * them. Categorizing rows as "Transfers" catches some of it, but only when you remember to, and a
 * transfer between two everyday accounts usually looks like an ordinary payment.
 *
 * The match is deliberately conservative: same magnitude, opposite direction, different accounts,
 * within a few days. Two legs that meet all four are a transfer far more often than they are a
 * coincidence — and where it does misfire, unlinking is one click and leaves the rows untouched.
 */

export interface TransferMatchOptions {
	/** How many days apart the two legs may be — banks post the two sides on different days. */
	maxDaysApart?: number;
	/** Amounts must agree to within this much (rounding, and the odd sub-cent FX difference). */
	amountTolerance?: number;
	/** Converts both legs to base currency before comparing, so a EUR→USD move can still pair up. */
	fx?: FxContext;
}

const DEFAULT_MAX_DAYS_APART = 3;
const DEFAULT_AMOUNT_TOLERANCE = 0.01;

export interface TransferPair {
	/** The leg money left (negative amount). */
	outflow: Transaction;
	/** The leg money arrived in (positive amount). */
	inflow: Transaction;
	/** Shared id written onto both legs. Derived from the two transaction ids, so re-running the
	 *  matcher on the same pair produces the same group rather than a fresh one every time. */
	groupId: string;
	/** Whole days between the two legs — surfaced so a UI can show how close a match actually was. */
	daysApart: number;
}

/** A deterministic group id for two legs, independent of which order they were matched in. */
export function transferGroupId(idA: string, idB: string): string {
	const [first, second] = [idA, idB].sort();
	return `xfer-${stableHash([first, second])}`;
}

function dayNumber(date: string): number | undefined {
	const ms = Date.parse(`${(date || "").slice(0, 10)}T00:00:00Z`);
	return isNaN(ms) ? undefined : Math.round(ms / 86_400_000);
}

/**
 * Finds every unlinked pair of legs that look like one transfer.
 *
 * Greedy and closest-first: candidates are scored by how far apart the two legs are in time, so when
 * a €500 outflow could pair with two different €500 inflows, the nearer one wins and the other stays
 * free to match something else. Each transaction is used at most once, and anything already carrying
 * a transferGroupId is left completely alone — re-running this is safe and only ever adds links.
 */
export function findTransferMatches(transactions: Transaction[], opts: TransferMatchOptions = {}): TransferPair[] {
	const maxDaysApart = opts.maxDaysApart ?? DEFAULT_MAX_DAYS_APART;
	const tolerance = opts.amountTolerance ?? DEFAULT_AMOUNT_TOLERANCE;

	const candidates = transactions.filter((t) => !t.transferGroupId && t.amount !== 0 && dayNumber(t.date) !== undefined);
	const outflows = candidates.filter((t) => t.amount < 0).sort((a, b) => a.date.localeCompare(b.date));
	const inflows = candidates.filter((t) => t.amount > 0).sort((a, b) => a.date.localeCompare(b.date));

	const baseAmount = (tx: Transaction): number => Math.abs(opts.fx ? convert(tx.amount, tx.currency, opts.fx) : tx.amount);

	const used = new Set<string>();
	const pairs: TransferPair[] = [];

	for (const outflow of outflows) {
		if (used.has(outflow.id)) continue;
		const outDay = dayNumber(outflow.date)!;
		const outAmount = baseAmount(outflow);

		let best: { inflow: Transaction; daysApart: number } | undefined;
		for (const inflow of inflows) {
			if (used.has(inflow.id)) continue;
			if (inflow.accountId === outflow.accountId) continue;
			if (Math.abs(baseAmount(inflow) - outAmount) > tolerance) continue;
			const daysApart = Math.abs(dayNumber(inflow.date)! - outDay);
			if (daysApart > maxDaysApart) continue;
			if (!best || daysApart < best.daysApart) best = { inflow, daysApart };
			if (daysApart === 0) break;
		}
		if (!best) continue;

		used.add(outflow.id);
		used.add(best.inflow.id);
		pairs.push({
			outflow,
			inflow: best.inflow,
			groupId: transferGroupId(outflow.id, best.inflow.id),
			daysApart: best.daysApart,
		});
	}

	return pairs;
}

/** The patches that apply a set of matches — one `transferGroupId` per leg, ready for updateTransactions. */
export function transferPatches(pairs: TransferPair[]): Map<string, Partial<Transaction>> {
	const patches = new Map<string, Partial<Transaction>>();
	for (const pair of pairs) {
		patches.set(pair.outflow.id, { transferGroupId: pair.groupId });
		patches.set(pair.inflow.id, { transferGroupId: pair.groupId });
	}
	return patches;
}

/** The other leg (or legs, if something odd happened) of a linked transfer. */
export function transferSiblings(transactions: Transaction[], tx: Transaction): Transaction[] {
	if (!tx.transferGroupId) return [];
	return transactions.filter((t) => t.transferGroupId === tx.transferGroupId && t.id !== tx.id);
}
