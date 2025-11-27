// Pro Admin Console
const $ = (s) => document.querySelector(s);

// top
const statusEl = $("#status");
const keyInput = $("#adminKey");
const saveKeyBtn = $("#saveKey");
const loadBtn = $("#loadSessions");
const fromDateEl = $("#fromDate");
const toDateEl = $("#toDate");
const queryEl = $("#query");
const pageSizeEl = $("#pageSize");
const autoRefresh = $("#autoRefresh");
const bulkExportBtn = $("#bulkExport");
const scanFlagsBtn = $("#scanFlags");

// sessions panel
const sessionsEl = $("#sessions");
const totalSessionsEl = $("#totalSessions");
const visibleSessionsEl = $("#visibleSessions");
const sortByDateBtn = $("#sortByDate");
const prevPageBtn = $("#prevPage");
const nextPageBtn = $("#nextPage");
const pageNumEl = $("#pageNum");

// right panel
const selEl = $("#sel");
const refreshEventsBtn = $("#refreshEvents");
const roleFilter = $("#roleFilter");
const eventSearch = $("#eventSearch");
const eventsEl = $("#events");
const exportCsvBtn = $("#exportCsv");
const copyTranscriptBtn = $("#copyTranscript");
const genIndexBtn = $("#genIndex");
const countUserEl = $("#countUser");
const countAssistantEl = $("#countAssistant");
const firstAtEl = $("#firstAt");
const lastAtEl = $("#lastAt");
const flagLevelEl = $("#flagLevel");
const flagSummaryEl = $("#flagSummary");

// risk scan section
const flagScanSection = $("#flagScanSection");
const flagListEl = $("#flagList");

let ADMIN_KEY = "";
let sessions = [];
let currentSession = null;
let currentEvents = [];
let sortNewest = true;
let refreshTimer = null;
let curPage = 1;
let total = 0;

function setStatus(s) {
  statusEl.textContent = s;
}
function saveKey() {
  ADMIN_KEY = keyInput.value.trim();
  localStorage.setItem("wurksy_admin_key", ADMIN_KEY);
  setStatus("Key saved");
}
function loadKey() {
  const k = localStorage.getItem("wurksy_admin_key") || "";
  keyInput.value = k;
  ADMIN_KEY = k;
}

async function fetchJSON(url) {
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok) {
    let m = t;
    try {
      m = JSON.parse(t).error || m;
    } catch {}
    throw new Error(m || "Request failed");
  }
  try {
    return JSON.parse(t);
  } catch {
    return {};
  }
}
function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function loadSessions(page = 1) {
  if (!ADMIN_KEY) {
    setStatus("Enter ADMIN_KEY first");
    return;
  }
  curPage = page;
  setStatus("Loading sessions…");
  try {
    const params = {
      admin_key: ADMIN_KEY,
      from: fromDateEl.value || undefined,
      to: toDateEl.value || undefined,
      page: curPage,
      pageSize: pageSizeEl.value || 50,
      q: queryEl.value || undefined,
    };
    const j = await fetchJSON(`/api/admin/sessions?${qs(params)}`);
    sessions = j.sessions || [];
    total = j.total || sessions.length;
    renderSessions();
    pageNumEl.textContent = String(curPage);
    totalSessionsEl.textContent = String(total);
    setStatus(`Loaded ${sessions.length} sessions`);
  } catch (e) {
    setStatus(e.message);
  }
}
function renderSessions() {
  let list = sessions.slice();
  if (!sortNewest)
    list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  sessionsEl.innerHTML = "";
  list.forEach((s) => {
    const li = document.createElement("li");
    li.className = "list-item";
    li.style.cursor = "pointer";
    li.innerHTML = `
      <div class="title">${s.id}</div>
      <div class="muted">${new Date(s.created_at).toLocaleString()} • ${s.mode || "guest"}</div>
    `;
    li.addEventListener("click", () => selectSession(s));
    sessionsEl.appendChild(li);
  });
  visibleSessionsEl.textContent = String(list.length);
}

async function loadEvents() {
  if (!ADMIN_KEY || !currentSession) return;
  setStatus("Loading events…");
  try {
    const p = {
      admin_key: ADMIN_KEY,
      sessionId: currentSession.id,
      page: 1,
      pageSize: 500,
    };
    const j = await fetchJSON(`/api/admin/events?${qs(p)}`);
    currentEvents = j.events || [];
    applyEventFilters();
    await loadFlagsForSession(currentSession.id);
    setStatus(`Loaded ${currentEvents.length} events`);
  } catch (e) {
    setStatus(e.message);
  }
}
function applyEventFilters() {
  const role = roleFilter.value;
  const needle = eventSearch.value.trim().toLowerCase();
  const filtered = currentEvents.filter(
    (e) =>
      (role === "all" || e.role === role) &&
      (!needle ||
        String(e.content || "")
          .toLowerCase()
          .includes(needle)),
  );
  renderEvents(filtered);
}
function renderEvents(list) {
  eventsEl.innerHTML = "";
  let cU = 0,
    cA = 0;
  let first = null,
    last = null;

  list.forEach((e) => {
    if (e.role === "user") cU++;
    if (e.role === "assistant") cA++;
    const t = new Date(e.created_at);
    if (!first || t < first) first = t;
    if (!last || t > last) last = t;

    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `<div class="title">${e.role.toUpperCase()} — ${t.toLocaleString()}</div><p>${e.content || ""}</p>`;
    eventsEl.appendChild(li);
  });

  countUserEl.textContent = String(cU);
  countAssistantEl.textContent = String(cA);
  firstAtEl.textContent = first ? first.toLocaleString() : "–";
  lastAtEl.textContent = last ? last.toLocaleString() : "–";
}

