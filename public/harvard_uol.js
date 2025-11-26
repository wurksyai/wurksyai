// public/harvard_uol.js
// University of Leicester Author–Date (Harvard) formatter (practical subset)
// Access date: uses user's current date; override via opts.accessDate = "10 May 2026"

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function todayLongUK() {
  const d = new Date();
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function norm(s) {
  return (s || "").toString().trim();
}
function withPeriod(s) {
  return s ? (/\.\s*$/.test(s) ? s : `${s}.`) : "";
}
function ital(s) {
  return s ? `*${s}*` : "";
} // Research view renders markdown to plain; italics kept in text

// ---- Formatters by type ----
// Expected meta fields (safely ignored if missing):
//  - author (string like "Smith, J., Doe, A.")
//  - year (YYYY or "n.d.")
//  - title
//  - journal / venue
//  - volume, issue, pages
//  - edition, place, publisher
//  - doi, url
//  - editors, chapter, confName, thesisType, org, reportNo

function fmtJournalOnline(m) {
  const a = norm(m.author),
    y = norm(m.year) || "n.d.",
    t = norm(m.title);
  const j = norm(m.journal || m.venue);
  const vol = norm(m.volume),
    iss = norm(m.issue),
    pp = norm(m.pages);
  const doi = norm(m.doi),
    url = norm(m.url);
  const tail = doi
    ? `Available at: https://doi.org/${doi}`
    : url
      ? `Available at: ${url}`
      : "";
  const volIssue = vol && iss ? `${vol}(${iss})` : vol || iss || "";
  const pages = pp ? `, pp. ${pp}` : "";
  const parts = [
    `${a} (${y}) ${t}.`,
    j ? `${ital(j)}, ${volIssue}${pages}.` : "",
    tail ? `${tail}.` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function fmtJournalPrint(m) {
  const a = norm(m.author),
    y = norm(m.year) || "n.d.",
    t = norm(m.title);
  const j = norm(m.journal || m.venue);
  const vol = norm(m.volume),
    iss = norm(m.issue),
    pp = norm(m.pages);
  const volIssue = vol && iss ? `${vol}(${iss})` : vol || iss || "";
  const pages = pp ? `, pp. ${pp}` : "";
  const parts = [
    `${a} (${y}) ${t}.`,
    j ? `${ital(j)}, ${volIssue}${pages}.` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function fmtBook(m) {
  const a = norm(m.author),
    y = norm(m.year) || "n.d.",
    t = norm(m.title);
  const ed = norm(m.edition);
  const place = norm(m.place),
    pub = norm(m.publisher);
  const edPart = ed && !/^1(st)?$/i.test(ed) ? `${ed} edn.` : ""; // first ed. omitted
  const parts = [
    `${a} (${y}) ${ital(t)}.`,
    edPart,
    [place, pub].filter(Boolean).join(": ") + ".",
  ].filter(Boolean);
  return parts.join(" ");
}

function fmtChapter(m) {
  const a = norm(m.author),
    y = norm(m.year) || "n.d.",
    ch = norm(m.chapter || m.title);
  const eds = norm(m.editors);
  const book = norm(m.bookTitle || m.containerTitle);
  const place = norm(m.place),
    pub = norm(m.publisher);
  const pp = norm(m.pages);
  const inPart = eds ? `In: ${eds} (eds) ${ital(book)}.` : `In: ${ital(book)}.`;
  const ppPart = pp ? ` pp. ${pp}.` : ".";
  const tail = [place, pub].filter(Boolean).join(": ");
  return `${a} (${y}) ${ch}. ${inPart} ${tail}.${ppPart}`;
}

function fmtWebsite(m, accessDate) {
  const a = norm(m.author) || norm(m.org) || "";
  const y = norm(m.year) || "n.d.";
  const t = norm(m.title);
  const url = norm(m.url);
  const acc = accessDate || todayLongUK();
  const parts = [
    a ? `${a} (${y}) ${ital(t)}.` : `${ital(t)} (${y}).`,
    url ? `Available at: ${url}.` : "",
    `Accessed: ${acc}.`,
  ].filter(Boolean);
  return parts.join(" ");
}

function fmtReport(m, accessDate) {
  const a = norm(m.author) || norm(m.org) || "";
  const y = norm(m.year) || "n.d.";
  const t = norm(m.title);
  const rn = norm(m.reportNo);
  const url = norm(m.url);
  const acc = accessDate || todayLongUK();
  const rnPart = rn ? ` (${rn})` : "";
  const parts = [
    `${a} (${y}) ${ital(t)}${rnPart}.`,
    url ? `Available at: ${url}.` : "",
    `Accessed: ${acc}.`,
  ].filter(Boolean);
  return parts.join(" ");
}

function fmtThesis(m) {
  const a = norm(m.author),
    y = norm(m.year) || "n.d.";
  const t = norm(m.title),
    type = norm(m.thesisType) || "Thesis";
  const inst = norm(m.org || m.institution || m.venue);
  return `${a} (${y}) ${ital(t)}. ${type}. ${inst}.`;
}

function fmtConference(m) {
  const a = norm(m.author),
    y = norm(m.year) || "n.d.";
  const t = norm(m.title),
    conf = norm(m.confName || m.venue);
  const loc = norm(m.place),
    pp = norm(m.pages);
  const ppPart = pp ? `, pp. ${pp}.` : ".";
  return `${a} (${y}) ${t}. In: ${ital(conf)}. ${withPeriod([loc].filter(Boolean).join(""))}${ppPart}`;
}

function fmtPreprint(m, accessDate) {
  const a = norm(m.author),
    y = norm(m.year) || "n.d.";
  const t = norm(m.title);
  const repo = norm(m.venue) || "preprint";
  const doi = norm(m.doi),
    url = norm(m.url);
  const acc = accessDate || todayLongUK();
  const where = doi ? `https://doi.org/${doi}` : url;
  const tail = where ? `Available at: ${where}.` : "";
  return `${a} (${y}) ${t}. ${ital(repo)}. ${tail} Accessed: ${acc}.`;
}

// ---- Router ----
export function formatHarvardUoL(meta, opts = {}) {
  const accessDate = opts.accessDate || todayLongUK();
  const t = (opts.type || meta.type || "").toLowerCase();

  // crude type inference if not provided:
  const hasJournal = !!(meta.journal || meta.venue);
  const hasVolIssue = meta.volume || meta.issue;
  const doi = meta.doi;

  let out;
  if (t === "book") out = fmtBook(meta);
  else if (t === "chapter") out = fmtChapter(meta);
  else if (t === "thesis") out = fmtThesis(meta);
  else if (t === "conference") out = fmtConference(meta);
  else if (t === "report") out = fmtReport(meta, accessDate);
  else if (t === "website" || (!hasJournal && meta.url && !doi))
    out = fmtWebsite(meta, accessDate);
  else if (
    t === "preprint" ||
    /arxiv|medrxiv|biorxiv/i.test(meta.venue || meta.url || "")
  )
    out = fmtPreprint(meta, accessDate);
  else if (hasJournal)
    out = doi ? fmtJournalOnline(meta) : fmtJournalPrint(meta);
  else out = fmtWebsite(meta, accessDate); // last resort

  return out.replace(/\s+/g, " ").replace(/\s+\./g, ".").trim();
}
