// public/admin.js — simplified admin console

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const statusEl = $("#status");
const keyInput = $("#adminKey");
const saveKeyBtn = $("#saveKey");

// tabs
const tabButtons = $$("[data-tab-btn]");
const tabPanels = $$("[data-tab]");

// create assignment wizard
const assModuleCodeEl = $("#assModuleCode");
const assTitleEl = $("#assTitle");
const assDeadlineEl = $("#assDeadline");
const assPromptCapEl = $("#assPromptCap");
const assBriefEl = $("#assBrief");
const assRecommendedEl = $("#assRecommended");
const stepBackBtn = $("#stepBack");
const stepNextBtn = $("#stepNext");
const stepNumEl = $("#stepNum");
const stepLabelEl = $("#stepLabel");
const createdAssignmentInfoEl = $("#createdAssignmentInfo");
const createdAssignmentLinkEl = $("#createdAssignmentLink");
const copyCreatedAssignmentLinkBtn = $("#copyCreatedAssignmentLink");

// AI Index tab
const sessionFilterEl = $("#sessionFilter");
const refreshSessionsBtn = $("#refreshSessions");
const indexSessionRowsEl = $("#indexSessionRows");

let ADMIN_KEY = "";
let currentStep = 1;
const MAX_STEP = 3;
let sessions = [];

// ---------- helpers ----------
function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

function saveKey() {
  ADMIN_KEY = (keyInput.value || "").trim();
  localStorage.setItem("wurksy_admin_key", ADMIN_KEY);
  setStatus("Admin key saved");
}

function loadKey() {
  const k = localStorage.getItem("wurksy_admin_key") || "";
  keyInput.value = k;
  ADMIN_KEY = k;
}

async function fetchJSON(url, options = {}) {
  const r = await fetch(url, options);
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).error || msg;
    } catch {}
    throw new Error(msg || "Request failed");
  }
  try {
    return JSON.parse(text);
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

// ---------- tabs ----------
function showTab(name) {
  tabButtons.forEach((btn) => {
    const active = btn.dataset.tabBtn === name;
    btn.classList.toggle("btn-primary", active);
    btn.classList.toggle("active", active);
  });
  tabPanels.forEach((p) => {
    p.style.display = p.dataset.tab === name ? "block" : "none";
  });
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const name = btn.dataset.tabBtn;
    if (!name) return;
    showTab(name);
  });
});

// ---------- wizard ----------
function updateStepUI() {
  stepNumEl.textContent = String(currentStep);
  const labels = {
    1: "Basics",
    2: "Deadline & prompt cap",
    3: "Brief & resources",
  };
  stepLabelEl.textContent = labels[currentStep] || "";

  $$(".assignment-step").forEach((div) => {
    const s = Number(div.dataset.step || "0");
    div.style.display = s === currentStep ? "grid" : "none";
  });

  stepBackBtn.disabled = currentStep === 1;
  stepNextBtn.textContent =
    currentStep === MAX_STEP ? "Create assignment" : "Next";
}

function clampPromptCap(raw) {
  let n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) n = 100;
  if (n > 100) n = 100;
  if (n < 1) n = 1;
  return n;
}

function parseRecommended() {
  const text = assRecommendedEl.value || "";
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      // if it looks like a URL use as url+label
      const isUrl = /^https?:\/\//i.test(line);
      return isUrl ? { url: line, label: line } : { url: "", label: line };
    });
}

