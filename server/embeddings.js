import fetch from "node-fetch";

const EMB_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

export async function embedTexts(apiKey, texts) {
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
  // OpenAI expects an array of inputs, returns .data[i].embedding
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMB_MODEL,
      input: texts,
    }),
  });
  const t = await r.text();
  if (!r.ok) {
    let msg = t;
    try {
      msg = JSON.parse(t)?.error?.message || t;
    } catch {}
    throw new Error(`Embeddings error ${r.status}: ${msg}`);
  }
  const j = JSON.parse(t);
  return (j.data || []).map((d) => d.embedding);
}
