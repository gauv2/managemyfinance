import type { Transaction } from "../types";

/**
 * Reduces a bank's description text to a stable merchant key, so that every transaction from the
 * same shop groups together no matter which till, branch or payment terminal produced the row.
 *
 * A real ledger holds the same merchant a dozen ways:
 *
 *     CCV*ALBERT HEIJN 1423 DEN HAAG
 *     Albert Heijn 5566, Amsterdam        01.02.2026 14:33
 *     BEA, Betaalpas  ALBERT HEIJN/PASVOLGNR 003
 *
 * All three become "albert heijn". That single fact is what lets one decision you make apply to
 * every other occurrence — past and future — which is worth more than any per-transaction guess.
 *
 * The normalization is deliberately conservative: it strips things that are provably noise (terminal
 * prefixes, branch numbers, dates, card references) and leaves everything else alone. Over-merging is
 * the dangerous failure here — two different shops sharing a key would silently mis-file a whole
 * merchant's history, which is far worse than failing to group and leaving rows for the review queue.
 */

/** Payment-terminal and processor prefixes glued to the front of a merchant name, e.g. "CCV*". */
const TERMINAL_PREFIXES = [
	"ccv*",
	"ccv ",
	"bck*",
	"nyx*",
	"tmc*",
	"msp*",
	"sumup *",
	"sumup*",
	"zettle_*",
	"zettle *",
	"sq *",
	"sq*",
	"paypal *",
	"paypal*",
	"iz *",
	"iz*",
	"pos ",
];

/**
 * Bank-added wrappers that describe *how* a payment was made rather than *who* was paid. Removed
 * anywhere in the string, since ING and friends put them at the front, the back, or both.
 */
const NOISE_PHRASES = [
	"betaalautomaat",
	"betaalpas",
	"bea, ",
	"bea ",
	"geldautomaat",
	"kaartnummer",
	"pasvolgnr",
	"transactie",
	"terminal",
	"apple pay",
	"google pay",
	"contactloze betaling",
	"incasso algemeen doorlopend",
	"sepa incasso",
	"sepa overboeking",
	"ideal betaling",
	"ideal",
	"machtiging id",
	"omschrijving",
	"valutadatum",
	"naam",
];

/**
 * The same phrases as case-insensitive patterns, compiled once. merchantDisplayName() is called per
 * transaction — by the review queue, and once per row again when hunting for matching descriptions —
 * so building twenty RegExps inside it meant hundreds of thousands of constructions on a real ledger.
 */
const NOISE_PATTERNS = NOISE_PHRASES.map((phrase) => new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));

/**
 * Words a bank puts in front of the actual payee: direction, instrument, and the verb for the
 * movement. Stripped from the front repeatedly, because they otherwise eat the whole token budget —
 * "Transfer from HOOGENDOORN HOLDING BV" reduced to "transfer from", which merged every transfer in
 * the ledger into a single merchant and gave a model nothing to identify.
 */
const LEADING_STOPWORDS = new Set([
	"to",
	"from",
	"van",
	"naar",
	"aan",
	"bij",
	"transfer",
	"payment",
	"betaling",
	"overboeking",
	"overschrijving",
	"incasso",
	"card",
	"pay",
	"purchase",
	"aankoop",
	"the",
]);

/**
 * The words a bank writes around a reference number rather than around a payee.
 *
 * Dutch bank descriptions are frequently nothing but these: "Kenmerk 8002227925600011 Omschrijving
 * Klantnummer" is an invoice reference and says nothing about who was paid — Eneco is in the next
 * column. Left in, they formed keys made entirely of admin vocabulary, and those keys then merged
 * *different companies*: six payees, among them XS4ALL and A.T.O. Electro, all filed together under
 * "factuurnummer" because that is the word their descriptions happened to open with.
 *
 * Only words that are purely administrative, never part of a trading name.
 */
const REFERENCE_WORDS = new Set([
	"kenmerk",
	"betalingskenmerk",
	"factuurnummer",
	"factuur",
	"klantnummer",
	"relatienummer",
	"relnr",
	"rel",
	"nr",
	"nummer",
	"referentie",
	"omschrijving",
	"periode",
	"termijn",
	"btw",
	"iban",
	"bic",
]);