async function createAssignment() {
  if (!ADMIN_KEY) {
    setStatus("Enter ADMIN_KEY first");
    return;
  }

  const moduleCode = assModuleCodeEl.value.trim();
  const title = assTitleEl.value.trim();
  const deadline = assDeadlineEl.value;
  const promptCap = clampPromptCap(assPromptCapEl.value);
  const brief = assBriefEl.value.trim();
  const recommendedPdfs = parseRecommended();

  if (!moduleCode || !title) {
    setStatus("Module code and title are required");
    return;
  }

  setStatus("Creating assignment…");
  try {
    const params = { admin_key: ADMIN_KEY };
    const body = {
      moduleCode,
      title,
      brief,
      deadline: deadline || null,
      promptCap,
      recommendedPdfs,
      createdBy: null,
    };
    const j = await fetchJSON(`/api/admin/assignments?${qs(params)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const url =
      j.studentUrl ||
      (j.assignment &&
        `${location.origin}/login.html?a=${encodeURIComponent(
          j.assignment.short_code,
        )}`);

    if (url) {
      createdAssignmentLinkEl.textContent = url;
      createdAssignmentInfoEl.style.display = "block";
      try {
        await navigator.clipboard.writeText(url);
        setStatus("Assignment created. Link copied to clipboard.");
      } catch {
        setStatus("Assignment created. Click 'Copy link' to copy.");
      }
    } else {
      setStatus("Assignment created, but link missing.");
    }

    // reset wizard back to step 1 (but keep values in case they want to tweak)
    currentStep = 1;
    updateStepUI();
  } catch (e) {
    setStatus(e.message || "Failed to create assignment");
  }
}

// navigation buttons
stepBackBtn.addEventListener("click", () => {
  if (currentStep > 1) {
    currentStep -= 1;
    updateStepUI();
  }
});

stepNextBtn.addEventListener("click", async () => {
  // simple validation per step
  if (currentStep === 1) {
    if (!assModuleCodeEl.value.trim() || !assTitleEl.value.trim()) {
      setStatus("Please fill in module code and title.");
      return;
    }
  }
  if (currentStep === 2) {
    assPromptCapEl.value = clampPromptCap(assPromptCapEl.value);
  }

  if (currentStep < MAX_STEP) {
    currentStep += 1;
    updateStepUI();
  } else {
    // final step -> create
    await createAssignment();
  }
});

copyCreatedAssignmentLinkBtn.addEventListener("click", async () => {
  const txt = createdAssignmentLinkEl.textContent || "";
  if (!txt) return;
  try {
    await navigator.clipboard.writeText(txt);
    setStatus("Link copied");
  } catch {
    setStatus("Unable to copy link");
  }
});

// ---------- AI Index tab ----------
async function loadSessions() {
  if (!ADMIN_KEY) {
    setStatus("Enter ADMIN_KEY first");
    return;
  }
  setStatus("Loading sessions…");
  try {
    const params = { admin_key: ADMIN_KEY };
    const j = await fetchJSON(`/api/admin/sessions?${qs(params)}`);
    sessions = j.sessions || j || [];
    renderSessions();
    setStatus(`Loaded ${sessions.length} sessions`);
  } catch (e) {
    setStatus(e.message || "Failed to load sessions");
  }
}

function renderSessions() {
  const needle = (sessionFilterEl.value || "").toLowerCase();
  indexSessionRowsEl.innerHTML = "";

  const filtered = sessions.filter((s) => {
    if (!needle) return true;
    const id = String(s.id || "").toLowerCase();
    const student = String(s.student_id || "").toLowerCase();
    const moduleCode = String(s.module_code || "").toLowerCase();
    const assignmentCode = String(s.assignment_code || "").toLowerCase();
    return (
      id.includes(needle) ||
      student.includes(needle) ||
      moduleCode.includes(needle) ||
      assignmentCode.includes(needle)
    );
  });

  if (!filtered.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "muted";
    td.textContent = "No sessions found.";
    tr.appendChild(td);
    indexSessionRowsEl.appendChild(tr);
    return;
  }

  filtered.forEach((s) => {
    const tr = document.createElement("tr");

    const studentTd = document.createElement("td");
    studentTd.textContent = s.student_id || "–";
    tr.appendChild(studentTd);

    const moduleTd = document.createElement("td");
    moduleTd.textContent = s.module_code || "–";
    tr.appendChild(moduleTd);

    const aCodeTd = document.createElement("td");
    aCodeTd.textContent = s.assignment_code || "–";
    tr.appendChild(aCodeTd);

    const createdTd = document.createElement("td");
    const dt = s.created_at ? new Date(s.created_at) : null;
    createdTd.textContent = dt ? dt.toLocaleString() : "–";
    tr.appendChild(createdTd);

    const statusTd = document.createElement("td");
    statusTd.textContent = s.locked_at ? "Submitted" : "Active";
    tr.appendChild(statusTd);

    const idxTd = document.createElement("td");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-small";
    btn.textContent = "Open";
    btn.addEventListener("click", async () => {
      await openAiIndexForSession(s.id);
    });
    idxTd.appendChild(btn);
    tr.appendChild(idxTd);

    indexSessionRowsEl.appendChild(tr);
  });
}

async function openAiIndexForSession(sessionId) {
  if (!sessionId) return;
  setStatus("Generating AI Index…");
  try {
    const r = await fetch(
      `/api/ai-index?sessionId=${encodeURIComponent(sessionId)}`,
    );
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    if (j.url) {
      window.open(j.url, "_blank", "noopener");
      setStatus("AI Index opened");
    } else {
      setStatus("AI Index URL missing");
    }
  } catch (e) {
    setStatus(e.message || "AI Index failed");
  }
}

// ---------- wiring ----------
saveKeyBtn.addEventListener("click", saveKey);

refreshSessionsBtn.addEventListener("click", loadSessions);
sessionFilterEl.addEventListener("input", () => renderSessions());

// boot
loadKey();
showTab("create");
currentStep = 1;
updateStepUI();
setStatus("Enter ADMIN_KEY to begin.");
