// public/app.js

let sessionId = null;
let cap = 0;
let used = 0;
let defaultCap = 0;
let assignmentMeta = null;
let assignmentId = null;

const msgs = document.querySelector("#msgs");
const form = document.querySelector("#send");
const input = document.querySelector("#input");
const capEl = document.querySelector("#cap");
const makeIndexBtn = document.querySelector("#makeIndex");
const submitBtn = document.querySelector("#submitBtn");
const startChatBtn = document.querySelector("#startChatBtn");

// Assignment UI hooks
const assignmentCardEl = document.querySelector("#assignmentCard");
const assignmentHeaderEl = document.querySelector("#assignmentHeader");
const assignmentBriefEl = document.querySelector("#assignmentBrief");
const assignmentRecListEl = document.querySelector("#assignmentRecommended");

// Notes field (optional declaration notes)
const notesInput = document.querySelector("#sessionNotes");

// Declaration modal
const declBackdrop = document.querySelector("#declBackdrop");
const declConfirm = document.querySelector("#declConfirm");
const declCancel = document.querySelector("#declCancel");
const d_onlyWurksy = document.querySelector("#d_onlyWurksy");
const d_noGhost = document.querySelector("#d_noGhost");
const d_independent = document.querySelector("#d_independent");
const d_understand = document.querySelector("#d_understand");
const d_assgn = document.querySelector("#d_assgn");

// ----------------------
// helpers
// ----------------------

function li(role, text) {
  const el = document.createElement("li");
  el.className = role;
  el.textContent = toBullets(text);
  return el;
}

// Clean bullet formatting
function toBullets(md) {
  if (!md) return "•";
  let s = String(md)
    .replace(/\r\n/g, "\n")
    .replace(/(\S)\s+•\s+/g, "$1\n• ")
    .replace(/\s+•\s+(\S)/g, "\n• $1");

  const lines = s.split("\n");
  const out = [];

  for (let raw of lines) {
    let ln = raw.trim();
    if (!ln) continue;

    // strip bold / italics markers
    ln = ln.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1");
    // strip blockquote / numbered list markers
    ln = ln.replace(/^>\s?/, "").replace(/^\d+\.\s+/, "");

    // Promote short "Heading: detail" into heading + bullet
    const head = ln.match(/^([^:]+):\s*(.*)$/);
    if (head && head[1].length <= 24 && /^[A-Z]/.test(head[1])) {
      out.push(`${head[1].trim()}:`);
      if (head[2]) out.push(`• ${head[2].trim()}`);
      continue;
    }

    // normal bullet
    if (/^[-*•]\s+/.test(ln)) ln = ln.replace(/^[-*•]\s+/, "");
    out.push(`• ${ln}`);
  }

  return out.join("\n");
}

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();

  if (!r.ok) {
    let msg = t;
    try {
      msg = JSON.parse(t).error || msg;
    } catch {}
    throw new Error(msg || "Request failed");
  }

  try {
    return JSON.parse(t);
  } catch {
    return {};
  }
}

// ----------------------
// Assignment + session helpers
// ----------------------

// Detect assignment ID from URL (?a= / ?assignment= / ?assignmentId=)
// or fallback to localStorage (set by login.html)
function detectAssignmentId() {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl =
      params.get("a") || params.get("assignment") || params.get("assignmentId");
    if (fromUrl) return fromUrl;
  } catch {
    // ignore
  }
  try {
    const stored = localStorage.getItem("wurksy_assignment_code");
    if (stored) return stored;
  } catch {
    // ignore
  }
  return null;
}

// Session key is per assignment so that chat / lectures / research
// all share the same session for that assignment.
function sessionKey() {
  const suffix = assignmentId ? `_${assignmentId}` : "_global";
  return `wurksy_session${suffix}`;
}

// ----------------------
// Notes helpers
// ----------------------

function notesKey() {
  return sessionId ? `wurksy_notes_${sessionId}` : null;
}

function restoreNotes() {
  if (!notesInput || !sessionId) return;
  try {
    const key = notesKey();
    if (!key) return;
    const saved = localStorage.getItem(key);
    if (saved) notesInput.value = saved;
  } catch {}
}

function persistNotes() {
  if (!notesInput || !sessionId) return;
  try {
    const key = notesKey();
    if (!key) return;
    localStorage.setItem(key, notesInput.value);
  } catch {}
}