/** A token that's mostly digits, or a known reference marker, carries no merchant identity. */
function isNoiseToken(token: string): boolean {
	if (!token) return true;
	if (REFERENCE_WORDS.has(token)) return true;
	// Pure numbers: branch numbers, till ids, reference numbers.
	if (/^\d+$/.test(token)) return true;
	// Dates and times in any of the shapes a bank export uses.
	if (/^\d{1,4}[-./]\d{1,2}([-./]\d{1,4})?$/.test(token)) return true;
	if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(token)) return true;
	// An IBAN or long alphanumeric reference.
	if (/^[a-z]{2}\d{2}[a-z0-9]{10,}$/.test(token)) return true;
	// Mixed alphanumerics that are majority digits — "1423a", "x0042" — are ids, not names.
	const digits = (token.match(/\d/g) ?? []).length;
	if (digits > 0 && digits >= token.length / 2) return true;
	// Single letters are legal-form debris ("b", "v" from "B.V."), never part of a name.
	if (token.length === 1) return true;
	return false;
}

/**
 * Five tokens — effectively "the whole cleaned name", since branch numbers, dates and references are
 * already gone by the time this applies.
 *
 * This was two, chosen to collapse "ALBERT HEIJN 1423 DEN HAAG" onto "albert heijn". That reasoning
 * was backwards. A two-word key merges *distinct payees*: "To Vo Ty Nguyen", "To Vo Ty Tran" and
 * "To Vo Ty Le" all became "vo ty", so 126 different people were about to be filed under whatever
 * category the first one got.
 *
 * The asymmetry is what matters. Under-merging costs a few extra merchants, and since every unknown
 * merchant is classified automatically and then remembered, that costs nothing the user ever sees.
 * Over-merging silently mis-files a whole group and is invisible until a total looks wrong. So the
 * cap is now generous and the cost is paid on the safe side.
 */
const MAX_TOKENS = 5;

/**
 * A card-terminal receipt line: where and when the card was used, not who was paid.
 *
 * Dutch banks write these as a place, a timestamp and the card's last digits — "BUNNIK 08-11-2014
 * 16:20 Pas: 4333". The shop's name is nowhere in it; it is in the counterparty column beside it.
 */
const TERMINAL_LINE = /\bpas\s*:|\bcard\s*:|\b\d{2}[-/.]\d{2}[-/.]\d{2,4}\b.*\b\d{1,2}:\d{2}\b/i;

/** An account number rather than a name — no use as a merchant identity, and what banks like ING put
 *  in the counterparty column. */
const ACCOUNT_LIKE = /^[a-z]{0,2}[\s\d]*$|^[a-z]{2}\d{2}[a-z0-9]{10,}$/i;

/**
 * Which of the two fields actually names the payee.
 *
 * Description first is right for the banks whose description *is* the merchant, and was the only
 * rule here. It is exactly backwards for a card payment, where the description is the terminal's
 * location and the merchant sits in the counterparty: keying on it collapsed 595 unrelated
 * transactions across one city into a single merchant called "rotterdam pas", which no rule could
 * categorise and no amount of asking a model could rescue — it was being asked what category a city
 * belongs to.
 *
 * So a description that reads as a terminal line defers to the counterparty, unless that is itself
 * an account number, which is what banks that put an IBAN there would offer instead. A description
 * that names nobody at all — a bare reference like "2014-0051" — defers to it too, rather than
 * leaving the row with no merchant identity while the company sits in the next column.
 *
 * Exported because the *label* has to come from the same field as the key. Choosing them separately
 * is how a row ends up correctly grouped under "CCV*Huffels Horeca" while still being shown, and sent
 * to a model, as "UTRECHT 08-11-2014 15:08 Pas: 4333".
 */
export function merchantSourceText(tx: Pick<Transaction, "description" | "counterparty">): string {
	const description = `${tx.description ?? ""}`.trim();
	const counterparty = `${tx.counterparty ?? ""}`.trim();
	const namedCounterparty = counterparty && !ACCOUNT_LIKE.test(counterparty) ? counterparty : "";
	if (namedCounterparty && TERMINAL_LINE.test(description)) return namedCounterparty;
	if (description && keyFrom(description)) return description;
	return namedCounterparty || description || counterparty;
}

/**
 * The stable key for a transaction's merchant, or undefined when the description carries no
 * recognizable name at all (a bare reference number, an empty row). Undefined means "don't group
 * this" — never group everything unrecognizable together under one key.
 */
/**
 * Cached by the two strings it reads, not by transaction identity.
 *
 * `merchantKey` is pure but not cheap — lowercasing, a dozen regex replaces, tokenising — and it is
 * called from everywhere: the review list, similarity matching, the unknown-merchant scan, account
 * stats. A ledger has far fewer distinct descriptions than rows, so the same handful of strings are
 * re-derived thousands of times over.
 *
 * Keyed on the inputs rather than the object because a transaction's description is editable; an
 * identity cache would keep answering with the old name after a row was corrected.
 */
