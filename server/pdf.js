// server/pdf.js
import PDFDocument from "pdfkit";
import { sha256 } from "./hash.js";
import { toBulletsOnly } from "./util.js";

function section(doc, title) {
  doc.moveDown(0.7);
  doc.font("Helvetica-Bold").fontSize(13).text(title, { underline: false });
  doc.moveDown(0.3);
}

function para(doc, text) {
  doc.font("Helvetica").fontSize(10).text(text);
}

function bullets(doc, text) {
  const cleaned = toBulletsOnly(text || "");
  cleaned.split(/\r?\n/).forEach((line) => {
    const m = line.replace(/^\s*[-•]?\s?/, "").trim();
    if (!m) return;
    doc.text(`• ${m}`, { indent: 10 });
  });
}

export async function buildAiIndex({ session, events }) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const chunks = [];
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  doc.on("data", (c) => chunks.push(c));

  // Header
  doc.font("Helvetica-Bold").fontSize(18).text("Wurksy AI Index", { align: "center" });
  doc.moveDown(0.5);
  doc.font("Helvetica").fontSize(10);
  para(doc, `Session: ${session?.id || session?.session_id || "unknown"}`);
  para(doc, `Created: ${new Date().toISOString()}`);
  if (session?.submitted_at) para(doc, `Submitted: ${session.submitted_at}`);

  // Declaration (if any)
  if (session?.declaration) {
    section(doc, "Declaration");
    const d = session.declaration || {};
    bullets(
      doc,
      [
        d.wurksy_only ? "I used only Wurksy (except basic tools like Grammarly/Canva)" : "",
        d.no_ghost ? "I did not copy, paraphrase or ‘humanise’ AI text" : "",
        d.own_work ? "The final submission is my own work" : "",
        d.understood ? "I understand non-compliance may be academic malpractice" : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  // Group events by channel
  const by = { chat: [], lecture: [], research: [] };
  (events || []).forEach((e) => {
    const channel = e.channel || "chat";
    by[channel]?.push(e);
  });

  // Render helper
  const renderChannel = (label, arr) => {
    if (!arr.length) return;
    section(doc, label);
    arr.forEach((e) => {
      doc.font("Helvetica-Bold").fontSize(10).text(`${e.at} — ${e.role.toUpperCase()}`);
      doc.font("Helvetica").fontSize(10);
      bullets(doc, e.content || "");
      doc.moveDown(0.2);
    });
  };

  renderChannel("Chat", by.chat);
  renderChannel("Lectures Q&A", by.lecture);
  renderChannel("Research Q&A", by.research);

  // Footer hash
  const serial = JSON.stringify({ sessionId: session?.id || session?.session_id, events });
  const hash = await sha256(serial);
  doc.moveDown(0.8).font("Courier").fontSize(9).text(`SHA-256: ${hash}`);

  doc.end();
  return done;
}
