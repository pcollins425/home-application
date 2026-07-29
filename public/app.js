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
const fullSyncBtn = document.getElementById("fullSyncBtn");
const searchInput = document.getElementById("searchInput");
const resultMeta = document.getElementById("resultMeta");
const scopeLabel = document.getElementById("scopeLabel");
const monthTotals = document.getElementById("monthTotals");
const pager = document.getElementById("pager");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const rangeFrom = document.getElementById("rangeFrom");
const rangeTo = document.getElementById("rangeTo");
const rangeApply = document.getElementById("rangeApply");
const rangeClear = document.getElementById("rangeClear");

let cachedLinkToken = null;
let linkTokenPromise = null;
let lastStatus = null;
let lastSummary = null;
let searchQuery = "";
let offset = 0;
let searchTimer = null;

/** @type {any} */
let selection = {
  itemId: null,
  accountId: null,
  year: null,
  month: null,
  since: null,
  until: null,
  label: "All transactions",
  mode: "all", // all | month | range
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
      (typeof data.error === "string" && data.error) ||
      data.error?.message ||
      data.detail?.error_message ||
      data.detail?.error_code ||
      (typeof data.detail === "string" ? data.detail : null) ||
      data.message ||
      res.statusText ||
      `HTTP ${res.status}`;
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

function monthUntil(ym) {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, "0")}`;
}

function monthSince(ym) {
  return `${ym}-01`;
}

function ymInRange(ym, fromYm, toYm) {
  if (!fromYm || !toYm) return false;
  const a = fromYm <= toYm ? fromYm : toYm;
  const b = fromYm <= toYm ? toYm : fromYm;
  return ym >= a && ym <= b;
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

function syncRangeInputsFromSelection() {
  if (!rangeFrom || !rangeTo || !rangeClear) return;
  if (selection.since && selection.until) {
    rangeFrom.value = selection.since.slice(0, 7);
    rangeTo.value = selection.until.slice(0, 7);
  }
  rangeClear.hidden = selection.mode !== "range";
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
    <span>${status.item_count || 0} bank(s) · ${status.account_count || 0} accounts · ${status.transaction_count || 0} tx</span>
    <span>Stored history: <strong>${escapeHtml(range)}</strong> <span class="hint">(D1 cache; widen via Apply range or Pull older history — uses Plaid date window, not Sync cursor)</span></span>
    ${syncBits}
    ${err ? `<span>Error: <strong>${escapeHtml(err.last_sync_error)}</strong></span>` : ""}
  `;
}

function selectionKey(sel) {
  return [sel.itemId, sel.accountId, sel.year, sel.month].map((x) => x || "").join("|");
}

function formatBalance(acct) {
  const cur = acct.balance_current;
  if (cur == null || Number.isNaN(Number(cur))) return null;
  const n = Number(cur);
  const type = (acct.type || "").toLowerCase();
  const subtype = (acct.subtype || "").toLowerCase();
  const isLoan =
    type === "loan" ||
    subtype.includes("loan") ||
    subtype.includes("mortgage") ||
    subtype === "line of credit";
  const label = isLoan ? "balance" : "bal";
  return `${label} ${moneyAbs(n)}`;
}

function accountLabel(inst, acct) {
  const acctName = [acct.name, acct.mask ? `••${acct.mask}` : null]
    .filter(Boolean)
    .join(" ");
  return `${inst.institution_name || "Bank"} · ${acctName || acct.account_id}`;
}

/** Sum In/Out/Net for months in [fromYm, toYm] for optional account filter. */
function totalsForRange(summary, fromYm, toYm, accountId, itemId) {
  let inflow = 0;
  let outflow = 0;
  let tx_count = 0;
  let pending_count = 0;
  for (const inst of summary?.institutions || []) {
    if (itemId && inst.item_id !== itemId) continue;
    for (const acct of inst.accounts || []) {
      if (accountId && acct.account_id !== accountId) continue;
      for (const yr of acct.years || []) {
        for (const mo of yr.months || []) {
          if (!ymInRange(mo.month, fromYm, toYm)) continue;
          inflow += Number(mo.inflow) || 0;
          outflow += Number(mo.outflow) || 0;
          tx_count += Number(mo.tx_count) || 0;
          pending_count += Number(mo.pending_count) || 0;
        }
      }
    }
  }
  return { inflow, outflow, net: inflow - outflow, tx_count, pending_count };
}

