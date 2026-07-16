/** works on workers.dev (/) and www.../plaid/ */
const API_BASE = location.pathname.startsWith("/plaid") ? "/plaid" : "";

const statusLine = document.getElementById("statusLine");
const meta = document.getElementById("meta");
const rows = document.getElementById("rows");
const linkBtn = document.getElementById("linkBtn");
const syncBtn = document.getElementById("syncBtn");

let cachedLinkToken = null;
let linkTokenPromise = null;

function setStatus(msg) {
  if (statusLine) statusLine.textContent = msg;
}

async function api(path, options = {}, timeoutMs = 30000) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      credentials: "same-origin",
      signal: ctrl.signal,
      ...options,
      headers,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      throw new Error("Request timed out — try Sign out, then open /plaid/ again");
    }
    throw err;
  }
  clearTimeout(timer);

  if (res.status === 401) {
    setStatus("Session expired — redirecting to sign-in…");
    location.href = `${API_BASE}/login`;
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail =
      data.detail?.error_message ||
      data.detail?.error_code ||
      (typeof data.detail === "string" ? data.detail : null) ||
      data.error ||
      res.statusText;
    throw new Error(detail);
  }
  return data;
}

function money(n) {
  const v = Number(n);
  const sign = v > 0 ? "-" : v < 0 ? "+" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function prefetchLinkToken() {
  if (linkBtn) linkBtn.disabled = true;
  linkTokenPromise = api("/api/create_link_token", { method: "POST" })
    .then((data) => {
      cachedLinkToken = data.link_token || null;
      if (linkBtn) linkBtn.disabled = !cachedLinkToken;
      return cachedLinkToken;
    })
    .catch((err) => {
      cachedLinkToken = null;
      if (linkBtn) linkBtn.disabled = false;
      console.error("link_token prefetch failed", err);
      return null;
    });
  return linkTokenPromise;
}

/** Poll until sync leaves "syncing" (background Worker job). */
async function waitForSync(maxMs = 120000) {
  const start = Date.now();
  let delay = 1500;
  while (Date.now() - start < maxMs) {
    const status = await api("/api/status");
    const st = status.item?.last_sync_status;
    if (st === "ok" || st === "error" || st === "linked") {
      return status;
    }
    setStatus(
      `Syncing${status.item?.institution_name ? ` · ${status.item.institution_name}` : ""}… (${status.transaction_count || 0} so far)`
    );
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 500, 4000);
  }
  return api("/api/status");
}

async function refresh() {
  setStatus("Fetching transactions…");
  let status = await api("/api/status");

  if (status.item?.last_sync_status === "syncing") {
    setStatus("Sync still running — waiting…");
    status = await waitForSync();
  }

  const syncClass =
    status.item?.last_sync_status === "ok"
      ? "ok"
      : status.item?.last_sync_status === "error"
        ? "err"
        : "warn";

  if (linkBtn) {
    linkBtn.textContent = status.linked ? "Link another / replace" : "Log in to bank";
  }

  setStatus(
    status.linked
      ? `Linked${status.item?.institution_name ? ` · ${status.item.institution_name}` : ""} · ${status.transaction_count} tx since ${status.transactions_since}`
      : "Not linked — log in to your bank to pull May 2026 → now."
  );

  if (meta) {
    meta.innerHTML = status.linked
      ? `
      <span>Last sync: <strong>${status.item?.last_sync_at || "—"}</strong>
        <span class="pill ${syncClass}">${status.item?.last_sync_status || "unknown"}</span>
      </span>
      ${status.item?.last_sync_error ? `<span>Error: <strong>${escapeHtml(status.item.last_sync_error)}</strong></span>` : ""}
    `
      : `<span>Connect one account. Done.</span>`;
  }

  if (!status.linked) {
    if (rows) {
      rows.innerHTML = `<tr><td colspan="5" class="empty">No account linked yet.</td></tr>`;
    }
    prefetchLinkToken();
    return;
  }

  setStatus(`Loading ${status.transaction_count || ""} transactions…`);
  const { transactions } = await api(
    `/api/transactions?since=${encodeURIComponent(status.transactions_since)}`
  );

  if (!transactions.length) {
    if (rows) {
      rows.innerHTML = `<tr><td colspan="5" class="empty">No transactions yet — try Sync now.</td></tr>`;
    }
    setStatus(
      `Linked${status.item?.institution_name ? ` · ${status.item.institution_name}` : ""} · 0 tx since ${status.transactions_since}`
    );
    prefetchLinkToken();
    return;
  }

  if (rows) {
    rows.innerHTML = transactions
      .map((t) => {
        const amt = Number(t.amount);
        const cls = amt > 0 ? "neg" : "pos";
        const pending = t.pending ? `<span class="pending">pending</span>` : "";
        const account = [t.account_name, t.account_mask ? `••${t.account_mask}` : null]
          .filter(Boolean)
          .join(" ");
        return `<tr>
        <td>${t.date}${pending}</td>
        <td class="amount ${cls}">${money(amt)}</td>
        <td>${escapeHtml(t.description || "—")}</td>
        <td>${escapeHtml(t.location || "—")}</td>
        <td>${escapeHtml(account || "—")}</td>
      </tr>`;
      })
      .join("");
  }

  setStatus(
    `Linked${status.item?.institution_name ? ` · ${status.item.institution_name}` : ""} · ${transactions.length} tx since ${status.transactions_since}`
  );
  prefetchLinkToken();
}

if (linkBtn) {
  linkBtn.disabled = true;
  linkBtn.addEventListener("click", () => {
    linkBtn.disabled = true;
    setStatus("Opening bank login…");
    try {
      const token = cachedLinkToken;
      if (!token) throw new Error("Bank login not ready yet — wait a second and try again");
      if (typeof Plaid === "undefined") {
        throw new Error("Plaid script failed to load — check network / ad blockers");
      }
      cachedLinkToken = null;
      const handler = Plaid.create({
        token,
        onSuccess: async (public_token, metadata) => {
          setStatus("Connecting…");
          await api("/api/exchange_public_token", {
            method: "POST",
            body: JSON.stringify({ public_token, metadata }),
          });
          setStatus("Connected — syncing in background…");
          await waitForSync();
          await refresh();
        },
        onExit: () => {
          prefetchLinkToken();
        },
      });
      handler.open();
    } catch (err) {
      setStatus(String(err.message || err));
      prefetchLinkToken();
    }
  });
}

if (syncBtn) {
  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    setStatus("Starting sync…");
    try {
      await api("/api/sync", { method: "POST" });
      await waitForSync();
      await refresh();
    } catch (err) {
      setStatus(String(err.message || err));
    } finally {
      syncBtn.disabled = false;
    }
  });
}

setStatus("Starting…");
refresh().catch((err) => {
  setStatus(String(err.message || err));
  if (rows) {
    rows.innerHTML = `<tr><td colspan="5" class="empty">Could not load: ${escapeHtml(String(err.message || err))}</td></tr>`;
  }
});
