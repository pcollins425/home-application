export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  PLAID_ENV: string;
  PLAID_PRODUCTS: string;
  PLAID_COUNTRY_CODES: string;
  PLAID_REDIRECT_URI?: string;
  PLAID_SEND_REDIRECT?: string;
  TRANSACTIONS_SINCE: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET: string;
  ALLOWED_EMAIL?: string;
  ACCESS_PASSWORD?: string;
}

type PlaidTx = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name?: string;
  merchant_name?: string | null;
  pending?: boolean;
  category?: string[] | null;
  location?: {
    city?: string | null;
    region?: string | null;
  } | null;
};

function plaidHost(env: string): string {
  const e = (env || "sandbox").toLowerCase();
  if (e === "production") return "https://production.plaid.com";
  if (e === "development") return "https://development.plaid.com";
  return "https://sandbox.plaid.com";
}

async function plaidFetch(
  env: Env,
  path: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`${plaidHost(env.PLAID_ENV)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      ...body,
    }),
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function createLinkToken(env: Env, request: Request): Promise<Response> {
  const products = (env.PLAID_PRODUCTS || "transactions")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const country_codes = (env.PLAID_COUNTRY_CODES || "US")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const body: Record<string, unknown> = {
    user: { client_user_id: "home-bridge-user-1" },
    client_name: "Home Application",
    products,
    country_codes,
    language: "en",
  };

  // Only send redirect_uri when allowlisted in Plaid dashboard AND enabled.
  // Sending an unregistered URI breaks /link/token/create (INVALID_FIELD).
  // Set PLAID_SEND_REDIRECT=true in [vars] after adding the URI in the dashboard.
  const sendRedirect = (env.PLAID_SEND_REDIRECT || "").toLowerCase() === "true"
  const redirect = (env.PLAID_REDIRECT_URI || "").trim()
  if (sendRedirect && redirect) {
    body.redirect_uri = redirect
  }

  const res = await plaidFetch(env, "/link/token/create", body)
  const data = (await res.json()) as Record<string, unknown>
  if (!res.ok) {
    return json(
      {
        error: "link_token_failed",
        detail: data,
        debug: {
          plaid_env: (env.PLAID_ENV || "").toLowerCase(),
          sent_redirect: Boolean(body.redirect_uri),
        },
      },
      502
    )
  }
  return json(data)
}

const MAX_LINKED_ACCOUNTS = 10;

async function exchangePublicToken(
  env: Env,
  request: Request
): Promise<{ response: Response; background?: () => Promise<unknown> }> {
  const { public_token, metadata } = (await request.json()) as {
    public_token?: string;
    metadata?: { institution?: { name?: string } };
  };
  if (!public_token) {
    return { response: json({ error: "public_token required" }, 400) };
  }

  const accountCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM accounts"
  ).first<{ n: number }>();
  if ((accountCount?.n ?? 0) >= MAX_LINKED_ACCOUNTS) {
    return {
      response: json(
        {
          error: "account_limit",
          detail: `Already at ${MAX_LINKED_ACCOUNTS} accounts — unlink or clear before adding more.`,
          account_count: accountCount?.n ?? 0,
        },
        400
      ),
    };
  }

  const res = await plaidFetch(env, "/item/public_token/exchange", {
    public_token,
  });
  const data = (await res.json()) as {
    access_token?: string;
    item_id?: string;
    error_code?: string;
    error_message?: string;
  };
  if (!res.ok || !data.access_token || !data.item_id) {
    return { response: json({ error: "exchange_failed", detail: data }, 502) };
  }

  const institution = metadata?.institution?.name || null;
  const now = new Date().toISOString();
  const itemId = data.item_id;
  const accessToken = data.access_token;

  // Add Item (multi-bank). Do not wipe other Items/accounts/transactions.
  // Sync in background so the browser isn't stuck behind multi-page sync.
  await env.DB.prepare(
    `INSERT INTO plaid_items (item_id, access_token, institution_name, cursor, linked_at, last_sync_status)
     VALUES (?, ?, ?, NULL, ?, 'syncing')
     ON CONFLICT(item_id) DO UPDATE SET
       access_token=excluded.access_token,
       institution_name=COALESCE(excluded.institution_name, plaid_items.institution_name),
       cursor=NULL,
       last_sync_status='syncing',
       last_sync_error=NULL`
  )
    .bind(itemId, accessToken, institution, now)
    .run();

  return {
    response: json({
      ok: true,
      item_id: itemId,
      sync: { started: true, status: "syncing" },
    }),
    background: () => syncItem(env, itemId, accessToken),
  };
}

async function upsertAccounts(
  env: Env,
  itemId: string,
  accessToken: string
): Promise<void> {
  const res = await plaidFetch(env, "/accounts/get", {
    access_token: accessToken,
  });
  const data = (await res.json()) as {
    accounts?: Array<{
      account_id: string;
      name?: string;
      official_name?: string | null;
      mask?: string | null;
      subtype?: string | null;
      type?: string;
      balances?: {
        available?: number | null;
        current?: number | null;
        limit?: number | null;
        iso_currency_code?: string | null;
        unofficial_currency_code?: string | null;
      };
    }>;
  };
  if (!res.ok || !data.accounts) return;

  const now = new Date().toISOString();
  const withBalances = data.accounts.map((a) =>
    env.DB.prepare(
      `INSERT INTO accounts (
         account_id, item_id, name, official_name, mask, subtype, type,
         balance_available, balance_current, balance_limit, balance_iso_currency, balance_updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         name=excluded.name,
         official_name=excluded.official_name,
         mask=excluded.mask,
         subtype=excluded.subtype,
         type=excluded.type,
         balance_available=excluded.balance_available,
         balance_current=excluded.balance_current,
         balance_limit=excluded.balance_limit,
         balance_iso_currency=excluded.balance_iso_currency,
         balance_updated_at=excluded.balance_updated_at`
    ).bind(
      a.account_id,
      itemId,
      a.name ?? null,
      a.official_name ?? null,
      a.mask ?? null,
      a.subtype ?? null,
      a.type ?? null,
      a.balances?.available ?? null,
      a.balances?.current ?? null,
      a.balances?.limit ?? null,
      a.balances?.iso_currency_code ??
        a.balances?.unofficial_currency_code ??
        null,
      now
    )
  );

  try {
    if (withBalances.length) await runBatch(env, withBalances);
  } catch (e) {
    // Migration 0002 not applied yet — still upsert core account fields.
    const basic = data.accounts.map((a) =>
      env.DB.prepare(
        `INSERT INTO accounts (account_id, item_id, name, official_name, mask, subtype, type)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           name=excluded.name,
           official_name=excluded.official_name,
           mask=excluded.mask,
           subtype=excluded.subtype,
           type=excluded.type`
      ).bind(
        a.account_id,
        itemId,
        a.name ?? null,
        a.official_name ?? null,
        a.mask ?? null,
        a.subtype ?? null,
        a.type ?? null
      )
    );
    if (basic.length) await runBatch(env, basic);
    console.warn(
      "upsertAccounts: balance columns missing — apply D1 migration 0002",
      e instanceof Error ? e.message : e
    );
  }
}

type AccountRow = {
  account_id: string;
  item_id: string;
  name: string | null;
  official_name?: string | null;
  mask: string | null;
  subtype: string | null;
  type: string | null;
  balance_available?: number | null;
  balance_current?: number | null;
  balance_limit?: number | null;
  balance_iso_currency?: string | null;
  balance_updated_at?: string | null;
  institution_name: string | null;
};

/** Prefer balance columns; fall back if migration 0002 not applied. */
async function listAccounts(
  env: Env,
  opts: { accountId?: string; itemId?: string } = {}
): Promise<{ accounts: AccountRow[]; balances_ready: boolean }> {
  const where: string[] = ["1=1"];
  const binds: (string | number)[] = [];
  if (opts.accountId) {
    where.push("a.account_id = ?");
    binds.push(opts.accountId);
  }
  if (opts.itemId) {
    where.push("a.item_id = ?");
    binds.push(opts.itemId);
  }
  const whereSql = where.join(" AND ");
  const order = "ORDER BY i.institution_name ASC, a.name ASC";

  const withBal = `SELECT a.account_id, a.item_id, a.name, a.official_name, a.mask, a.subtype, a.type,
            a.balance_available, a.balance_current, a.balance_limit, a.balance_iso_currency,
            a.balance_updated_at, i.institution_name
     FROM accounts a
     LEFT JOIN plaid_items i ON i.item_id = a.item_id
     WHERE ${whereSql}
     ${order}`;
  const basic = `SELECT a.account_id, a.item_id, a.name, a.official_name, a.mask, a.subtype, a.type,
            i.institution_name
     FROM accounts a
     LEFT JOIN plaid_items i ON i.item_id = a.item_id
     WHERE ${whereSql}
     ${order}`;

  try {
    const stmt = env.DB.prepare(withBal);
    const { results } = binds.length
      ? await stmt.bind(...binds).all<AccountRow>()
      : await stmt.all<AccountRow>();
    return { accounts: results || [], balances_ready: true };
  } catch (e) {
    console.warn(
      "listAccounts: balance columns missing — apply D1 migration 0002",
      e instanceof Error ? e.message : e
    );
    const stmt = env.DB.prepare(basic);
    const { results } = binds.length
      ? await stmt.bind(...binds).all<AccountRow>()
      : await stmt.all<AccountRow>();
    return { accounts: results || [], balances_ready: false };
  }
}

async function runBatch(
  env: Env,
  stmts: D1PreparedStatement[],
  chunkSize = 50
): Promise<void> {
  for (let i = 0; i < stmts.length; i += chunkSize) {
    await env.DB.batch(stmts.slice(i, i + chunkSize));
  }
}

async function applyTransactionPage(
  env: Env,
  itemId: string,
  added: PlaidTx[],
  modified: PlaidTx[],
  removed: Array<{ transaction_id: string }>
): Promise<{ stored: number; removed: number }> {
  const stmts: D1PreparedStatement[] = [];
  let stored = 0;

  const upsert = (tx: PlaidTx) => {
    const category = tx.category?.join(", ") ?? null;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO transactions (
           transaction_id, account_id, item_id, date, amount, name, merchant_name,
           location_city, location_region, pending, category, raw_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(transaction_id) DO UPDATE SET
           account_id=excluded.account_id,
           date=excluded.date,
           amount=excluded.amount,
           name=excluded.name,
           merchant_name=excluded.merchant_name,
           location_city=excluded.location_city,
           location_region=excluded.location_region,
           pending=excluded.pending,
           category=excluded.category,
           raw_json=excluded.raw_json`
      ).bind(
        tx.transaction_id,
        tx.account_id,
        itemId,
        tx.date,
        tx.amount,
        tx.name ?? null,
        tx.merchant_name ?? null,
        tx.location?.city ?? null,
        tx.location?.region ?? null,
        tx.pending ? 1 : 0,
        category,
        JSON.stringify(tx)
      )
    );
    stored += 1;
  };

  for (const tx of added) upsert(tx);
  for (const tx of modified) upsert(tx);
  for (const r of removed) {
    stmts.push(
      env.DB.prepare("DELETE FROM transactions WHERE transaction_id = ?").bind(
        r.transaction_id
      )
    );
  }

  if (stmts.length) await runBatch(env, stmts);
  return { stored, removed: removed.length };
}

