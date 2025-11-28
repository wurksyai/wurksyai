// public/research.js
// Research workspace with inline PDF viewer + robust resolver + Q&A
// Auto-extracts PDF text; summary replaces extract panel; chat appends; Enter=send.

const $ = (s) => document.querySelector(s);

// Search
const form = $("#qform");
const qEl = $("#q");
const statusEl = $("#status");
const resultsEl = $("#results");

// Preview
const paperTitleEl = $("#paperTitle");
const metaEl = $("#meta");
const abstractEl = $("#abstract");

// Viewer
const pdfCanvas = $("#pdfCanvas");
const pageInfo = $("#pageInfo");
const prevPageBtn = $("#prevPage");
const nextPageBtn = $("#nextPage");
const openPdfBtn = $("#openPdfBtn");

// Panels / controls
const summariseBtn = $("#summariseBtn");
const pdfTextEl = $("#pdfText");

// (If the HTML still has an Extract button, remove it quietly)
const leftoverExtractBtn = document.querySelector("#extractBtn");
if (leftoverExtractBtn) leftoverExtractBtn.remove();

// Citations
const styleEl = $("#style");
const citeBtn = $("#citeBtn");
const addBibBtn = $("#addBibBtn");
const bibEl = $("#bib");
const copyBibBtn = $("#copyBibBtn");

// Q&A
const questionEl = $("#question");
const askBtn = $("#askBtn");
const answerEl = $("#answer");

// -------- shared session (for AI Index logging) --------
let sessionId = null;

async function ensureSession() {
  if (sessionId) return sessionId;

  let existing = null;
  try {
    // prefer new key, fall back to old, then migrate
    existing =
      localStorage.getItem("wurksy_session") ||
      localStorage.getItem("wurksy_session_id") ||
      null;
  } catch {}

  if (existing) {
    sessionId = existing;
    try {
      localStorage.setItem("wurksy_session", sessionId);
    } catch {}
    return sessionId;
  }

  // No existing session anywhere → start one guest session
  const r = await fetch("/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "guest" }),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || "Failed to start session");
  sessionId = j.sessionId;
  try {
    localStorage.setItem("wurksy_session", sessionId);
  } catch {}
  return sessionId;
}

// ---------- utils ----------
function setStatus(s) {
  statusEl.textContent = s;
}
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
function metaLine(it) {
  const bits = [it.source, it.venue, it.year, it.author].filter(Boolean);
  return bits.join(" • ");
}
const doiUrl = (d) =>
  `https://doi.org/${String(d).replace(/^https?:\/\/doi.org\//i, "")}`;

// bullets → <ul>
function renderBullets(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^\s*[-•*]\s?/, "").trim());
  const ul = document.createElement("ul");
  ul.className = "bullets";
  lines.forEach((l) => {
    const li = document.createElement("li");
    li.textContent = l;
    ul.appendChild(li);
  });
  return ul;
}
function escapeHTML(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (m) => ({ "&": "&amp;", "<": "&gt;", '"': "&quot;", "'": "&#39;" })[m],
  );
}

// ---------- results ----------
let current = null;
let bibliography = [];
let lastExtractedText = ""; // keep the raw text so user can ask questions

function resultRow(it) {
  const li = document.createElement("li");
  li.className = "list-item";

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = it.title || it.doi || "Untitled";

  const meta = document.createElement("div");
  meta.className = "muted";
  meta.textContent = metaLine(it);

  const tiny = document.createElement("div");
  tiny.className = "muted";
  tiny.style.fontSize = "11px";
  tiny.textContent = it.doi
    ? `DOI: ${String(it.doi).replace(/^https?:\/\/doi.org\//i, "")}`
    : it.url || "";

  const rowBtns = document.createElement("div");
  rowBtns.style.marginTop = "6px";
  const openBtn = document.createElement("button");
  openBtn.className = "btn";
  openBtn.textContent = "Open Source";
  openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const u = bestPdfUrl(it) || it.url || (it.doi ? doiUrl(it.doi) : "");
    if (u) window.open(u, "_blank", "noopener");
  });
  rowBtns.appendChild(openBtn);

  li.appendChild(title);
  li.appendChild(meta);
  li.appendChild(tiny);
  li.appendChild(rowBtns);

  li.addEventListener("click", () => {
    // fire-and-forget async; we don't await so UI stays snappy
    void selectItem(it);
  });
  return li;
}

