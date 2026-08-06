/** Minimal RFC4180-ish CSV codec — no external dependency needed for this plugin's data files. */

export function parseCSV(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

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
		} else if (c === ",") {
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

export function toCSV(rows: (string | number | undefined)[][]): string {
	return (
		rows
			.map((r) =>
				r
					.map((cell) => {
						const s = String(cell ?? "");
						if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
						return s;
					})
					.join(",")
			)
			.join("\n") + "\n"
	);
}
