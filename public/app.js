/** works on workers.dev (/) and www.../plaid/ */
const API_BASE =
  typeof window !== "undefined" && window.__BASE != null
    ? window.__BASE
    : location.pathname.startsWith("/plaid")
      ? "/plaid"
      : "";

const PAGE_SIZE = 500;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const statusLine = document.getElementById("statusLine");
const meta = document.getElementById("meta");
const treeEl = document.getElementById("tree");
const navAll = document.getElementById("navAll");
const rows = document.getElementById("rows");
const linkBtn = document.getElementById("linkBtn");
const syncBtn = document.getElementById("syncBtn");
const searchInput = document.getElementById("searchInput");
const resultMeta = document.getElementById("resultMeta");
const scopeLabel = document.getElementById("scopeLabel");
const monthTotals = document.getElementById("monthTotals");
const pager = document.getElementById("pager");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");

let cachedLinkToken = null;
let linkTokenPromise = null;
let lastStatus = null;
let lastSummary = null;
let searchQuery = "";
let offset = 0;
let searchTimer = null;

/** @type {{ itemId: string|null, accountId: string|null, year: string|null, month: string|null, since: string|null, until: string|null, label: string }} */
let selection = {
  itemId: null,
  accountId: null,
  year: null,
  month: null,
  since: null,
  until: null,
  label: "All transactions",
};

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

function moneyAbs(n) {
  return `$${Math.abs(Number(n) || 0).toFixed(2)}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function monthLabel(ym) {
  const [y, m] = String(ym).split("-");
  const idx = Number(m) - 1;
  const name = MONTH_NAMES[idx] || m;
  return `${name} ${y}`;
}

/** Inclusive last day of YYYY-MM. */
function monthUntil(ym) {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, "0")}`;
}

function monthSince(ym) {
  return `${ym}-01`;
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

async function waitForSync(maxMs = 180000) {
  const start = Date.now();
  let delay = 1500;
  while (Date.now() - start < maxMs) {
    const status = await api("/api/status");
    if (!status.syncing) return status;
    setStatus(`Syncing… (${status.transaction_count || 0} tx · ${status.account_count || 0} accounts)`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 500, 4000);
  }
  return api("/api/status");
}

function renderMeta(status) {
  if (!meta) return;
  if (!status.linked) {
    meta.innerHTML = `<span>Link each bank (up to ${status.account_limit || 10} accounts). Organize by institution → account → month.</span>`;
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
      return `<span>${escapeHtml(i.institution_name || "Bank")} <span class="pill ${cls}">${escapeHtml(i.last_sync_status || "?")}</span></span>`;
    })
    .join("");
  const err = items.find((i) => i.last_sync_error);
  const range =
    status.date_min && status.date_max
      ? `${status.date_min} → ${status.date_max}`
      : "no dates yet";
  meta.innerHTML = `
    <span>${status.item_count || 0} bank(s) · ${status.account_count || 0} accounts · ${status.transaction_count || 0} tx · ${escapeHtml(range)}</span>
    ${syncBits}
    ${err ? `<span>Error: <strong>${escapeHtml(err.last_sync_error)}</strong></span>` : ""}
  `;
}

function selectionKey(sel) {
  return [sel.itemId, sel.accountId, sel.year, sel.month].map((x) => x || "").join("|");
}