function renderTree(summary) {
  if (!treeEl) return;
  const institutions = summary?.institutions || [];
  if (!institutions.length) {
    treeEl.innerHTML = `<p class="nav-empty">No linked accounts yet.</p>`;
    return;
  }

  const selKey = selectionKey(selection);
  const fromYm = selection.since ? selection.since.slice(0, 7) : null;
  const toYm = selection.until ? selection.until.slice(0, 7) : null;

  treeEl.innerHTML = institutions
    .map((inst) => {
      const instName = inst.institution_name || "Institution";
      const accountsHtml = (inst.accounts || [])
        .map((acct) => {
          const acctName = [acct.name, acct.mask ? `••${acct.mask}` : null]
            .filter(Boolean)
            .join(" ");
          const bal = formatBalance(acct);
          const acctTitle = bal ? `${acctName} · ${bal}` : acctName;
          const hasMonths = (acct.years || []).some((y) => (y.months || []).length);
          const yearsHtml = hasMonths
            ? (acct.years || [])
                .map((yr) => {
                  const monthsHtml = (yr.months || [])
                    .map((mo) => {
                      const key = `${inst.item_id}|${acct.account_id}|${yr.year}|${mo.month}`;
                      const activeMonth = selection.mode === "month" && selKey === key;
                      const inRange =
                        selection.mode === "range" &&
                        (!selection.accountId || selection.accountId === acct.account_id) &&
                        ymInRange(mo.month, fromYm, toYm);
                      const active = activeMonth || inRange ? " active" : "";
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
                .join("")
            : `<p class="nav-empty-acct">${
                (acct.type || "").toLowerCase() === "loan"
                  ? "Loan — balance only (no transaction history from Plaid)"
                  : "No transactions in stored history"
              }</p>`;
          const acctActive =
            selection.accountId === acct.account_id && selection.mode !== "month"
              ? " active-acct"
              : "";
          return `<div class="nav-account${acctActive}">
            <button type="button" class="nav-account-label" data-item="${escapeHtml(inst.item_id)}" data-account="${escapeHtml(acct.account_id)}">${escapeHtml(acctTitle || acct.account_id)}</button>
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
        mode: "month",
        inflow: Number(btn.getAttribute("data-in") || 0),
        outflow: Number(btn.getAttribute("data-out") || 0),
        net: Number(btn.getAttribute("data-net") || 0),
        tx_count: Number(btn.getAttribute("data-count") || 0),
        pending_count: Number(btn.getAttribute("data-pending") || 0),
      };
      offset = 0;
      syncRangeInputsFromSelection();
      renderTree(lastSummary);
      loadTransactions().catch((err) => setStatus(String(err.message || err)));
    });
  });

  treeEl.querySelectorAll(".nav-account-label").forEach((btn) => {
    btn.addEventListener("click", () => {
      const itemId = btn.getAttribute("data-item");
      const accountId = btn.getAttribute("data-account");
      const inst = (lastSummary?.institutions || []).find((i) => i.item_id === itemId);
      const acct = inst?.accounts?.find((a) => a.account_id === accountId);
      selection = {
        itemId,
        accountId,
        year: null,
        month: null,
        since: null,
        until: null,
        label: acct && inst ? `${accountLabel(inst, acct)} · all months` : "Account",
        mode: "all",
      };
      offset = 0;
      if (rangeClear) rangeClear.hidden = true;
      renderTree(lastSummary);
      loadTransactions().catch((err) => setStatus(String(err.message || err)));
    });
  });

  if (navAll) {
    navAll.classList.toggle(
      "active",
      selection.mode === "all" && !selection.accountId && !selection.itemId
    );
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
  if (selection.mode !== "month" && selection.mode !== "range") {
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
  syncRangeInputsFromSelection();

  const data = await api(`/api/transactions?${params}`);
  const transactions = data.transactions || [];
  const total = data.total ?? transactions.length;

  if (resultMeta) {
    const frame =
      data.since || data.until
        ? ` · ${data.since || "…"} → ${data.until || "…"}`
        : " · all stored dates";
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
          : "No transactions in this view — try Sync now, another month, or a wider range."
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
              label: `${accountLabel(inst, acct)} · ${monthLabel(mo.month)}`,
              mode: "month",
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

async function applyRangeFromInputs() {
  const from = rangeFrom?.value;
  const to = rangeTo?.value;
  if (!from || !to) {
    setStatus("Pick both From and To months for a range.");
    return;
  }
  const fromYm = from <= to ? from : to;
  const toYm = from <= to ? to : from;
  const wantSince = monthSince(fromYm);
  const wantUntil = monthUntil(toYm);

  const storedMin = lastStatus?.date_min || lastSummary?.date_min;
  const storedMax = lastStatus?.date_max || lastSummary?.date_max;
  const beforeStored = Boolean(storedMin && wantSince < storedMin);
  const afterStored = Boolean(storedMax && wantUntil > storedMax);

  // Date ranges must be requested from Plaid via /transactions/get (backfill).
  // Plain Sync has no start_date/end_date — that was the bug.
  if ((beforeStored || afterStored) && lastStatus?.linked) {
    setStatus(
      `Pulling ${wantSince} → ${wantUntil} from Plaid into D1…`
    );
    try {
      await api("/api/backfill", {
        method: "POST",
        body: JSON.stringify({ since: wantSince, until: wantUntil }),
      });
      await waitForSync(300000);
      lastStatus = await api("/api/status");
      lastSummary = await api("/api/summary?all=1");
      renderMeta(lastStatus);
      renderTree(lastSummary);
      const errItem = (lastStatus.items || []).find((i) => i.last_sync_error);
      if (errItem?.last_sync_error) {
        setStatus(`Backfill error: ${errItem.last_sync_error}`);
      }
    } catch (err) {
      setStatus(String(err.message || err));
      return;
    }
  }

  const totals = totalsForRange(
    lastSummary,
    fromYm,
    toYm,
    selection.accountId,
    selection.itemId
  );
  const scope =
    selection.accountId && lastSummary
      ? (() => {
          for (const inst of lastSummary.institutions || []) {
            const acct = (inst.accounts || []).find((a) => a.account_id === selection.accountId);
            if (acct) return accountLabel(inst, acct);
          }
          return "Selected account";
        })()
      : "All accounts";
  selection = {
    itemId: selection.itemId,
    accountId: selection.accountId,
    year: null,
    month: null,
    since: wantSince,
    until: wantUntil,
    label: `${scope} · ${monthLabel(fromYm)} → ${monthLabel(toYm)}`,
    mode: "range",
    ...totals,
  };
  offset = 0;
  if (rangeClear) rangeClear.hidden = false;
  renderTree(lastSummary);
  try {
    await loadTransactions();
    const newMin = lastStatus?.date_min || lastSummary?.date_min;
    const newMax = lastStatus?.date_max || lastSummary?.date_max;
    if (beforeStored && newMin && wantSince < newMin) {
      setStatus(
        `Pulled from Plaid; earliest in D1 is still ${newMin}. Institution may not expose older txs.`
      );
    } else if (afterStored && newMax && wantUntil > newMax) {
      setStatus(`Pulled from Plaid; latest in D1 is ${newMax}.`);
    } else {
      setStatus(
        lastStatus?.linked
          ? `${lastStatus.account_count} account(s) · ${lastStatus.transaction_count} tx · ${newMin || "?"} → ${newMax || "?"}`
          : "Not linked"
      );
    }
  } catch (err) {
    setStatus(String(err.message || err));
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

  // Hint bounds from stored history, but do not lock the picker — user may
  // request a wider range (triggers sync; still limited by what Plaid has).
  if (rangeFrom && rangeTo && lastSummary.date_min && lastSummary.date_max) {
    const minYm = lastSummary.date_min.slice(0, 7);
    const maxYm = lastSummary.date_max.slice(0, 7);
    rangeFrom.min = "";
    rangeTo.min = "";
    rangeFrom.max = "";
    rangeTo.max = "";
    if (!rangeFrom.value) rangeFrom.value = minYm;
    if (!rangeTo.value) rangeTo.value = maxYm;
  }

  if (selection.mode === "all" && !selection.accountId && !selection.month) {
    const def = pickDefaultSelection(lastSummary);
    if (def) selection = def;
  } else if (selection.mode === "month" && selection.month) {
    const t = totalsForRange(
      lastSummary,
      selection.month,
      selection.month,
      selection.accountId,
      selection.itemId
    );
    selection = { ...selection, ...t };
  } else if (selection.mode === "range" && selection.since && selection.until) {
    const t = totalsForRange(
      lastSummary,
      selection.since.slice(0, 7),
      selection.until.slice(0, 7),
      selection.accountId,
      selection.itemId
    );
    selection = { ...selection, ...t };
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
      mode: "all",
    };
    offset = 0;
    if (rangeClear) rangeClear.hidden = true;
    renderTree(lastSummary);
    loadTransactions().catch((err) => setStatus(String(err.message || err)));
  });
}

if (rangeApply) {
  rangeApply.addEventListener("click", () => applyRangeFromInputs());
}

if (rangeClear) {
  rangeClear.addEventListener("click", () => {
    selection = {
      itemId: selection.itemId,
      accountId: selection.accountId,
      year: null,
      month: null,
      since: null,
      until: null,
      label: selection.accountId ? "Account · all months" : "All transactions",
      mode: "all",
    };
    offset = 0;
    rangeClear.hidden = true;
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
            mode: "all",
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
    if (fullSyncBtn) fullSyncBtn.disabled = true;
    setStatus("Starting sync…");
    try {
      await api("/api/sync", { method: "POST", body: JSON.stringify({}) });
      await waitForSync();
      await refresh();
    } catch (err) {
      setStatus(String(err.message || err));
    } finally {
      syncBtn.disabled = false;
      if (fullSyncBtn) fullSyncBtn.disabled = false;
    }
  });
}

if (fullSyncBtn) {
  fullSyncBtn.addEventListener("click", async () => {
    fullSyncBtn.disabled = true;
    if (syncBtn) syncBtn.disabled = true;
    const until = new Date().toISOString().slice(0, 10);
    // Two years back — explicit Plaid /transactions/get window (not sync cursor).
    const sinceDate = new Date();
    sinceDate.setFullYear(sinceDate.getFullYear() - 2);
    const since = sinceDate.toISOString().slice(0, 10);
    setStatus(`Pulling ${since} → ${until} from Plaid…`);
    try {
      const beforeMin = lastStatus?.date_min;
      await api("/api/backfill", {
        method: "POST",
        body: JSON.stringify({ since, until }),
      });
      await waitForSync(300000);
      await refresh();
      const afterMin = lastStatus?.date_min;
      const errItem = (lastStatus?.items || []).find((i) => i.last_sync_error);
      if (errItem?.last_sync_error) {
        setStatus(`Backfill error: ${errItem.last_sync_error}`);
      } else if (beforeMin && afterMin && afterMin >= beforeMin) {
        setStatus(
          `Pull done. Earliest in D1: ${afterMin} (was ${beforeMin}). If unchanged, the bank isn’t giving older txs through Plaid.`
        );
      } else {
        setStatus(
          `Pull done. Stored history: ${afterMin || "?"} → ${lastStatus?.date_max || "?"}`
        );
      }
    } catch (err) {
      setStatus(String(err.message || err));
    } finally {
      fullSyncBtn.disabled = false;
      if (syncBtn) syncBtn.disabled = false;
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
