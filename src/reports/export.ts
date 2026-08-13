import { categoryChain } from "../categories";
import { toCSV } from "../csv";
import { formatMoney } from "../money";
import type { Account, Category, Transaction } from "../types";
import type { ReportGroup, ReportResult } from "./query";

/**
 * One report, four files.
 *
 * A report is worth having outside Obsidian — attached to a tax return, handed to an accountant,
 * pasted into a spreadsheet — and each destination wants a different shape:
 *
 *   CSV   whatever you're going to load it into
 *   XLS   Excel and Numbers, with the numbers arriving as numbers and dates as dates
 *   HTML  the print dialog, which is where a PDF actually comes from
 *   MD    the vault itself, so the report stays linkable, searchable and Dataview-queryable
 *
 * All four are pure string builders over the same ReportResult, for the same reason the monthly and
 * yearly builders share their calculation modules: an exported file that disagrees with the screen it
 * was exported from is worse than no export at all.
 */

export interface ExportContext {
	title: string;
	/** Human description of the period covered, e.g. "2025" — see describePeriod(). */
	period: string;
	categories: Category[];
	accounts: Account[];
	generatedAt?: string;
	pluginVersion?: string;
	portfolioName?: string;
	/** What the query asked for, in words, for the header of a report someone reads months later. */
	filterSummary?: string[];
}

const COLUMNS = ["Date", "Description", "Counterparty", "Account", "Category", "Subcategory", "Amount", "Currency", "Notes"];

interface Cell {
	text: string;
	/** Present when the cell is genuinely a number — drives real number cells in the spreadsheet. */
	number?: number;
	date?: boolean;
}

function cellsFor(tx: Transaction, ctx: ExportContext): Cell[] {
	const chain = categoryChain(ctx.categories, tx.categoryId);
	const account = ctx.accounts.find((a) => a.id === tx.accountId);
	return [
		{ text: tx.date, date: true },
		{ text: tx.description ?? "" },
		{ text: tx.counterparty ?? "" },
		{ text: account?.name ?? tx.accountId },
		{ text: chain.primary?.name ?? "" },
		{ text: chain.secondary?.name ?? "" },
		// Written with a plain "." decimal point regardless of display preference: these files are read
		// by spreadsheets, which want a machine-readable number, not a localized one.
		{ text: tx.amount.toFixed(2), number: tx.amount },
		{ text: tx.currency || "" },
		{ text: tx.notes ?? "" },
	];
}

// ─── CSV ────────────────────────────────────────────────────────────────────────────────────────

export interface CsvOptions {
	/** ";" for a locale where Excel treats "," as the decimal separator and won't split on it. */
	delimiter?: "," | ";";
	/** A UTF-8 BOM, which is what makes Excel read "café" as "café" rather than "cafÃ©". */
	bom?: boolean;
	/** A few lines of "what this is" above the header. Off by default — most tools want row 1 to be the header. */
	preamble?: boolean;
}

export function buildReportCsv(result: ReportResult, ctx: ExportContext, opts: CsvOptions = {}): string {
	const rows: (string | number | undefined)[][] = [];

	if (opts.preamble) {
		rows.push([ctx.title]);
		rows.push([`Period`, ctx.period]);
		rows.push([`Transactions`, result.count]);
		rows.push([`Total out (${result.baseCurrency})`, result.spent.toFixed(2)]);
		rows.push([`Total in (${result.baseCurrency})`, result.received.toFixed(2)]);
		rows.push([`Net (${result.baseCurrency})`, result.net.toFixed(2)]);
		rows.push([]);
	}

	rows.push(COLUMNS);
	for (const tx of result.rows) rows.push(cellsFor(tx, ctx).map((c) => c.text));

	const csv = toCSV(rows, opts.delimiter ?? ",");
	return opts.bom === false ? csv : `﻿${csv}`;
}

// ─── SpreadsheetML (.xls) ───────────────────────────────────────────────────────────────────────