function selectSession(s) {
  currentSession = s;
  selEl.textContent = `Selected: ${s.id}`;
  loadEvents();
}

function toCsvRow(arr) {
  return arr
    .map((v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}
function download(name, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}
function exportCsv() {
  if (!currentSession) return;
  const head = ["created_at", "session_id", "role", "content", "tokens"];
  const rows = currentEvents.map((e) => [
    e.created_at,
    currentSession.id,
    e.role,
    e.content,
    e.tokens ?? "",
  ]);
  const csv = [toCsvRow(head), ...rows.map(toCsvRow)].join("\n");
  download(`wurksy_${currentSession.id}_events.csv`, csv);
}
async function copyTranscript() {
  if (!currentEvents.length) return;
  const lines = currentEvents.map(
    (e) =>
      `[${new Date(e.created_at).toISOString()}] ${e.role.toUpperCase()}: ${e.content}`,
  );
  await navigator.clipboard.writeText(lines.join("\n"));
  setStatus("Transcript copied");
}
async function generateIndex() {
  if (!currentSession) return;
  setStatus("Generating AI Index…");
  try {
    const r = await fetch(
      `/api/ai-index?sessionId=${encodeURIComponent(currentSession.id)}`,
    );
    const j = await r.json();
    if (j.url) window.open(j.url, "_blank", "noopener");
    setStatus(j.url ? "AI Index ready" : j.error || "Failed");
  } catch (e) {
    setStatus(e.message);
  }
}

// flags
async function loadFlagsForSession(sessionId) {
  try {
    const p = { admin_key: ADMIN_KEY, sessionId };
    const j = await fetchJSON(`/api/admin/flags?${qs(p)}`);
    const level = j.summary?.level || "none";
    flagLevelEl.textContent = level;
    flagSummaryEl.innerHTML = "";
    const counts = j.summary?.counts || {};
    const keys = Object.keys(counts);
    if (!keys.length) {
      const li = document.createElement("li");
      li.className = "list-item";
      li.textContent = "No flags";
      flagSummaryEl.appendChild(li);
    } else {
      keys.sort((a, b) => counts[b] - counts[a]);
      keys.forEach((k) => {
        const li = document.createElement("li");
        li.className = "list-item";
        li.textContent = `${k} — ${counts[k]}`;
        flagSummaryEl.appendChild(li);
      });
    }
  } catch (e) {
    flagLevelEl.textContent = "error";
  }
}
async function scanFlags() {
  if (!ADMIN_KEY) {
    setStatus("Enter ADMIN_KEY first");
    return;
  }
  setStatus("Scanning flags…");
  flagListEl.innerHTML = "";
  flagScanSection.style.display = "block";
  try {
    const p = {
      admin_key: ADMIN_KEY,
      from: fromDateEl.value || undefined,
      to: toDateEl.value || undefined,
    };
    const j = await fetchJSON(`/api/admin/flags?${qs(p)}`);
    const items = j.items || [];
    if (!items.length) {
      flagListEl.innerHTML = `<li class="list-item">No risky sessions found in range.</li>`;
      setStatus("No risk found");
      return;
    }
    items.forEach((it) => {
      const li = document.createElement("li");
      li.className = "list-item";
      li.innerHTML = `
        <div class="title">${it.sessionId} — score ${it.score} (${it.level})</div>
        <div class="muted">${new Date(it.created_at).toLocaleString()}</div>
        <div class="muted">${Object.entries(it.counts)
          .map(([k, v]) => `${k}:${v}`)
          .join(" • ")}</div>
      `;
      li.style.cursor = "pointer";
      li.addEventListener("click", () => {
        // jump to session
        queryEl.value = it.sessionId;
        loadSessions(1).then(() => {
          const found = sessions.find((s) => s.id === it.sessionId);
          if (found) selectSession(found);
        });
      });
      flagListEl.appendChild(li);
    });
    setStatus(`Found ${items.length} risky sessions`);
  } catch (e) {
    setStatus(e.message);
  }
}
async function bulkExport() {
  if (!ADMIN_KEY) {
    setStatus("Enter ADMIN_KEY first");
    return;
  }
  setStatus("Preparing export…");
  const p = {
    admin_key: ADMIN_KEY,
    from: fromDateEl.value || undefined,
    to: toDateEl.value || undefined,
  };
  const url = `/api/admin/export?${qs(p)}`;
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  a.click();
  setStatus("Export started");
}

// wiring
saveKeyBtn.addEventListener("click", saveKey);
loadBtn.addEventListener("click", () => loadSessions(1));
prevPageBtn.addEventListener("click", () => {
  if (curPage > 1) loadSessions(curPage - 1);
});
nextPageBtn.addEventListener("click", () => loadSessions(curPage + 1));
sortByDateBtn.addEventListener("click", () => {
  sortNewest = !sortNewest;
  renderSessions();
});

refreshEventsBtn.addEventListener("click", loadEvents);
roleFilter.addEventListener("change", applyEventFilters);
eventSearch.addEventListener("input", applyEventFilters);
exportCsvBtn.addEventListener("click", exportCsv);
copyTranscriptBtn.addEventListener("click", copyTranscript);
genIndexBtn.addEventListener("click", generateIndex);

autoRefresh.addEventListener("change", () => {
  if (autoRefresh.checked) {
    refreshTimer = setInterval(() => loadSessions(curPage), 30000);
  } else if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

scanFlagsBtn.addEventListener("click", scanFlags);
bulkExportBtn.addEventListener("click", bulkExport);

// boot
loadKey();
setStatus("Enter ADMIN_KEY, set range, click Load.");