async function syncItem(
  env: Env,
  itemId: string,
  accessToken: string,
  existingCursor: string | null = null
): Promise<{
  ok: boolean;
  added: number;
  modified: number;
  removed: number;
  pages: number;
  error?: string;
}> {
  await upsertAccounts(env, itemId, accessToken);

  let cursor = existingCursor;
  let pages = 0;
  let added = 0;
  let modified = 0;
  let removed = 0;

  try {
    for (;;) {
      const body: Record<string, unknown> = {
        access_token: accessToken,
        count: 500,
      };
      if (cursor) body.cursor = cursor;

      const res = await plaidFetch(env, "/transactions/sync", body);
      const data = (await res.json()) as {
        added?: PlaidTx[];
        modified?: PlaidTx[];
        removed?: Array<{ transaction_id: string }>;
        next_cursor?: string;
        has_more?: boolean;
        error_code?: string;
        error_message?: string;
      };

      if (!res.ok) {
        const err = data.error_message || data.error_code || "sync_failed";
        await env.DB.prepare(
          `UPDATE plaid_items SET last_sync_at = ?, last_sync_status = 'error', last_sync_error = ? WHERE item_id = ?`
        )
          .bind(new Date().toISOString(), err, itemId)
          .run();
        return { ok: false, added, modified, removed, pages, error: err };
      }

      pages += 1;
      const page = await applyTransactionPage(
        env,
        itemId,
        data.added || [],
        data.modified || [],
        data.removed || []
      );
      added += data.added?.length || 0;
      modified += data.modified?.length || 0;
      removed += page.removed;
      cursor = data.next_cursor ?? cursor;

      if (!data.has_more) break;
    }

    await env.DB.prepare(
      `UPDATE plaid_items
       SET cursor = ?, last_sync_at = ?, last_sync_status = 'ok', last_sync_error = NULL
       WHERE item_id = ?`
    )
      .bind(cursor, new Date().toISOString(), itemId)
      .run();

    return { ok: true, added, modified, removed, pages };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await env.DB.prepare(
      `UPDATE plaid_items SET last_sync_at = ?, last_sync_status = 'error', last_sync_error = ? WHERE item_id = ?`
    )
      .bind(new Date().toISOString(), err, itemId)
      .run();
    return { ok: false, added, modified, removed, pages, error: err };
  }
}

