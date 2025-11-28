/* ============================================================
   Wurksy AI — Lectures Page (FULL NEW VERSION - OPTION C)
   ============================================================ */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ---------- Elements ---------- */
const themeToggle = $("#themeToggle");

/* Upload */
const titleInput = $("#titleInput");
const fileInput = $("#fileInput");
const uploadBtn = $("#uploadBtn");
const uploadStatus = $("#uploadStatus");

/* Sidebar list */
const lectureSearch = $("#lectureSearch");
const refreshLectures = $("#refreshLectures");
const lectureList = $("#lectureList");
const lectureMeta = $("#lectureMeta");

/* Viewer */
const lectureTitle = $("#lectureTitle");
const lectureStats = $("#lectureStats");
const lectureContent = $("#lectureContent");
const outlineList = $("#outlineList");

/* Slide area (visual slides) */
const slideArea = document.createElement("div");
slideArea.id = "slideArea";
slideArea.style.display = "none";
slideArea.style.padding = "1rem";
slideArea.style.overflowY = "auto";
lectureContent.before(slideArea);

/* Toggle buttons */
let viewerMode = "text"; // "text" | "slides"
const toggleBtn = document.createElement("button");
toggleBtn.textContent = "Show Slides";
toggleBtn.className = "primary";
toggleBtn.style.marginRight = "8px";
toggleBtn.onclick = switchViewerMode;

/* Toolbar buttons */
const summariseBtn = $("#summariseBtn");
const findInDoc = $("#findInDoc");
const clearFind = $("#clearFind");
const busy = $("#busy");

/* Chat */
const qaThread = $("#qaThread");
const qaForm = $("#qaForm");
const qaInput = $("#qaInput");

/* ---------- State ---------- */
let sessionId = null;
let allLectures = [];
let currentLectureId = null;
let currentRawText = "";
let currentSlideImages = []; // for slide view
let assignmentId = null;

/* ---------- Helpers ---------- */
async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let j = {};
  try {
    j = JSON.parse(t);
  } catch {}
  if (!r.ok) throw new Error(j.error || "Request failed");
  return j;
}

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

async function ensureSession() {
  if (sessionId) return sessionId;

  // Make sure we know which assignment we're on
  if (!assignmentId) {
    assignmentId = detectAssignmentId();
  }

  let existing = null;
  try {
    existing = localStorage.getItem(sessionKey()) || null;
    // Legacy fallback in case an old global session exists
    if (!existing) {
      const legacy = localStorage.getItem("wurksy_session");
      if (legacy) existing = legacy;
    }
  } catch {
    // ignore
  }

  if (existing) {
    sessionId = existing;
    return sessionId;
  }

  // No session yet → create one (guest mode, but still tagged with assignmentId if known)
  const j = await getJSON("/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "guest", assignmentId }),
  });
  sessionId = j.sessionId;
  try {
    localStorage.setItem(sessionKey(), sessionId);
  } catch {
    // ignore
  }
  return sessionId;
}

function setBusy(on, msg = "Working…") {
  busy.style.display = on ? "" : "none";
  busy.textContent = msg;
}

function escapeHTML(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&quot;", "'": "&#39;" })[m],
  );
}

function timeAgo(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return d.toLocaleString();
}

/* ---------- PDF.js loader ---------- */
let pdfReady = false;
async function ensurePdfjsReady() {
  if (pdfReady) return;
  try {
    const mod = await import("/pdfjs/pdf.mjs");
    window.pdfjsLib = mod;
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.mjs";
    pdfReady = true;
  } catch {
    throw new Error("Failed to load PDF.js");
  }
}

/* ---------- Extract Text from PDF ---------- */
async function extractPdf(file) {
  await ensurePdfjsReady();
  const ab = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  const pages = [];
  const slideImgs = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    uploadStatus.textContent = `Extracting page ${i}/${pdf.numPages}…`;
    const page = await pdf.getPage(i);

    // Text
    const tc = await page.getTextContent();
    const text = tc.items.map((it) => it.str).join(" ");
    pages.push({ n: i, text });

    // Render image for slide view
    const viewport = page.getViewport({ scale: 1.4 });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport }).promise;
    slideImgs.push(canvas.toDataURL("image/png"));
  }

  return { pages, pagesCount: pdf.numPages, slideImgs };
}

