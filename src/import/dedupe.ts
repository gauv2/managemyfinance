import type { Transaction } from "../types";

/**
 * Makes genuinely-repeated transactions distinguishable without breaking re-import safety.
 *
 * Every parser derives a transaction's id by hashing account + date + amount + description, which is
 * what lets you re-import an overlapping export without duplicating anything. The flaw is that two
 * *real* payments that happen to agree on all four — two €3.50 coffees at the same shop on the same
 * day, a bus fare paid twice, two identical top-ups — hash to the same id, so the second one is
 * treated as a duplicate of the first and silently never arrives. That is a wrong ledger that looks
 * completely normal, which is the worst kind.
 *
 * The fix is an occurrence suffix: the first row with a given hash keeps the bare hash, the second
 * becomes "<hash>~2", the third "<hash>~3". Re-importing the same file produces the same rows in the
 * same order and therefore the same suffixes, so every one still matches what's already stored and is
 * still skipped. An export that legitimately contains one *more* of the same coffee than last time
 * yields "~3" as a new id and imports exactly the one new row.
 *
 * The remaining edge: an export that starts mid-day and contains only the *second* of two identical
 * payments will hash it as the first and see it as already present. Preferring a false duplicate to a
 * false new row is the right way round — one loses a row that a fuller export re-supplies, the other
 * quietly inflates spending forever.
 */
export function withOccurrenceSuffixes(transactions: Transaction[]): Transaction[] {
	const seen = new Map<string, number>();
	return transactions.map((tx) => {
		const count = (seen.get(tx.id) ?? 0) + 1;
		seen.set(tx.id, count);
		return count === 1 ? tx : { ...tx, id: `${tx.id}~${count}` };
	});
}

/** How many rows in `transactions` share an id with an earlier row — what the suffixing just rescued. */
export function countRepeatedIds(transactions: Transaction[]): number {
	const seen = new Set<string>();
	let repeats = 0;
	for (const tx of transactions) {
		if (seen.has(tx.id)) repeats++;
		else seen.add(tx.id);
	}
	return repeats;
}