function renderTree(summary) {
  if (!treeEl) return;
  const institutions = summary?.institutions || [];
  if (!institutions.length) {
    treeEl.innerHTML = `<p class="nav-empty">No months yet — sync after linking.</p>`;
    return;
  }

  const selKey = selectionKey(selection);
  treeEl.innerHTML = institutions
    .map((inst) => {
      const instName = inst.institution_name || "Institution";
      const accountsHtml = (inst.accounts || [])
        .map((acct) => {
          const acctName = [acct.name, acct.mask ? `••${acct.mask}` : null]
            .filter(Boolean)
            .join(" ");
          const yearsHtml = (acct.years || [])
            .map((yr) => {
              const monthsHtml = (yr.months || [])
                .map((mo) => {
                  const key = `${inst.item_id}|${acct.account_id}|${yr.year}|${mo.month}`;
                  const active = selKey === key ? " active" : "";
                  return `<button type="button" class="nav-month${active}"
                    data-item="${escapeHtml(inst.item_id)}"
                    data-account="${escapeHtml(acct.account_id)}"
                    data-year="${escapeHtml(yr.year)}"
                    data-month="${escapeHtml(mo.month)}"
                    data-in="${mo.inflow}"
                    data-out="${mo.outflow}"
                    data-net="${mo.net}"
                    data-count="${mo.tx_count}"
                    data-pending="${mo.pending_count}">
                    <span class="nav-month-name">${escapeHtml(monthLabel(mo.month))}</span>
                    <span class="nav-month-net">${moneyAbs(mo.net)} net</span>
                  </button>`;
                })
                .join("");
              return `<div class="nav-year">
                <p class="nav-year-label">${escapeHtml(yr.year)}</p>
                ${monthsHtml}
              </div>`;
            })
            .join("");
          return `<div class="nav-account">
            <p class="nav-account-label">${escapeHtml(acctName || acct.account_id)}</p>
            ${yearsHtml}
          </div>`;
        })
        .join("");
      return `<div class="nav-inst">
        <p class="nav-inst-label">${escapeHtml(instName)}</p>
        ${accountsHtml}
      </div>`;
    })
    .join("");

  treeEl.querySelectorAll(".nav-month").forEach((btn) => {
    btn.addEventListener("click", () => {
      const month = btn.getAttribute("data-month");
      selection = {
        itemId: btn.getAttribute("data-item"),
        accountId: btn.getAttribute("data-account"),
        year: btn.getAttribute("data-year"),
        month,
        since: monthSince(month),
        until: monthUntil(month),
        label: `${btn.closest(".nav-inst")?.querySelector(".nav-inst-label")?.textContent || "Bank"} · ${btn.closest(".nav-account")?.querySelector(".nav-account-label")?.textContent || "Account"} · ${monthLabel(month)}`,
        inflow: Number(btn.getAttribute("data-in") || 0),
        outflow: Number(btn.getAttribute("data-out") || 0),
        net: Number(btn.getAttribute("data-net") || 0),
        tx_count: Number(btn.getAttribute("data-count") || 0),
        pending_count: Number(btn.getAttribute("data-pending") || 0),
      };
      offset = 0;
      renderTree(lastSummary);
      loadTransactions().catch((err) => setStatus(String(err.message || err)));
    });
  });

  if (navAll) {
    navAll.classList.toggle("active", !selection.month && !selection.accountId);
  }
}

function updatePager(total) {
  if (!pager || !prevBtn || !nextBtn) return;
  const hasPages = total > PAGE_SIZE;
  pager.hidden = !hasPages;
  prevBtn.disabled = offset <= 0;
  nextBtn.disabled = offset + PAGE_SIZE >= total;
}

function renderMonthTotals() {
  if (!monthTotals) return;
  if (!selection.month) {
    monthTotals.hidden = true;
    monthTotals.innerHTML = "";
    return;
  }
  monthTotals.hidden = false;
  monthTotals.innerHTML = `
    <span>In <strong class="pos">${moneyAbs(selection.inflow)}</strong></span>
    <span>Out <strong class="neg">${moneyAbs(selection.outflow)}</strong></span>
    <span>Net <strong>${moneyAbs(selection.net)}</strong></span>
    <span>${selection.tx_count || 0} tx${selection.pending_count ? ` · ${selection.pending_count} pending` : ""}</span>
  `;
}