async function syncAll(env: Env, opts: { full?: boolean } = {}) {
  const { results } = await env.DB.prepare(
    "SELECT item_id, access_token, cursor FROM plaid_items"
  ).all<{ item_id: string; access_token: string; cursor: string | null }>();

  const out = [];
  for (const row of results || []) {
    if (opts.full) {
      // Empty cursor = Plaid re-sends all history it has for the Item (as adds).
      await env.DB.prepare(
        `UPDATE plaid_items SET cursor = NULL WHERE item_id = ?`
      )
        .bind(row.item_id)
        .run();
    }
    out.push(
      await syncItem(
        env,
        row.item_id,
        row.access_token,
        opts.full ? null : row.cursor
      )
    );
  }
  return out;
}

/**
 * Pull a concrete date window from Plaid via /transactions/get (supports
 * start_date/end_date). /transactions/sync does not — ranges only filtered D1
 * before. Upserts into D1; does not burn a new Item slot.
 */
async function backfillItem(
  env: Env,
  itemId: string,
  accessToken: string,
  since: string,
  until: string
): Promise<{ ok: boolean; stored: number; pages: number; error?: string }> {
  await upsertAccounts(env, itemId, accessToken);

  let offset = 0;
  let pages = 0;
  let stored = 0;
  const pageSize = 500;

  try {
    for (;;) {
      const res = await plaidFetch(env, "/transactions/get", {
        access_token: accessToken,
        start_date: since,
        end_date: until,
        options: { count: pageSize, offset },
      });
      const data = (await res.json()) as {
        transactions?: PlaidTx[];
        total_transactions?: number;
        error_code?: string;
        error_message?: string;
      };

      if (!res.ok) {
        const err = data.error_message || data.error_code || "backfill_failed";
        await env.DB.prepare(
          `UPDATE plaid_items SET last_sync_at = ?, last_sync_status = 'error', last_sync_error = ? WHERE item_id = ?`
        )
          .bind(new Date().toISOString(), err, itemId)
          .run();
        return { ok: false, stored, pages, error: err };
      }

      const txs = data.transactions || [];
      pages += 1;
      const page = await applyTransactionPage(env, itemId, txs, [], []);
      stored += page.stored;
      offset += txs.length;

      const total = data.total_transactions ?? offset;
      if (offset >= total || txs.length === 0) break;
    }

    await env.DB.prepare(
      `UPDATE plaid_items
       SET last_sync_at = ?, last_sync_status = 'ok', last_sync_error = NULL
       WHERE item_id = ?`
    )
      .bind(new Date().toISOString(), itemId)
      .run();

    return { ok: true, stored, pages };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await env.DB.prepare(
      `UPDATE plaid_items SET last_sync_at = ?, last_sync_status = 'error', last_sync_error = ? WHERE item_id = ?`
    )
      .bind(new Date().toISOString(), err, itemId)
      .run();
    return { ok: false, stored, pages, error: err };
  }
}

