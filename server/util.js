// server/util.js
// Shared helpers for formatting & storage

// --- Markdown → clean bullets (no **, no #, no leading/trailing noise)
export function markdownToBullets(md) {
  if (!md) return "•";
  const raw = String(md).replace(/\r/g, "");
  const lines = raw.split("\n");

  const out = [];
  for (let line of lines) {
    let s = line.trim();

    // strip markdown headings/emphasis/quote ticks
    s = s.replace(/^#{1,6}\s*/, ""); // # Heading
    s = s.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1"); // **bold** / *em*
    s = s.replace(/^>\s?/, ""); // blockquote
    s = s.replace(/`{1,3}([^`]+)`{1,3}/g, "$1"); // inline code

    // merge numbered/asterisk lists into bullets
    s = s.replace(/^\d+\.\s+/, ""); // "1. "
    s = s.replace(/^[\-*•]\s+/, ""); // "-", "*", "•"

    if (s.length === 0) continue;
    out.push(`• ${s}`);
  }

  return out.length ? out.join("\n") : "•";
}

// Keep (legacy) bullets-only compatibility
export function toBulletsOnly(text) {
  return markdownToBullets(text);
}

// Chronological normalisation for AI Index
export function normaliseEvents(events) {
  return (events || [])
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map((e, i) => ({
      seq: e.seq ?? i + 1,
      role: e.role,
      content: e.content,
      tokens: e.tokens ?? null,
      at: new Date(e.created_at || Date.now()).toISOString(),
    }));
}

// Simple amber-mode guardrails
const BLOCK_LIST = [
  /write (?:my|the) (?:essay|assignment|report)\b/i,
  /\bghost[-\s]?write\b/i,
  /\bhumanis(e|ing|ed)\b/i,
  /\bparaphras(e|ing|ed) to avoid detection\b/i,
  /\bmake it undetectable\b/i,
  /\bspin (?:this|the) text\b/i,
  /\bdo my homework\b/i,
];

export function violatesAmberPolicy(message) {
  if (!message) return false;
  const m = String(message);
  return BLOCK_LIST.some((re) => re.test(m));
}

// Trim oversized prompts
export function trimMessage(message, cap = 4000) {
  const s = String(message || "");
  return s.length > cap ? s.slice(0, cap) : s;
}
