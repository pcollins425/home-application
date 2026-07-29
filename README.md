# Home application (Plaid bridge)

Short-lived personal finance bridge: **Cloudflare Worker + D1 + simple transaction dashboard**.

- Multiple bank Links (Plaid Items), soft cap **10 accounts** total
- History from **2026-05-01** (configurable) through ongoing cron sync
- UI: searchable table — date, amount, description, bank, account, location
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

From the credential USB (do **not** commit). For a **real** bank Link use **Production** keys (`PLAID_ENV=production` on the Worker — already set for this bridge).

```bash
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET
npx wrangler secret put ACCESS_KEY          # pick a long random passphrase for the UI
```

Redirect URI is **opt-in**: leave `PLAID_SEND_REDIRECT=false` until the URI is allowlisted in the Plaid dashboard. Then:

```bash
npx wrangler secret put PLAID_REDIRECT_URI
# e.g. https://home-application.paul-collins.workers.dev/
# set PLAID_SEND_REDIRECT = "true" in wrangler.toml [vars] and redeploy
```
### 4. Deploy

```bash
npm run deploy
```

Open the Worker URL → unlock with `ACCESS_KEY` → **Link account** → **Sync now** if the table is empty for a minute.

**Note:** If `*.workers.dev` returns Cloudflare error **1042**, enable the workers.dev subdomain for that Worker (Settings → Domains, or API `POST .../scripts/<name>/subdomain` with `{"enabled":true}`).

### 5. Custom domain (collinsmediallc.com)

Add DNS for `plaid-test` (proxied) or use **Workers → Custom Domains** in the dashboard. `wrangler.toml` already declares route `plaid-test.collinsmediallc.com/*`. Then set `PLAID_REDIRECT_URI` to that origin and register it in Plaid.

## API (session cookie required)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/status` | Linked Items/accounts, sync flags, date_min/max |
| GET | `/api/summary?all=1` or `since=&until=` | Institution → account → year → month In/Out/Net |
| POST | `/api/create_link_token` | Start Link |
| POST | `/api/exchange_public_token` | **Add** Item + background sync (does not wipe others) |
| POST | `/api/sync` | Sync all Items |
| GET | `/api/transactions?since=&until=&all=1&q=&account_id=&offset=` | Date-framed searchable rows |
| POST | `/api/reset` | Wipe all Items/accounts/transactions |

Date frames: `since` / `until` are inclusive `YYYY-MM-DD`. Pass `all=1` for no date filter. Sync still stores whatever Plaid returns; frames only affect reads/aggregates.

## Saturday cutover (mini-PC)

1. Delete/disable this Worker and wipe D1  
2. Rotate Plaid Development **secret** in the dashboard  
3. Put the **new** secret only on the mini-PC  
4. Re-Link the bank (do **not** copy `access_token` or the old secret from Cloudflare)

## Notes

- Plaid amounts: **positive = money out** (matches Plaid; UI shows spending as negative-looking red).
- After Link, history can take seconds–minutes; use **Sync now** or wait for cron.
- USB (`G:`) holds secrets source-of-truth; this repo on `E:` is code only.
- **Link another bank** adds a connection. Full wipe is `/api/reset` only (not in the UI).
- Account **balances** refresh on Sync (`/accounts/get` → D1). Loans show balance without requiring transactions.
- Date ranges query D1 first. A range outside stored `date_min`/`date_max` triggers Sync (same Items — no extra Plaid slot). Plaid still only returns history the institution made available; empty range after sync means no older data upstream.
- D1 free storage is ample at personal scale; prune-by-age later only if needed. Plaid Trial cost is **Items** (~10), not D1 bytes.
