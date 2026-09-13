import { describe, expect, it } from "vitest";
import { forecastSinkingFund } from "./sinkingFund";
import type { ForecastStore } from "../types";
import type { Account, Category, Transaction } from "../../types";

const CHECKING: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR" };
const MEDICAL = "cat-medical";
const REPAIRS = "cat-repairs";
const FILLER = "cat-filler";

const CATEGORIES: Category[] = [
	{ id: MEDICAL, name: "Medical", color: "#000", icon: "tag", aliases: [] },
	{ id: REPAIRS, name: "Repairs", color: "#000", icon: "tag", aliases: [] },
	{ id: FILLER, name: "Filler", color: "#000", icon: "tag", aliases: [] },
];

let nextId = 0;
function tx(date: string, amount: number, categoryId: string, counterparty: string): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, date, accountId: CHECKING.id, description: counterparty, counterparty, amount, currency: "EUR", categoryId, source: "manual" };
}

/** Spreads real tracked months across 2018–2025 (via an unrelated category) so every calendar year
 *  has the >= 8 tracked months §16's coverage rule requires — including the years Medical/Repairs
 *  themselves had nothing at all, which must still count as a real tracked €0 year. */
function fillerTransactions(): Transaction[] {
	const out: Transaction[] = [];
	for (let year = 2018; year <= 2025; year++) {
		for (let month = 1; month <= 10; month++) {
			out.push(tx(`${year}-${String(month).padStart(2, "0")}-20`, -5, FILLER, "Grocery Store"));
		}
	}
	return out;
}

function store(categoryTx: Transaction[]): ForecastStore {
	return { accounts: [CHECKING], categories: CATEGORIES, transactions: [...categoryTx, ...fillerTransactions()] };
}

describe("forecastSinkingFund — Medical (the spec's own worked example, §33)", () => {
	// 2019 €500, 2020 €0, 2021 €1,200, 2022 €400, 2023 €1,800, 2024 €700, 2025 €900 — plus a genuine
	// tracked €0 in 2018 from the filler coverage, for 8 comparable years total.
	const medicalByYear: Record<number, number> = { 2019: 500, 2021: 1200, 2022: 400, 2023: 1800, 2024: 700, 2025: 900 };
	const medicalTx = Object.entries(medicalByYear).map(([year, amount]) => tx(`${year}-03-15`, -amount, MEDICAL, "General Hospital"));
	const target = { from: "2026-06-01", to: "2026-06-30", label: "June 2026" };
	const result = forecastSinkingFund(store(medicalTx), { categoryId: MEDICAL, target, scope: "leaf" });

	it("aggregates by calendar year rather than a monthly median that would read mostly as zero", () => {
		expect(result.diagnostics.comparableObservations).toBe(8);
	});

	it("converts the annual P25/P50/P75 down to a monthly reserve (annual / 12)", () => {
		// Annual quantiles over [0,0,400,500,700,900,1200,1800] (R7): P25=300, P50=600, P75=975.
		expect(result.p25?.amount).toBeCloseTo(25, 5);
		expect(result.p50?.amount).toBeCloseTo(50, 5);
		expect(result.p75?.amount).toBeCloseTo(81.25, 5);
	});

	it("day-prorates instead of dividing by 12 for a target that isn't a plain calendar month", () => {
		const payCycle = { from: "2026-08-20", to: "2026-09-19", label: "Pay cycle" };
		const prorated = forecastSinkingFund(store(medicalTx), { categoryId: MEDICAL, target: payCycle, scope: "leaf" });
		// 31 inclusive days of a 600 annual P50: 600 × 31 / 365.2425.
		expect(prorated.p50?.amount).toBeCloseTo((600 * 31) / 365.2425, 5);
		expect(prorated.p50?.amount).not.toBeCloseTo(result.p50!.amount, 2);
	});
});

describe("forecastSinkingFund — Repairs (a notable large event, §34)", () => {
	// One genuinely large repair among years of ordinary ones, plus a tracked €0 year (2025, via
	// filler coverage) — different merchants/months per year so this fixture can't accidentally look
	// like its own recurring series.
	const repairsByYear: [number, number, string, string][] = [
		[2018, 150, "03-12", "Auto Garage"],
		[2019, 200, "11-02", "Bike Shop"],
		[2020, 180, "07-22", "Auto Garage"],
		[2021, 2800, "01-30", "Roofing Co"],
		[2022, 220, "09-14", "Appliance Repair"],
		[2023, 190, "05-05", "Auto Garage"],
		[2024, 210, "12-19", "Bike Shop"],
	];
	const repairsTx = repairsByYear.map(([year, amount, dayMonth, merchant]) => tx(`${year}-${dayMonth}`, -amount, REPAIRS, merchant));
	const target = { from: "2025-06-01", to: "2025-06-30", label: "June 2025" };
	const result = forecastSinkingFund(store(repairsTx), { categoryId: REPAIRS, target, scope: "leaf" });

	it("flags the €2,800 year but includes it by default — the risk the fund exists to absorb", () => {
		const notable = result.outliers.find((o) => o.id === "2021");
		expect(notable).toMatchObject({ amount: 2800, includedByDefault: true });
	});

	it("still lets the €2,800 year pull the upper quantiles up, since it wasn't excluded", () => {
		// Annual quantiles over [0,150,180,190,200,210,220,2800] (R7): P75=212.5 -> monthly 17.71,
		// noticeably above what the ordinary ~€150-220 years alone would suggest.
		expect(result.p75?.amount).toBeCloseTo(212.5 / 12, 5);
	});

	it("recomputes without the flagged year once the user excludes it as non-repeatable", () => {
		const excluded = forecastSinkingFund(store(repairsTx), { categoryId: REPAIRS, target, scope: "leaf", outlierOverrides: { "2021": "exclude" } });
		expect(excluded.p75!.amount).toBeLessThan(result.p75!.amount);
		expect(excluded.outliers.find((o) => o.id === "2021")).toBeTruthy();
	});
});