// ----------------------
// UI update helpers
// ----------------------

function updateCapLabel() {
  if (!capEl) return;
  if (!sessionId) {
    capEl.textContent = "";
    return;
  }
  if (!cap) {
    capEl.textContent = `${used}`;
  } else {
    capEl.textContent = `${used}/${cap}`;
  }
}

function renderAssignmentHeader() {
  if (!assignmentHeaderEl || !assignmentMeta) return;

  const a = assignmentMeta;
  const title = a.title || "Assignment";
  const moduleCode = a.module_code || "";
  const deadlineText = a.deadline
    ? new Date(a.deadline).toLocaleString()
    : "No deadline set";

  assignmentHeaderEl.innerHTML = `
    <div class="assignment-meta-inner">
      <p class="muted" style="margin:0 0 4px 0; font-size:12px;">Current assignment</p>
      <h3 style="margin:0 0 4px 0; font-size:18px; font-weight:700;">${title}</h3>
      <p class="muted" style="margin:0 0 2px 0; font-size:13px;"><strong>Module:</strong> ${moduleCode || "—"}</p>
      <p class="muted" style="margin:0 0 2px 0; font-size:13px;"><strong>Deadline:</strong> ${deadlineText}</p>
      <p class="muted" style="margin:0; font-size:13px;"><strong>Prompt cap:</strong> ${used}/${cap}</p>
    </div>
  `;
}

// ----------------------
// Session/bootstrap
// ----------------------

async function loadConfig() {
  try {
    const cfg = await fetchJSON("/api/config");
    defaultCap = cfg.cap || 100;
  } catch {
    defaultCap = 100;
  }
}

// Load metadata for an existing session (from DB)
// and make sure localStorage has the same ID so
// Lectures/Research can reuse it.
async function loadSessionMeta(existingSessionId) {
  const meta = await fetchJSON(
    `/api/session-meta?sessionId=${encodeURIComponent(existingSessionId)}`,
  );

  const s = meta.session || {};
  const a = meta.assignment || null;

  sessionId = s.id || existingSessionId;
  used = s.used_prompts ?? 0;
  assignmentMeta = a;

  cap = (a && a.prompt_cap) || defaultCap || 100;

  // If backend knows the assignment short_code but our frontend
  // assignmentId is empty, adopt it so nav stays in sync.
  if (!assignmentId && a && a.short_code) {
    assignmentId = a.short_code;
    try {
      localStorage.setItem("wurksy_assignment_code", assignmentId);
    } catch {}
  }

  // keep localStorage in sync with the real session id
  try {
    if (sessionId) {
      localStorage.setItem(sessionKey(), sessionId);
    }
  } catch {}

  if (assignmentBriefEl && a && a.brief) {
    assignmentCardEl.style.display = "block";
    assignmentBriefEl.textContent = a.brief;
  }

  if (assignmentRecListEl && a && Array.isArray(a.recommended_pdfs)) {
    assignmentRecListEl.innerHTML = "";
    a.recommended_pdfs.forEach((item) => {
      if (!item || !item.url) return;
      const liEl = document.createElement("li");
      liEl.className = "list-item";
      liEl.innerHTML = `<a href="${item.url}" target="_blank" rel="noopener">${item.label || item.url}</a>`;
      assignmentRecListEl.appendChild(liEl);
    });
  }

  renderAssignmentHeader();
  updateCapLabel();
  restoreNotes();
}

