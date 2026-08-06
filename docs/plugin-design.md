# Finance plugin — analysis & proposed design

Source analyzed: `Finance Overview 2021-2026.xlsx` (23 sheets, ~850KB, 2021–2026).

## 1. What's actually in the spreadsheet

This isn't a simple transaction log — it's five distinct systems layered into one workbook:

| Sheet(s) | What it is | Rows |
|---|---|---|
| `Dashboard` | Top-level KPIs: net worth, savings rate, FI ratio, years-to-FI, a 2021–2026 historical performance table, a "financial health scorecard" vs. targets, guiding principles | 44 |
| `Strategy` | A living policy document: goals & timeline, a 10-rule investment policy statement, an age-based asset-allocation glidepath, trigger→action decision rules, an annual review checklist | 195 |
| `DB {year}` × 6 (2021–2026) | Per-year dashboard: income tracker, planned-vs-actual budget by month/category, net worth by account, asset allocation vs. target, plus ad-hoc scenario calculators | ~43–97 |
| `ING {year}` × 6 (2021–2026) + `Blad1` | Raw ING bank CSV exports, one tab per year (Date, Name/Description, Counterparty, Debit/Credit, Category, Amount, Notifications). `Blad1` looks like a legacy combined sheet (2171 rows) predating the per-year split | up to 654/yr |
| `TR {year}` × 3 (2024–2026) | Trade Republic broker exports: Buy/Sell/Dividend/Deposit, ticker, asset class, shares, price, fee, tax, category | up to 178 |
| `FPF {year}` | Forecasting: historical monthly spend per category across *all* years, feeding a P25/P50/P75 percentile analysis used to set "Good/Typical/Bad" budget bands, plus fixed-cost totals and a cash-buffer surplus rule | 65 |
| `DB EY`, `EY Salary`, `EY Travel` | Employer-specific: payslip breakdown, a gas-vs-mobility-budget reimbursement reconciliation, and a raw travel-expense-system export | up to 236 |
| `RCP&IVC` | Receipts/invoices with VAT columns — headers only, unused so far | 0 data rows |

Two things stand out as real pain points worth solving, not just replicating:

1. **Category taxonomy drift.** Across years the same concept is spelled `Car`, `Car & Travelling`, ` Car & Travelling `, `Travelling`; `Food`, `Groceries`, ` Groceries `; `Otherexp`, `Other exp.`, ` Other exp. `. Any plugin needs to normalize this once and for all via an alias table, not perpetuate it.
2. **Dashboards are hand-maintained duplicates of raw data.** `DB {year}` and `FPF` recompute things (monthly totals, percentiles) that are fully derivable from the `ING`/`TR` rows. Every new year means copy-pasting a sheet and re-wiring formulas. This is exactly the kind of thing a plugin should compute on the fly instead of storing.

## 2. Functional requirements this implies

- **Transaction ledger** across multiple accounts (ING checking, 2 ING savings, Trade Republic cash, Trade Republic portfolio, physical cash), each transaction categorized (main + sub).
- **Investment ledger**: buys/sells/dividends/deposits/fees/tax by ticker, rolling up to current holdings.
- **Recurring bulk import** from bank/broker CSV exports — not manual entry — with de-duplication so re-importing an overlapping export is safe.
- **Category normalization** at import time (canonical list + aliases), plus learnable auto-categorization by merchant.
- **Budgeting**: planned vs. actual per category per month, essential/lifestyle/investing grouping, variance.
- **Net worth tracking**: per-account balances over time, allocation vs. target.
- **Yearly/rolling KPIs**: income, expenses, savings rate, personal inflation rate, FI number/ratio — computed, not hand-typed.
- **Percentile-based forecasting**: budget bands derived from full transaction history, not a separately maintained sheet.
- **Strategy as a living document**: goals, IPS rules, glidepath, decision rules — narrative content that the dashboard should be able to read numeric targets from (e.g. glidepath % by age band), not a second copy of the same numbers.
- **Optional/secondary**: employer reimbursement matching (generalizable beyond EY), receipts + VAT tracking (currently unused but structurally present).

## 3. Proposed architecture

### 3.1 Storage: hybrid, not one-note-per-transaction

With ~5,000+ historical rows and ~650/year of growth, one Markdown note per transaction would flood the vault and be slow. One giant opaque database would break "Obsidian is my single source of truth" (nothing greppable, nothing diffable, nothing syncs cleanly via git/Syncthing).

Proposed split:

