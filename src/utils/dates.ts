/** Normalizes ING/Trade Republic date formats (YYYYMMDD, D/M/YY, or already-ISO) to ISO yyyy-mm-dd. */
export function parseFlexibleDate(raw: string): string {
	const s = raw.trim();
	if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
	// Both ING and Trade Republic exports use the European day/month order (e.g. 27/07/2026), not US month/day.
	const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
	if (m) {
		const [, d, mo, yRaw] = m;
		const y = yRaw.length === 2 ? (Number(yRaw) > 70 ? "19" : "20") + yRaw : yRaw;
		return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
	}
	const parsed = new Date(s);
	if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
	return s;
}