// Create a brand-new session only if we don't have one.
// Tag it with assignmentId if known.
async function startFresh(mode = "guest") {
  const payload = { mode };
  if (assignmentId) {
    // backend can use this to link session -> assignment
    payload.assignmentId = assignmentId;
  }

  const j = await fetchJSON("/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  sessionId = j.sessionId;
  cap = j.cap || defaultCap || 100;
  used = 0;

  try {
    localStorage.setItem(sessionKey(), sessionId);
  } catch {}

  updateCapLabel();
  restoreNotes();
}

// Small shared helper so *any* feature can safely
// ensure we have a session (chat, index button, etc.)
async function ensureSession() {
  if (sessionId) return;

  // Make sure we know assignmentId first
  if (!assignmentId) {
    assignmentId = detectAssignmentId();
  }

  let existingSession = null;
  try {
    // New per-assignment key
    existingSession = localStorage.getItem(sessionKey()) || null;

    // Legacy fallback: old global key if present
    if (!existingSession) {
      const legacy = localStorage.getItem("wurksy_session");
      if (legacy) existingSession = legacy;
    }
  } catch {
    // ignore storage errors
  }

  if (existingSession) {
    await loadSessionMeta(existingSession);
    return;
  }

  await startFresh("guest");
}

// ----------------------
// Chat send
// ----------------------

async function send(message) {
  await ensureSession();

  const j = await fetchJSON("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });

  used = j.used;
  updateCapLabel();
  renderAssignmentHeader();

  return j.reply;
}

// ----------------------
// Event Listeners
// ----------------------

// Click "Start Chat" → scroll + focus textbox
startChatBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  document
    .getElementById("chat")
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => input?.focus(), 250);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  msgs.appendChild(li("user", text));
  input.value = "";
  input.style.height = "auto";

  try {
    const reply = await send(text);
    msgs.appendChild(li("assistant", reply));
    msgs.scrollTop = msgs.scrollHeight;
  } catch (err) {
    msgs.appendChild(li("error", err.message));
  }
});

// Enter to send, Shift+Enter for newline
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.shiftKey) {
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    form.dispatchEvent(new Event("submit"));
  }
});

// Auto-height textarea
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = input.scrollHeight + "px";
});

// Notes persistence
notesInput?.addEventListener("input", () => {
  persistNotes();
});

// AI Index button (include notes as query param if present)
makeIndexBtn?.addEventListener("click", async () => {
  try {
    await ensureSession();
  } catch (e) {
    return alert(e.message || "Could not start a session");
  }

  if (!sessionId) return alert("Start a session first");

  const notes = (notesInput?.value || "").trim();
  let url = `/api/ai-index?sessionId=${encodeURIComponent(sessionId)}`;
  if (notes) {
    url += `&notes=${encodeURIComponent(notes)}`;
  }

  try {
    const j = await fetchJSON(url);
    if (j.url) window.open(j.url, "_blank");
  } catch (e) {
    alert(e.message || "Failed to generate AI Index");
  }
});

// Submit flow
submitBtn?.addEventListener("click", async () => {
  await ensureSession();
  if (!sessionId) return alert("Start a session first");
  declBackdrop.classList.add("show");
});

// Modal cancel
declCancel?.addEventListener("click", () => {
  declBackdrop.classList.remove("show");
});

// Modal confirm
let submitting = false;
declConfirm?.addEventListener("click", async () => {
  if (submitting) return;

  if (
    !d_onlyWurksy.checked ||
    !d_noGhost.checked ||
    !d_independent.checked ||
    !d_understand.checked
  ) {
    alert("Please tick all declaration boxes.");
    return;
  }

  const assignmentIdText = d_assgn.value.trim();
  if (!assignmentIdText) {
    alert("Please enter your Assignment ID.");
    return;
  }

  const notes = (notesInput?.value || "").trim();

  const declaration = {
    onlyWurksy: true,
    noGhost: true,
    independent: true,
    understand: true,
    assignmentId: assignmentIdText,
    notes,
    version: "2025-10-27",
  };

  try {
    submitting = true;
    declConfirm.disabled = true;
    declConfirm.textContent = "Submitting…";

    await ensureSession();

    const j = await fetchJSON("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, declaration }),
    });

    if (j.locked_at || j.ok) {
      input.disabled = true;
      submitBtn.disabled = true;
      capEl.textContent = "🔒 LOCKED";

      msgs.appendChild(
        li(
          "assistant",
          "Session submitted and locked. You can still generate the AI Index.",
        ),
      );
      declBackdrop.classList.remove("show");
    }
  } catch (e) {
    alert(e.message || "Submit failed");
  } finally {
    submitting = false;
    declConfirm.disabled = false;
    declConfirm.textContent = "Submit & Lock";
  }
});

// ----------------------
// Boot
// ----------------------

async function boot() {
  try {
    assignmentId = detectAssignmentId();
    await loadConfig();
    await ensureSession();
  } catch (e) {
    msgs.appendChild(li("error", `Failed to start: ${e.message}`));
  }
}

boot();
