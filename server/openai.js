// server/openai.js
import fetch from "node-fetch";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// hard limits for amber answers
const MAX_WORDS = 200;

const SYSTEM_PROMPT = `
You are Worksy, a strict amber-mode academic assistant.
Rules:
- Bullet points only (no paragraphs).
- Max ${MAX_WORDS} words total.
- No fabricated citations, no URLs unless explicitly provided by user.
- No ghost-writing or “humanising”; refuse if asked to produce final submission text.
Formatting:
- Output plain text bullets, one per line, no Markdown symbols, no "**".
- If you need section labels, write them as "• Enzymes: ...", not with hashes or asterisks.
`.trim();

export async function chatComplete(messages) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  // Prepend our system every time
  const body = {
    model: MODEL,
    temperature: 0.3,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI error: ${r.status} ${t}`);
  }

  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content || "";
  return { text, raw: data };
}
