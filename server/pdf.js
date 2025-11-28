// server/pdf.js
import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";

// Format UK datetime
function formatUK(dt) {
  try {
    return new Date(dt).toLocaleString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dt;
  }
}

// Section title helper
function section(doc, title) {
  doc.moveDown(1);
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .text(title, { underline: true, align: "left" });
  doc.moveDown(0.5);
}

// Paragraph helper
function para(doc, text) {
  doc.font("Helvetica").fontSize(11).text(text, { align: "left" });
}

// Bullet helper (keeps bullets clean)
function bullets(doc, lines) {
  if (!lines) return;
  const arr = Array.isArray(lines) ? lines : String(lines).split(/\r?\n/);
  arr.forEach((l) => {
    const t = l.replace(/^[•\-]\s?/, "").trim();
    if (t) doc.text("• " + t, { indent: 15 });
  });
  doc.moveDown(0.1);
}

// Determines if role is "user" or "assistant"
function nameFromRole(role) {
  if (role === "assistant") return "Wurksy AI";
  if (role === "system") return "System";
  return "Student";
}

// Extract lecture name
function extractLectureName(e) {
  return e?.meta?.lecture_name || e?.meta?.filename || null;
}

// Extract research click info
function extractResearchClick(e) {
  return e?.meta?.title || e?.meta?.doi || null;
}

export async function buildAiIndex({ session, events }) {
  // Create PDF
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const chunks = [];
  const done = new Promise((resolve) =>
    doc.on("end", () => resolve(Buffer.concat(chunks))),
  );
  doc.on("data", (c) => chunks.push(c));

  // --- LOGO ---
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const logoPath = path.join(__dirname, "../public/logo.svg");
    doc.image(logoPath, { width: 80, align: "center" });
  } catch {}

  // --- TITLE ---
  doc.moveDown(1);
  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .text("Wurksy AI Index", { align: "center", underline: true });
  doc.moveDown(0.5);

  // --- META ---
  para(doc, `Generated: ${formatUK(Date.now())}`);
  if (session?.locked_at)
    para(doc, `Submitted: ${formatUK(session.locked_at)}`);
  doc.moveDown(1);

  // --- DECLARATION BOX ---
  section(doc, "Academic Integrity Declaration (Optional)");
  para(
    doc,
    "If you used any additional AI tools outside Wurksy (e.g. Grammarly, summarisation tools), declare them here:",
  );
  doc.moveDown(0.5);
  doc.rect(doc.x, doc.y, 500, 60).stroke();
  doc.moveDown(2.5);

  // --------------------------------------------------------------
  // 🔥 INTEGRATED TIMELINE
  // --------------------------------------------------------------
  section(doc, "Full Session Timeline");

  // Ensure chronological
  const ordered = [...(events || [])].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at),
  );

  let currentLecture = null;
  let currentResearchSearch = null;

  ordered.forEach((e) => {
    const ts = formatUK(e.created_at);
    const speaker = nameFromRole(e.role);

    // ----- LECTURE UPLOAD EVENT -----
    if (e.channel === "lecture_upload") {
      const name = extractLectureName(e);
      currentLecture = name;
      doc.moveDown(0.8);
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .text(`Lecture Uploaded: ${name}`, { align: "left" });
      para(doc, `Time: ${ts}`);
      doc.moveDown(0.5);
      return;
    }

    // ----- LECTURE Q&A -----
    if (e.channel === "lecture") {
      const name = extractLectureName(e) || currentLecture;
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(12).text(`Lecture Q&A — ${name}`);
      doc.font("Helvetica-Bold").fontSize(10).text(`${speaker} — ${ts}`);
      bullets(doc, e.content);
      return;
    }

    // ----- RESEARCH SEARCH -----
    if (e.channel === "research_search") {
      currentResearchSearch = e.content;
      doc.moveDown(0.6);
      doc.font("Helvetica-Bold").fontSize(12).text("Research Search");
      para(doc, `Query: ${e.content}`);
      para(doc, `Time: ${ts}`);
      return;
    }

    // ----- RESEARCH CLICK -----
    if (e.channel === "research_click") {
      const clicked = extractResearchClick(e);
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(12).text("Research Item Opened");
      para(doc, `Paper: ${clicked}`);
      para(doc, `Time: ${ts}`);
      return;
    }

    // ----- GENERAL CHAT -----
    if (e.channel === "chat") {
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(10).text(`${speaker} — ${ts}`);
      bullets(doc, e.content);
    }
  });

  // --------------------------------------------------------------
  // 🔥 LECTURE SUMMARY SECTION
  // --------------------------------------------------------------
  section(doc, "Lecture Summaries");

  const lectureGroups = {};
  ordered.forEach((e) => {
    if (e.channel === "lecture") {
      const name = extractLectureName(e) || "Lecture";
      if (!lectureGroups[name]) lectureGroups[name] = [];
      lectureGroups[name].push(e.content);
    }
  });

  if (Object.keys(lectureGroups).length === 0) {
    para(doc, "No lecture interactions recorded.");
  } else {
    for (const [name, arr] of Object.entries(lectureGroups)) {
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(12).text(name);
      let combined = arr.join(" ");
      para(doc, `Summary:`);
      bullets(doc, combined);
    }
  }

  // --------------------------------------------------------------
  // 🔥 RESEARCH SUMMARY SECTION
  // --------------------------------------------------------------
  section(doc, "Research Activity");

  const researchLogs = ordered.filter((e) =>
    ["research_search", "research_click"].includes(e.channel),
  );

  if (researchLogs.length === 0) {
    para(doc, "No research interactions recorded.");
  } else {
    researchLogs.forEach((e) => {
      const ts = formatUK(e.created_at);

      if (e.channel === "research_search") {
        doc.font("Helvetica-Bold").fontSize(12).text("Search Performed");
        para(doc, `Query: ${e.content}`);
        para(doc, `Time: ${ts}`);
        doc.moveDown(0.5);
      }

      if (e.channel === "research_click") {
        const clicked = extractResearchClick(e);
        doc.font("Helvetica-Bold").fontSize(12).text("Paper Opened");
        para(doc, `Paper: ${clicked}`);
        para(doc, `Time: ${ts}`);
        doc.moveDown(0.5);
      }
    });
  }

  doc.end();
  return done;
}
