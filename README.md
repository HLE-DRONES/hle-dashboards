# Company Dashboard — HLE Sales Ops Wallboard

1920×1080 wallboard (scales to any screen) showing live company numbers,
built from the Claude Design handoff "Company Dashboard - HLE" on the
HLE Drones design system (monochrome ink/bone, Archivo + IBM Plex Mono).

| Panel | Source | Notes |
|---|---|---|
| Sales MTD (both stores) | Shopify Admin API | non-cancelled orders, current totals (net of refunds) |
| Sales calls / Service calls today (OH·KS) + DDR | Aircall | inbound per line, missed = never answered, delta vs yesterday same-time |
| Sales — last 90 days charts | Shopify | weekly buckets, dashed prior-90-day overlay |
| Inventory — available | Finale GraphQL | on hand − reserved, all facilities |
| Calls — inbound 30 days | Aircall + Workers KV | per-number daily buckets, lazily backfilled |
| Sold — this week | Shopify | Mon-ET week, net units (monday-morning counting rule), weekly targets |

## Config knobs (all in `src/worker.js`)

- `LINES` — Aircall number ids (OH/KS sales+service, DDR).
- `INVENTORY_ITEMS` — Finale SKUs per inventory row.
- `SOLD_ROWS` — ledger rows: store, SKU rule, **weekly target**.

## Local dev

```bash
npm install
./make-dev-vars.sh   # writes .dev.vars from the macOS Keychain (gitignored)
npm run dev          # http://localhost:8787
```

Localhost skips the Access JWT check; everything else requires it.

## Deploy (one-time setup)

1. `wrangler kv namespace create CALL_STATS` → paste id into `wrangler.toml`.
2. `wrangler secret put` each secret listed in `wrangler.toml` (values from Keychain).
3. `wrangler deploy`.
4. Custom domain `dashboard.hle.team` + Access app via the curl recipe in the
   hle-team-access memory; paste the returned `aud` into `[vars] ACCESS_AUD`,
   redeploy.
5. Add a card to `PROJECTS/hle-team-home/src/index.ts`.

## Behavior notes

- `/api/data` is cached ~4 min and served stale-while-revalidate up to 1 h,
  so the board never blocks on the ~15 s aggregation.
- Aircall can't filter calls by number server-side; completed days are
  bucketed per-number into KV (`calls:v1:YYYY-MM-DD`). On a fresh deploy the
  30-day panel self-backfills over the first ~30–40 min of refreshes
  (`historyMissingDays` in the payload shows progress).
- Ledger badges: green "On target" when sold ≥ weekly target; red "Review"
  when below 50 % of the pro-rated (day-of-week) pace; nothing in between.
