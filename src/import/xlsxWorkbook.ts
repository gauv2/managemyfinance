import readXlsxFile from "read-excel-file/browser";
import { detectFormat, DetectedFormat } from "./detect";
import { KNAB_HEADERS, looksLikeKnabSheet } from "./knabSheet";

export interface DetectedTable {
	sheetName: string;
	format: DetectedFormat;
	headers: string[];
	rows: string[][];
}

function cellToString(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (v instanceof Date) {
		const y = v.getFullYear();
		const m = String(v.getMonth() + 1).padStart(2, "0");
		const d = String(v.getDate()).padStart(2, "0");
		return `${y}-${m}-${d}`;
	}
	return String(v);
}

/**
 * Reads every sheet in the workbook and keeps only the ones that look like a known bank/broker
 * export (by header row) — e.g. a combined "Finance Overview" workbook with one ING/TR sheet per
 * year. Sheets that don't match a known format (dashboards, summaries, charts) are skipped.
 */
export async function extractTransactionTables(data: ArrayBuffer): Promise<DetectedTable[]> {
	const sheets = await readXlsxFile(data);
	const tables: DetectedTable[] = [];
	for (const sheet of sheets) {
		const rows = sheet.data;
		if (rows.length === 0) continue;

		// A sheet with no header row at all — its first cell is already a transaction. Recognising the
		// layout by content supplies the names the rest of the pipeline reads, so KNAB imports on the
		// same path as every bank whose export bothers to label its columns.
		if (looksLikeKnabSheet(rows)) {
			const headers = [...KNAB_HEADERS];
			tables.push({
				sheetName: sheet.sheet,
				format: detectFormat(headers),
				headers,
				// Every row is data here; there is no header line to skip.
				rows: rows.map((r) => headers.map((_, i) => cellToString(r[i]))),
			});
			continue;
		}

		const headers = rows[0].map((c) => cellToString(c).trim());
		const format: DetectedFormat = detectFormat(headers);
		if (format === "unknown") continue;
		const dataRows = rows.slice(1).map((r) => headers.map((_, i) => cellToString(r[i])));
		tables.push({ sheetName: sheet.sheet, format, headers, rows: dataRows });
	}
	return tables;
}
