// server/openai.js
import fetch from "node-fetch";

const ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT; // MUST end with /
const KEY = process.env.AZURE_OPENAI_API_KEY;
const DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-5-mini";
const API_VERSION =
  process.env.AZURE_OPENAI_API_VERSION || "2025-04-01-preview";

const MAX_WORDS = 200;

const SYSTEM_PROMPT = `
You are Wurksy, a strict amber-mode academic assistant.
Rules:
- Bullet points only.
- Max ${MAX_WORDS} words total.
- No fabricated citations.
- No URLs unless user provides them.
- No ghost-writing.
Formatting:
- Plain text bullet points only.
`.trim();

export async function chatComplete(messages) {
  if (!ENDPOINT) throw new Error("Missing AZURE_OPENAI_ENDPOINT");
  if (!KEY) throw new Error("Missing AZURE_OPENAI_API_KEY");
  if (!DEPLOYMENT) throw new Error("Missing AZURE_OPENAI_DEPLOYMENT");

  const url = `${ENDPOINT}openai/deployments/${DEPLOYMENT}/chat/completions?api-version=${API_VERSION}`;

  const body = {
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    // temperature removed — Azure model only supports default
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": KEY,
    },
    body: JSON.stringify(body),
  });

  const data = await r.json();

  if (!r.ok) {
    throw new Error(
      `Azure OpenAI error ${r.status}: ${JSON.stringify(data, null, 2)}`,
    );
  }

  const text = data?.choices?.[0]?.message?.content || "";
  return { text, raw: data };
}