/* ---------- PPTX Extraction Placeholder ---------- */
async function extractPptx(file) {
  // FUTURE: implement real PPTX parsing + slide images
  // For now: 1 fake "slide" and placeholder text
  return {
    pages: [{ n: 1, text: "PPTX content extraction placeholder" }],
    pagesCount: 1,
    slideImgs: ["/assets/pptx-placeholder.png"],
  };
}

/* ---------- Switch Viewer Mode ---------- */
function switchViewerMode() {
  if (viewerMode === "text") {
    viewerMode = "slides";
    toggleBtn.textContent = "Show Text";
    lectureContent.style.display = "none";
    slideArea.style.display = "block";
    renderSlides();
  } else {
    viewerMode = "text";
    toggleBtn.textContent = "Show Slides";
    slideArea.style.display = "none";
    lectureContent.style.display = "block";
  }
}

/* ---------- Render Slides ---------- */
function renderSlides() {
  slideArea.innerHTML = "";
  currentSlideImages.forEach((src) => {
    const img = document.createElement("img");
    img.src = src;
    img.style.maxWidth = "100%";
    img.style.marginBottom = "16px";
    slideArea.appendChild(img);
  });
}

/* ---------- Render Lecture List ---------- */
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
    const pages = it.meta?.pagesCount ? `${it.meta.pagesCount} pages` : "";
    const when = timeAgo(it.created_at);
    meta.textContent = [when, pages].filter(Boolean).join(" • ");

    row.appendChild(title);
    row.appendChild(meta);

    row.onclick = () => openLecture(it.id);
    lectureList.appendChild(row);
  }

  lectureMeta.textContent = `${items.length} lecture${items.length === 1 ? "" : "s"}`;
}

/* ---------- Load Lecture List ---------- */
async function loadLectureList() {
  await ensureSession();
  const j = await getJSON(
    `/api/lectures/list?sessionId=${encodeURIComponent(sessionId)}`,
  );
  allLectures = j.items || [];
  renderLectureList(allLectures);
}

/* ---------- Open Lecture ---------- */
async function openLecture(id) {
  try {
    setBusy(true, "Loading…");
    const j = await getJSON(`/api/lectures/${encodeURIComponent(id)}`);
    const item = j.item;

    currentLectureId = id;
    lectureTitle.textContent = item.title || `Lecture ${id}`;
    const pagesLabel = item.meta?.pagesCount
      ? `${item.meta.pagesCount} pages`
      : "";
    lectureStats.textContent = pagesLabel;

    /* Text Mode */
    currentRawText = item.content || "";
    lectureContent.innerHTML = `<div>${escapeHTML(currentRawText).replace(
      /\n/g,
      "<br>",
    )}</div>`;

    /* Slides Mode */
    currentSlideImages = item.meta?.slideImgs || item.meta?.slide_imgs || [];
    if (viewerMode === "slides") renderSlides();

    buildOutlineFromText(currentRawText);

    $$(".list-item").forEach((el) =>
      el.classList.toggle("active", el.dataset.id == id),
    );
  } finally {
    setBusy(false);
  }
}

/* ---------- Outline Generator ---------- */
function buildOutlineFromText(text) {
  outlineList.innerHTML = "";
  const lines = String(text || "").split(/\r?\n/);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i].trim();
    if (!L || L.length < 4) continue;
    const looksLikeHeading =
      /^[0-9]+[\.\)]\s+/.test(L) || // "1. Introduction"
      /^[A-Z][A-Z0-9 \-:]{4,}$/.test(L) || // BIG CAPS
      /:$/.test(L); // ends with colon
    if (looksLikeHeading) {
      out.push({ idx: i, text: L.replace(/[:\s]*$/, "") });
    }
  }

  if (!out.length) {
    outlineList.innerHTML =
      '<small class="doc-subtle">No outline found</small>';
    return;
  }

  out.forEach((o) => {
    const btn = document.createElement("button");
    btn.textContent = o.text;
    btn.onclick = () => {
      const brs = lectureContent.querySelectorAll("br");
      const target = brs[Math.max(0, o.idx - 2)];
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    outlineList.appendChild(btn);
  });
}

