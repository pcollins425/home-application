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

  // Store Item immediately; sync in background so the browser isn't stuck behind
  // a multi-page /transactions/sync (frontend used to abort at 20s).
  await env.DB.batch([
    env.DB.prepare("DELETE FROM transactions"),
    env.DB.prepare("DELETE FROM accounts"),
    env.DB.prepare("DELETE FROM plaid_items"),
    env.DB.prepare(
      `INSERT INTO plaid_items (item_id, access_token, institution_name, cursor, linked_at, last_sync_status)
       VALUES (?, ?, ?, NULL, ?, 'syncing')`
    ).bind(itemId, accessToken, institution, now),
  ]);

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
  if (stmts.length) await runBatch(env, stmts);
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
  path: string,
  ctx: ExecutionContext
): Promise<Response> {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) {
    return json({ error: "plaid_secrets_missing" }, 500);
  }

  if (path === "/api/status" && request.method === "GET") {
    return status(env);
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
    // Kick sync in background; client polls /api/status until last_sync_status=ok|error
    const item = await env.DB.prepare(
      "SELECT item_id FROM plaid_items LIMIT 1"
    ).first<{ item_id: string }>();
    if (!item) return json({ error: "not_linked" }, 400);
    await env.DB.prepare(
      `UPDATE plaid_items SET last_sync_status = 'syncing', last_sync_error = NULL WHERE item_id = ?`
    )
      .bind(item.item_id)
      .run();
    ctx.waitUntil(syncAll(env));
    return json({ ok: true, sync: { started: true, status: "syncing" } });
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