async function backfillAll(
  env: Env,
  since: string,
  until: string
): Promise<Array<{ ok: boolean; stored: number; pages: number; error?: string }>> {
  const { results } = await env.DB.prepare(
    "SELECT item_id, access_token FROM plaid_items"
  ).all<{ item_id: string; access_token: string }>();

  const out = [];
  for (const row of results || []) {
    out.push(await backfillItem(env, row.item_id, row.access_token, since, until));
  }
  return out;
}

/** YYYY-MM-DD only; rejects junk. */
function parseDateParam(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

/** Inclusive since/until from query. all=1 → no date filter. */
function dateFrameFromUrl(url: URL): {
  since: string | null;
  until: string | null;
  all: boolean;
} {
  const allRaw = (url.searchParams.get("all") || "").toLowerCase();
  const all = allRaw === "1" || allRaw === "true";
  const since = parseDateParam(url.searchParams.get("since"));
  const until = parseDateParam(url.searchParams.get("until"));
  if (all) return { since: null, until: null, all: true };
  return { since, until, all: false };
}

function appendDateFrame(
  where: string[],
  binds: (string | number)[],
  since: string | null,
  until: string | null,
  column = "t.date"
): void {
  if (since) {
    where.push(`${column} >= ?`);
    binds.push(since);
  }
  if (until) {
    where.push(`${column} <= ?`);
    binds.push(until);
  }
}

type MonthAggRow = {
  item_id: string;
  institution_name: string | null;
  account_id: string;
  account_name: string | null;
  account_mask: string | null;
  year: string;
  month: string;
  tx_count: number;
  inflow: number;
  outflow: number;
  pending_count: number;
};

async function status(env: Env): Promise<Response> {
  const { results: items } = await env.DB.prepare(
    `SELECT item_id, institution_name, linked_at, last_sync_at, last_sync_status, last_sync_error
     FROM plaid_items
     ORDER BY linked_at ASC`
  ).all<{
    item_id: string;
    institution_name: string | null;
    linked_at: string;
    last_sync_at: string | null;
    last_sync_status: string | null;
    last_sync_error: string | null;
  }>();

  const { accounts: accountList, balances_ready } = await listAccounts(env);

  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM transactions"
  ).first<{ n: number }>();
  const range = await env.DB.prepare(
    "SELECT MIN(date) AS date_min, MAX(date) AS date_max FROM transactions"
  ).first<{ date_min: string | null; date_max: string | null }>();

  const itemList = items || [];
  const syncing = itemList.some((i) => i.last_sync_status === "syncing");
  const item = itemList[0] || null;

  return json({
    linked: itemList.length > 0,
    item,
    items: itemList,
    accounts: accountList,
    item_count: itemList.length,
    account_count: accountList.length,
    account_limit: MAX_LINKED_ACCOUNTS,
    can_link_more: accountList.length < MAX_LINKED_ACCOUNTS,
    syncing,
    balances_ready,
    transaction_count: countRow?.n ?? 0,
    date_min: range?.date_min ?? null,
    date_max: range?.date_max ?? null,
    // Legacy default window; UI now prefers explicit since/until or all=1.
    transactions_since: env.TRANSACTIONS_SINCE || null,
    plaid_env: env.PLAID_ENV,
  });
}

