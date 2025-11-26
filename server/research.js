// server/research.js
import fetch from "node-fetch";

const TIMEOUT_MS = 10_000;
const UA = "WorksyAI/1.0 (+https://worksy.example)";

/* ---------------- Helpers ---------------- */
async function getJSON(url, accept = "application/json") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { Accept: accept, "User-Agent": UA },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const cleanStr = (s) => (s == null ? "" : String(s));
const normDoiUrl = (raw) => {
  if (!raw) return null;
  const s = String(raw).trim();
  return /^https?:\/\/doi\.org\//i.test(s) ? s : `https://doi.org/${s}`;
};

// OpenAlex abstract is inverted index: {word:[pos...],...} -> plain text
function deinvertAbstract(inv) {
  if (!inv || typeof inv !== "object") return "";
  const words = [];
  for (const [w, arr] of Object.entries(inv)) {
    for (const pos of arr) words[pos] = w;
  }
  return words.join(" ");
}

/* ---------------- Crossref ---------------- */
export async function searchCrossref(q, rows = 8) {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=${rows}`;
  const j = await getJSON(url);

  const items = (j.message?.items || []).map((it) => {
    // Authors
    const author =
      (it.author || [])
        .map((a) => [a.given, a.family].filter(Boolean).join(" "))
        .filter(Boolean)
        .join(", ") || "";

    // Year (prefer issued then created)
    const year =
      it.issued?.["date-parts"]?.[0]?.[0] ??
      it.created?.["date-parts"]?.[0]?.[0] ??
      "";

    // Venue / container/journal title
    const venue = Array.isArray(it["container-title"])
      ? it["container-title"][0] || ""
      : it["container-title"] || "";

    // Landing / DOI
    const doi = it.DOI || null;
    const doiUrl = normDoiUrl(doi);
    const landing = it.URL || doiUrl || null;

    // Try to find a direct PDF from Crossref links
    let oa_pdf = null;
    if (Array.isArray(it.link)) {
      const pdfLink = it.link.find(
        (lnk) =>
          /application\/pdf/i.test(lnk?.["content-type"] || "") &&
          cleanStr(lnk.URL).startsWith("http"),
      );
      if (pdfLink?.URL) oa_pdf = pdfLink.URL;
    }

    // Crossref doesn't carry abstracts reliably; leave null
    return {
      source: "Crossref",
      title: Array.isArray(it.title) ? it.title[0] : it.title || "",
      author,
      year: year || "",
      doi,
      url: landing,
      oa_pdf,
      abstract: null,
      venue,
    };
  });

  return items;
}

/* ---------------- OpenAlex ---------------- */
export async function searchOpenAlex(q, per_page = 8) {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per_page=${per_page}&mailto=opensource@worksy.ai`;
  const j = await getJSON(url);

  const items = (j.results || []).map((it) => {
    const authors =
      (it.authorships || [])
        .map((a) => a.author?.display_name)
        .filter(Boolean)
        .join(", ") || "";

    const venue =
      it.host_venue?.display_name ||
      it.primary_location?.source?.display_name ||
      it.primary_location?.source?.host_organization_name ||
      "";

    const doiUrl = normDoiUrl(it.doi);
    const landing =
      it.primary_location?.landing_page_url ||
      it.open_access?.oa_url ||
      it.best_oa_location?.landing_page_url ||
      doiUrl ||
      null;

    // Prefer a real PDF url where available
    const oa_pdf =
      it.primary_location?.pdf_url ||
      (it.open_access?.oa_url && /\.pdf($|\?)/i.test(it.open_access.oa_url))
        ? it.open_access.oa_url
        : it.best_oa_location?.pdf_url || null;

    // Abstract
    const abstract =
      cleanStr(deinvertAbstract(it.abstract_inverted_index)) ||
      cleanStr(it.abstract) ||
      null;

    return {
      source: "OpenAlex",
      title: it.title || "",
      author: authors,
      year: it.publication_year || "",
      doi: it.doi || null,
      url: landing,
      oa_pdf,
      abstract,
      venue,
      arxivId: it.ids?.arxiv || null,
    };
  });

  return items;
}
