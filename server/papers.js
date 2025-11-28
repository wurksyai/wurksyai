// server/papers.js
import fetch from "node-fetch";
import { searchCrossref, searchOpenAlex } from "./research.js";

/** ===== Constants ===== */
const UA = "WurksyAI/1.0 (+https://wurksy.ai)";
const UNPAYWALL_EMAIL = process.env.UNPAYWALL_EMAIL || "oa@wurksy.ai";
const CORE_API_KEY = process.env.CORE_API_KEY || "";

/** ===== Helpers ===== */
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

/** ===== SUPABASE LOGGING HELPERS ===== */
async function logEvent(
  supabase,
  sessionId,
  role,
  content,
  channel,
  meta = {},
) {
  if (!supabase) return;

  try {
    await supabase.from("chat_events").insert({
      session_id: sessionId,
      role,
      content,
      channel,
      meta,
    });
  } catch (e) {
    console.error("logEvent error:", e.message);
  }
}

async function saveResearchArtifact(supabase, sessionId, meta, title = "") {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from("artifacts")
      .insert({
        session_id: sessionId,
        kind: "research",
        title,
        meta,
        content: null,
      })
      .select("id")
      .single();

    if (error) throw error;
    return data.id;
  } catch (e) {
    console.error("saveResearchArtifact error:", e.message);
    return null;
  }
}

/** ===== CORE SEARCH API ===== */
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
    out.push({
      source: "CORE",
      title: it.title || "",
      author: (it.authors || []).map((a) => a.name || a).join(", "),
      year: it.publishedDate
        ? (String(it.publishedDate).match(/\b(19|20)\d{2}\b/) || [, ""])[1]
        : "",
      doi: it.doi || null,
      url: it.url || null,
      oa_pdf:
        it.downloadUrl ||
        it.fullTextLink ||
        (it.links || []).find(
          (x) => typeof x === "string" && /\.pdf/i.test(x),
        ) ||
        null,
      abstract: it.abstract || null,
      venue: it.publisher || it.source || it.journal || "",
    });
  }

  return out;
}

/** ===== Normalise + Dedupe ===== */
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
      `title:${String(it.title).toLowerCase()}`;

    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }

  return out;
}

/** ===== PDF extraction helpers ===== */
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