/**
 * Institution → account → year → month rollups (In/Out/Net).
 * Optional since/until (inclusive). Sort/aggregate only — no labels.
 */
async function summary(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { since, until } = dateFrameFromUrl(url);
  const accountId = (url.searchParams.get("account_id") || "").trim();
  const itemId = (url.searchParams.get("item_id") || "").trim();

  const where: string[] = ["1=1"];
  const binds: (string | number)[] = [];
  appendDateFrame(where, binds, since, until);
  if (accountId) {
    where.push("t.account_id = ?");
    binds.push(accountId);
  }
  if (itemId) {
    where.push("t.item_id = ?");
    binds.push(itemId);
  }

  const summarySql = `SELECT
       t.item_id AS item_id,
       i.institution_name AS institution_name,
       t.account_id AS account_id,
       a.name AS account_name,
       a.mask AS account_mask,
       substr(t.date, 1, 4) AS year,
       substr(t.date, 1, 7) AS month,
       COUNT(*) AS tx_count,
       SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END) AS inflow,
       SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) AS outflow,
       SUM(CASE WHEN t.pending = 1 THEN 1 ELSE 0 END) AS pending_count
     FROM transactions t
     LEFT JOIN accounts a ON a.account_id = t.account_id
     LEFT JOIN plaid_items i ON i.item_id = t.item_id
     WHERE ${where.join(" AND ")}
     GROUP BY t.item_id, i.institution_name, t.account_id, a.name, a.mask,
              substr(t.date, 1, 4), substr(t.date, 1, 7)
     ORDER BY i.institution_name ASC, a.name ASC, month DESC`;
  const summaryStmt = env.DB.prepare(summarySql);
  const { results } = binds.length
    ? await summaryStmt.bind(...binds).all<MonthAggRow>()
    : await summaryStmt.all<MonthAggRow>();

  type MonthNode = {
    month: string;
    year: string;
    tx_count: number;
    inflow: number;
    outflow: number;
    net: number;
    pending_count: number;
  };
  type YearNode = { year: string; months: MonthNode[] };
  type AccountNode = {
    account_id: string;
    name: string | null;
    mask: string | null;
    subtype?: string | null;
    type?: string | null;
    balance_available?: number | null;
    balance_current?: number | null;
    balance_limit?: number | null;
    balance_iso_currency?: string | null;
    balance_updated_at?: string | null;
    years: YearNode[];
  };
  type InstNode = {
    item_id: string;
    institution_name: string | null;
    accounts: AccountNode[];
  };

  const institutions: InstNode[] = [];
  const instMap = new Map<string, InstNode>();
  const acctMap = new Map<string, AccountNode>();
  const yearMap = new Map<string, YearNode>();

  // Seed every linked account (even with zero transactions) so the tree
  // matches /accounts/get, not only accounts that have posted rows.
  const { accounts: allAccounts, balances_ready } = await listAccounts(env, {
    accountId: accountId || undefined,
    itemId: itemId || undefined,
  });

  for (const a of allAccounts || []) {
    let inst = instMap.get(a.item_id);
    if (!inst) {
      inst = {
        item_id: a.item_id,
        institution_name: a.institution_name,
        accounts: [],
      };
      instMap.set(a.item_id, inst);
      institutions.push(inst);
    }
    const acctKey = `${a.item_id}:${a.account_id}`;
    if (!acctMap.has(acctKey)) {
      const acct: AccountNode = {
        account_id: a.account_id,
        name: a.name,
        mask: a.mask,
        subtype: a.subtype,
        type: a.type,
        balance_available: a.balance_available ?? null,
        balance_current: a.balance_current ?? null,
        balance_limit: a.balance_limit ?? null,
        balance_iso_currency: a.balance_iso_currency ?? null,
        balance_updated_at: a.balance_updated_at ?? null,
        years: [],
      };
      acctMap.set(acctKey, acct);
      inst.accounts.push(acct);
    }
  }

  for (const row of results || []) {
    let inst = instMap.get(row.item_id);
    if (!inst) {
      inst = {
        item_id: row.item_id,
        institution_name: row.institution_name,
        accounts: [],
      };
      instMap.set(row.item_id, inst);
      institutions.push(inst);
    }

    const acctKey = `${row.item_id}:${row.account_id}`;
    let acct = acctMap.get(acctKey);
    if (!acct) {
      acct = {
        account_id: row.account_id,
        name: row.account_name,
        mask: row.account_mask,
        years: [],
      };
      acctMap.set(acctKey, acct);
      inst.accounts.push(acct);
    }

    const yearKey = `${acctKey}:${row.year}`;
    let yearNode = yearMap.get(yearKey);
    if (!yearNode) {
      yearNode = { year: row.year, months: [] };
      yearMap.set(yearKey, yearNode);
      acct.years.push(yearNode);
    }

    const inflow = Number(row.inflow) || 0;
    const outflow = Number(row.outflow) || 0;
    yearNode.months.push({
      month: row.month,
      year: row.year,
      tx_count: Number(row.tx_count) || 0,
      inflow,
      outflow,
      net: inflow - outflow,
      pending_count: Number(row.pending_count) || 0,
    });
  }

  const range = await env.DB.prepare(
    "SELECT MIN(date) AS date_min, MAX(date) AS date_max FROM transactions"
  ).first<{ date_min: string | null; date_max: string | null }>();

  return json({
    since,
    until,
    date_min: range?.date_min ?? null,
    date_max: range?.date_max ?? null,
    account_count: acctMap.size,
    balances_ready,
    institutions,
  });
}

