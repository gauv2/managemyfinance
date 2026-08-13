# Finance

A personal finance dashboard, ledger, budgeting, and import pipeline for [Obsidian](https://obsidian.md) — everything stored locally in your vault as plain JSON and CSV, no telemetry, no background network calls. The one exception: an explicit "Fetch latest rates" button in Settings → Currency, which calls the free [Frankfurter](https://frankfurter.dev) API for daily exchange rates — nothing but currency codes is ever sent, and it only runs when you click it.

## Features

- **Multi-portfolio** — track more than one person/entity's finances separately (each portfolio is its own set of accounts, transactions, and settings).
- **Accounts** — debit, credit, investing, saving, cash and crypto, plus property, pension, loan and mortgage for the things that hold value but never appear in a bank export. Each gets a type-appropriate dashboard; loans and mortgages count *against* net worth.
- **Recorded balances** — note what an account is actually worth on a date. A recorded balance supersedes every assumption before it and lets transactions carry on from there, which is what makes net worth true for a house, a pension, or a savings account you never import.
- **Manual transactions** — add, edit and delete rows by hand. Cash spending, a payment nothing exports, or fixing a row an import got wrong.
- **Transfer matching** — money moved between your own accounts arrives as two unconnected rows that inflate income *and* expenses. The matcher pairs them (same amount, opposite sign, a few days apart, different accounts) and you confirm; linked transfers then count as neither.
- **Multi-currency** — pick the currency you read everything in; anything else converts through your rate table, in every total rather than only in subscriptions.
- **Ledger** — searchable, filterable, sortable transaction list with category chips, month drill-downs, and file attachments (link a receipt/invoice already in your vault to a transaction).
- **Import wizard** — drag in a CSV, Excel, CAMT.053, MT940, OFX/QFX or QIF export. ING, Trade Republic, Revolut, bunq and N26 are auto-detected, statement formats are recognized from their contents, and anything else gets the manual column-mapping step (with auto-guessed defaults). Every import is one undoable batch.
- **Auto-categorization** — a built-in keyword rule set for common merchants (plus your own custom rules) categorizes transactions on import, and flags recurring counterparties whose transactions land in more than one category so miscategorization gets caught early.
- **Merchant memory** — the same shop written a dozen ways (`CCV*ALBERT HEIJN 1423 DEN HAAG`, `BEA, Betaalpas ALBERT HEIJN`) reduces to one merchant, so a category you set once applies to every other occurrence, past and future.
- **AI categorization (opt-in, off by default)** — see [AI categorization](#ai-categorization-opt-in) below.
- **Budgets** — monthly limits per category with optional **rollover** (an envelope you underspend genuinely carries forward), whole-year **annual budgets** for costs that don't divide by twelve, named **one-off budgets** for a holiday or a renovation, **income categories** whose budget is a target to reach rather than a limit to stay under, **alerts** when you're about to blow one, and a **year review** tab pairing every month's plan with what actually happened.
- **Review queue** — work through imported transactions in one list: fix the category inline, select rows in bulk, then approve. Anything you can't decide on yet can be flagged and returned to, so the queue can actually reach empty.
- **Subscriptions** — track recurring payments in any billing cycle and currency, optionally linked to the account they're paid from. Map real ledger transactions to a subscription to see what it has *actually* cost, get told when a price quietly goes up, scan the ledger for recurring charges you're not tracking yet, and be reminded before a renewal. Quote everything per month or per year with one toggle, or let each subscription carry its own preference.
- **Cards** — a card manager with tier/issuer/network-driven visual styling (CSS/SVG only — no external logos or images).
- **Flexible amount entry** — `1.234,56`, `1,234.56`, `1234.56` and `€ 1 234,56` all read as the same number wherever you type an amount, and each field echoes back what it understood. Displayed amounts follow a number-format setting of their own.
- **Backup, restore and reset** — export the whole portfolio as one JSON file (or the ledger as a flat CSV), import a backup by merging or replacing, and clear a portfolio outright behind a typed confirmation.
- **Privacy mode** — blur every displayed amount, IBAN and card number, for working with the vault open or demoing the plugin without exposing real numbers.
- **In your notes** — a ```` ```finance ```` code block renders a live budget meter, spending chart, net worth card, subscription list or savings-goal meter inside any note. Generate monthly, yearly and net-worth **reports** as real markdown notes with Dataview-queryable frontmatter.
- **Mobile-friendly layout** — auto-detects Obsidian mobile, or force it on/off manually.

## Two places to configure things

The plugin deliberately has two settings surfaces, and they hold different kinds of thing:

- **Vault settings** (Obsidian's own Settings → *Manage My Finance*) — what the plugin *knows*: data folder, portfolios, accounts, categories, FI projection assumptions, base currency and exchange rates, alerts and reports, importing bank exports (and undoing one), and backup / restore / delete-all.
- **App settings** (the *Settings* page inside the workspace itself) — how it *looks* while you work: number format, hiding amounts, mobile layout, the subscriptions default view, and review-queue behaviour.

Each links to the other, so neither is a dead end.

## AI categorization (opt-in)

Everything above works entirely offline. Whatever the keyword rules and merchant memory can't
place, you can optionally hand to Claude — **disabled by default, and it never runs without being
switched on in Vault settings → AI.**

Two transports, both configured there:

- **API key** — the Anthropic Messages API, over Obsidian's `requestUrl` (works on mobile).
- **Claude CLI** — shells out to a local `claude` binary in print mode, so the work rides an
  existing subscription instead of per-token billing. Desktop only, since it spawns a subprocess.

What makes it cheap and consistent is that it classifies **merchants, not transactions**: a few
hundred uncategorized rows are usually well under a hundred distinct shops, and each answer is
written into merchant memory, so a merchant is classified once, ever. Answers above a confidence
threshold apply directly; the rest land categorized *and* flagged so they surface in the review
queue rather than being silently trusted.

**What leaves the vault:** merchant names and your category tree — nothing else. No amounts, dates,
account names, IBANs, card numbers or balances. `buildUserPrompt()` in `src/ai/prompt.ts` is a pure
function, so the exact payload is rendered in the settings panel before anything is sent, and
`src/ai/prompt.test.ts` asserts what isn't in it. An API key you enter is stored in this vault's
plugin `data.json` in plain text; the settings panel says so.

## Embedding figures in a note

A ```` ```finance ```` code block renders live figures inside any note — read from the ledger every
time the note is opened, so a monthly-review note never goes stale:

````markdown
```finance
view: budget
month: current
limit: 5
```
````

`view` is one of `summary` (the default), `budget`, `spending`, `networth`, `subscriptions` or
`goal`. `month` takes `current` or a `YYYY-MM`; `year` takes a `YYYY`; `limit` caps how many rows a
list renders; `title` overrides the heading; and `name` picks a one-off budget for `view: goal`.

The **Write this month's report into the vault** command (and its yearly and net-worth siblings)
generates a full markdown note under `<data folder>/reports/`, with the headline figures in
frontmatter so a folder of them is a dataset Dataview can query:

```dataview
TABLE income, expenses, savings_rate FROM "Manage My Finance/reports" WHERE period = "month"
```

## Getting started

1. Install the plugin (see below) and enable it in Obsidian's Community Plugins settings.
2. Open it from the ribbon icon, or run **Open Finance workspace** from the command palette.
3. Add your first account, then use the **Import transactions** command (or the in-app Import button) to bring in a bank/broker export. No export for it? Use **Add a transaction** — cash accounts are filled in by hand.
4. Optionally run **Install default categories & auto-categorize transactions** from the command palette to seed a standard category set and categorize what it can recognize.
5. If you have more than one account, run **Find transfers between your accounts** — until the two halves of a transfer are linked, they inflate both your income and your expenses.
6. For anything whose value can't be derived from transactions (a house, a pension, a mortgage), run **Record an account balance**.

All data lives under a folder in your vault (`Finance` by default, configurable per portfolio) as human-readable JSON (accounts, categories, rules, subscriptions, cards, recorded balances, one-off budgets, import history) and CSV (the transaction ledger, one file per source per year) — nothing is stored anywhere the plugin doesn't tell you about, and everything stays readable/diffable outside the plugin too. Generated reports go in `reports/` as ordinary markdown notes.

## Development

```bash
npm install
npm run dev        # esbuild watch mode
npm run build      # typecheck + production build
npm test           # vitest
npm run typecheck  # tsc -noEmit
```

Every push and pull request runs typecheck, tests and a production build (`.github/workflows/ci.yml`).
Modules that import `obsidian` are testable too — `vitest.config.mts` aliases it to an in-memory stub
in `test/obsidianStub.ts`, which is what lets the store's ledger round-trip and schema migrations be
covered directly.

The build output (`main.js`, `manifest.json`, `styles.css`) goes in your vault at `.obsidian/plugins/finance-plugin/`.

## License

MIT — see [LICENSE](LICENSE).
