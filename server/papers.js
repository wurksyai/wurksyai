console.log("✅ UNPAYWALL_EMAIL:", process.env.UNPAYWALL_EMAIL);

// server/papers.js
import fetch from "node-fetch";
import { searchCrossref, searchOpenAlex } from "./research.js";

/** ===== Helpers ===== */
const UA = "WurksyAI/1.0 (+https://example.edu) contact=wurksy@example.edu";
const UNPAYWALL_EMAIL = process.env.UNPAYWALL_EMAIL || "oa@wurksy.ai";
const CORE_API_KEY = process.env.CORE_API_KEY || "";

function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  const headers = {
    "User-Agent": UA,
    Accept: opts.accept || "application/json",
    ...(opts.headers || {}),
  };
  return fetch(url, { ...opts, headers, signal: controller.signal }).finally(
    () => clearTimeout(id),
  );
}

const isPdfType = (t = "") => /^application\/pdf\b/i.test(t);
const cleanDoi = (d) =>
  d ? `https://doi.org/${String(d).replace(/^https?:\/\/doi.org\//i, "")}` : "";

/** ===== CORE (Open Access Repository) ===== */
async function searchCore(term, max = 6) {
  const key = CORE_API_KEY;
  if (!key) {
    console.warn("⚠️ CORE_API_KEY not set");
    return [];
  }
  const url = `https://api.core.ac.uk/v3/search/works?apiKey=${encodeURIComponent(
    key,
  )}&q=${encodeURIComponent(term)}&page=1&pageSize=${max}`;
  const r = await fetchWithTimeout(url, {}, 10000);
  if (!r.ok) throw new Error(`CORE failed ${r.status}`);
  const j = await r.json();
  const out = [];
  for (const it of j.results || []) {
    const title = it.title || "";
    const authors = (it.authors || [])
      .map((a) => a.name || a)
      .filter(Boolean)
      .join(", ");
    const year = it.publishedDate
      ? (String(it.publishedDate).match(/\b(19|20)\d{2}\b/) || [, ""])[1]
      : "";
    const doi = it.doi || null;
    const oa_pdf =
      it.downloadUrl ||
      it.fullTextLink ||
      (it.links || []).find(
        (x) => typeof x === "string" && /\.pdf($|\?)/i.test(x),
      ) ||
      null;
    const venue = it.publisher || it.source || it.journal || "";

    out.push({
      source: "CORE",
      title,
      author: authors,
      year,
      doi,
      url: it.links?.[0] || it.url || null,
      oa_pdf,
      abstract: it.abstract || null,
      venue,
    });
  }
  return out;
}

/** ===== Normalise & Dedupe ===== */
function normalise(items = []) {
  return items.map((it) => ({
    source: it.source || "",
    title: it.title || "",
    author: it.author || "",
    year: it.year || "",
    doi: it.doi || null,
    url: it.url || null,
    oa_pdf:
      it.oa_pdf ||
      it.pdf_url ||
      it.primary_pdf ||
      it.primary_location?.pdf_url ||
      null,
    abstract: it.abstract || it.summary || null,
    venue:
      it.venue ||
      it.journal ||
      it.container_title ||
      it.host_venue?.display_name ||
      "",
    arxivId: it.arxivId || null,
  }));
}
function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k =
      (it.doi ? `doi:${String(it.doi).toLowerCase()}` : "") ||
      (it.arxivId ? `arxiv:${String(it.arxivId).toLowerCase()}` : "") ||
      (it.title ? `title:${String(it.title).toLowerCase()}` : "");
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

/** ===== Citations ===== */
const toHarvard = (m) =>
  `${m.author || ""} (${m.year || ""}) ${m.title || ""}. ${
    m.venue || ""
  }. ${cleanDoi(m.doi) || m.url || ""}`.replace(/\s+\./g, ".");
const toVancouver = (m) =>
  `${m.author || ""}. ${m.title || ""}. ${m.venue || ""}. ${
    m.year || ""
  }. ${cleanDoi(m.doi)}`.replace(/\s+\./g, ".");

/** ===== Landing page -> PDF finder ===== */
function resolveUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
async function tryFindPdfOnPage(landingUrl) {
  const r = await fetchWithTimeout(landingUrl, { accept: "text/html" }, 8000);
  if (!r.ok) throw new Error(`Landing fetch ${r.status}`);
  const html = await r.text();
  const hrefs = [
    ...html.matchAll(/href\s*=\s*"(.*?)"/gi),
    ...html.matchAll(/href\s*=\s*'(.*?)'/gi),
  ]
    .map((m) => m[1])
    .filter(Boolean);
  const extra = [
    ...html.matchAll(/data-pdf-url\s*=\s*"(.*?)"/gi),
    ...html.matchAll(/content\s*=\s*"(.*?)"\s*[^>]*?pdf/gi),
  ]
    .map((m) => m[1])
    .filter(Boolean);
  const candidates = [
    ...new Set(
      [...hrefs, ...extra]
        .map((h) => resolveUrl(h, landingUrl))
        .filter((u) => u && /\.pdf($|\?)/i.test(u)),
    ),
  ].slice(0, 10);

  for (const u of candidates) {
    try {
      const h = await fetchWithTimeout(u, { method: "HEAD" }, 6000);
      const t = h.headers.get("content-type") || "";
      const len = Number(h.headers.get("content-length") || "0");
      if (isPdfType(t) && (!len || len < 25 * 1024 * 1024)) return u;
    } catch {}
  }
  return null;
}