async function loadTransactions() {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (selection.since) params.set("since", selection.since);
  if (selection.until) params.set("until", selection.until);
  if (!selection.since && !selection.until) params.set("all", "1");
  if (selection.accountId) params.set("account_id", selection.accountId);
  if (selection.itemId && !selection.accountId) params.set("item_id", selection.itemId);
  if (searchQuery) params.set("q", searchQuery);

  if (scopeLabel) scopeLabel.textContent = selection.label;
  renderMonthTotals();

  const data = await api(`/api/transactions?${params}`);
  const transactions = data.transactions || [];
  const total = data.total ?? transactions.length;

  if (resultMeta) {
    const frame =
      data.since || data.until
        ? ` · ${data.since || "…"} → ${data.until || "…"}`
        : " · all dates";
    resultMeta.textContent = searchQuery
      ? `${total} match${total === 1 ? "" : "es"} for “${searchQuery}”${frame}`
      : `${total} transaction${total === 1 ? "" : "s"}${frame}`;
  }

  updatePager(total);

  if (!transactions.length) {
    if (rows) {
      rows.innerHTML = `<tr><td colspan="6" class="empty">${
        searchQuery
          ? "No matches in this view."
          : "No transactions in this view — try Sync now or another month."
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

/** Pick most recent month across tree as default selection. */
function pickDefaultSelection(summary) {
  let best = null;
  for (const inst of summary?.institutions || []) {
    for (const acct of inst.accounts || []) {
      for (const yr of acct.years || []) {
        for (const mo of yr.months || []) {
          if (!best || mo.month > best.month) {
            best = {
              itemId: inst.item_id,
              accountId: acct.account_id,
              year: yr.year,
              month: mo.month,
              since: monthSince(mo.month),
              until: monthUntil(mo.month),
              label: `${inst.institution_name || "Bank"} · ${[acct.name, acct.mask ? `••${acct.mask}` : null].filter(Boolean).join(" ")} · ${monthLabel(mo.month)}`,
              inflow: mo.inflow,
              outflow: mo.outflow,
              net: mo.net,
              tx_count: mo.tx_count,
              pending_count: mo.pending_count,
            };
          }
        }
      }
    }
  }
  return best;
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
      ? `${status.account_count} account(s) · ${status.transaction_count} tx`
      : "Not linked — log in to each bank you want to include."
  );

  renderMeta(status);

  if (!status.linked) {
    if (treeEl) treeEl.innerHTML = "";
    if (rows) {
      rows.innerHTML = `<tr><td colspan="6" class="empty">No accounts linked yet.</td></tr>`;
    }
    if (resultMeta) resultMeta.textContent = "";
    if (pager) pager.hidden = true;
    if (monthTotals) monthTotals.hidden = true;
    prefetchLinkToken();
    return;
  }

  lastSummary = await api("/api/summary?all=1");
  if (!selection.month) {
    const def = pickDefaultSelection(lastSummary);
    if (def) selection = def;
  } else {
    // Refresh totals for current month from new summary
    for (const inst of lastSummary.institutions || []) {
      if (inst.item_id !== selection.itemId) continue;
      for (const acct of inst.accounts || []) {
        if (acct.account_id !== selection.accountId) continue;
        for (const yr of acct.years || []) {
          for (const mo of yr.months || []) {
            if (mo.month !== selection.month) continue;
            selection = {
              ...selection,
              inflow: mo.inflow,
              outflow: mo.outflow,
              net: mo.net,
              tx_count: mo.tx_count,
              pending_count: mo.pending_count,
            };
          }
        }
      }
    }
  }

  renderTree(lastSummary);
  await loadTransactions();
  prefetchLinkToken();
}

if (navAll) {
  navAll.addEventListener("click", () => {
    selection = {
      itemId: null,
      accountId: null,
      year: null,
      month: null,
      since: null,
      until: null,
      label: "All transactions",
    };
    offset = 0;
    renderTree(lastSummary);
    loadTransactions().catch((err) => setStatus(String(err.message || err)));
  });
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
          selection = {
            itemId: null,
            accountId: null,
            year: null,
            month: null,
            since: null,
            until: null,
            label: "All transactions",
          };
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
        await loadTransactions();
      } catch (err) {
        setStatus(String(err.message || err));
      }
    }, 250);
  });
}

if (prevBtn) {
  prevBtn.addEventListener("click", async () => {
    offset = Math.max(0, offset - PAGE_SIZE);
    try {
      await loadTransactions();
    } catch (err) {
      setStatus(String(err.message || err));
    }
  });
}

if (nextBtn) {
  nextBtn.addEventListener("click", async () => {
    offset += PAGE_SIZE;
    try {
      await loadTransactions();
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
