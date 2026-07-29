/** works on workers.dev (/) and www.../plaid/ */
const API_BASE =
  typeof window !== "undefined" && window.__BASE != null
    ? window.__BASE
    : location.pathname.startsWith("/plaid")
      ? "/plaid"
      : "";

const PAGE_SIZE = 500;

const statusLine = document.getElementById("statusLine");
const meta = document.getElementById("meta");
const sources = document.getElementById("sources");
const rows = document.getElementById("rows");
const linkBtn = document.getElementById("linkBtn");
const syncBtn = document.getElementById("syncBtn");
const searchInput = document.getElementById("searchInput");
const resultMeta = document.getElementById("resultMeta");
const pager = document.getElementById("pager");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");

let cachedLinkToken = null;
let linkTokenPromise = null;
let lastStatus = null;
let searchQuery = "";
let offset = 0;
let searchTimer = null;

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
      const canLink = lastStatus?.can_link_more !== false;
      if (linkBtn) linkBtn.disabled = !cachedLinkToken || !canLink;
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

/** Poll until no Item is syncing. */
async function waitForSync(maxMs = 180000) {
  const start = Date.now();
  let delay = 1500;
  while (Date.now() - start < maxMs) {
    const status = await api("/api/status");
    if (!status.syncing) return status;
    const n = status.account_count || 0;
    setStatus(`Syncing… (${status.transaction_count || 0} tx · ${n} accounts)`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 500, 4000);
  }
  return api("/api/status");
}

function renderSources(status) {
  if (!sources) return;
  const accounts = status.accounts || [];
  if (!accounts.length) {
    sources.innerHTML = "";
    sources.hidden = true;
    return;
  }
  sources.hidden = false;
  sources.innerHTML = `
    <p class="sources-label">Linked accounts (${accounts.length}/${status.account_limit || 10})</p>
    <ul class="sources-list">
      ${accounts
        .map((a) => {
          const label = [a.institution_name, a.name, a.mask ? `••${a.mask}` : null]
            .filter(Boolean)
            .join(" · ");
          return `<li>${escapeHtml(label || a.account_id)}</li>`;
        })
        .join("")}
    </ul>
  `;
}

function renderMeta(status) {
  if (!meta) return;
  if (!status.linked) {
    meta.innerHTML = `<span>Link each bank once (up to ${status.account_limit || 10} accounts). Data stays in one table.</span>`;
    return;
  }
  const items = status.items || [];
  const syncBits = items
    .map((i) => {
      const cls =
        i.last_sync_status === "ok"
          ? "ok"
          : i.last_sync_status === "error"
            ? "err"
            : "warn";
      const name = i.institution_name || "Bank";
      return `<span>${escapeHtml(name)} <span class="pill ${cls}">${escapeHtml(i.last_sync_status || "?")}</span></span>`;
    })
    .join("");
  const err = items.find((i) => i.last_sync_error);
  meta.innerHTML = `
    <span>${status.item_count || 0} bank link(s) · ${status.account_count || 0} accounts · ${status.transaction_count || 0} tx since ${status.transactions_since}</span>
    ${syncBits}
    ${err ? `<span>Error: <strong>${escapeHtml(err.last_sync_error)}</strong></span>` : ""}
  `;
}

function updatePager(total) {
  if (!pager || !prevBtn || !nextBtn) return;
  const hasPages = total > PAGE_SIZE;
  pager.hidden = !hasPages;
  prevBtn.disabled = offset <= 0;
  nextBtn.disabled = offset + PAGE_SIZE >= total;
}

async function loadTransactions(status) {
  const since = status.transactions_since;
  const params = new URLSearchParams({
    since,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (searchQuery) params.set("q", searchQuery);

  const data = await api(`/api/transactions?${params}`);
  const transactions = data.transactions || [];
  const total = data.total ?? transactions.length;

  if (resultMeta) {
    resultMeta.textContent = searchQuery
      ? `${total} match${total === 1 ? "" : "es"} for “${searchQuery}”`
      : `${total} transaction${total === 1 ? "" : "s"}`;
  }

  updatePager(total);

  if (!transactions.length) {
    if (rows) {
      rows.innerHTML = `<tr><td colspan="6" class="empty">${
        searchQuery
          ? "No matches — try a different search."
          : "No transactions yet — try Sync now."
      }</td></tr>`;
    }
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
        <td>${escapeHtml(t.institution_name || "—")}</td>
        <td>${escapeHtml(account || "—")}</td>
        <td>${escapeHtml(t.location || "—")}</td>
      </tr>`;
      })
      .join("");
  }
}

async function refresh() {
  setStatus("Fetching…");
  let status = await api("/api/status");
  lastStatus = status;

  if (status.syncing) {
    setStatus("Sync still running — waiting…");
    status = await waitForSync();
    lastStatus = status;
  }

  if (linkBtn) {
    linkBtn.textContent = status.linked ? "Link another bank" : "Log in to bank";
    if (!status.can_link_more) {
      linkBtn.disabled = true;
      linkBtn.title = `Account limit (${status.account_limit}) reached`;
    } else {
      linkBtn.title = "";
    }
  }

  setStatus(
    status.linked
      ? `${status.account_count} account(s) · ${status.transaction_count} tx since ${status.transactions_since}`
      : "Not linked — log in to each bank you want to include."
  );

  renderMeta(status);
  renderSources(status);

  if (!status.linked) {
    if (rows) {
      rows.innerHTML = `<tr><td colspan="6" class="empty">No accounts linked yet.</td></tr>`;
    }
    if (resultMeta) resultMeta.textContent = "";
    if (pager) pager.hidden = true;
    prefetchLinkToken();
    return;
  }

  await loadTransactions(status);
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
          offset = 0;
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

if (searchInput) {
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      searchQuery = searchInput.value.trim();
      offset = 0;
      if (!lastStatus?.linked) return;
      try {
        await loadTransactions(lastStatus);
      } catch (err) {
        setStatus(String(err.message || err));
      }
    }, 250);
  });
}

if (prevBtn) {
  prevBtn.addEventListener("click", async () => {
    offset = Math.max(0, offset - PAGE_SIZE);
    if (!lastStatus?.linked) return;
    try {
      await loadTransactions(lastStatus);
    } catch (err) {
      setStatus(String(err.message || err));
    }
  });
}

if (nextBtn) {
  nextBtn.addEventListener("click", async () => {
    offset += PAGE_SIZE;
    if (!lastStatus?.linked) return;
    try {
      await loadTransactions(lastStatus);
    } catch (err) {
      setStatus(String(err.message || err));
    }
  });
}

setStatus("Starting…");
refresh().catch((err) => {
  setStatus(String(err.message || err));
  if (rows) {
    rows.innerHTML = `<tr><td colspan="6" class="empty">Could not load: ${escapeHtml(String(err.message || err))}</td></tr>`;
  }
});
