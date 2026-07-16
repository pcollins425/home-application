# Home application (Plaid bridge)

Short-lived personal finance bridge: **Cloudflare Worker + D1 + simple transaction dashboard**.

- One bank account (Plaid Development)
- History from **2026-05-01** (configurable) through ongoing cron sync
- UI: date, amount, description, location — enough to compare to the bank app
- **No tunnel / webhooks** for this bridge (cron every 4 hours)
- Creds on Cloudflare are **cloud-only** — rotate secret + re-Link on mini-PC cutover; do not copy tokens/secrets to local

Local clone (canonical): `E:/family/home-application` (`/mnt/e/family/home-application`)

## Stack

| Piece | Role |
|-------|------|
| `public/` | Frontend (static) |
| `src/index.ts` | Worker API + cron |
| D1 `home_plaid` | items, accounts, transactions |

## One-time setup

### 1. Tools

```bash
# Node 22+
nvm use 22
cd /mnt/e/family/home-application   # or E:\family\home-application
npm install
npx wrangler login
```

### 2. Create D1 and plug in the id

```bash
npx wrangler d1 create home_plaid
```

Copy the `database_id` into `wrangler.toml` (`REPLACE_AFTER_D1_CREATE`).

```bash
npx wrangler d1 migrations apply home_plaid --remote
```

### 3. Secrets (cloud-only)

From the credential USB (do **not** commit). For a **real** bank Link use **Development** keys (`PLAID_ENV=development`), not Sandbox.

```bash
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET
npx wrangler secret put ACCESS_KEY          # pick a long random passphrase for the UI
# optional if not using wrangler.toml [vars]:
# npx wrangler secret put PLAID_ENV
```

Optional redirect (OAuth banks) — register the same URL in the [Plaid dashboard](https://dashboard.plaid.com/developers/api):

```bash
npx wrangler secret put PLAID_REDIRECT_URI
# e.g. https://home-application.<account>.workers.dev/
# or https://plaid-test.collinsmediallc.com/
```

### 4. Deploy

```bash
npm run deploy
```

Open the Worker URL → unlock with `ACCESS_KEY` → **Link account** → **Sync now** if the table is empty for a minute.

**Note:** If `*.workers.dev` returns Cloudflare error **1042**, enable the workers.dev subdomain for that Worker (Settings → Domains, or API `POST .../scripts/<name>/subdomain` with `{"enabled":true}`).

### 5. Custom domain (collinsmediallc.com)

Add DNS for `plaid-test` (proxied) or use **Workers → Custom Domains** in the dashboard. `wrangler.toml` already declares route `plaid-test.collinsmediallc.com/*`. Then set `PLAID_REDIRECT_URI` to that origin and register it in Plaid.

## API (all require `Authorization: Bearer <ACCESS_KEY>`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/status` | Linked? last sync? count |
| POST | `/api/create_link_token` | Start Link |
| POST | `/api/exchange_public_token` | Store Item + first sync |
| POST | `/api/sync` | Manual `/transactions/sync` |
| GET | `/api/transactions?since=2026-05-01` | Dashboard rows |

## Saturday cutover (mini-PC)

1. Delete/disable this Worker and wipe D1  
2. Rotate Plaid Development **secret** in the dashboard  
3. Put the **new** secret only on the mini-PC  
4. Re-Link the bank (do **not** copy `access_token` or the old secret from Cloudflare)

## Notes

- Plaid amounts: **positive = money out** (matches Plaid; UI shows spending as negative-looking red).
- After Link, history can take seconds–minutes; use **Sync now** or wait for cron.
- USB (`G:`) holds secrets source-of-truth; this repo on `E:` is code only.