async function resolveViaUnpaywall(doi) {
  if (!doi) return null;

  const clean = String(doi).replace(/^https?:\/\/doi\.org\//i, "");
  const url = `https://api.unpaywall.org/v2/${encodeURIComponent(
    clean,
  )}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`;

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

async function resolveBestPdfUrl(meta) {
  try {
    if (meta.oa_pdf) return meta.oa_pdf;

    const viaUnpaywall = await resolveViaUnpaywall(meta.doi);
    if (viaUnpaywall) return viaUnpaywall;

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

/** ===== REGISTER ROUTES ===== */

export function registerPaperRoutes(app, logger, supabase) {
  /** --- SEARCH PAPERS --- */
  app.get("/api/papers/search", async (req, res) => {
    try {
      const q = req.query.q || "";
      const sessionId = req.query.sessionId || null;

      if (!q) return res.json({ items: [] });

      // Log the search
      if (sessionId) {
        await logEvent(
          supabase,
          sessionId,
          "user",
          `Paper search: ${q}`,
          "research_search",
        );
      }

      const [cr, oa, core] = await Promise.all([
        searchCrossref(q, 8).catch(() => []),
        searchOpenAlex(q, 8).catch(() => []),
        searchCore(q, 8).catch(() => []),
      ]);

      const results = dedupe(normalise([...core, ...cr, ...oa]));

      res.json({ items: results });
    } catch (e) {
      logger?.error({ err: e }, "papers.search");
      res.status(500).json({ error: "Search failed" });
    }
  });

  /** --- CLICK / OPEN PAPER --- */
  app.post("/api/papers/click", async (req, res) => {
    try {
      const { sessionId, meta } = req.body || {};

      if (!sessionId || !meta)
        return res.status(400).json({ error: "Missing sessionId or meta" });

      const title = meta.title || "Unknown title";

      // Log event
      await logEvent(
        supabase,
        sessionId,
        "user",
        `Opened paper: ${title}`,
        "research_click",
        meta,
      );

      // Save artifact
      await saveResearchArtifact(supabase, sessionId, meta, title);

      res.json({ ok: true });
    } catch (e) {
      logger?.error({ err: e }, "papers.click");
      res.status(500).json({ error: "Click failed" });
    }
  });

  /** --- FIND PDF --- */
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

  /** --- RESOLVE PDF (Unpaywall/CORE) --- */
  app.get("/api/papers/resolve", async (req, res) => {
    try {
      const doi = req.query.doi || "";
      const url = req.query.url || "";
      const oa_pdf = req.query.oa_pdf || "";
      const sessionId = req.query.sessionId || null;

      const meta = { doi, url, oa_pdf };
      const pdf = await resolveBestPdfUrl(meta);

      // Log the fact we resolved a PDF for this session
      if (sessionId && (doi || url || oa_pdf)) {
        await logEvent(
          supabase,
          sessionId,
          "user",
          "Resolved paper PDF",
          "research_resolve",
          { ...meta, pdf },
        );
      }

      res.json({ pdf });
    } catch (e) {
      logger?.error({ err: e }, "papers.resolve");
      res.status(500).json({ error: "Resolve failed" });
    }
  });

  /** --- Q&A ON PAPER TEXT --- */
  app.post("/api/papers/ask", async (req, res) => {
    try {
      const { sessionId, question, context, title } = req.body || {};

      if (!sessionId)
        return res.status(400).json({ error: "Missing sessionId" });
      if (!question) return res.status(400).json({ error: "Missing question" });
      if (!context) return res.status(400).json({ error: "Missing context" });

      // Log user Q
      await logEvent(
        supabase,
        sessionId,
        "user",
        `Paper question: ${question}`,
        "research",
      );

      const system = {
        role: "system",
        content:
          "You are Wurksy, an amber-mode assistant. Answer ONLY in concise bullet points based strictly on the provided text. If not in text, say you cannot confirm.",
      };

      const user = {
        role: "user",
        content: `PAPER: ${title || "Untitled"}\n\nTEXT (truncated ~45k):\n${String(
          context,
        ).slice(0, 45000)}\n\nQUESTION: ${question}`,
      };

      const { chatComplete } = await import("./openai.js");
      const { text } = await chatComplete([system, user]);

      // Log reply
      await logEvent(supabase, sessionId, "assistant", text, "research");

      res.json({ reply: text });
    } catch (e) {
      logger?.error({ err: e }, "papers.ask");
      res.status(500).json({ error: "Ask failed" });
    }
  });

  /** --- FORMAT CITATION --- */
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

      const toHarvard = (m) =>
        `${m.author} (${m.year}) ${m.title}. ${m.venue}. ${
          cleanDoi(m.doi) || m.url
        }`.replace(/\s+\./g, ".");

      const toVancouver = (m) =>
        `${m.author}. ${m.title}. ${m.venue}. ${m.year}. ${cleanDoi(
          m.doi,
        )}`.replace(/\s+\./g, ".");

      const harvard = toHarvard(m);
      const vancouver = toVancouver(m);

      res.json({
        harvard,
        vancouver,
        formatted: style === "vancouver" ? vancouver : harvard,
      });
    } catch (e) {
      logger?.error({ err: e }, "papers.cite");
      res.status(500).json({ error: "Cite failed" });
    }
  });

  /** --- PROXY PDF DOWNLOAD --- */
  app.get("/api/pdf-proxy", async (req, res) => {
    try {
      const raw = String(req.query.url || "");
      if (!/^https:\/\//i.test(raw))
        return res.status(400).json({ error: "Invalid URL" });

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
