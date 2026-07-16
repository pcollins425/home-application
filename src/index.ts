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
  ACCESS_KEY: string;
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

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

function requireAccess(request: Request, env: Env): boolean {
  const key = env.ACCESS_KEY;
  if (!key) return false;
  const header = request.headers.get("Authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const urlKey = new URL(request.url).searchParams.get("key") || "";
  return bearer === key || urlKey === key;
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

async function exchangePublicToken(
  env: Env,
  request: Request
): Promise<Response> {
  const { public_token, metadata } = (await request.json()) as {
    public_token?: string;
    metadata?: { institution?: { name?: string } };
  };
  if (!public_token) return json({ error: "public_token required" }, 400);

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
    return json({ error: "exchange_failed", detail: data }, 502);
  }

  const institution =
    metadata?.institution?.name || null;
  const now = new Date().toISOString();

  // Single-item bridge: replace any previous Item.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM transactions"),
    env.DB.prepare("DELETE FROM accounts"),
    env.DB.prepare("DELETE FROM plaid_items"),
    env.DB.prepare(
      `INSERT INTO plaid_items (item_id, access_token, institution_name, cursor, linked_at, last_sync_status)
       VALUES (?, ?, ?, NULL, ?, 'linked')`
    ).bind(data.item_id, data.access_token, institution, now),
  ]);

  // Kick sync; may be empty until Plaid finishes preparing history.
  const syncResult = await syncItem(env, data.item_id, data.access_token);
  return json({ ok: true, item_id: data.item_id, sync: syncResult });
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
    }>;
  };
  if (!res.ok || !data.accounts) return;

  const stmts = data.accounts.map((a) =>
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
  if (stmts.length) await env.DB.batch(stmts);
}

function locationLabel(tx: PlaidTx): string | null {
  const city = tx.location?.city;
  const region = tx.location?.region;
  if (city && region) return `${city}, ${region}`;
  if (city) return city;
  if (region) return region;
  return null;
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
    const loc = locationLabel(tx);
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
    void loc;
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

  if (stmts.length) await env.DB.batch(stmts);
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

async function syncAll(env: Env) {
  const { results } = await env.DB.prepare(
    "SELECT item_id, access_token, cursor FROM plaid_items"
  ).all<{ item_id: string; access_token: string; cursor: string | null }>();

  const out = [];
  for (const row of results || []) {
    out.push(
      await syncItem(env, row.item_id, row.access_token, row.cursor)
    );
  }
  return out;
}

async function status(env: Env): Promise<Response> {
  const item = await env.DB.prepare(
    `SELECT item_id, institution_name, linked_at, last_sync_at, last_sync_status, last_sync_error
     FROM plaid_items LIMIT 1`
  ).first<{
    item_id: string;
    institution_name: string | null;
    linked_at: string;
    last_sync_at: string | null;
    last_sync_status: string | null;
    last_sync_error: string | null;
  }>();

  const since = env.TRANSACTIONS_SINCE || "2026-05-01";
  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM transactions WHERE date >= ?"
  )
    .bind(since)
    .first<{ n: number }>();

  return json({
    linked: !!item,
    item,
    transaction_count: countRow?.n ?? 0,
    transactions_since: since,
    plaid_env: env.PLAID_ENV,
  });
}

async function listTransactions(
  env: Env,
  request: Request
): Promise<Response> {
  const url = new URL(request.url);
  const since =
    url.searchParams.get("since") || env.TRANSACTIONS_SINCE || "2026-05-01";
  const limit = Math.min(
    Number(url.searchParams.get("limit") || 500),
    2000
  );

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
       a.name AS account_name,
       a.mask AS account_mask
     FROM transactions t
     LEFT JOIN accounts a ON a.account_id = t.account_id
     WHERE t.date >= ?
     ORDER BY t.date DESC, t.transaction_id DESC
     LIMIT ?`
  )
    .bind(since, limit)
    .all();

  return json({ since, count: results?.length ?? 0, transactions: results || [] });
}

async function handleApi(
  request: Request,
  env: Env,
  path: string
): Promise<Response> {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) {
    return json({ error: "plaid_secrets_missing" }, 500);
  }
  if (!env.ACCESS_KEY) {
    return json({ error: "ACCESS_KEY secret not set" }, 500);
  }
  if (!requireAccess(request, env)) return unauthorized();

  if (path === "/api/status" && request.method === "GET") {
    return status(env);
  }
  if (path === "/api/create_link_token" && request.method === "POST") {
    return createLinkToken(env, request);
  }
  if (path === "/api/exchange_public_token" && request.method === "POST") {
    return exchangePublicToken(env, request);
  }
  if (path === "/api/sync" && request.method === "POST") {
    const results = await syncAll(env);
    return json({ ok: true, results });
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
}

/** Serve under www.collinsmediallc.com/plaid* and also at workers.dev root. */
const WWW_BASE = "/plaid";

function rewritePath(pathname: string): {
  path: string;
  redirectedFromBareBase: boolean;
} {
  if (pathname === WWW_BASE) {
    return { path: "/", redirectedFromBareBase: true };
  }
  if (pathname.startsWith(`${WWW_BASE}/`)) {
    return { path: pathname.slice(WWW_BASE.length) || "/", redirectedFromBareBase: false };
  }
  return { path: pathname, redirectedFromBareBase: false };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { path, redirectedFromBareBase } = rewritePath(url.pathname);

    if (redirectedFromBareBase) {
      url.pathname = `${WWW_BASE}/`;
      return Response.redirect(url.toString(), 302);
    }

    if (path.startsWith("/api/")) {
      return handleApi(request, env, path);
    }

    const assetUrl = new URL(request.url);
    assetUrl.pathname = path;
    return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    await syncAll(env);
  },
};