const keyCache = new Map<string, string | undefined>();
/** Bounded so a very large import can't grow this without limit; far above any real vault's count of
 *  distinct descriptions, and clearing wholesale is cheaper than tracking recency. */
const KEY_CACHE_LIMIT = 20000;

export function merchantKey(tx: Pick<Transaction, "description" | "counterparty">): string | undefined {
	const cacheKey = `${tx.description ?? ""}\u0000${tx.counterparty ?? ""}`;
	const hit = keyCache.get(cacheKey);
	if (hit !== undefined || keyCache.has(cacheKey)) return hit;
	const key = keyFrom(merchantSourceText(tx));
	if (keyCache.size >= KEY_CACHE_LIMIT) keyCache.clear();
	keyCache.set(cacheKey, key);
	return key;
}

function keyFrom(raw: string): string | undefined {
	if (!raw) return undefined;

	let s = raw.toLowerCase();

	for (const phrase of NOISE_PHRASES) s = s.split(phrase).join(" ");
	for (const prefix of TERMINAL_PREFIXES) {
		if (s.startsWith(prefix)) {
			s = s.slice(prefix.length);
			break;
		}
	}

	// Everything after a comma or slash is usually the branch/city or a reference tail.
	s = s.split(/[,/|]/)[0];
	// Punctuation becomes spaces so "e-mail" and "e mail" agree; letters and digits survive.
	s = s.replace(/[^a-z0-9äöüéèêáàâíìîóòôúùûñçß\s]/g, " ");

	const tokens = s
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 0 && !isNoiseToken(t));

	// Drop leading connectives, but never everything: a description that is *only* stopwords has no
	// merchant in it, and returning "" would group every such row together.
	while (tokens.length > 1 && LEADING_STOPWORDS.has(tokens[0])) tokens.shift();
	if (tokens.length === 1 && LEADING_STOPWORDS.has(tokens[0])) return undefined;

	if (tokens.length === 0) return undefined;
	// A single one- or two-letter leftover ("bv", "nv") isn't a merchant name.
	if (tokens.length === 1 && tokens[0].length <= 2) return undefined;

	return tokens.slice(0, MAX_TOKENS).join(" ");
}

/**
 * A readable merchant name taken from the original description, for the review queue and for the AI
 * request. Deliberately *not* derived from the key: the key is a grouping token capped at two words,
 * and asking a model to classify "to koninklijke" instead of "Koninklijke PostNL B.V." is why an
 * earlier version had it decline almost everything it was shown.
 *
 * Cleaned of terminal prefixes, references, dates and leading connectives, but otherwise left intact
 * — full name, original capitalization, no token cap.
 */
export function merchantDisplayName(raw: string): string {
	let s = (raw ?? "").trim();
	if (!s) return "";

	const lower = s.toLowerCase();
	for (const prefix of TERMINAL_PREFIXES) {
		if (lower.startsWith(prefix)) {
			s = s.slice(prefix.length);
			break;
		}
	}
	for (const phrase of NOISE_PATTERNS) s = s.replace(phrase, " ");
	s = s.split(/[,/|]/)[0];

	let tokens = s
		.split(/\s+/)
		.map((tok) => tok.trim())
		.filter((tok) => tok.length > 0 && !isNoiseToken(tok.toLowerCase().replace(/[^a-z0-9]/g, "")));

	while (tokens.length > 1 && LEADING_STOPWORDS.has(tokens[0].toLowerCase())) tokens.shift();
	if (tokens.length === 0) return "";

	// SHOUTED bank text reads badly and gives a model no extra signal; anything else keeps its casing.
	const joined = tokens.join(" ");
	if (joined === joined.toUpperCase() && /[A-Z]{3}/.test(joined)) {
		// Same heuristic as merchantLabel: a short word with no vowel is an initialism (BV, NV) and
		// should stay shouted; anything else is a word and shouldn't.
		tokens = tokens.map((tok) =>
			tok.length <= 3 && !/[aeiou]/i.test(tok) ? tok : tok.charAt(0) + tok.slice(1).toLowerCase()
		);
	}
	return tokens.join(" ").trim();
}

/**
 * A human-readable name for a merchant *key*, used where no original description is to hand.
 * Prefer merchantDisplayName() when you have the raw text — it keeps far more of the name.
 */
export function merchantLabel(key: string): string {
	return key
		.split(" ")
		// A short word with no vowel is an initialism (KPN, NL, BV) and reads wrong title-cased;
		// a short word with one is an ordinary word (Lab, One) and reads wrong shouted.
		.map((word) => (word.length <= 3 && !/[aeiouäöüéèêáàâíìîóòôúùû]/.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
		.join(" ");
}
