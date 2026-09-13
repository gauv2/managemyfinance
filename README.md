# Finance

A personal finance dashboard, ledger, budgeting, and import pipeline for [Obsidian](https://obsidian.md) — everything stored locally in your vault as plain JSON and CSV, no telemetry, no background network calls. The exceptions are a handful of explicit, user-initiated actions, each firing only when clicked: "Fetch latest rates" and "Backfill historical rates" in Settings → Currency, both calling the free [Frankfurter](https://frankfurter.dev) API for ECB exchange-rate data (nothing but currency codes and dates is ever sent); and, on the Investing/Crypto dashboards, an optional "Refresh price" action that queries Yahoo Finance (for stocks/ETFs) or CoinGecko (for crypto) to price your current holdings.

## Features

- **Multi-portfolio** — track more than one person/entity's finances separately (each portfolio is its own set of accounts, transactions, and settings).
- **Accounts** — debit, credit, investing, saving, cash and crypto, plus property, pension, loan and mortgage for the things that hold value but never appear in a bank export. Each gets a type-appropriate dashboard; loans and mortgages count *against* net worth. An account you no longer use can be marked **closed** — it keeps all its history and moves into a collapsed group rather than competing with the ones you use — and an account you keep only for its history can be marked **register-only**, which drops it out of net worth entirely (left out, not counted as zero) while its transactions go on feeding spending, budgets and reports.
- **Recorded balances** — note what an account is actually worth on a date. A recorded balance supersedes every assumption before it and lets transactions carry on from there, which is what makes net worth true for a house, a pension, or a savings account you never import.
- **Manual transactions** — add, edit and delete rows by hand. Cash spending, a payment nothing exports, or fixing a row an import got wrong.
- **Transfer matching** — money moved between your own accounts arrives as two unconnected rows that inflate income *and* expenses. The matcher pairs them (same amount, opposite sign, a few days apart, different accounts) and you confirm; linked transfers then count as neither.
- **Multi-currency** — pick the currency you read everything in; anything else converts through your rate table, in every total rather than only in subscriptions.
- **Ledger** — searchable, filterable, sortable transaction list with category chips, month drill-downs, and file attachments (link a receipt/invoice already in your vault to a transaction).
- **Import wizard** — drag in a CSV, Excel, CAMT.053, MT940, OFX/QFX or QIF export. ING, Trade Republic, Revolut, bunq, N26 and KNAB are auto-detected — KNAB's spreadsheet export ships with no header row at all, so it is recognised by the shape of its contents instead — statement formats are recognized from their contents, and anything else gets the manual column-mapping step (with auto-guessed defaults). Every import is one undoable batch.
- **Auto-categorization** — a built-in keyword rule set for common merchants (plus your own custom rules) categorizes transactions on import, and flags recurring counterparties whose transactions land in more than one category so miscategorization gets caught early.
- **Category rules from a transaction** — right-click any row to build a rule from the merchant you are looking at. A rule matches *exactly*, by prefix, by substring or by regex, so "Apple" can be filed without dragging in "Apple Store", and it can carry an **amount condition** for the merchants that bill everything under one description — pick the €9.99 and €2.99 charges out of 201 identical "Apple" rows and leave the one-off app purchases alone. Before anything is written you get every affected transaction listed and tickable, with money movements held back by default so a merchant rule can't quietly recast a transfer as spending. Rows filed by a rule say so, and the badge opens the rule that did it.
- **Merchant memory** — the same shop written a dozen ways (`CCV*ALBERT HEIJN 1423 DEN HAAG`, `BEA, Betaalpas ALBERT HEIJN`) reduces to one merchant, so a category you set once applies to every other occurrence, past and future.
- **AI categorization (opt-in, off by default)** — see [AI categorization](#ai-categorization-opt-in) below.
- **Budgets** — monthly limits per category with optional **rollover** (an envelope you underspend genuinely carries forward), whole-year **annual budgets** for costs that don't divide by twelve, named **one-off budgets** for a holiday or a renovation, **income categories** whose budget is a target to reach rather than a limit to stay under, **alerts** when you're about to blow one, and a **year review** tab pairing every month's plan with what actually happened.
- **Review queue** — work through imported transactions in one list: fix the category inline, **correct a wrong amount in place** with the pencil on the row, select rows in bulk, then approve. Anything you can't decide on yet can be flagged and returned to, so the queue can actually reach empty.
- **Settle matching transactions in one go** — approve one row and the queue offers every other transaction that looks like it, in three clearly separated tiers of decreasing certainty: rows the merchant grouping already considers the *same* merchant (pre-selected), rows that merely *read* like it (a similarity score, selected by nobody but you), and — on request — rows **Claude** says are the same payee, each with its confidence and the reason it gave. That last tier is the only one that can catch "AH to go" for "Albert Heijn": no string metric reaches names sharing neither words nor characters. Approve, flag and set a category across the whole set at once. Switchable off; still reachable per-row from the button on each row.
- **Category recheck** — every other categorization step only ever touches rows with *no* category, so whatever a keyword rule got wrong in 2023 stays wrong forever. This is the pass that revisits them: Claude re-classifies merchants you've already categorized, **without being told what they're currently filed as** (telling it would just make it agree), and every disagreement is listed for you to accept or reject with the affected transactions visible. Nothing is applied until you say so, rejecting is recorded as "confirmed as-is" so it isn't raised again, and the summary states what it skipped and why — merchants deliberately split across categories are left alone.
- **Scheduled reports** — have a report built and delivered weekly, monthly, quarterly or yearly, to **email** and/or a **Telegram** bot, as PDF, CSV and/or Excel. See [Scheduled reports](#scheduled-reports) for how the timing really works.
- **Reports** — ask a question of your ledger and take the answer out of Obsidian: pick a period, any combination of categories (a primary pulls in its subcategories), accounts, direction and free text, and get totals, a per-category/month/merchant/account breakdown and the matching transactions. Export as **PDF** (a save dialog, written straight to disk and opened), **CSV**, **Excel** (`.xls`, with real numbers and a sheet per breakdown), or as a **markdown note** in your vault with Dataview-queryable frontmatter. "Everything I spent on restaurants in 2025", "what the car has cost", or both at once.
- **Subscriptions** — track recurring payments in any billing cycle and currency, optionally linked to the account they're paid from. Map real ledger transactions to a subscription to see what it has *actually* cost, get told when a price quietly goes up, scan the ledger for recurring charges you're not tracking yet, and be reminded before a renewal. Quote everything per month or per year with one toggle, or let each subscription carry its own preference.
- **Debts** — a register of what you owe and what you're owed, to a bank, a company or a person: who, how much, since when, when it's due, and whether it's settled. Deliberately its own island — no figure here touches net worth, budgets or any report — so a €20 IOU and a family loan can both be written down without either being asked to reconcile against anything.
- **Account coverage** — right-click an account (or open it for every account at once) to see what it actually holds: the period covered and whether there's a hole in it, how many transactions and distinct payees, how much is still unfiled, and which import sources they came from. The questions you ask while bringing in years of statements one file at a time.
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

## AI assistance (opt-in)

Everything above works entirely offline. Two jobs can optionally be handed to Claude — **both
disabled by default, and neither ever runs without being switched on in Vault settings → AI.**

- **Categorizing** — whatever the keyword rules and merchant memory can't place.
- **Matching** — which of your other merchants are the same shop as the one you're reviewing.
  Triggered only by pressing "Ask Claude" on the match sheet in Review; never automatic.
- **Rechecking** — a second opinion on categories you already have. Triggered only by "Recheck
  categories" on the Review page, and it never writes anything without you accepting it.

Two transports, both configured there:

- **API key** — the Anthropic Messages API, over Obsidian's `requestUrl` (works on mobile).
- **Claude CLI** — shells out to a local `claude` binary in print mode, so the work rides an
  existing subscription instead of per-token billing. Desktop only, since it spawns a subprocess.

What makes both passes cheap and consistent is that they ask about **merchants, not transactions**:
a few hundred uncategorized rows are usually well under a hundred distinct shops, and a 4,000-row
ledger is a few hundred merchants. Each categorization answer is written into merchant memory, so a
merchant is classified once, ever. Answers above a confidence threshold apply directly; the rest
land categorized *and* flagged so they surface in the review queue rather than being silently
trusted.

Match answers are never applied for you at all — they arrive as a third, unticked tier on the match
sheet with the model's confidence and its stated reason, because a model will happily call two
branches of a franchise "the same merchant" when you file them apart on purpose. A matching pass is
capped at the 400 busiest merchants, and says so in its summary when the cap bites rather than
presenting a partial search as a complete one.

**What leaves the vault:** merchant names, plus your category tree for the categorizing pass only —
nothing else. No amounts, dates, account names, IBANs, card numbers or balances. `buildUserPrompt()`
in `src/ai/prompt.ts` and `buildMatchPrompt()` in `src/ai/matchPrompt.ts` are pure functions, so both
exact payloads are rendered in the settings panel before anything is sent, and their tests assert
what isn't in them. An API key you enter is stored in this vault's plugin `data.json` in plain text;
the settings panel says so.

## Scheduled reports

A report can be built and delivered on a recurring schedule — weekly, monthly, quarterly or yearly —
to email, a Telegram chat, or both. Set up in **Vault settings → Scheduled reports**.

**Read this bit first: there is no background process.** An Obsidian plugin only runs while Obsidian
is open, so "weekly" really means *"on the first launch on or after the period ends"*. Leave the app
closed over a weekend and Monday's report arrives when you next open it — stamped with how late it
was, so the delay is visible in the report rather than invisible. Missing several periods produces
**one** report, for the most recent completed one, not a burst of back-filled ones.

Every report covers a *completed* period. A monthly report generated on the 3rd is about last month,
never a third of this one — a partial period presented as a period is simply a wrong number.

- **PDF** is rendered off-screen in an Electron `<webview>` and captured with its `printToPDF`, the
  same mechanism the Food Spot and Are We There Yet plugins use — no print dialog anywhere in the
  path, so a scheduled PDF and a manually saved one are byte-for-byte the same renderer. Desktop
  only; on mobile a schedule asking for PDF sends HTML instead and says so in its log.
- **Email** goes through the [Resend](https://resend.com) HTTP API — a free account and a verified
  sender domain. **Telegram** needs a bot from @BotFather plus your chat id; there's a Send test
  button for it.
- **Credentials are stored in this vault's plugin `data.json` in plain text**, exactly like the
  Claude API key. The settings panel says so too.
- Each schedule shows when it last ran and exactly what happened per channel, so a revoked API key
  looks like a failure rather than like six months of quiet success. A failed delivery leaves the
  period undelivered and is retried on the next launch — one bad key never silently costs you a month.
- **Send now** on any schedule delivers immediately without consuming the scheduled run, so testing a
  schedule doesn't eat the delivery it was meant to be testing.

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
