/**
 * One place that decides what a typed or imported amount actually means, and one place that decides
 * how an amount is written back out.
 *
 * Both halves exist because "." and "," swap roles between locales: a Dutch ING export writes
 * 1.234,56 where an Irish one writes 1,234.56, and the same person types either into a form
 * depending on their keyboard and mood. Every parser here previously did
 * `raw.replace(",", ".")`, which silently turns 1.234,56 into 1.234 — a 1000x error that lands in
 * the ledger looking perfectly plausible. parseMoney() resolves the separators properly instead,
 * and refuses input it can't read rather than guessing a number out of it.
 */

/** How amounts are written when this plugin displays them. "auto" follows the device's own locale. */
export type NumberFormatPreference = "auto" | "dot" | "comma" | "space";

export const NUMBER_FORMAT_LABEL: Record<NumberFormatPreference, string> = {
	auto: "Auto (follow system)",
	dot: "1,234.56",
	comma: "1.234,56",
	space: "1 234,56",
};

/** A representative locale per preference — chosen only for its grouping/decimal separators. */
const LOCALE_BY_PREFERENCE: Record<NumberFormatPreference, string | undefined> = {
	auto: undefined,
	dot: "en-IE",
	comma: "nl-NL",
	space: "fr-FR",
};

let activePreference: NumberFormatPreference = "auto";

/** Set once from settings at load, and again whenever the preference changes, so every formatMoney()
 *  call site stays a plain `formatMoney(n)` instead of threading settings through every render function. */
export function setNumberFormatPreference(pref: NumberFormatPreference | undefined): void {
	activePreference = pref ?? "auto";
}

export function numberFormatPreference(): NumberFormatPreference {
	return activePreference;
}

function activeLocale(): string | undefined {
	return LOCALE_BY_PREFERENCE[activePreference];
}

/** The decimal separator the current preference writes — used to label/placeholder input fields. */
export function decimalSeparator(): string {
	return new Intl.NumberFormat(activeLocale()).formatToParts(1.1).find((p) => p.type === "decimal")?.value ?? ".";
}

