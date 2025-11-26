// Worksy AI — Lectures page logic (upload + list + viewer + chat)

// ---------- Shorthands ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// ---------- Elements ----------
const themeToggle = $("#themeToggle");

// Upload
const titleInput = $("#titleInput");
const fileInput = $("#fileInput");
const uploadBtn = $("#uploadBtn");
const uploadStatus = $("#uploadStatus");

// Sidebar list
const lectureSearch = $("#lectureSearch");
const refreshLectures = $("#refreshLectures");
const lectureList = $("#lectureList");
const lectureMeta = $("#lectureMeta");

// Viewer
const findInDoc = $("#findInDoc");
const clearFind = $("#clearFind");
const summariseBtn = $("#summariseBtn");
const busy = $("#busy");
const lectureTitle = $("#lectureTitle");
const lectureStats = $("#lectureStats");
const outlineList = $("#outlineList");
const lectureContent = $("#lectureContent");

// Chat
const qaThread = $("#qaThread");
const qaForm = $("#qaForm");
const qaInput = $("#qaInput");

// ---------- State ----------
let sessionId = null;
let allLectures = [];
let currentLectureId = null;
let currentRawText = "";

// ---------- Helpers ----------
async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  if (!r.ok) {
    try {
      const j = JSON.parse(t);
      throw new Error(j.error || j.message || "Request failed");
    } catch {
      throw new Error(t || "Request failed");
    }
  }
  try {
    return JSON.parse(t);
  } catch {
    return {};
  }
}

async function ensureSession() {
  if (sessionId) return;
  const j = await getJSON("/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  sessionId = j.sessionId;
}

function setBusy(on, msg = "Working…") {
  busy.style.display = on ? "" : "none";
  busy.textContent = on ? msg : "";
}

function escapeHTML(s) {
  return s.replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        m
      ],
  );
}

function timeAgo(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return d.toLocaleString();
}

// ---------- pdf.js loader (ESM first, fallback UMD) ----------
let pdfReady = false;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}
function setWorker(prefix) {
  const candidates = [
    `${prefix}/pdf.worker.min.mjs`,
    `${prefix}/pdf.worker.mjs`,
    `${prefix}/pdf.worker.min.js`,
    `${prefix}/pdf.worker.js`,
  ];
  if (window.pdfjsLib?.GlobalWorkerOptions)
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = candidates[0];
}
async function ensurePdfjsReady() {
  if (pdfReady) return;
  try {
    const mod = await import("/pdfjs/pdf.mjs");
    window.pdfjsLib = mod;
    setWorker("/pdfjs");
    pdfReady = true;
    return;
  } catch {}
  try {
    try {
      await loadScript("/pdfjs-legacy/pdf.min.js");
    } catch {
      await loadScript("/pdfjs-legacy/pdf.js");
    }
    if (!window.pdfjsLib) throw new Error("pdf.js UMD not on window");
    setWorker("/pdfjs-legacy");
    pdfReady = true;
    return;
  } catch (e) {
    throw new Error("PDF engine not loaded.");
  }
}

async function extractPdf(file) {
  await ensurePdfjsReady();
  const ab = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: ab }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    uploadStatus.textContent = `Extracting page ${i}/${pdf.numPages}…`;
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const s = tc.items.map((it) => it.str).join(" ");
    pages.push({ n: i, text: s });
  }
  return { pages, pagesCount: pdf.numPages };
}

// ---------- Lectures list ----------
function renderLectureList(items) {
  lectureList.innerHTML = "";
  if (!items.length) {
    lectureList.innerHTML = `<div class="list-item">No lectures yet.</div>`;
    lectureMeta.textContent = "";
    return;
  }
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "list-item";
    row.dataset.id = it.id;

    const title = document.createElement("div");
    title.style.fontWeight = "600";
    title.textContent = it.title || `Lecture ${it.id}`;

    const meta = document.createElement("div");
    meta.className = "doc-subtle";
    const pages = it.meta?.pagesCount ? `${it.meta.pagesCount}p` : "";
    const when = timeAgo(it.created_at);
    meta.textContent = [when, pages].filter(Boolean).join(" • ");

    row.appendChild(title);
    row.appendChild(meta);
    row.addEventListener("click", () => openLecture(it.id));
    lectureList.appendChild(row);
  }
  lectureMeta.textContent = `${items.length} lecture${items.length === 1 ? "" : "s"}`;
}

