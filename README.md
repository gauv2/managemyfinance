# Finance

A personal finance dashboard, ledger, budgeting, and import pipeline for [Obsidian](https://obsidian.md) — everything stored locally in your vault as plain JSON and CSV, no network calls, no telemetry, no external service.

## Features

- **Multi-portfolio** — track more than one person/entity's finances separately (each portfolio is its own set of accounts, transactions, and settings).
- **Accounts** — debit, credit, investing, saving, cash, and crypto accounts, each with its own type-appropriate dashboard (net worth, income/expenses, savings rate, financial-independence projection).
- **Ledger** — searchable, filterable, sortable transaction list with category chips, month drill-downs, and file attachments (link a receipt/invoice already in your vault to a transaction).
- **Import wizard** — drag in a CSV or Excel export. ING and Trade Republic exports are auto-detected; anything else gets a manual column-mapping step (with auto-guessed defaults) so it can still be imported without a dedicated parser.
- **Auto-categorization** — a built-in keyword rule set for common merchants (plus your own custom rules) categorizes transactions on import, and flags recurring counterparties whose transactions land in more than one category so miscategorization gets caught early.
- **Budgets** — simple monthly limits per category (no rollover), with progress meters and suggested budgets extracted from your last few months of actual spending.
- **Subscriptions** — track recurring payments (any billing cycle), optionally linked to the account they're paid from.
- **Cards** — a card manager with tier/issuer/network-driven visual styling (CSS/SVG only — no external logos or images).
- **Privacy mode** — blur every displayed amount at a click, for demoing the plugin without exposing real numbers.
- **Mobile-friendly layout** — auto-detects Obsidian mobile, or force it on/off manually.

## Installation

### Via BRAT (recommended while this is in beta)

This plugin isn't in the community plugin store yet, so the easiest way to install it — and to keep getting updates — is [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install **BRAT** from Obsidian's Community Plugins browser and enable it.
2. Run **BRAT: Add a beta plugin for testing** from the command palette.
3. Paste this repository URL: `https://github.com/gauv2/managemyfinance`
4. Choose the latest version and click **Add plugin**.
5. Enable **Finance** under Settings → Community Plugins.

BRAT will check for new releases on startup and update the plugin automatically.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/gauv2/managemyfinance/releases/latest) and drop them into `<vault>/.obsidian/plugins/finance-plugin/`, then reload Obsidian and enable the plugin.

## Getting started

1. Install the plugin (see above) and enable it in Obsidian's Community Plugins settings.
2. Open it from the ribbon icon, or run **Open Finance workspace** from the command palette.
3. Add your first account, then use the **Import transactions** command (or the in-app Import button) to bring in a bank/broker export.
4. Optionally run **Install eMoney categories & auto-categorize transactions** from the command palette to seed a standard category set and categorize what it can recognize.

All data lives under a folder in your vault (`Finance` by default, configurable per portfolio) as human-readable JSON (accounts, categories, rules, subscriptions, cards) and CSV (the transaction ledger, one file per source per year) — nothing is stored anywhere the plugin doesn't tell you about, and everything stays readable/diffable outside the plugin too.

## Development

```bash
npm install
npm run dev        # esbuild watch mode
npm run build      # typecheck + production build
npm test           # vitest
npm run typecheck  # tsc -noEmit
```

The build output (`main.js`, `manifest.json`, `styles.css`) goes in your vault at `.obsidian/plugins/finance-plugin/`.

### Cutting a release

BRAT and Obsidian both locate a plugin's files at `releases/download/<manifest.json version>/`, so the git tag has to match `manifest.json` exactly — plain `1.2.3`, no `v` prefix.

```bash
npm version patch   # or minor / major
git push && git push --tags
```

`npm version` runs `version-bump.mjs`, which writes the new version into `manifest.json` and adds a `versions.json` entry mapping it to the current `minAppVersion`. Pushing the tag triggers `.github/workflows/release.yml`, which tests, builds, and publishes a release with `main.js`, `manifest.json`, and `styles.css` attached as assets. The workflow refuses to publish if the tag and `manifest.json` disagree.

## License

MIT — see [LICENSE](LICENSE).