describe("forecastSinkingFund — fewer than 3 usable years", () => {
	it("falls back to a flat average across every tracked month, with confidence forced low (§33)", () => {
		// Deliberately not `store()`'s eight years of filler coverage — only two tracked years exist
		// at all here, so there's no way this can reach three usable years no matter the threshold.
		const sparseStore: ForecastStore = {
			accounts: [CHECKING],
			categories: CATEGORIES,
			transactions: [
				tx("2023-04-10", -300, REPAIRS, "Auto Garage"),
				...Array.from({ length: 8 }, (_, i) => tx(`2023-${String(i + 1).padStart(2, "0")}-20`, -5, FILLER, "Grocery Store")),
				tx("2024-08-02", -100, REPAIRS, "Bike Shop"),
				...Array.from({ length: 8 }, (_, i) => tx(`2024-${String(i + 1).padStart(2, "0")}-20`, -5, FILLER, "Grocery Store")),
			],
		};
		const target = { from: "2025-06-01", to: "2025-06-30", label: "June 2025" };
		const result = forecastSinkingFund(sparseStore, { categoryId: REPAIRS, target, scope: "leaf" });

		expect(result.diagnostics.comparableObservations).toBeLessThan(3);
		expect(result.p25?.amount).toBe(result.p50?.amount);
		expect(result.p50?.amount).toBe(result.p75?.amount);
		expect(result.p50?.confidenceLabel).toBe("low");
	});
});

describe("forecastSinkingFund — edge cases", () => {
	it("is not forecastable at all with no history whatsoever", () => {
		const emptyStore: ForecastStore = { accounts: [CHECKING], categories: CATEGORIES, transactions: [] };
		const result = forecastSinkingFund(emptyStore, { categoryId: MEDICAL, target: { from: "2026-06-01", to: "2026-06-30", label: "June 2026" }, scope: "leaf" });
		expect(result.forecastable).toBe(false);
		expect(result.reason).toMatch(/no spending history/i);
	});

	it("still forecasts €0 for a category that's tracked but never spent on — a real zero, not an error", () => {
		const result = forecastSinkingFund(store([]), { categoryId: MEDICAL, target: { from: "2026-06-01", to: "2026-06-30", label: "June 2026" }, scope: "leaf" });
		expect(result.forecastable).toBe(true);
		expect(result.p50?.amount).toBe(0);
	});
});

describe("evidence, not window size, drives sinking-fund confidence", () => {
	const TARGET = { from: "2026-01-01", to: "2026-01-31", label: "January 2026" };

	it("does not call a category charged once in eight years a confident forecast", () => {
		// The regression: `annualObservations` admits a year on ledger coverage alone, so this
		// category arrived with eight "observations" — seven of them €0 — cleared §33's three-year
		// bar, and scored 80/high off a single €19 charge. Confidence ran inverse to evidence.
		const s = store([tx("2021-06-14", -19.3, MEDICAL, "Notary")]);
		const result = forecastSinkingFund(s, { categoryId: MEDICAL, target: TARGET, scope: "leaf" });
		expect(result.forecastable).toBe(true);
		expect(result.p50!.confidenceLabel).toBe("low");
	});

	it("leaves a genuinely lumpy category with real history at its own confidence", () => {
		// What a sinking fund is *for* (§21–24): spending that clusters, across four of the eight
		// tracked years and plenty of months. It must not be swept up by the fix above.
		const rows: Transaction[] = [];
		for (const year of [2019, 2021, 2023, 2025]) {
			for (const month of [3, 4, 7, 9, 11]) {
				rows.push(tx(`${year}-${String(month).padStart(2, "0")}-12`, -300, REPAIRS, "Builder"));
			}
		}
		const result = forecastSinkingFund(store(rows), { categoryId: REPAIRS, target: TARGET, scope: "leaf" });
		expect(result.forecastable).toBe(true);
		expect(result.p50!.confidenceLabel).not.toBe("low");
		expect(result.p50!.amount).toBeGreaterThan(0);
	});

	it("counts spending years, not tracked years, at the §33 usability bar", () => {
		// Two years carrying spend is below MIN_USABLE_YEARS however many years the ledger covers,
		// so this drops to the flat-average rung and inherits its forced-low confidence.
		const s = store([tx("2020-05-10", -80, MEDICAL, "Clinic"), tx("2024-08-03", -120, MEDICAL, "Clinic")]);
		const result = forecastSinkingFund(s, { categoryId: MEDICAL, target: TARGET, scope: "leaf" });
		expect(result.p50!.confidenceScore).toBeLessThanOrEqual(49);
		expect(result.p50!.confidenceLabel).toBe("low");
	});
});
