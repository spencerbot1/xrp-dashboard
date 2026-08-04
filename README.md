# XRP Fundamentals Dashboard

A static, dependency-free dashboard tracking XRP ledger activity, RLUSD adoption
and market context. **No Node, no npm, no build step** — every data source is
fetched directly from the browser, so the npm/TLS certificate problems that
blocked the original `xrp-dashboard-mvp` are irrelevant here.

## Run it locally

Any static file server works. With the Python that ships on macOS:

```bash
cd "/Users/spencer/Documents/XRP Dashboard" && python3 -m http.server 8010
```

Then open <http://localhost:8010>.

## Data sources (all free, no API keys)

| Panel | Source | How |
|---|---|---|
| Price, market cap, 24h volume, 12-month chart | CoinGecko API | browser `fetch` (CORS-open) |
| RLUSD total supply + price | CoinGecko API (`ripple-usd`) | browser `fetch` |
| Live ledger pulse (payments/sec, XRP delivered per ledger) | xrplcluster.com JSON-RPC | browser `fetch`, last 10 validated ledgers with expanded transactions |
| RLUSD issued on XRPL | s1.ripple.com | browser WebSocket, `gateway_balances` on the issuer account |
| Fundamentals score | computed in-browser | 4 live components: 90d price momentum, volume/mcap turnover, RLUSD 90d supply growth + on-ledger scale, sampled payment/tx rates. Falls back to the curated JSON value offline. |
| XRP news (72h window) | Supabase cache endpoint | `xrp-refresh` edge function on comit-command-center, cron-refreshed every 10 min from Google News RSS; falls back to `data/dashboard.json` |
| Monthly volume series | `data/dashboard.json` | curated baseline, clearly labeled **Estimate** |

## Supabase backbone (live)

Project **comit-command-center** (`dzjqmtoexnthdtlhlcxd`) now hosts the
aggregation layer:

- `public.xrp_dashboard_cache` — key/value JSONB cache (markets, price/volume/
  RLUSD histories, RLUSD on-ledger supply, ledger pulse, news, refresh report).
  RLS enabled, public read.
- Edge function `xrp-refresh` — fetches every upstream source server-side.
  `GET` returns the full cache (CORS-open); `GET ?refresh=1` refreshes first
  (rate-limited to one refresh per 2 minutes; `&force=1` bypasses).
- `pg_cron` job `xrp-dashboard-refresh` — hits the function every 10 minutes
  via `pg_net`.

The published claude.ai artifact reads this cache live through the viewer's
Supabase connector (`window.claude.mcp` → `execute_sql`) and falls back to its
baked snapshot when the connector isn't available.

Methodology notes (per the design conversation):

- Payment volume uses `delivered_amount` from transaction **metadata**, never the
  requested `Amount` (partial/path payments can deliver less).
- Only `tesSUCCESS` payments count; self-transfers (`Account == Destination`)
  and non-native-XRP deliveries are excluded.
- RLUSD **on XRPL** (issuer obligations) is always shown separately from
  **cross-chain total supply** — the two are never conflated.
- Estimates are labeled as estimates. Gross vs adjusted volume are shown as two
  stacked series so one number never overstates precision.

## Putting it on the web

Because the whole thing is static files, hosting is nearly free everywhere.
**Recommended: GitHub Pages** — one repo, HTTPS, zero servers, and the included
GitHub Action keeps the cached data snapshot fresh daily.

```bash
cd "/Users/spencer/Documents/XRP Dashboard"
git init && git add -A && git commit -m "XRP fundamentals dashboard"
gh repo create xrp-dashboard --private --source . --push
gh api repos/{owner}/xrp-dashboard/pages -X POST -f build_type=workflow 2>/dev/null || true
```

Then in the repo: **Settings → Pages → Deploy from branch → `main` / root**.
The site appears at `https://<user>.github.io/xrp-dashboard/`. (Private repos
need GitHub Pro for Pages; a public repo is free — this dashboard contains no
secrets, keys or private data.)

Alternatives, equally valid:

- **Cloudflare Pages / Netlify** — drag-and-drop the folder in their dashboard,
  or connect the repo. Free tier, custom domains, instant.
- **Vercel** — `vercel deploy` or repo connect. Same result.
- Any plain web server (DigitalOcean droplet, existing hosting) — copy the
  folder into the web root. There is nothing to install.

The daily refresh workflow (`.github/workflows/refresh-data.yml`) runs
`scripts/refresh_data.py` (stdlib-only Python) to snapshot live values into
`data/dashboard.json`, so the page still shows recent numbers if a viewer's
browser can't reach an API.

## Production data pipeline (next phase)

The curated monthly series and fundamentals score are **estimates** until a real
XRPL ingestion pipeline exists. The plan from the design conversation, which
this dashboard is already shaped to receive:

```
QuickNode XRPL Streams  →  ingestion worker  →  Supabase (PostgreSQL)
                                                    │
                              nightly aggregation job (daily metrics,
                              entity classification, adjusted volume)
                                                    │
                              writes data/dashboard.json  →  this frontend
```

- Phase 1: gross + adjusted native-XRP payment volume, payment count, unique
  senders, RLUSD payment volume, RLUSD outstanding supply.
- Phase 2: entity classification (exchange wallets, Ripple treasury/escrow,
  custodians, market makers) with a classification-coverage metric.
- Phase 3: ETF flows, derivatives open interest, DEX/AMM liquidity, RWA value.

To swap in pipeline output, only `data/dashboard.json` changes — the frontend
reads `score`, `monthly[]` (`month`, `gross`, `adjusted`, `payments`, `active`)
and `cached{}` as-is.

Estimated running cost (verified Aug 2026): QuickNode Build $49/mo (Streams
bills API credits per ledger processed; XRPL closes ~665K ledgers/mo — fits the
80M-credit Build allowance) + Supabase Pro $25/mo (8 GB DB included; store
filtered payments only, prune raw JSON after aggregation) ≈ **$75/mo**, plus a
one-time 12-month backfill (~8M ledgers) that may add a single overage charge
on the order of $25–100. A free-tier proof of concept (QuickNode Free 10M
credits + Supabase Free 500 MB) can validate the pipeline on a few days of
data at $0. Streams can deliver directly into Supabase Postgres, so no worker
server is required; aggregation runs as pg_cron jobs inside Supabase.
