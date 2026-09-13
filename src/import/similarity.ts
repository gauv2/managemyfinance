import type { Transaction } from "../types";
import { merchantDisplayName, merchantSourceText, merchantKey } from "./merchantKey";

/**
 * "Which other rows are this same payment, more or less?" — the question behind approving one row and
 * wanting the other eleven from the same shop settled with it.
 *
 * There are two very different answers to that, and this module keeps them apart on purpose.
 *
 * The first is merchantKey(): a conservative normalization that strips terminal prefixes, branch
 * numbers, dates and card references, so "CCV*ALBERT HEIJN 1423 DEN HAAG" and "Albert Heijn 5566"
 * land on the same token. Two rows sharing a key are the same merchant as far as this app has ever
 * been willing to claim — categorization, merchant memory and the AI pass all already act on it — so
 * a bulk action over that set is no more of a leap than what happens on every import.
 *
 * The second is fuzzy text similarity, which is a guess. "AH TO GO" and "Albert Heijn" are the same
 * shop to a human and share no key; so are "T-Mobile NL" and "T Mobile Netherlands". But so are
 * "Vo Ty Nguyen" and "Vo Ty Tran" by any string measure, and they are two different people. That
 * asymmetry is why the two tiers are never merged into one ranked list: the exact tier is offered
 * pre-selected, the fuzzy tier is offered unticked, and the difference between them stays visible.
 */

export interface ScoredMatch {
	tx: Transaction;
	/** 0–1, where 1 means the cleaned merchant text is character-for-character identical. */
	score: number;
}

export interface MatchGroups {
	/** The key the subject transaction groups under, when its description carries a name at all. */
	key?: string;
	/** Rows sharing that exact key. Safe enough to act on as a set — this is what the app already does. */
	sameMerchant: Transaction[];
	/** Rows that read like the same payee but don't share the key, most similar first. A guess. */
	similar: ScoredMatch[];
}

export interface MatchOptions {
	/** Minimum similarity for the fuzzy tier. Below ~0.5 unrelated Dutch bank text starts matching. */
	threshold?: number;
	/** Cap on the fuzzy tier — a review modal listing 400 maybes is not a decision anyone can make. */
	limit?: number;
	/** Restricts what's eligible, e.g. "only rows that aren't approved yet". */
	filter?: (tx: Transaction) => boolean;
}

const DEFAULT_THRESHOLD = 0.55;
const DEFAULT_LIMIT = 60;

/**
 * Lowercased, punctuation flattened to spaces, whitespace collapsed.
 *
 * Flattening punctuation matters more than it looks: "T-Mobile NL" and "T Mobile Netherlands" are
 * the same company, but leaving the hyphen in makes "t-mobile" a single token that shares nothing
 * with "t" + "mobile", and the pair scores near zero on the exact comparison it should top.
 */
function normalize(text: string): string {
	return (text ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9äöüéèêáàâíìîóòôúùûñçß]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

/**
 * The cleaned, lowercased merchant text a comparison actually runs on.
 *
 * Read from the same field the merchant key comes from, not from the description regardless. For a
 * card payment the description is the terminal's location and timestamp — "CAPELLE AAN D 18-07-2019
 * 07:30 Pas: 4333" — so comparing descriptions scored every card payment made in one town, on one
 * card, as "100% alike". Sixty unrelated shops arrived pre-ticked under a fuel transaction, and
 * approving them would have filed the lot as Fuel: the amounts alone gave it away, €3.50 and €5.90
 * beside €76 of diesel. "Similar" has to mean a similar payee, or it is worse than no suggestion.
 */
export function comparableText(tx: Pick<Transaction, "description" | "counterparty">): string {
	return normalize(merchantDisplayName(merchantSourceText(tx)));
}

/** Words worth comparing. One-character leftovers carry no identity and inflate every score. */
function tokensOf(text: string): Set<string> {
	return new Set(text.split(/\s+/).filter((t) => t.length > 1));
}

/** Character trigrams, so "t-mobile"/"t mobile" and "shell"/"shell station" still read as close. */
function trigramsOf(text: string): Set<string> {
	const padded = ` ${text.replace(/\s+/g, " ")} `;
	const out = new Set<string>();
	for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
	return out;
}

/** Sørensen–Dice: twice the overlap over the combined size. 1 = identical sets, 0 = disjoint. */
function dice(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const item of a) if (b.has(item)) shared++;
	return (2 * shared) / (a.size + b.size);
}