function xmlEscape(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		// Control characters are not legal in XML 1.0 at all, and one stray byte in a bank description
		// makes Excel refuse the whole file rather than skip the cell.
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

function xmlCell(cell: Cell, styleId?: string): string {
	const style = styleId ? ` ss:StyleID="${styleId}"` : "";
	if (cell.number !== undefined && isFinite(cell.number)) {
		return `<Cell${style}><Data ss:Type="Number">${cell.number.toFixed(2)}</Data></Cell>`;
	}
	return `<Cell${style}><Data ss:Type="String">${xmlEscape(cell.text)}</Data></Cell>`;
}

function xmlRow(cells: string[]): string {
	return `<Row>${cells.join("")}</Row>`;
}

function headerRow(labels: string[]): string {
	return xmlRow(labels.map((l) => xmlCell({ text: l }, "sHeader")));
}

function groupSheet(name: string, label: string, groups: ReportGroup[], currency: string): string {
	const rows = [
		headerRow([label, "Transactions", `Total (${currency})`]),
		...groups.map((g) =>
			xmlRow([xmlCell({ text: g.label }), xmlCell({ text: String(g.count), number: g.count }), xmlCell({ text: "", number: g.total }, "sMoney")])
		),
	];
	return `<Worksheet ss:Name="${xmlEscape(name)}"><Table>${rows.join("")}</Table></Worksheet>`;
}

/**
 * SpreadsheetML 2003 — plain XML that Excel, Numbers and LibreOffice all open natively.
 *
 * Deliberately not .xlsx: that is a ZIP container, and writing one means adding a compression
 * dependency to a plugin whose only current dependency reads spreadsheets rather than writing them.
 * This format is a single text file, needs nothing, and still delivers what CSV can't — bold headers,
 * amounts that arrive as numbers, dates that arrive as dates, and a summary on its own sheet.
 */
export function buildReportXml(result: ReportResult, ctx: ExportContext): string {
	const styles = [
		'<Style ss:ID="sHeader"><Font ss:Bold="1"/><Interior ss:Color="#E9EDF4" ss:Pattern="Solid"/></Style>',
		'<Style ss:ID="sTitle"><Font ss:Bold="1" ss:Size="14"/></Style>',
		'<Style ss:ID="sMoney"><NumberFormat ss:Format="#,##0.00"/></Style>',
		'<Style ss:ID="sDate"><NumberFormat ss:Format="yyyy\\-mm\\-dd"/></Style>',
	].join("");

	const txRows = [
		headerRow(COLUMNS),
		...result.rows.map((tx) => xmlRow(cellsFor(tx, ctx).map((c) => xmlCell(c, c.number !== undefined ? "sMoney" : undefined)))),
	];

	const summaryRows = [
		xmlRow([xmlCell({ text: ctx.title }, "sTitle")]),
		xmlRow([xmlCell({ text: "Period" }, "sHeader"), xmlCell({ text: ctx.period })]),
		...(ctx.portfolioName ? [xmlRow([xmlCell({ text: "Portfolio" }, "sHeader"), xmlCell({ text: ctx.portfolioName })])] : []),
		...(ctx.filterSummary ?? []).map((line) => xmlRow([xmlCell({ text: "Filter" }, "sHeader"), xmlCell({ text: line })])),
		xmlRow([]),
		xmlRow([xmlCell({ text: "Transactions" }, "sHeader"), xmlCell({ text: "", number: result.count })]),
		xmlRow([xmlCell({ text: `Total out (${result.baseCurrency})` }, "sHeader"), xmlCell({ text: "", number: result.spent }, "sMoney")]),
		xmlRow([xmlCell({ text: `Total in (${result.baseCurrency})` }, "sHeader"), xmlCell({ text: "", number: result.received }, "sMoney")]),
		xmlRow([xmlCell({ text: `Net (${result.baseCurrency})` }, "sHeader"), xmlCell({ text: "", number: result.net }, "sMoney")]),
		...(ctx.generatedAt ? [xmlRow([xmlCell({ text: "Generated" }, "sHeader"), xmlCell({ text: ctx.generatedAt })])] : []),
	];

	return [
		'<?xml version="1.0"?>',
		'<?mso-application progid="Excel.Sheet"?>',
		'<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
		`<Styles>${styles}</Styles>`,
		`<Worksheet ss:Name="Summary"><Table>${summaryRows.join("")}</Table></Worksheet>`,
		`<Worksheet ss:Name="Transactions"><Table>${txRows.join("")}</Table></Worksheet>`,
		groupSheet("By category", "Category", result.byCategory, result.baseCurrency),
		groupSheet("By month", "Month", result.byMonth, result.baseCurrency),
		groupSheet("By merchant", "Merchant", result.byMerchant, result.baseCurrency),
		"</Workbook>",
	].join("\n");
}

// ─── Printable HTML (the PDF path) ──────────────────────────────────────────────────────────────

function htmlEscape(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Print styling, inlined.
 *
 * Fixed light colors rather than Obsidian's theme variables: this document is going onto paper (or
 * into a PDF that looks like paper), where a dark theme means an unreadable page and a printer's
 * worth of toner. `thead { display: table-header-group }` is what repeats the column headings on
 * every page of a long transaction list.
 */
const PRINT_CSS = `
/* printToPDF is called with zero hardware margins, so the page padding below *is* the margin. That
   keeps the layout width exactly A4 (794px at 96dpi, matching the render frame) and guarantees
   nothing overflows the sheet. Same arrangement the other plugins in this vault settled on. */
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }

/* Roles, not raw hex, so the palette lives in one place. Fixed light values with no dark variant:
   this document is going onto paper, where "dark mode" means an unreadable page and a cartridge of
   toner. Values are the reference data-viz palette, validated against a white surface. */
:root {
  --ink:        #0b0b0b;
  --ink-2:      #52514e;
  --ink-muted:  #898781;
  --rule:       #e1e0d9;
  --rule-2:     #c3c2b7;
  --surface:    #fcfcfb;
  --series:     #2a78d6;  /* sequential blue 450 — 4.3:1 on white */
  --series-soft:#cde2fb;  /* blue 100, the bar track */
  --neg:        #d03b3b;  /* status critical — 4.7:1 */
  --pos:        #006300;  /* success text step, not the 3.3:1 mark green */
  --warn-edge:  #fab219;
  --warn-bg:    #fdf6e7;
}
body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
       color: var(--ink); background: #fff; margin: 0; padding: 13mm 12mm; font-size: 11.5px; line-height: 1.5;
       -webkit-print-color-adjust: exact; print-color-adjust: exact; }

/* ---- masthead ---- */
.masthead { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px;
            padding-bottom: 10px; border-bottom: 2px solid var(--ink); }
h1 { font-size: 21px; line-height: 1.2; margin: 0; letter-spacing: -0.01em; }
.masthead .period { margin: 3px 0 0; font-size: 12.5px; color: var(--ink-2); }
.masthead .meta { text-align: right; font-size: 9.5px; color: var(--ink-muted); line-height: 1.6; white-space: nowrap; }
.filters { margin: 9px 0 0; }
.filters span { display: inline-block; border: 1px solid var(--rule); border-radius: 10px;
                padding: 1px 8px; margin: 0 4px 4px 0; font-size: 9.5px; color: var(--ink-2); }

/* ---- headline figures: one hero, the rest as a KPI row ---- */
.hero-row { display: flex; gap: 10px; align-items: stretch; margin: 16px 0 4px; }
.hero { flex: 0 0 34%; padding: 12px 14px; border-radius: 10px; background: var(--surface); border: 1px solid var(--rule); }
.hero .label, .tile .label { font-size: 9px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-muted); }
.hero .value { font-size: 32px; font-weight: 650; line-height: 1.1; margin-top: 4px; letter-spacing: -0.02em;
               font-variant-numeric: tabular-nums; }
.hero .sub { font-size: 10px; color: var(--ink-2); margin-top: 3px; }
.tiles { flex: 1; display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.tile { padding: 8px 11px; border-radius: 8px; border: 1px solid var(--rule); }
.tile .value { font-size: 15px; font-weight: 600; margin-top: 1px; font-variant-numeric: tabular-nums; }

/* ---- sections ---- */
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--ink-2);
     margin: 24px 0 9px; padding-bottom: 5px; border-bottom: 1px solid var(--rule); }
section { break-inside: auto; }

/* ---- horizontal bars: magnitude, one hue, labels carry identity ---- */
.bars { display: flex; flex-direction: column; gap: 5px; }
.bar-row { display: grid; grid-template-columns: minmax(90px, 27%) 1fr auto; align-items: center; gap: 10px; break-inside: avoid; }
.bar-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { height: 9px; border-radius: 5px; background: var(--series-soft); overflow: hidden; }
/* Rounded data-end anchored to the baseline: square where it starts, 4px where the value stops. */
.bar-fill { height: 100%; background: var(--series); border-radius: 0 4px 4px 0; }
.bar-value { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; font-weight: 600; }
.bar-share { color: var(--ink-muted); font-weight: 400; margin-left: 5px; }

/* ---- column chart ---- */
.chart { width: 100%; height: auto; break-inside: avoid; }
.chart .axis { stroke: var(--rule-2); stroke-width: 1; }
.chart .col { fill: var(--series); }
.chart .tick { fill: var(--ink-muted); font-size: 8.5px; }
.chart .peak { fill: var(--ink); font-size: 8.5px; font-weight: 600; }

/* ---- tables ---- */
table { width: 100%; border-collapse: collapse; margin-top: 2px; }
th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: .06em;
     color: var(--ink-muted); border-bottom: 1px solid var(--rule-2); padding: 5px 7px; font-weight: 600; }
td { padding: 4px 7px; border-bottom: 1px solid var(--rule); vertical-align: top; }
td.num, th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
tbody tr:nth-child(even) td { background: var(--surface); }
tfoot td { font-weight: 700; border-top: 1.5px solid var(--ink); border-bottom: none; background: #fff; }
.date { color: var(--ink-2); white-space: nowrap; }

/* Sign is always in the glyph itself, so colour here is redundant reinforcement, never the carrier —
   which is what makes a red/green pair acceptable to a reader who can't tell them apart. */
.neg { color: var(--neg); }
.pos { color: var(--pos); }
.muted { color: var(--ink-muted); }
.note { color: var(--ink-muted); font-size: 10px; margin: 0 0 6px; }
.foot { margin-top: 26px; padding-top: 8px; border-top: 1px solid var(--rule);
        color: var(--ink-muted); font-size: 9px; display: flex; justify-content: space-between; gap: 12px; }
.warn { margin-top: 12px; padding: 8px 10px; border-left: 3px solid var(--warn-edge); background: var(--warn-bg);
        font-size: 10.5px; break-inside: avoid; }

@media print {
  /* The body padding is the page margin now, so it must survive printing rather than be reset.
     Repeating the table header is what keeps a transaction list readable past page one. */
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  h2 { page-break-after: avoid; }
  .hero-row, .bars, .chart { page-break-inside: avoid; }
}
`;

function money(amount: number, currency: string): string {
	return formatMoney(amount, { currency });
}

function groupTable(title: string, label: string, groups: ReportGroup[], currency: string): string {
	if (groups.length === 0) return "";
	// Same reasoning as the bar list: a minus and a red on every row of a spending-only report is
	// decoration, not information.
	const mixedSigns = groups.some((g) => g.total > 0) && groups.some((g) => g.total < 0);
	const body = groups
		.map(
			(g) =>
				`<tr><td>${htmlEscape(g.label)}</td><td class="num muted">${g.count}</td><td class="num${
					mixedSigns && g.total < 0 ? " neg" : ""
				}">${htmlEscape(money(mixedSigns ? g.total : Math.abs(g.total), currency))}</td></tr>`
		)
		.join("");
	return `<h2>${htmlEscape(title)}</h2><table><thead><tr><th>${htmlEscape(
		label
	)}</th><th class="num">Rows</th><th class="num">Total</th></tr></thead><tbody>${body}</tbody></table>`;
}

/** Beyond this many bars the list stops being a comparison and becomes a long tail; the rest fold. */
const MAX_BARS = 12;

/**
 * Magnitude across categories, as a sorted horizontal bar list.
 *
 * Horizontal because category names are long and a rotated x-axis label is a tax on the reader.
 * One hue rather than a colour per category: the name is right there on every row, so identity is
 * already carried and a second encoding of it would just be decoration that fails under CVD.
 */
function barList(groups: ReportGroup[], currency: string, total: number): string {
	if (groups.length === 0) return "";

	// When every line has the same sign the report is single-sided, and a minus on all twelve rows
	// (plus red on all twelve) is decoration. Magnitudes read better; the heading carries direction.
	const mixedSigns = groups.some((g) => g.total > 0) && groups.some((g) => g.total < 0);

	const ranked = [...groups].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
	const shown = ranked.slice(0, MAX_BARS);
	const tail = ranked.slice(MAX_BARS);
	if (tail.length > 0) {
		shown.push({
			key: "__other",
			label: `Other (${tail.length} categories)`,
			count: tail.reduce((n, g) => n + g.count, 0),
			total: tail.reduce((n, g) => n + g.total, 0),
		});
	}

	// Scaled against the biggest bar, not the total: the reader is comparing rows to each other, and
	// against-the-total would squash everything into the left margin the moment one category leads.
	const peak = shown.reduce((max, g) => Math.max(max, Math.abs(g.total)), 0) || 1;

	const rows = shown
		.map((g) => {
			const magnitude = Math.abs(g.total);
			const share = total > 0 ? Math.round((magnitude / total) * 100) : 0;
			const shown = mixedSigns ? money(g.total, currency) : money(magnitude, currency);
			return `<div class="bar-row">
<div class="bar-name" title="${htmlEscape(g.label)}">${htmlEscape(g.label)}</div>
<div class="bar-track"><div class="bar-fill" style="width:${Math.max(1.5, (magnitude / peak) * 100).toFixed(1)}%"></div></div>
<div class="bar-value${mixedSigns && g.total < 0 ? " neg" : ""}">${htmlEscape(shown)}<span class="bar-share">${share}%</span></div>
</div>`;
		})
		.join("");

	return `<div class="bars">${rows}</div>`;
}

/**
 * Spend per month as a column chart, drawn as inline SVG.
 *
 * SVG rather than CSS boxes because this one has a baseline and tick labels that have to line up
 * exactly, and because it scales to the page width without reflowing. Only the tallest column is
 * labelled with its value — a number on every column is noise, and the axis carries the rest.
 */
function monthChart(groups: ReportGroup[], currency: string): string {
	if (groups.length < 2) return "";

	const W = 720;
	const H = 118;
	const PAD_BOTTOM = 18;
	const PAD_TOP = 14;
	const plot = H - PAD_BOTTOM - PAD_TOP;
	const peak = groups.reduce((max, g) => Math.max(max, Math.abs(g.total)), 0) || 1;

	// 2px of surface between columns, per the mark spec — adjacent fills must not touch.
	const slot = W / groups.length;
	const barW = Math.max(3, Math.min(34, slot - 2));
	const peakIndex = groups.reduce((best, g, i) => (Math.abs(g.total) > Math.abs(groups[best].total) ? i : best), 0);

	const cols = groups
		.map((g, i) => {
			const h = Math.max(1, (Math.abs(g.total) / peak) * plot);
			const x = i * slot + (slot - barW) / 2;
			const y = PAD_TOP + plot - h;
			const r = Math.min(4, barW / 2, h);
			// Rounded top corners only — the data-end is rounded, the baseline end stays square.
			const path = `M${x.toFixed(1)},${(y + h).toFixed(1)} V${(y + r).toFixed(1)} Q${x.toFixed(1)},${y.toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)} H${(
				x +
				barW -
				r
			).toFixed(1)} Q${(x + barW).toFixed(1)},${y.toFixed(1)} ${(x + barW).toFixed(1)},${(y + r).toFixed(1)} V${(y + h).toFixed(1)} Z`;
			const label = `<text class="tick" x="${(x + barW / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${htmlEscape(monthTick(g.key))}</text>`;
			const value =
				i === peakIndex
					? `<text class="peak" x="${(x + barW / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${htmlEscape(
							money(Math.abs(g.total), currency)
					  )}</text>`
					: "";
			return `<path class="col" d="${path}"/>${label}${value}`;
		})
		.join("");

	return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Spending per month">
<line class="axis" x1="0" y1="${PAD_TOP + plot}" x2="${W}" y2="${PAD_TOP + plot}"/>
${cols}
</svg>`;
}

const MONTH_TICKS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2025-03" → "Mar", or "Mar 25" when the range crosses a year boundary and the month alone is ambiguous. */
function monthTick(key: string): string {
	const index = parseInt(key.slice(5, 7), 10) - 1;
	return index >= 0 && index < 12 ? MONTH_TICKS[index] : key;
}

export interface HtmlOptions {
	/**
	 * How many transactions the document lists. 0 omits the section entirely; Infinity (the default)
	 * lists all of them.
	 *
	 * Uncapped is right for a report you built and exported yourself — you chose the filters, so you
	 * know what you asked for. It is wrong for one that arrives by email every month, where a year of
	 * a real ledger is a fifty-page attachment nobody opens twice. Either way the count and the totals
	 * above it always cover *everything* that matched; only the listing is trimmed, and it says so.
	 */
	maxRows?: number;
}

export function buildReportHtml(result: ReportResult, ctx: ExportContext, opts: HtmlOptions = {}): string {
	const currency = result.baseCurrency;
	const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;

	/**
	 * One hero figure plus a KPI row, rather than five equal tiles.
	 *
	 * A report has a number it is *about* — for a spending report that is what went out — and five
	 * boxes of identical weight make the reader hunt for it. The hero states it once, large; the rest
	 * are the context you check second.
	 */
	/**
	 * A spending-only report has no income, so "Total in €0.00" and a Net that merely restates the
	 * hero are two tiles saying nothing. When only one direction is present the report is single-sided
	 * and the space goes to figures that carry information instead.
	 */
	const singleSided = result.received === 0 || result.spent === 0;
	const leadsWithIncome = result.received > result.spent;

	const hero = {
		label: leadsWithIncome ? "Total in" : "Total out",
		value: money(leadsWithIncome ? result.received : result.spent, currency),
		sub: `across ${result.count} transaction${result.count === 1 ? "" : "s"}`,
	};

	const twoSidedTiles = [
		{ label: leadsWithIncome ? "Total out" : "Total in", value: money(leadsWithIncome ? result.spent : result.received, currency), cls: "" },
		// Net is the one figure whose sign is the point, so it carries the colour — and the glyph.
		{ label: "Net", value: money(result.net, currency), cls: result.net < 0 ? " neg" : " pos" },
	];
	const singleSidedTiles = [
		{ label: "Largest single", value: money(result.largest || Math.abs(result.net), currency), cls: "" },
		{ label: "Categories", value: String(result.byCategory.length), cls: "" },
	];

	const tiles = [
		...(singleSided ? singleSidedTiles : twoSidedTiles),
		{
			label: result.months > 1 ? "Average / month" : "Merchants",
			value: result.months > 1 ? money((leadsWithIncome ? result.received : result.spent) / result.months, currency) : String(result.byMerchant.length),
			cls: "",
		},
		{ label: "Transactions", value: String(result.count), cls: "" },
	]
		.map((t) => `<div class="tile"><div class="label">${htmlEscape(t.label)}</div><div class="value${t.cls}">${htmlEscape(t.value)}</div></div>`)
		.join("");

	// Biggest first when trimming: if only 100 of 4,000 rows fit, the hundred worth printing are the
	// ones that moved the most money, not whichever hundred happen to be most recent.
	const listed = maxRows === Number.POSITIVE_INFINITY ? result.rows : [...result.rows].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, maxRows);
	const trimmed = result.rows.length - listed.length;

	const txBody = listed
		.map((tx) => {
			const cells = cellsFor(tx, ctx);
			const category = [cells[4].text, cells[5].text].filter(Boolean).join(" › ");
			return `<tr><td>${htmlEscape(cells[0].text)}</td><td>${htmlEscape(cells[1].text)}</td><td>${htmlEscape(
				cells[3].text
			)}</td><td>${htmlEscape(category || "—")}</td><td class="num${tx.amount < 0 ? " neg" : ""}">${htmlEscape(
				money(tx.amount, tx.currency || currency)
			)}</td></tr>`;
		})
		.join("");

	const filters = (ctx.filterSummary ?? []).map((f) => `<span>${htmlEscape(f)}</span>`).join("");
	const mixed =
		result.mixedCurrencies.length > 0
			? `<div class="warn">Totals include ${htmlEscape(
					result.mixedCurrencies.join(", ")
			  )} converted at 1:1 — no exchange rate is set for ${result.mixedCurrencies.length === 1 ? "it" : "them"}.</div>`
			: "";

	const generated = ctx.generatedAt ? new Date(ctx.generatedAt).toLocaleString() : "";
	const categoryBars = barList(result.byCategory, currency, result.spent);
	const chart = monthChart(result.byMonth, currency);

	return `<!doctype html>
<html><head><meta charset="utf-8"><title>${htmlEscape(ctx.title)}</title><style>${PRINT_CSS}</style></head>
<body>
<header class="masthead">
  <div>
    <h1>${htmlEscape(ctx.title)}</h1>
    <p class="period">${htmlEscape(ctx.period)}${ctx.portfolioName ? ` · ${htmlEscape(ctx.portfolioName)}` : ""}</p>
  </div>
  <div class="meta">${generated ? `${htmlEscape(generated)}<br>` : ""}${
		ctx.pluginVersion ? `Manage My Finance v${htmlEscape(ctx.pluginVersion)}` : ""
	}</div>
</header>
${filters ? `<p class="filters">${filters}</p>` : ""}

<div class="hero-row">
  <div class="hero">
    <div class="label">${htmlEscape(hero.label)}</div>
    <div class="value">${htmlEscape(hero.value)}</div>
    <div class="sub">${htmlEscape(hero.sub)}</div>
  </div>
  <div class="tiles">${tiles}</div>
</div>
${mixed}
${categoryBars ? `<section><h2>Where it went</h2>${categoryBars}</section>` : ""}
${chart ? `<section><h2>Month by month</h2>${chart}</section>` : ""}
${groupTable("Top merchants", "Merchant", result.byMerchant.slice(0, 15), currency)}
${
	maxRows === 0
		? result.count > 0
			? `<h2>Transactions</h2><p class="muted">${result.count} transaction${
					result.count === 1 ? "" : "s"
			  } — not listed in this summary. The CSV and Excel exports carry every one.</p>`
			: ""
		: `<h2>Transactions</h2>
${trimmed > 0 ? `<p class="note">The ${listed.length} largest of ${result.count}. Totals above cover all ${result.count}; the CSV and Excel exports carry every row.</p>` : ""}
<table><thead><tr><th>Date</th><th>Description</th><th>Account</th><th>Category</th><th class="num">Amount</th></tr></thead>
<tbody>${txBody || '<tr><td colspan="5" class="muted">Nothing matched this report.</td></tr>'}</tbody>
<tfoot><tr><td colspan="4">Net${trimmed > 0 ? " (all " + result.count + " transactions)" : ""}</td><td class="num${
				result.net < 0 ? " neg" : ""
		  }">${htmlEscape(money(result.net, currency))}</td></tr></tfoot>
</table>`
}
<footer class="foot">
  <span>${htmlEscape(ctx.title)} · ${htmlEscape(ctx.period)}</span>
  <span>${htmlEscape(
		[ctx.portfolioName ?? "", generated ? `generated ${generated}` : "", ctx.pluginVersion ? `v${ctx.pluginVersion}` : ""]
			.filter(Boolean)
			.join(" · ")
	)}</span>
</footer>
</body></html>`;
}

// ─── Markdown (the vault note) ──────────────────────────────────────────────────────────────────

function mdEscape(text: string): string {
	// Only the pipe genuinely breaks a markdown table; escaping more would make the note unreadable
	// in source, which defeats the point of writing a note rather than a binary.
	return text.replace(/\|/g, "\\|");
}

function mdTable(headers: string[], rows: string[][]): string {
	if (rows.length === 0) return "_Nothing to report._\n";
	return [
		`| ${headers.join(" | ")} |`,
		`| ${headers.map(() => "---").join(" | ")} |`,
		...rows.map((r) => `| ${r.join(" | ")} |`),
		"",
	].join("\n");
}

function mdGroupTable(label: string, groups: ReportGroup[], currency: string): string {
	return mdTable(
		[label, "Rows", "Total"],
		groups.map((g) => [mdEscape(g.label), String(g.count), money(g.total, currency)])
	);
}

/** How many transaction rows a note lists before it stops — see the note in buildReportMarkdown. */
export const MARKDOWN_ROW_LIMIT = 500;

export function buildReportMarkdown(result: ReportResult, ctx: ExportContext): string {
	const currency = result.baseCurrency;
	const numeric = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

	const frontmatter = [
		"---",
		"type: finance-report",
		"period: custom",
		`title: "${ctx.title.replace(/"/g, '\\"')}"`,
		`range: "${ctx.period}"`,
		`currency: ${currency}`,
		`transactions: ${result.count}`,
		`spent: ${numeric(result.spent)}`,
		`received: ${numeric(result.received)}`,
		`net: ${numeric(result.net)}`,
		...(ctx.portfolioName ? [`portfolio: ${ctx.portfolioName}`] : []),
		...(ctx.generatedAt ? [`generated: ${ctx.generatedAt}`] : []),
		"---",
		"",
	].join("\n");

	const out: string[] = [frontmatter, `# ${ctx.title}\n`];
	if ((ctx.filterSummary ?? []).length > 0) out.push(`${ctx.filterSummary!.map((f) => `\`${f}\``).join(" · ")}\n`);

	out.push(
		mdTable(
			["Metric", "Value"],
			[
				["Transactions", String(result.count)],
				["Total out", money(result.spent, currency)],
				["Total in", money(result.received, currency)],
				["Net", money(result.net, currency)],
				["Largest single expense", money(result.largest, currency)],
				...(result.months > 1 ? [["Average per month", money(result.spent / result.months, currency)]] : []),
			]
		)
	);

	if (result.mixedCurrencies.length > 0) {
		out.push(`> [!warning] Totals include ${result.mixedCurrencies.join(", ")} converted at 1:1 — no exchange rate is set.\n`);
	}

	out.push("## Spending by category\n", mdGroupTable("Category", result.byCategory, currency));
	out.push("## By month\n", mdGroupTable("Month", result.byMonth, currency));
	out.push("## Top merchants\n", mdGroupTable("Merchant", result.byMerchant.slice(0, 25), currency));

	// A note is a document, not a database — the ledger CSVs are already the complete record, and a
	// 4,000-row markdown table is a file Obsidian struggles to render and nobody reads. The cap is
	// stated in the note rather than applied silently, and the CSV/Excel exports carry everything.
	const listed = result.rows.slice(0, MARKDOWN_ROW_LIMIT);
	out.push(`## Transactions\n`);
	if (result.rows.length > listed.length) {
		out.push(`_Showing the first ${listed.length} of ${result.count}. Export to CSV or Excel for the full list._\n`);
	}
	out.push(
		mdTable(
			["Date", "Description", "Account", "Category", "Amount"],
			listed.map((tx) => {
				const cells = cellsFor(tx, ctx);
				const category = [cells[4].text, cells[5].text].filter(Boolean).join(" › ");
				return [cells[0].text, mdEscape(cells[1].text), mdEscape(cells[3].text), mdEscape(category || "—"), money(tx.amount, tx.currency || currency)];
			})
		)
	);

	if (ctx.pluginVersion) out.push(`\n_Generated by Manage My Finance v${ctx.pluginVersion}._\n`);
	return out.join("\n");
}
