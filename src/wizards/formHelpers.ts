import { moneyInput, type MoneyInputHandle } from "../ui/dom";

/** A labeled `<input>` row — the field building block every wizard step reaches for. Previously
 *  redefined identically in each wizard file; consolidated here once a third wizard (Strategy) needed
 *  the same fields plus one neither existing copy had (formTextAreaField). */
export function formField(
	parent: HTMLElement,
	label: string,
	type: string,
	placeholder?: string,
	extraAttr?: Record<string, string>
): { row: HTMLElement; input: HTMLInputElement } {
	const row = parent.createDiv({ cls: "fp-form-row" });
	row.createEl("label", { text: label });
	const attr = { ...(placeholder ? { placeholder } : {}), ...(extraAttr ?? {}) };
	const input = row.createEl("input", { type, attr: Object.keys(attr).length ? attr : undefined });
	return { row, input };
}

/** A labeled `<select>` whose options are plain strings (value === label). */
export function formSelectField(parent: HTMLElement, label: string, options: string[]): { row: HTMLElement; select: HTMLSelectElement } {
	const row = parent.createDiv({ cls: "fp-form-row" });
	row.createEl("label", { text: label });
	const select = row.createEl("select");
	options.forEach((opt) => select.createEl("option", { text: opt, value: opt }));
	return { row, select };
}

/** A labeled `<select>` whose options carry a value distinct from their label. */
export function formSelectFieldVL(
	parent: HTMLElement,
	label: string,
	options: { value: string; label: string }[]
): { row: HTMLElement; select: HTMLSelectElement } {
	const row = parent.createDiv({ cls: "fp-form-row" });
	row.createEl("label", { text: label });
	const select = row.createEl("select");
	options.forEach((opt) => select.createEl("option", { text: opt.label, value: opt.value }));
	return { row, select };
}

/** A labeled currency-aware money field: a currency `<select>` beside the `moneyInput` control. */
export function formMoneyField(
	parent: HTMLElement,
	label: string,
	currencies: string[],
	opts: { value?: number; currency?: string; onChange: (value: number | undefined) => void }
): { row: HTMLElement; select: HTMLSelectElement; money: MoneyInputHandle } {
	const row = parent.createDiv({ cls: "fp-form-row" });
	row.createEl("label", { text: label });
	const wrap = row.createDiv({ cls: "fp-form-money-wrap" });
	const select = wrap.createEl("select");
	currencies.forEach((c) => select.createEl("option", { text: c, value: c }));
	const money = moneyInput(wrap, {
		value: opts.value,
		currency: opts.currency,
		allowNegative: false,
		onChange: opts.onChange,
	});
	return { row, select, money };
}

/** A labeled `<textarea>` row, for free-text notes fields longer than a single-line input suits. */
export function formTextAreaField(
	parent: HTMLElement,
	label: string,
	placeholder?: string
): { row: HTMLElement; textarea: HTMLTextAreaElement } {
	const row = parent.createDiv({ cls: "fp-form-row" });
	row.createEl("label", { text: label });
	const textarea = row.createEl("textarea", { attr: placeholder ? { placeholder, rows: "3" } : { rows: "3" } });
	return { row, textarea };
}