/** ===== Unpaywall resolver ===== */
async function resolveViaUnpaywall(doi) {
  const email = UNPAYWALL_EMAIL;
  if (!doi) return null;
  const clean = String(doi).replace(/^https?:\/\/doi\.org\//i, "");
  const url = `https://api.unpaywall.org/v2/${encodeURIComponent(
    clean,
  )}?email=${encodeURIComponent(email)}`;
  try {
    const r = await fetchWithTimeout(url, {}, 8000);
    if (!r.ok) return null;
    const j = await r.json();
    return (
      j.best_oa_location?.url_for_pdf ||
      j.first_oa_location?.url_for_pdf ||
      (j.oa_locations || [])
        .map((x) => x.url_for_pdf)
        .find((u) => u && /\.pdf/i.test(u)) ||
      null
    );
  } catch {
    return null;
  }
}

/** ===== Universal resolver ===== */
async function resolveBestPdfUrl(meta) {
  try {
    if (meta.oa_pdf) return meta.oa_pdf;
    const fromUnpaywall = await resolveViaUnpaywall(meta.doi);
    if (fromUnpaywall) return fromUnpaywall;
    const landing = meta.url || cleanDoi(meta.doi);
    if (landing) {
      const found = await tryFindPdfOnPage(landing);
      if (found) return found;
    }
    return null;
  } catch (err) {
    console.error("resolveBestPdfUrl error:", err.message);
    return null;
  }
}

/** ===== ROUTES ===== */
export function registerPaperRoutes(app, logger) {
  // SEARCH (now includes CORE)
  app.get("/api/papers/search", async (req, res) => {
    try {
      const q = req.query.q || "";
      if (!q) return res.json({ items: [] });
      const [cr, oa, core] = await Promise.all([
        searchCrossref(q, 8).catch(() => []),
        searchOpenAlex(q, 8).catch(() => []),
        searchCore(q, 8).catch(() => []),
      ]);
      res.json({ items: dedupe(normalise([...core, ...cr, ...oa])) });
    } catch (e) {
      logger?.error({ err: e }, "papers.search");
      res.status(500).json({ error: "Search failed" });
    }
  });

  // FIND PDF
  app.get("/api/papers/find-pdf", async (req, res) => {
    try {
      const raw = String(req.query.url || "");
      if (!/^https?:\/\//i.test(raw)) return res.json({ pdf: null });
      const pdf = await tryFindPdfOnPage(raw);
      res.json({ pdf });
    } catch {
      res.json({ pdf: null });
    }
  });

  // RESOLVE (via Unpaywall / CORE / landing)
  app.get("/api/papers/resolve", async (req, res) => {
    try {
      const doi = req.query.doi || "";
      const url = req.query.url || "";
      const oa_pdf = req.query.oa_pdf || "";
      const meta = { doi, url, oa_pdf };
      const pdf = await resolveBestPdfUrl(meta);
      res.json({ pdf });
    } catch (e) {
      res.status(500).json({ error: "Resolve failed" });
    }
  });

  // Q&A
  app.post("/api/papers/ask", async (req, res) => {
    try {
      const { question, context, title } = req.body || {};
      if (!question) return res.status(400).json({ error: "Missing question" });
      if (!context) return res.status(400).json({ error: "Missing context" });

      const system = {
        role: "system",
        content:
          "You are Wurksy, an amber-mode academic assistant. Answer in concise bullet points and ground ONLY in the provided paper text. If not in text, say you cannot confirm.",
      };
      const user = {
        role: "user",
        content: `PAPER: ${title || "Untitled"}\n\nTEXT (truncated ~45k):\n${String(
          context,
        ).slice(0, 45000)}\n\nQUESTION: ${question}`,
      };
      const { chatComplete } = await import("./openai.js");
      const { text } = await chatComplete([system, user]);
      res.json({ reply: text });
    } catch (e) {
      logger?.error({ err: e }, "papers.ask");
      res.status(500).json({ error: "Ask failed" });
    }
  });

  // CITE
  app.post("/api/papers/cite", async (req, res) => {
    try {
      const { meta, style } = req.body || {};
      if (!meta) return res.status(400).json({ error: "Missing meta" });
      const m = {
        author: meta.author || "",
        year: meta.year || "",
        title: meta.title || "",
        venue: meta.venue || "",
        doi: meta.doi || "",
        url: meta.url || "",
      };
      const harvard = toHarvard(m);
      const vancouver = toVancouver(m);
      const formatted = style === "vancouver" ? vancouver : harvard;
      res.json({ harvard, vancouver, formatted });
    } catch (e) {
      logger?.error({ err: e }, "papers.cite");
      res.status(500).json({ error: "Cite failed" });
    }
  });

  // PDF PROXY
  app.get("/api/pdf-proxy", async (req, res) => {
    try {
      const raw = String(req.query.url || "");
      if (!/^https:\/\//i.test(raw)) {
        return res.status(400).json({ error: "Invalid URL" });
      }
      const r = await fetchWithTimeout(raw, { method: "GET" }, 10000);
      if (!r.ok)
        return res.status(r.status).json({ error: `Upstream ${r.status}` });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Cache-Control", "no-store");
      r.body.pipe(res);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