function filterLectureList() {
  const q = (lectureSearch.value || "").toLowerCase().trim();
  if (!q) return renderLectureList(allLectures);
  const filtered = allLectures.filter((it) =>
    (it.title || "").toLowerCase().includes(q),
  );
  renderLectureList(filtered);
}

async function loadLectureList() {
  await ensureSession();
  const j = await getJSON(
    `/api/lectures/list?sessionId=${encodeURIComponent(sessionId)}`,
  );
  allLectures = j.items || [];
  filterLectureList();
}

// ---------- Open a lecture ----------
async function openLecture(id) {
  try {
    setBusy(true, "Loading lecture…");
    const j = await getJSON(`/api/lectures/${encodeURIComponent(id)}`);
    const item = j.item || {};
    currentLectureId = id;

    lectureTitle.textContent = item.title || `Lecture ${id}`;
    const pages = item.meta?.pagesCount ? `${item.meta.pagesCount} pages` : "";
    const words = item.content
      ? `${item.content.trim().split(/\s+/).length} words`
      : "";
    lectureStats.textContent = [pages, words].filter(Boolean).join(" • ");

    currentRawText = item.content || "";
    lectureContent.innerHTML = `<div>${escapeHTML(currentRawText).replace(/\n/g, "<br>")}</div>`;

    buildOutlineFromText(currentRawText);
    $$(".list-item").forEach((el) =>
      el.classList.toggle("active", el.dataset.id == id),
    );
    qaInput.focus();
  } catch (e) {
    lectureContent.innerHTML = `<p class="doc-subtle">${escapeHTML(e.message)}</p>`;
  } finally {
    setBusy(false);
  }
}

// ---------- Outline ----------
function buildOutlineFromText(text) {
  outlineList.innerHTML = "";
  const lines = text.split(/\r?\n/);
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length < 4) continue;
    const isHeading =
      /^[0-9]+[\.\)]\s+/.test(line) ||
      /^[A-Z][A-Z0-9 \-:]{4,}$/.test(line) ||
      /:$/.test(line);
    if (isHeading)
      candidates.push({ idx: i, text: line.replace(/[:\s]*$/, "") });
  }
  let outline = candidates;
  if (outline.length < 3) {
    outline = [];
    const chunk = 200;
    for (let i = 0; i < lines.length; i += chunk) {
      const preview =
        lines[i].trim().slice(0, 80) || `Section ${Math.floor(i / chunk) + 1}`;
      outline.push({ idx: i, text: preview });
    }
  }
  if (!outline.length) {
    outlineList.innerHTML = `<small class="doc-subtle">No outline found.</small>`;
    return;
  }
  for (const o of outline) {
    const btn = document.createElement("button");
    btn.textContent = o.text;
    btn.addEventListener("click", () => {
      const brs = lectureContent.querySelectorAll("br");
      const target = brs[Math.max(0, o.idx - 2)];
      if (target?.scrollIntoView)
        target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    outlineList.appendChild(btn);
  }
}

// ---------- Find in document ----------
function clearHighlights() {
  lectureContent.querySelectorAll("mark.__hit").forEach((m) => {
    const text = document.createTextNode(m.textContent);
    m.parentNode.replaceChild(text, m);
    m.parentNode.normalize();
  });
}
function highlightTerm(term) {
  if (!term) return;
  const walker = document.createTreeWalker(
    lectureContent,
    NodeFilter.SHOW_TEXT,
    null,
  );
  const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) if (re.test(n.nodeValue)) nodes.push(n);
  for (const node of nodes) {
    const span = document.createElement("span");
    const html = escapeHTML(node.nodeValue).replace(
      re,
      (m) => `<mark class="__hit">${m}</mark>`,
    );
    span.innerHTML = html;
    node.parentNode.replaceChild(span, node);
  }
}
function runFind() {
  clearHighlights();
  const q = (findInDoc.value || "").trim();
  if (!q) return;
  highlightTerm(q);
}