// NEW: record that the student opened / selected a paper
async function recordPaperClick(it) {
  try {
    await ensureSession();
    await fetch("/api/papers/click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, meta: it }),
    });
  } catch {
    // swallow – logging failure shouldn't break the UI
  }
}

async function selectItem(it) {
  current = it;
  paperTitleEl.textContent = it.title || "Untitled";
  metaEl.textContent = metaLine(it);
  abstractEl.textContent = it.abstract || "(no abstract available)";
  lastExtractedText = "";
  pdfTextEl.textContent = "";

  // log + save research artifact for AI Index
  await recordPaperClick(it);

  // keep chat history visible; don't clear
  await loadForViewing(it);
}

// ---------- PDF helpers ----------
function bestPdfUrl(it) {
  return (
    it.oa_pdf || (it.url && /\.pdf($|\?)/i.test(it.url) ? it.url : "") || null
  );
}
function proxyUrl(u) {
  return `/api/pdf-proxy?url=${encodeURIComponent(u)}`;
}

// dynamic import pdf.js
let pdfLoaded = false;
async function ensurePdfjsReady() {
  if (window.pdfjsLib && !pdfLoaded) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc ||= "/pdfjs/pdf.worker.mjs";
    pdfLoaded = true;
    return;
  }
  if (pdfLoaded) return;
  const mod = await import("/pdfjs/pdf.mjs");
  window.pdfjsLib = mod;

  const candidates = [
    "/pdfjs/pdf.worker.mjs",
    "/pdfjs/pdf.worker.min.mjs",
    "/pdfjs/pdf.worker.js",
    "/pdfjs/pdf.worker.min.js",
  ];
  let chosen = candidates[0];
  for (const c of candidates) {
    try {
      const head = await fetch(c, { method: "HEAD", cache: "no-store" });
      if (head.ok) {
        chosen = c;
        break;
      }
    } catch {}
  }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = chosen;
  pdfLoaded = true;
}

// inline viewer state
let _pdfDoc = null;
let _pageNum = 1;

async function loadPdfIntoViewer(url) {
  await ensurePdfjsReady();
  setStatus("Loading PDF…");
  _pdfDoc = await window.pdfjsLib.getDocument({ url }).promise;
  _pageNum = 1;
  pageInfo.textContent = `1 / ${_pdfDoc.numPages}`;
  await renderPage(_pageNum);
  setStatus("");
}
async function renderPage(num) {
  if (!_pdfDoc) return;
  const page = await _pdfDoc.getPage(num);
  const viewport = page.getViewport({ scale: 1.5 });
  const canvas = pdfCanvas;
  const ctx = canvas.getContext("2d");
  canvas.height = viewport.height;
  canvas.width = viewport.width;
  await page.render({ canvasContext: ctx, viewport }).promise;
  pageInfo.textContent = `${num} / ${_pdfDoc.numPages}`;
}
function goToPage(n) {
  if (!_pdfDoc) return;
  const clamped = Math.max(1, Math.min(n, _pdfDoc.numPages));
  _pageNum = clamped;
  return renderPage(_pageNum);
}
prevPageBtn.addEventListener("click", async () => {
  if (!_pdfDoc || _pageNum <= 1) return;
  _pageNum -= 1;
  await renderPage(_pageNum);
});
nextPageBtn.addEventListener("click", async () => {
  if (!_pdfDoc || _pageNum >= _pdfDoc.numPages) return;
  _pageNum += 1;
  await renderPage(_pageNum);
});
openPdfBtn.addEventListener("click", () => {
  if (!current) return;
  const url =
    bestPdfUrl(current) ||
    current.url ||
    (current.doi ? doiUrl(current.doi) : "");
  if (url) window.open(url, "_blank", "noopener");
});

// ---------- resolver + auto-extraction ----------
async function resolvePdfFor(it) {
  await ensureSession();
  const params = new URLSearchParams();
  if (it.doi) params.set("doi", String(it.doi));
  if (it.url) params.set("url", String(it.url));
  if (it.oa_pdf) params.set("oa_pdf", String(it.oa_pdf));
  if (sessionId) params.set("sessionId", sessionId); // for AI Index logging
  const j = await getJSON(`/api/papers/resolve?${params.toString()}`);
  return j; // { pdf, landing }
}