async function listTransactions(
  env: Env,
  request: Request
): Promise<Response> {
  const url = new URL(request.url);
  const { since, until, all } = dateFrameFromUrl(url);
  // Default frame only when caller sent neither since/until nor all=1.
  const effectiveSince =
    since ??
    (all || until ? null : env.TRANSACTIONS_SINCE || null);
  const q = (url.searchParams.get("q") || "").trim();
  const accountId = (url.searchParams.get("account_id") || "").trim();
  const itemId = (url.searchParams.get("item_id") || "").trim();
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") || 500) || 500, 1),
    2000
  );
  const offset = Math.max(Number(url.searchParams.get("offset") || 0) || 0, 0);

  const where: string[] = ["1=1"];
  const binds: (string | number)[] = [];
  appendDateFrame(where, binds, effectiveSince, until);

  if (accountId) {
    where.push("t.account_id = ?");
    binds.push(accountId);
  }
  if (itemId) {
    where.push("t.item_id = ?");
    binds.push(itemId);
  }
  if (q) {
    where.push(
      `(
        COALESCE(t.merchant_name, '') LIKE ? OR
        COALESCE(t.name, '') LIKE ? OR
        COALESCE(t.location_city, '') LIKE ? OR
        COALESCE(t.location_region, '') LIKE ? OR
        COALESCE(t.category, '') LIKE ? OR
        COALESCE(a.name, '') LIKE ? OR
        COALESCE(a.mask, '') LIKE ? OR
        COALESCE(i.institution_name, '') LIKE ?
      )`
    );
    const like = `%${q.replace(/[%_]/g, "")}%`;
    for (let i = 0; i < 8; i++) binds.push(like);
  }

  const whereSql = where.join(" AND ");

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n
     FROM transactions t
     LEFT JOIN accounts a ON a.account_id = t.account_id
     LEFT JOIN plaid_items i ON i.item_id = t.item_id
     WHERE ${whereSql}`
  )
    .bind(...binds)
    .first<{ n: number }>();

  const { results } = await env.DB.prepare(
    `SELECT
       t.date,
       t.amount,
       COALESCE(t.merchant_name, t.name) AS description,
       CASE
         WHEN t.location_city IS NOT NULL AND t.location_region IS NOT NULL
           THEN t.location_city || ', ' || t.location_region
         WHEN t.location_city IS NOT NULL THEN t.location_city
         WHEN t.location_region IS NOT NULL THEN t.location_region
         ELSE NULL
       END AS location,
       t.pending,
       t.category,
       a.name AS account_name,
       a.mask AS account_mask,
       a.account_id,
       i.institution_name,
       i.item_id
     FROM transactions t
     LEFT JOIN accounts a ON a.account_id = t.account_id
     LEFT JOIN plaid_items i ON i.item_id = t.item_id
     WHERE ${whereSql}
     ORDER BY t.date DESC, t.transaction_id DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...binds, limit, offset)
    .all();

  return json({
    since: effectiveSince,
    until,
    all,
    q: q || null,
    account_id: accountId || null,
    item_id: itemId || null,
    limit,
    offset,
    total: countRow?.n ?? 0,
    count: results?.length ?? 0,
    transactions: results || [],
  });
}