// Currency symbols and codes that can sit next to an amount in an export. Stripped before parsing —
// the currency of a transaction comes from its own column, never from decoration on the number.
const CURRENCY_NOISE = /[€$£¥₹¢₽₺₩]|\b(?:EUR|USD|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK|PLN|INR)\b/gi;
// Every space-ish character a bank has ever used as a thousands separator, plus the Swiss apostrophe.
const GROUPING_WHITESPACE = /[\s   ']/g;

/**
 * Reads an amount out of arbitrary text, resolving "." vs "," by structure rather than by assuming a
 * locale. Returns undefined for anything it can't read confidently — callers decide whether that
 * means 0, "leave unset", or a validation error, which is exactly the distinction the old
 * `parseFloat(...) || 0` threw away.
 *
 * Handles: plain numbers, either decimal separator, grouped thousands in either convention, Swiss
 * apostrophe and space grouping, currency symbols/codes, leading and trailing minus signs, and
 * accountancy parentheses for negatives.
 */
export function parseMoney(raw: string | number | null | undefined): number | undefined {
	if (typeof raw === "number") return isFinite(raw) ? raw : undefined;
	if (raw === null || raw === undefined) return undefined;

	let s = String(raw).trim();
	if (!s) return undefined;

	let negative = false;

	// Accountancy style: (1.234,56) means -1234.56.
	if (s.startsWith("(") && s.endsWith(")")) {
		negative = true;
		s = s.slice(1, -1).trim();
	}

	s = s.replace(CURRENCY_NOISE, "").replace(GROUPING_WHITESPACE, "").trim();

	// Some exports put the sign after the number ("1.234,56-"), some in front, some use a lone "+".
	if (s.endsWith("-")) {
		negative = !negative;
		s = s.slice(0, -1);
	} else if (s.endsWith("+")) {
		s = s.slice(0, -1);
	}
	if (s.startsWith("-")) {
		negative = !negative;
		s = s.slice(1);
	} else if (s.startsWith("+")) {
		s = s.slice(1);
	}

	if (!s) return undefined;
	// Anything left that isn't a digit or a separator means this wasn't an amount at all.
	if (!/^[\d.,]+$/.test(s)) return undefined;

	const normalized = normalizeSeparators(s);
	if (normalized === undefined) return undefined;

	const n = Number(normalized);
	if (!isFinite(n)) return undefined;
	return negative ? -n : n;
}

/** Digits-and-separators only. Returns a plain JS-parseable numeric string, or undefined if the
 *  separator layout is contradictory (e.g. "1.234.5,6,7") and shouldn't be guessed at. */
function normalizeSeparators(s: string): string | undefined {
	const lastDot = s.lastIndexOf(".");
	const lastComma = s.lastIndexOf(",");

	if (lastDot !== -1 && lastComma !== -1) {
		// Both present: whichever comes last is the decimal point, the other groups thousands.
		const decimal = lastDot > lastComma ? "." : ",";
		const group = decimal === "." ? "," : ".";
		const withoutGroups = s.split(group).join("");
		// After removing groupings there must be exactly one decimal separator left.
		if (withoutGroups.split(decimal).length !== 2) return undefined;
		return validateNumeric(withoutGroups.replace(decimal, "."));
	}

	const sep = lastDot !== -1 ? "." : lastComma !== -1 ? "," : undefined;
	if (!sep) return validateNumeric(s);

	const parts = s.split(sep);
	const count = parts.length - 1;

	// A clean grouping layout — 1-3 digits, then groups of exactly 3 — is thousands, never decimals.
	// This is what makes "1.234" read as 1234 (the Dutch ING convention) instead of 1.234, and it
	// reads "1,234" the same way, which for money is the right call in both locales.
	const groupingPattern = new RegExp(`^\\d{1,3}(?:\\${sep}\\d{3})+$`);
	if (groupingPattern.test(s)) return validateNumeric(parts.join(""));

	// More than one separator that isn't clean grouping is contradictory input, not a number.
	if (count > 1) return undefined;

	const [whole, fraction] = parts;
	if (fraction === "") return validateNumeric(whole || "0");
	if (whole === "") return validateNumeric(`0.${fraction}`);
	return validateNumeric(`${whole}.${fraction}`);
}

function validateNumeric(s: string): string | undefined {
	return /^\d+(?:\.\d+)?$/.test(s) ? s : undefined;
}

/**
 * parseMoney with a fallback — for import parsers, where a blank or unreadable cell has always meant
 * "no amount on this row" and the row is still worth keeping.
 */
export function parseMoneyOr(raw: string | number | null | undefined, fallback: number): number {
	return parseMoney(raw) ?? fallback;
}

/** Share counts and unit prices aren't currency, but arrive with the same separator ambiguity. */
export function parseDecimal(raw: string | number | null | undefined): number | undefined {
	return parseMoney(raw);
}

export interface FormatMoneyOptions {
	currency?: string;
	/** Drops the currency symbol — for input fields and axis labels that carry their own unit. */
	plain?: boolean;
	minimumFractionDigits?: number;
	maximumFractionDigits?: number;
	/** Prefixes a non-negative value with "+" — for deltas, where the sign is the point. */
	signed?: boolean;
}

/**
 * The single money formatter for the whole plugin. Everything displayed goes through here so one
 * setting flips every amount at once, instead of each section hard-coding its own locale.
 */
export function formatMoney(amount: number, opts: FormatMoneyOptions = {}): string {
	const value = isFinite(amount) ? amount : 0;
	const formatter = new Intl.NumberFormat(activeLocale(), {
		style: opts.plain ? "decimal" : "currency",
		currency: opts.plain ? undefined : opts.currency || "EUR",
		minimumFractionDigits: opts.minimumFractionDigits ?? 2,
		maximumFractionDigits: opts.maximumFractionDigits ?? 2,
	});
	const text = formatter.format(value);
	return opts.signed && value >= 0 ? `+${text}` : text;
}

/** Whole-euro variant for dense tables and tiles where the cents are noise. */
export function formatMoneyRounded(amount: number, currency = "EUR"): string {
	return formatMoney(amount, { currency, minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/**
 * How an amount should be pre-filled into a text input the user will edit: no currency symbol and no
 * thousands grouping (grouping in an editable field is a trap — it re-enters as ambiguous input),
 * but using the preferred decimal separator so the field matches what's displayed elsewhere.
 */
export function formatMoneyForInput(amount: number | undefined): string {
	if (amount === undefined || !isFinite(amount)) return "";
	const fixed = Math.abs(amount) < 1e15 ? String(Math.round(amount * 100) / 100) : String(amount);
	return decimalSeparator() === "," ? fixed.replace(".", ",") : fixed;
}