/**
 * How much of the *shorter* name the longer one contains — the measure Dice is worst at.
 *
 * "Albert Heijn" against "Albert Heijn Den Haag Centraal Station" is the same shop by any human
 * reading, but Dice punishes it to 0.44 purely for the length gap. Containment says 1.0.
 *
 * The danger is that containment says 1.0 just as loudly for "Vo Ty" against "Vo Ty Nguyen", which is
 * a different person — the exact over-merge that made merchantKey's token cap generous in the first
 * place. So it only counts when the shared words are *distinctive*: either one word of six-plus
 * characters, or eight characters across all shared words. "albert heijn" clears that; "vo ty",
 * four characters over two stopword-length tokens, does not.
 */
function containment(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	const shared: string[] = [];
	for (const item of small) if (large.has(item)) shared.push(item);
	if (shared.length === 0) return 0;

	const totalChars = shared.reduce((sum, word) => sum + word.length, 0);
	const distinctive = shared.some((word) => word.length >= 6) || totalChars >= 8;
	if (!distinctive) return 0;

	return shared.length / small.size;
}

interface Profile {
	text: string;
	tokens: Set<string>;
	trigrams: Set<string>;
}

function profile(text: string): Profile {
	return { text, tokens: tokensOf(text), trigrams: trigramsOf(text) };
}

/**
 * How alike two merchant descriptions read, 0–1.
 *
 * The highest of three measures, because each fails on inputs the others handle: word overlap misses
 * "T-Mobile" vs "T Mobile NL" (tokenized differently), character overlap misses a long branch suffix,
 * and both punish the length gap that containment is built for. A pair only has to look the same by
 * one of the three, which is roughly how a person reads them.
 */
export function similarity(a: string, b: string): number {
	const left = normalize(a);
	const right = normalize(b);
	if (!left || !right) return 0;
	if (left === right) return 1;
	return scoreProfiles(profile(left), profile(right));
}

function scoreProfiles(a: Profile, b: Profile): number {
	return Math.max(dice(a.tokens, b.tokens), dice(a.trigrams, b.trigrams), containment(a.tokens, b.tokens));
}

/**
 * Splits everything that looks like `tx` into the two tiers above.
 *
 * `tx` itself is never in either list, and a row is never in both: the fuzzy tier is what's left over
 * after the exact tier has taken its share.
 */
export function findMatches(transactions: Transaction[], tx: Transaction, opts: MatchOptions = {}): MatchGroups {
	const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
	const limit = opts.limit ?? DEFAULT_LIMIT;
	const eligible = opts.filter ?? ((): boolean => true);

	const key = merchantKey(tx);
	const subject = profile(comparableText(tx));

	const sameMerchant: Transaction[] = [];
	const similar: ScoredMatch[] = [];

	for (const other of transactions) {
		if (other.id === tx.id || !eligible(other)) continue;

		if (key && merchantKey(other) === key) {
			sameMerchant.push(other);
			continue;
		}
		// No subject text to compare against means there is nothing to be fuzzy about — a bare
		// reference number must not drag in every other unnameable row.
		if (!subject.text) continue;

		const text = comparableText(other);
		if (!text) continue;
		const score = text === subject.text ? 1 : scoreProfiles(subject, profile(text));
		if (score >= threshold) similar.push({ tx: other, score });
	}

	sameMerchant.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
	similar.sort((a, b) => b.score - a.score || (a.tx.date > b.tx.date ? -1 : 1));

	return { key, sameMerchant, similar: similar.slice(0, limit) };
}

/** Whether pulling up the match sheet would show anything at all — the check before offering it. */
export function hasMatches(groups: MatchGroups): boolean {
	return groups.sameMerchant.length > 0 || groups.similar.length > 0;
}