async function loadForViewing(it) {
  try {
    setStatus("Resolving PDF…");
    const { pdf } = await resolvePdfFor(it);
    if (pdf) {
      // 1) Render
      await loadPdfIntoViewer(proxyUrl(pdf));
      // 2) Auto-extract
      setStatus("Extracting text…");
      const text = await extractPdfFromUrl(pdf);
      lastExtractedText = text || "";
      pdfTextEl.textContent = lastExtractedText || "(no text extracted)";
      setStatus("");
      return;
    }
  } catch {}
  // Fallback if no PDF
  setStatus("No direct PDF available. Use Open Source.");
  pageInfo.textContent = "–/–";
  const ctx = pdfCanvas.getContext("2d");
  ctx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);
}

async function extractPdfFromUrl(url) {
  await ensurePdfjsReady();
  const doc = await window.pdfjsLib.getDocument({ url: proxyUrl(url) }).promise;
  const chunks = [];
  const max = Math.min(doc.numPages, 20); // cap for speed
  for (let i = 1; i <= max; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const s = tc.items.map((it) => it.str).join(" ");
    chunks.push(`# Page ${i}\n${s}`);
  }
  return chunks.join("\n\n");
}

// --- citations & bibliography ---

import("/harvard_uol.js").then(({ formatHarvardUoL }) => {
  const ACCESS_DYNAMIC = null; // null = use today's date; or set "7 November 2025"

  function formatRef(meta, styleVal) {
    if (styleVal === "vancouver") {
      // quick Vancouver fallback
      const author = meta.author || "";
      const title = meta.title || "";
      const venue = meta.journal || meta.venue || "";
      const year = meta.year || "";
      const url = meta.doi
        ? `https://doi.org/${String(meta.doi).replace(
            /^https?:\/\/doi\.org\//i,
            "",
          )}`
        : meta.url || "";
      return `${author}. ${title}. ${venue}. ${year}. ${url}`
        .replace(/\s+\./g, ". ")
        .trim();
    }
    // default: Harvard (UoL)
    const mapped = {
      author: meta.author,
      year: meta.year,
      title: meta.title,
      journal: meta.journal || meta.venue,
      venue: meta.venue,
      volume: meta.volume,
      issue: meta.issue,
      pages: meta.pages,
      doi: meta.doi && String(meta.doi).replace(/^https?:\/\/doi\.org\//i, ""),
      url: meta.url,
      place: meta.place,
      publisher: meta.publisher,
      edition: meta.edition,
      editors: meta.editors,
      chapter: meta.chapter,
      bookTitle: meta.bookTitle || meta.container_title,
      confName: meta.confName,
      org: meta.org,
      reportNo: meta.reportNo,
      thesisType: meta.thesisType,
      type: meta.type,
    };
    return formatHarvardUoL(mapped, { accessDate: ACCESS_DYNAMIC });
  }

  citeBtn.addEventListener("click", async () => {
    if (!current) return;
    const line = formatRef(current, styleEl.value);
    await navigator.clipboard.writeText(line);
    setStatus("Citation copied");
  });

  addBibBtn.addEventListener("click", async () => {
    if (!current) return;
    const line = formatRef(current, styleEl.value);
    bibliography.push(line);
    renderBib();
  });

  copyBibBtn.addEventListener("click", async () => {
    if (!bibliography.length) return;
    await navigator.clipboard.writeText(bibliography.join("\n"));
    setStatus("Bibliography copied");
  });

  function renderBib() {
    bibEl.innerHTML = "";
    bibliography.forEach((line, i) => {
      const li = document.createElement("li");
      li.className = "list-item";
      li.textContent = `${i + 1}. ${line}`;
      bibEl.appendChild(li);
    });
  }
});

// ---------- Wurksy Q&A ----------
async function askWurksy(prompt, contextOverride) {
  await ensureSession();

  const contextText = String(
    contextOverride || lastExtractedText || abstractEl.textContent || "",
  ).slice(0, 12000);

  const pre = contextText
    ? `ARTICLE TEXT (truncated to 12k chars):\n${contextText}`
    : `ARTICLE META:\n${JSON.stringify(
        {
          title: current?.title,
          author: current?.author,
          venue: current?.venue,
          year: current?.year,
          doi: current?.doi,
          url: current?.url,
        },
        null,
        2,
      ).slice(0, 4000)}`;

  const userMsg = `${pre}\n\nQUESTION: ${prompt}`;

  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      message: userMsg,
      channel: "research", // logged in chat_events
    }),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || "Ask failed");
  return j.reply;
}

// Append chat (never clear)
function addChat(role, content) {
  const li = document.createElement("li");
  li.className = "list-item";
  if (role === "user") {
    li.textContent = content;
  } else {
    li.appendChild(renderBullets(content));
  }
  answerEl.appendChild(li);
  answerEl.scrollTop = answerEl.scrollHeight;
}