async function handleApi(
  request: Request,
  env: Env,
  path: string,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) {
      return json({ error: "plaid_secrets_missing" }, 500);
    }

    if (path === "/api/status" && request.method === "GET") {
      return status(env);
    }
    if (path === "/api/summary" && request.method === "GET") {
      return summary(env, request);
    }
    if (path === "/api/create_link_token" && request.method === "POST") {
      return createLinkToken(env, request);
    }
    if (path === "/api/exchange_public_token" && request.method === "POST") {
      const out = await exchangePublicToken(env, request);
      if (out.background) ctx.waitUntil(out.background());
      return out.response;
    }
    if (path === "/api/sync" && request.method === "POST") {
      // Kick sync in background; client polls /api/status until syncing=false
      // Body: { full: true } clears cursors and re-pulls all history Plaid has.
      const body = (await request.json().catch(() => ({}))) as {
        full?: boolean;
      };
      const full = Boolean(body.full);
      const { results } = await env.DB.prepare(
        "SELECT item_id FROM plaid_items"
      ).all<{ item_id: string }>();
      if (!results?.length) return json({ error: "not_linked" }, 400);
      await env.DB.prepare(
        `UPDATE plaid_items SET last_sync_status = 'syncing', last_sync_error = NULL`
      ).run();
      ctx.waitUntil(syncAll(env, { full }));
      return json({
        ok: true,
        sync: { started: true, status: "syncing", items: results.length, full },
      });
    }
    if (path === "/api/backfill" && request.method === "POST") {
      // Date-ranged pull via /transactions/get (sync API has no start/end dates).
      const body = (await request.json().catch(() => ({}))) as {
        since?: string;
        until?: string;
      };
      const since = parseDateParam(body.since ?? null);
      const until = parseDateParam(body.until ?? null);
      if (!since || !until) {
        return json(
          { error: "since_and_until_required", detail: "YYYY-MM-DD" },
          400
        );
      }
      if (since > until) {
        return json({ error: "since_after_until" }, 400);
      }
      const { results } = await env.DB.prepare(
        "SELECT item_id FROM plaid_items"
      ).all<{ item_id: string }>();
      if (!results?.length) return json({ error: "not_linked" }, 400);
      await env.DB.prepare(
        `UPDATE plaid_items SET last_sync_status = 'syncing', last_sync_error = NULL`
      ).run();
      ctx.waitUntil(backfillAll(env, since, until));
      return json({
        ok: true,
        sync: {
          started: true,
          status: "syncing",
          mode: "backfill",
          since,
          until,
          items: results.length,
        },
      });
    }
    if (path === "/api/transactions" && request.method === "GET") {
      return listTransactions(env, request);
    }
    if (path === "/api/reset" && request.method === "POST") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM transactions"),
        env.DB.prepare("DELETE FROM accounts"),
        env.DB.prepare("DELETE FROM plaid_items"),
      ]);
      return json({ ok: true, cleared: true });
    }

    return json({ error: "not_found" }, 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("handleApi", path, message);
    return json({ error: message || "server_error", path }, 500);
  }
}

/** Serve under www.collinsmediallc.com/plaid* and also at workers.dev root. */
const WWW_BASE = "/plaid";
const COOKIE_NAME = "home_session";
const DEFAULT_ALLOWED_EMAIL = "pcollins425@gmail.com";

function rewritePath(pathname: string): {
  path: string;
  redirectedFromBareBase: boolean;
  basePath: string;
} {
  if (pathname === WWW_BASE) {
    return { path: "/", redirectedFromBareBase: true, basePath: WWW_BASE };
  }
  if (pathname.startsWith(`${WWW_BASE}/`)) {
    return {
      path: pathname.slice(WWW_BASE.length) || "/",
      redirectedFromBareBase: false,
      basePath: WWW_BASE,
    };
  }
  return { path: pathname, redirectedFromBareBase: false, basePath: "" };
}

function allowedEmail(env: Env): string {
  return (env.ALLOWED_EMAIL || DEFAULT_ALLOWED_EMAIL).trim().toLowerCase();
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlJson(obj: unknown): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return b64url(sig);
}

async function makeSessionCookie(
  env: Env,
  email: string,
  basePath: string
): Promise<string> {
  const payload = {
    email: email.toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14,
  };
  const body = b64urlJson(payload);
  const sig = await hmacSign(env.SESSION_SECRET, body);
  const value = `${body}.${sig}`;
  const path = basePath || "/";
  return `${COOKIE_NAME}=${value}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}`;
}