- **Ledger data** (bank/broker rows) → plain **CSV files**, one per account per year, plugin-managed. Text, diffable, matches the mental model you already have from the yearly sheets, and trivially re-exportable.
- **Reference/config data** (accounts, category taxonomy + aliases, auto-categorization rules, budgets) → small **JSON files**, plugin-managed, editable through a settings UI rather than by hand.
- **Narrative + policy content** (Strategy, goals) → real **Markdown notes**, hand-edited, with a thin YAML frontmatter block for the few numeric fields the dashboard needs to read (glidepath % per age band, FI multiplier, health-scorecard targets). This is the one place hand-editing stays first-class, because it already reads like prose.
- **Reports** (yearly/monthly summaries, net-worth snapshots) → **generated Markdown notes**, written into a `reports/` folder, safe to regenerate, browsable/searchable/linkable like any other note, but marked as generated (don't hand-edit).

```
Finance/
  data/
    accounts.json          — id, name, type, currency, institution
    categories.json         — canonical categories + aliases + budget targets
    rules.json               — merchant → category auto-tagging rules
    ledger/
      ing/2021.csv … 2026.csv
      trade-republic/2024.csv … 2026.csv
      cash/2026.csv          — manual entries (no CSV export exists)
    inbox/                    — drop new bank/broker exports here to import
  reports/
    yearly/2025.md
    monthly/2026-07.md
    net-worth/2026-07.md
  Strategy.md                 — hand-edited, frontmatter carries glidepath/targets
```

### 3.2 Canonical transaction schema

```
id            stable hash of (account, date, amount, description, counterparty)
date          ISO date
account       ref → accounts.json
description   merchant/counterparty text
counterparty  name + IBAN if present
amount        signed, account currency
currency
category      canonical main category
subcategory
type          card | transfer | direct debit | trade | dividend | interest | fee …
source        ing-csv | tr-csv | ey-travel | manual
raw           original notification/description text (audit trail)
tags[]        optional (e.g. reimbursable, business)
notes         optional manual annotation
```

Investment rows extend this with `ticker`, `assetClass`, `shares`, `price`, `fee`, `tax`, `action`.

### 3.3 Import pipeline (the "don't re-enter anything" part)

1. Export CSV from ING / Trade Republic (or drop the employer travel-system export) into `Finance/data/inbox/`.
2. Run **"Finance: Import from inbox"** (or point it at a file). The plugin detects the source format by column signature (ING's columns, Trade Republic's columns, etc.) — no manual mapping for known sources. A generic column-mapper handles anything unrecognized, and the mapping is saved as a reusable named profile.
3. Each row is normalized to the canonical schema, categorized via the alias table + merchant rules (falls back to `Uncategorized`), and hashed into a stable id.
4. The importer diffs against the existing year-CSV for that account and **appends only genuinely new rows** — re-importing an export that overlaps a previous one is a no-op for anything already stored.
5. Import summary: N new, M duplicates skipped, K auto-categorized, J flagged for review — with a quick review pane for the flagged ones before they're committed.

This means each year you do: export → drop file → run one command. No re-typing, no re-categorizing from scratch (merchant rules carry forward).

### 3.4 Views (computed, not hand-maintained)

All of these read the ledger + config live — nothing here is a stored duplicate:

1. **Dashboard** — net worth, savings rate, FI ratio/number, years-to-FI, historical performance table, health scorecard (targets from `Strategy.md` frontmatter), guiding principles (pulled straight from the note).
2. **Ledger** — searchable/filterable/sortable across all accounts and years, inline re-categorize, manual entry for cash.
3. **Budget** — planned vs. actual per category/month, essential/lifestyle/investing grouping, variance highlighting.
4. **Net worth & allocation** — accounts + balances, current vs. target allocation (from the glidepath), net-worth trend.
5. **Investments** — holdings derived from the Trade Republic ledger (shares, avg. cost, P/L if you enter/update a current price).
6. **Forecast** — P25/P50/P75 spend bands per category computed from full history (replaces the `FPF` sheet's formulas), fixed-cost total, cash-buffer/surplus rule status.
7. *(later)* **Reimbursement matching** — generalized version of the EY gas/mobility reconciliation: "category X spend should be offset by category Y income within N months," flags shortfalls. Not EY-specific in the model.
8. *(later)* **Receipts/VAT** — attach a file + VAT breakdown to any transaction; matches the currently-empty `RCP&IVC` sheet's intent.

### 3.5 Export

- **CSV export** of any account/date range — backup and interop, since the canonical schema round-trips cleanly.
- **Yearly/monthly report generation** — writes the computed dashboard numbers into a real Markdown note under `reports/`, so a given month/year's snapshot is a linkable, searchable artifact even after the underlying ledger keeps growing.
- **Full backup** — one-shot dump of `data/` for portability, independent of the plugin.

### 3.6 Migration from the existing Excel

One-time, separate from the recurring importer, since historical formatting is messier than a clean bank export:

- `ING {year}` and `TR {year}` sheets → parsed straight into `ledger/ing/{year}.csv` and `ledger/trade-republic/{year}.csv`, with existing category values run through the alias table to land on the canonical taxonomy.
- `Strategy` sheet → hand-converted to `Strategy.md` (it already reads as prose/tables — mostly a copy-paste-and-reformat job), with glidepath %, FI multiplier, and health-scorecard targets lifted into frontmatter.
- `FPF`'s curated Good/Typical/Bad thresholds and fixed-cost/cash-buffer parameters → become `categories.json` config, not re-imported data (they're derivable from the ledger going forward).
- `Dashboard` / `DB {year}` → **not imported** — they're exactly what the new Dashboard/Budget views recompute. Nothing here is authoritative source data.
- `EY Salary` / `EY Travel` / `DB EY` → optional; import travel rows into the ledger tagged `source: ey-travel` only if you want reimbursement matching in v1, otherwise defer.
- `RCP&IVC` → nothing to migrate (empty); just confirms the receipts/VAT feature has a real, if currently unused, home.

## 4. Suggested build order

1. Data model + settings (accounts, categories/aliases, storage folder) + manual transaction entry.
2. ING importer + Ledger view + category rules/dedupe.
3. Dashboard + Budget views computed from the ledger.
4. Trade Republic importer + Investments view.
5. Migration script for the historical Excel data (steps above) — run once.
6. Forecast (percentile bands) + Net worth/allocation view.
7. Strategy.md frontmatter wiring (glidepath targets feeding the Dashboard/allocation views).
8. Later: reimbursement matching, receipts/VAT.