// ---------- Summarise ----------
async function summariseCurrent() {
  if (!currentLectureId) return;
  setBusy(true, "Summarising…");
  try {
    await ensureSession();
    const j = await getJSON("/api/lectures/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        lectureId: currentLectureId,
        question:
          "Summarise this lecture into 6–8 concise bullet points. Highlight key concepts, definitions, steps, and exam-relevant facts.",
      }),
    });
    appendAssistant((j.reply || "").trim() || "No summary returned.");
  } catch (e) {
    appendAssistant(`Summary failed: ${e.message}`);
  } finally {
    setBusy(false);
  }
}

// ---------- Chat ----------
function appendUser(text) {
  const div = document.createElement("div");
  div.className = "msg user";
  div.textContent = text;
  qaThread.appendChild(div);
  qaThread.scrollTop = qaThread.scrollHeight;
}
function appendAssistant(text) {
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.innerHTML = escapeHTML(text).replace(/\n/g, "<br>");
  qaThread.appendChild(div);
  qaThread.scrollTop = qaThread.scrollHeight;
}
async function askAboutCurrent(question) {
  if (!currentLectureId) {
    appendAssistant("Open a lecture first.");
    return;
  }
  await ensureSession();
  appendUser(question);
  appendAssistant("Thinking…");
  try {
    const j = await getJSON("/api/lectures/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        lectureId: currentLectureId,
        question,
      }),
    });
    const last = qaThread.querySelector(".msg.assistant:last-child");
    if (last && last.textContent === "Thinking…") {
      last.innerHTML = escapeHTML(j.reply || "(no reply)").replace(
        /\n/g,
        "<br>",
      );
    } else {
      appendAssistant(j.reply || "(no reply)");
    }
  } catch (e) {
    const last = qaThread.querySelector(".msg.assistant:last-child");
    if (last && last.textContent === "Thinking…")
      last.textContent = `Error: ${e.message}`;
    else appendAssistant(`Error: ${e.message}`);
  }
}

// ---------- Upload handling ----------
uploadBtn?.addEventListener("click", async () => {
  try {
    await ensureSession();
    const file = fileInput?.files?.[0];
    if (!file) {
      uploadStatus.textContent = "Choose a PDF first.";
      return;
    }
    if (file.type !== "application/pdf") {
      uploadStatus.textContent = "Please select a PDF file.";
      return;
    }

    uploadStatus.textContent = "Reading PDF…";
    const { pages, pagesCount } = await extractPdf(file);

    uploadStatus.textContent = "Saving…";
    const title = (titleInput.value || file.name.replace(/\.pdf$/i, "")).trim();

    const j = await getJSON("/api/lectures/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, title, pages, meta: { pagesCount } }),
    });
    uploadStatus.textContent = "Saved.";
    fileInput.value = "";
    titleInput.value = "";

    await loadLectureList();
    // Auto-open the new lecture
    if (j.id) openLecture(j.id);
  } catch (e) {
    uploadStatus.textContent = e.message;
  }
});

// ---------- Events ----------
lectureSearch.addEventListener("input", filterLectureList);
refreshLectures.addEventListener("click", loadLectureList);

summariseBtn.addEventListener("click", summariseCurrent);
findInDoc.addEventListener("input", runFind);
clearFind.addEventListener("click", () => {
  findInDoc.value = "";
  clearHighlights();
  findInDoc.focus();
});

qaForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = (qaInput.value || "").trim();
  if (!q) return;
  qaInput.value = "";
  askAboutCurrent(q);
});

// Optional: theme toggle hook (theme.js also handles it)
if (themeToggle) {
  themeToggle.addEventListener("click", () => {
    // theme.js handles switching; nothing else needed here
    // (keeping listener prevents event from being swallowed in rare cases)
  });
}

// ---------- Init ----------
(async function init() {
  try {
    await ensureSession();
    await loadLectureList();
  } catch (e) {
    lectureList.innerHTML = `<div class="list-item">Failed to load: ${escapeHTML(e.message)}</div>`;
  }
})();
