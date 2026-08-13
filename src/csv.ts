/** Minimal RFC4180-ish CSV codec — no external dependency needed for this plugin's data files. */

/** Some EU bank exports (e.g. ING's Dutch-locale download) use ';' since ',' is their decimal separator. */
function detectDelimiter(text: string): "," | ";" {
	const breakIdx = text.search(/\r\n|\r|\n/);
	const firstLine = breakIdx === -1 ? text : text.slice(0, breakIdx);
	const commas = (firstLine.match(/,/g) ?? []).length;
	const semicolons = (firstLine.match(/;/g) ?? []).length;
	return semicolons > commas ? ";" : ",";
}

export function parseCSV(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	// Strip a UTF-8 BOM (common in Windows-exported bank CSVs) so the first header cell matches cleanly.
	const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const s = withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const delimiter = detectDelimiter(s);

	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (inQuotes) {
			if (c === '"') {
				if (s[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += c;
			}
		} else if (c === '"') {
			inQuotes = true;
		} else if (c === delimiter) {
			row.push(field);
			field = "";
		} else if (c === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else {
			field += c;
		}
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/**
 * The delimiter defaults to "," — the format every data file this plugin writes for itself uses, and
 * the one parseCSV round-trips. ";" exists for exports headed to a spreadsheet in a locale where the
 * comma is the decimal separator: Excel there reads a comma-delimited file as a single column.
 */
export function toCSV(rows: (string | number | undefined)[][], delimiter: "," | ";" = ","): string {
	// Built from the delimiter so a semicolon file quotes the fields that need it, and no others.
	const needsQuoting = new RegExp(`["\\n${delimiter}]`);
	return (
		rows
			.map((r) =>
				r
					.map((cell) => {
						const s = String(cell ?? "");
						if (needsQuoting.test(s)) return '"' + s.replace(/"/g, '""') + '"';
						return s;
					})
					.join(delimiter)
			)
			.join("\n") + "\n"
	);
}
