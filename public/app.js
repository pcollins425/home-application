/** works on workers.dev (/) and www.../plaid/ */
const API_BASE = location.pathname.startsWith("/plaid") ? "/plaid" : "";

const statusLine = document.getElementById("statusLine");
const meta = document.getElementById("meta");
const rows = document.getElementById("rows");
const linkBtn = document.getElementById("linkBtn");
const syncBtn = document.getElementById("syncBtn");

/** Prefetch so Plaid.open() stays inside the click gesture (mobile). */
let cachedLinkToken = null;
let linkTokenPromise = null;

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  if (res.status === 401) {
    location.href = `${API_BASE}/auth/login`;
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
  // Plaid: positive amount = money leaving the account.
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
  linkTokenPromise = api("/api/create_link_token", { method: "POST" })
    .then((data) => {
      cachedLinkToken = data.link_token || null;
      return cachedLinkToken;
    })
    .catch((err) => {
      cachedLinkToken = null;
      console.error("link_token prefetch failed", err);
      return null;
    });
  return linkTokenPromise;
}

async function refresh() {
  const status = await api("/api/status");
  const syncClass =
    status.item?.last_sync_status === "ok"
      ? "ok"
      : status.item?.last_sync_status === "error"
        ? "err"
        : "warn";

  if (linkBtn) {
    linkBtn.textContent = status.linked ? "Link another / replace" : "Log in to bank";
  }

  statusLine.textContent = status.linked
    ? `Linked${status.item?.institution_name ? ` · ${status.item.institution_name}` : ""} · ${status.transaction_count} tx since ${status.transactions_since}`
    : "Not linked — log in to your bank to pull May 2026 → now.";

  meta.innerHTML = status.linked
    ? `
      <span>Last sync: <strong>${status.item?.last_sync_at || "—"}</strong>
        <span class="pill ${syncClass}">${status.item?.last_sync_status || "unknown"}</span>
      </span>
      ${status.item?.last_sync_error ? `<span>Error: <strong>${status.item.last_sync_error}</strong></span>` : ""}
    `
    : `<span>Connect one account. Done.</span>`;

  if (!status.linked) {
    rows.innerHTML = `<tr><td colspan="5" class="empty">No account linked yet.</td></tr>`;
    prefetchLinkToken();
    return;
  }

  const { transactions } = await api(
    `/api/transactions?since=${encodeURIComponent(status.transactions_since)}`
  );

  if (!transactions.length) {
    rows.innerHTML = `<tr><td colspan="5" class="empty">No transactions yet — try Sync now (history can take a minute after Link).</td></tr>`;
    prefetchLinkToken();
    return;
  }

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

  prefetchLinkToken();
}

async function openPlaidLink(linkToken) {
  if (typeof Plaid === "undefined") {
    throw new Error("Plaid script failed to load — check network / ad blockers");
  }
  return new Promise((resolve, reject) => {
    const handler = Plaid.create({
      token: linkToken,
      onSuccess: async (public_token, metadata) => {
        try {
          statusLine.textContent = "Connecting and syncing…";
          await api("/api/exchange_public_token", {
            method: "POST",
            body: JSON.stringify({ public_token, metadata }),
          });
          cachedLinkToken = null;
          await refresh();
          resolve();
        } catch (err) {
          reject(err);
        }
      },
      onExit: (err) => {
        if (err) reject(err);
        else resolve();
      },
    });
    handler.open();
  });
}

if (linkBtn) {
  linkBtn.addEventListener("click", async () => {
    linkBtn.disabled = true;
    statusLine.textContent = "Opening bank login…";
    try {
      let token = cachedLinkToken;
      if (!token) {
        token = await (linkTokenPromise || prefetchLinkToken());
      }
      if (!token) {
        token = (await api("/api/create_link_token", { method: "POST" })).link_token;
      }
      if (!token) throw new Error("Could not create link token");
      cachedLinkToken = null; // one-time
      await openPlaidLink(token);
    } catch (err) {
      statusLine.textContent = String(err.message || err);
    } finally {
      linkBtn.disabled = false;
      prefetchLinkToken();
    }
  });
}

if (syncBtn) {
  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    statusLine.textContent = "Syncing…";
    try {
      await api("/api/sync", { method: "POST" });
      await refresh();
    } catch (err) {
      statusLine.textContent = String(err.message || err);
    } finally {
      syncBtn.disabled = false;
    }
  });
}

refresh().catch((err) => {
  statusLine.textContent = String(err.message || err);
  rows.innerHTML = `<tr><td colspan="5" class="empty">Could not load.</td></tr>`;
});