/* ---------- Search in Document ---------- */
function clearHighlights() {
  lectureContent.querySelectorAll("mark.__hit").forEach((m) => {
    const t = document.createTextNode(m.textContent);
    m.parentNode.replaceChild(t, m);
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
  while ((n = walker.nextNode())) {
    if (re.test(n.nodeValue)) nodes.push(n);
  }
  nodes.forEach((node) => {
    const span = document.createElement("span");
    span.innerHTML = escapeHTML(node.nodeValue).replace(
      re,
      (m) => `<mark class="__hit">${m}</mark>`,
    );
    node.parentNode.replaceChild(span, node);
  });
}

findInDoc?.addEventListener("input", () => {
  clearHighlights();
  const q = (findInDoc.value || "").trim();
  if (q) highlightTerm(q);
});

clearFind?.addEventListener("click", () => {
  findInDoc.value = "";
  clearHighlights();
  findInDoc.focus();
});

/* ---------- Chat ---------- */
function appendUser(t) {
  const d = document.createElement("div");
  d.className = "msg user";
  d.textContent = t;
  qaThread.appendChild(d);
  qaThread.scrollTop = qaThread.scrollHeight;
}

function appendAssistant(t) {
  const d = document.createElement("div");
  d.className = "msg assistant";
  d.innerHTML = escapeHTML(t).replace(/\n/g, "<br>");
  qaThread.appendChild(d);
  qaThread.scrollTop = qaThread.scrollHeight;
}

async function askAboutCurrent(q) {
  if (!currentLectureId) {
    appendAssistant("Open a lecture first.");
    return;
  }
  await ensureSession();
  appendUser(q);
  appendAssistant("Thinking…");
  try {
    const j = await getJSON("/api/lectures/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        lectureId: currentLectureId,
        question: q,
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
    appendAssistant(`Error: ${e.message}`);
  }
}

/* ---------- Summarise ---------- */
async function summariseCurrent() {
  if (!currentLectureId) return;
  await ensureSession();
  setBusy(true, "Summarising…");
  try {
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

/* ---------- Upload (PDF + PPTX) ---------- */
uploadBtn?.addEventListener("click", async () => {
  try {
    await ensureSession();

    const file = fileInput.files[0];
    if (!file) {
      uploadStatus.textContent = "Choose a file.";
      return;
    }

    const ext = file.name.toLowerCase();
    let extracted = null;

    if (ext.endsWith(".pdf")) {
      extracted = await extractPdf(file);
    } else if (ext.endsWith(".pptx")) {
      extracted = await extractPptx(file);
    } else {
      uploadStatus.textContent = "Upload PDF or PPTX only.";
      return;
    }

    uploadStatus.textContent = "Saving…";

    const title = (
      titleInput.value || file.name.replace(/\.(pdf|pptx)$/i, "")
    ).trim();

    const body = {
      sessionId,
      title,
      pages: extracted.pages,
      slideImgs: extracted.slideImgs || [],
    };

    if (ext.endsWith(".pptx")) {
      body.pptxBase64 = await fileToBase64(file);
    }

    const j = await getJSON("/api/lectures/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    uploadStatus.textContent = "Uploaded.";
    fileInput.value = "";
    titleInput.value = "";

    await loadLectureList();
    if (j.id) openLecture(j.id);
  } catch (e) {
    uploadStatus.textContent = e.message;
  }
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const res = String(r.result || "");
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/* ---------- Events ---------- */
qaForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = (qaInput.value || "").trim();
  if (!q) return;
  qaInput.value = "";
  askAboutCurrent(q);
});

lectureSearch?.addEventListener("input", () => {
  const q = (lectureSearch.value || "").toLowerCase();
  renderLectureList(
    allLectures.filter((x) => (x.title || "").toLowerCase().includes(q)),
  );
});

refreshLectures?.addEventListener("click", loadLectureList);

summariseBtn?.addEventListener("click", summariseCurrent);

/* Add toggle button to toolbar */
const toolbar = document.querySelector(".toolbar");
if (toolbar) toolbar.prepend(toggleBtn);

/* ---------- Init ---------- */
(async function init() {
  try {
    assignmentId = detectAssignmentId();
    await ensureSession();
    await loadLectureList();
  } catch (e) {
    lectureList.innerHTML = `<div class="list-item">Failed to load: ${escapeHTML(
      e.message,
    )}</div>`;
  }
})();
