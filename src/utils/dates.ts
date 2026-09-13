export type DateOrder = "dmy" | "mdy";

/**
 * A two-part-then-year date under any of the separators banks actually use.
 *
 * Slash-only was the original reading, and it quietly excluded every dash-separated export — KNAB
 * writes 28-10-2014, and plenty of European CSVs use dots. The cost was not that those dates went
 * unrecognised: it was that they fell through to `new Date`, which reads "12-08-2019" as month-first
 * regardless of where the file came from, so a European file's dates came out transposed while
 * looking perfectly valid.
 */
const SHORT_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/;

/** Local calendar date, not `toISOString`. A date-only string parsed by `new Date` becomes local
 *  midnight, and converting that to UTC lands on the previous day everywhere east of Greenwich —
 *  which turned 12-08-2019 into 2019-12-07: wrong month *and* a day early. */
function localIsoDate(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/**
 * Works out whether a batch of dates is day-first or month-first, decided once for the whole batch
 * rather than guessed per row.
 *
 * A component above 12 can only be a day, so a single unambiguous date in the batch settles every
 * row — including the ones that looked fine misread the other way. That's the exact shape of bug
 * this exists to catch: a US-formatted export's "08/12/2026" (12 August) silently misreads as 8
 * December under a hardcoded day-first assumption, and nothing about that one row looks wrong on its
 * own — only a sibling row like "08/18/2026" (an impossible month) gives the mismatch away, and by
 * then every row in the file needs the same correction, not just the visibly-broken ones.
 *
 * Falls back to day-first — this plugin's long-standing default for ING/European exports — when
 * every date in the batch happens to fall in the first twelve days of a month, where the ambiguity
 * genuinely can't be resolved from the dates alone.
 */
export function detectDateOrder(dates: string[]): DateOrder {
	for (const raw of dates) {
		const m = SHORT_DATE.exec(raw.trim());
		if (!m) continue;
		const first = parseInt(m[1], 10);
		const second = parseInt(m[2], 10);
		if (first > 12 && second <= 12) return "dmy";
		if (second > 12 && first <= 12) return "mdy";
	}
	return "dmy";
}

/** Normalizes the date formats bank exports actually use (YYYYMMDD, d/m/yy, d-m-yyyy, d.m.yyyy, or
 *  already-ISO) to ISO yyyy-mm-dd.
 *  `order` defaults to day-first, matching ING and Trade Republic's own real exports (e.g.
 *  27/07/2026) — pass the result of `detectDateOrder` run over the whole column for a source (like a
 *  manually column-mapped or US-issued CSV) that isn't guaranteed to be day-first. */
export function parseFlexibleDate(raw: string, order: DateOrder = "dmy"): string {
	const s = raw.trim();
	if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
	// Already ISO (with or without a time on the end) — read directly rather than round-tripped
	// through `new Date`, which is where the timezone shift below came from.
	const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
	const m = s.match(SHORT_DATE);
	if (m) {
		const [, a, b, yRaw] = m;
		const day = order === "dmy" ? a : b;
		const month = order === "dmy" ? b : a;
		const y = yRaw.length === 2 ? (Number(yRaw) > 70 ? "19" : "20") + yRaw : yRaw;
		return `${y}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
	}
	const parsed = new Date(s);
	if (!isNaN(parsed.getTime())) return localIsoDate(parsed);
	return s;
}