async function sendQuestion() {
  if (!current) return;
  const q = questionEl.value.trim();
  if (!q) return;
  addChat("user", q);
  questionEl.value = "";
  const thinking = document.createElement("li");
  thinking.className = "list-item";
  thinking.textContent = "Thinking…";
  answerEl.appendChild(thinking);

  try {
    const reply = await askWurksy(q);
    thinking.remove();
    addChat("assistant", reply);

    // naive page jump if answer mentions pages
    const m = String(reply).match(
      /p(?:age|p\.)?s?\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/i,
    );
    if (m && _pdfDoc) {
      const first = parseInt(m[1], 10);
      if (!isNaN(first)) goToPage(first);
    }
  } catch (e) {
    thinking.textContent = e.message;
  }
}

askBtn?.addEventListener("click", sendQuestion);
questionEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendQuestion();
  }
});

// ---------- Summary button (writes into extracted-text panel) ----------
summariseBtn?.addEventListener("click", async () => {
  if (!current) return;
  const original = lastExtractedText || "";
  pdfTextEl.textContent = "Summarising…";
  try {
    const reply = await askWurksy(
      "Summarise this article in 6–10 bullet points and list 3 key statistics with exact values. If figures are present, list which figure shows each stat.",
    );
    // Replace extract panel with bullets
    pdfTextEl.innerHTML = "";
    pdfTextEl.appendChild(renderBullets(reply));
    // keep original text in memory so Q&A still uses it
    lastExtractedText = original || lastExtractedText;
  } catch (e) {
    pdfTextEl.textContent = e.message || "Summary failed.";
  }
});

// ---------- “Highlight to Ask” on extracted text ----------
let hlPopup, askHlBtn, lastSel;
function ensureHlPopup() {
  if (hlPopup) return;
  hlPopup = document.createElement("div");
  hlPopup.style.position = "absolute";
  hlPopup.style.background = "var(--card)";
  hlPopup.style.border = "1px solid var(--border)";
  hlPopup.style.borderRadius = "8px";
  hlPopup.style.padding = "6px";
  hlPopup.style.zIndex = "70";
  hlPopup.style.boxShadow = "var(--shadow)";
  hlPopup.style.display = "none";
  askHlBtn = document.createElement("button");
  askHlBtn.className = "btn";
  askHlBtn.textContent = "Ask Wurksy";
  hlPopup.appendChild(askHlBtn);
  document.body.appendChild(hlPopup);
}
pdfTextEl.addEventListener("mouseup", () => {
  ensureHlPopup();
  const sel = window.getSelection && window.getSelection().toString().trim();
  if (!sel) {
    hlPopup.style.display = "none";
    return;
  }
  lastSel = sel;
  const r = window.getSelection().getRangeAt(0).getBoundingClientRect();
  hlPopup.style.left = `${r.left + window.scrollX}px`;
  hlPopup.style.top = `${r.top + window.scrollY - 44}px`;
  hlPopup.style.display = "block";
});
document.addEventListener("click", (e) => {
  if (hlPopup && !hlPopup.contains(e.target) && e.target !== pdfTextEl) {
    hlPopup.style.display = "none";
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && hlPopup) hlPopup.style.display = "none";
});
document.addEventListener("selectionchange", () => {
  if (window.getSelection && !window.getSelection().toString()) {
    if (hlPopup) hlPopup.style.display = "none";
  }
});
askHlBtn?.addEventListener("click", async () => {
  if (!lastSel) return;
  hlPopup.style.display = "none";
  addChat("user", `Explain this: ${lastSel.slice(0, 120)}…`);
  const reply = await askWurksy(
    "Explain this highlighted section in crisp bullet points.",
    lastSel,
  );
  addChat("assistant", reply || "(no reply)");
});

// ---------- search ----------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const term = qEl.value.trim();
  if (!term) return;
  resultsEl.innerHTML = "";
  try {
    await ensureSession();
    setStatus("Searching…");
    const url =
      `/api/papers/search?q=${encodeURIComponent(term)}` +
      (sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : "");
    const j = await getJSON(url);
    (j.items || []).forEach((it) => resultsEl.appendChild(resultRow(it)));
    if (!j.items?.length)
      resultsEl.innerHTML = `<li class="muted">No results.</li>`;
    setStatus(`Found ${j.items?.length || 0} items`);
  } catch (err) {
    resultsEl.innerHTML = `<li class="muted">${escapeHTML(err.message)}</li>`;
    setStatus("Search failed");
  }
});