function clearSessionCookie(basePath: string): string {
  const path = basePath || "/";
  return `${COOKIE_NAME}=; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

async function sessionEmail(
  request: Request,
  env: Env
): Promise<string | null> {
  if (!env.SESSION_SECRET) return null;
  const raw = readCookie(request, COOKIE_NAME);
  if (!raw || !raw.includes(".")) return null;
  const [body, sig] = raw.split(".");
  const expect = await hmacSign(env.SESSION_SECRET, body);
  if (sig !== expect) return null;
  try {
    const pad = "=".repeat((4 - (body.length % 4)) % 4);
    const json = atob((body + pad).replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json) as { email?: string; exp?: number };
    if (!payload.email || !payload.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.email.toLowerCase();
  } catch {
    return null;
  }
}

async function requireGoogleUser(
  request: Request,
  env: Env,
  basePath: string,
  mode: "html" | "api"
): Promise<{ email: string } | Response> {
  const email = await sessionEmail(request, env);
  if (email && email === allowedEmail(env)) return { email };
  // Prefer /login (pretty Assets path) so relative CSS works; /auth/login also works
  // but nested under /auth/ breaks relative styles.css → /plaid/auth/styles.css 404.
  const login = `${basePath}/login`;
  if (mode === "html") {
    return new Response(null, {
      status: 302,
      headers: { Location: new URL(login, request.url).toString() },
    });
  }
  return json({ error: "unauthorized", login }, 401);
}

async function verifyGoogleIdToken(
  env: Env,
  idToken: string
): Promise<{ email: string }> {
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );
  const info = (await res.json()) as {
    aud?: string;
    email?: string;
    email_verified?: string | boolean;
    error?: string;
  };
  if (!res.ok || info.error) {
    throw new Error(info.error || "invalid_google_token");
  }
  if (info.aud !== env.GOOGLE_CLIENT_ID) {
    throw new Error("google_token_audience_mismatch");
  }
  const email = (info.email || "").toLowerCase();
  const verified =
    info.email_verified === true || info.email_verified === "true";
  if (!email || !verified) throw new Error("email_unverified");
  if (email !== allowedEmail(env)) {
    throw new Error(`access_denied:${email}`);
  }
  return { email };
}

async function handleAuth(
  request: Request,
  env: Env,
  path: string,
  basePath: string
): Promise<Response> {
  if (!env.SESSION_SECRET) {
    return json({ error: "session_not_configured" }, 500);
  }

  const url = new URL(request.url);

  if (path === "/auth/config" && request.method === "GET") {
    return json({
      google_client_id: env.GOOGLE_CLIENT_ID || null,
      allowed_email: allowedEmail(env),
      password_enabled: Boolean(env.ACCESS_PASSWORD),
    });
  }

  if (path === "/auth/login" && request.method === "GET") {
    // Assets rewrites login.html → /login; fetch that pretty path and return it
    // (do not pass through the 307 Location:/login — that breaks under /plaid).
    const loginAsset = await env.ASSETS.fetch(
      new Request(new URL("/login", request.url), request)
    );
    const headers = new Headers(loginAsset.headers);
    headers.set("Cache-Control", "no-store");
    headers.delete("Location");
    return new Response(loginAsset.body, {
      status: loginAsset.status === 307 || loginAsset.status === 302 ? 200 : loginAsset.status,
      headers,
    });
  }

  if (path === "/auth/logout") {
    const dest = `${url.origin}${basePath}/login`;
    return new Response(null, {
      status: 302,
      headers: {
        Location: dest,
        "Set-Cookie": clearSessionCookie(basePath),
      },
    });
  }

  if (path === "/auth/session" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      google_token?: string;
      password?: string;
    };

    try {
      let email: string | null = null;
      if (body.google_token) {
        if (!env.GOOGLE_CLIENT_ID) {
          return json({ error: "google_not_configured" }, 500);
        }
        email = (await verifyGoogleIdToken(env, body.google_token)).email;
      } else if (body.password != null) {
        if (!env.ACCESS_PASSWORD || body.password !== env.ACCESS_PASSWORD) {
          return json({ error: "invalid_password" }, 401);
        }
        email = allowedEmail(env);
      } else {
        return json({ error: "google_token_or_password_required" }, 400);
      }

      const headers = new Headers({ "Content-Type": "application/json" });
      headers.append("Set-Cookie", await makeSessionCookie(env, email, basePath));
      return new Response(JSON.stringify({ ok: true, email }), { status: 200, headers });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("access_denied:")) {
        return json({ error: "access_denied", detail: msg.slice("access_denied:".length) }, 403);
      }
      return json({ error: msg }, 401);
    }
  }

  return json({ error: "not_found" }, 404);
}

function isAuthed(
  result: { email: string } | Response
): result is { email: string } {
  return "email" in result;
}

/** CSS/JS must not hit the Google redirect — browsers treat that as broken styles. */
function isStaticAsset(path: string): boolean {
  return /\.(css|js|map|ico|png|jpe?g|gif|svg|webp|woff2?|html)$/i.test(path);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const { path, redirectedFromBareBase, basePath } = rewritePath(url.pathname);

    if (redirectedFromBareBase) {
      url.pathname = `${WWW_BASE}/`;
      return Response.redirect(url.toString(), 302);
    }

    if (path.startsWith("/auth/")) {
      return handleAuth(request, env, path, basePath);
    }

    // Public pretty login path (Cloudflare Assets maps login.html → /login)
    if (path === "/login" || path === "/login/") {
      const loginAsset = await env.ASSETS.fetch(
        new Request(new URL("/login", request.url), request)
      );
      const headers = new Headers(loginAsset.headers);
      headers.set("Cache-Control", "no-store");
      return new Response(loginAsset.body, { status: 200, headers });
    }

    if (path.startsWith("/api/")) {
      const gate = await requireGoogleUser(request, env, basePath, "api");
      if (!isAuthed(gate)) return gate;
      return handleApi(request, env, path, ctx);
    }

    // Public static assets (no secrets). Gate HTML shell + API only.
    if (!isStaticAsset(path)) {
      const gate = await requireGoogleUser(request, env, basePath, "html");
      if (!isAuthed(gate)) return gate;
    }

    const assetUrl = new URL(request.url);
    assetUrl.pathname = path;
    const assetRes = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
    // Never cache the HTML shell — stale copies stick on "Loading…" without a session.
    if (path === "/" || path.endsWith(".html")) {
      const headers = new Headers(assetRes.headers);
      headers.set("Cache-Control", "no-store, max-age=0");
      return new Response(assetRes.body, {
        status: assetRes.status,
        statusText: assetRes.statusText,
        headers,
      });
    }
    return assetRes;
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    await syncAll(env);
  },
};
