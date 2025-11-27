// server/lectures.js
import crypto from "crypto";

export function registerLectureRoutes(app, supabase, logger) {
  const mem = { artifacts: [] };

  // ---------- Utility helpers ----------
  async function insertArtifact(row) {
    if (!supabase) {
      const id = mem.artifacts.length + 1;
      mem.artifacts.push({ id, created_at: new Date().toISOString(), ...row });
      return { data: { id } };
    }
    const { data, error } = await supabase
      .from("artifacts")
      .insert(row)
      .select("id")
      .single();
    if (error) throw error;
    return { data };
  }

  async function listArtifacts(sessionId) {
    if (!supabase) {
      return mem.artifacts
        .filter((a) => a.session_id === sessionId && a.kind === "lecture")
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    const { data, error } = await supabase
      .from("artifacts")
      .select("id, created_at, title, meta")
      .eq("session_id", sessionId)
      .eq("kind", "lecture")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  }

  async function getArtifact(id) {
    if (!supabase) {
      const row = mem.artifacts.find((a) => String(a.id) === String(id));
      if (!row) throw new Error("Not found");
      return row;
    }
    const { data, error } = await supabase
      .from("artifacts")
      .select("*")
      .eq("id", id)
      .single();
    if (error) throw error;
    return data;
  }

  async function logChat(sessionId, role, content) {
    if (!supabase) return;
    try {
      await supabase
        .from("chat_events")
        .insert({ session_id: sessionId, role, content, channel: "lecture" });
    } catch (e) {
      logger?.warn({ err: e }, "chat_events.insert.failed");
    }
  }

  async function checkLocked(sessionId) {
    if (!supabase) return false;
    try {
      const { data } = await supabase
        .from("sessions")
        .select("submitted_at")
        .eq("id", sessionId)
        .single();
      return !!data?.submitted_at;
    } catch {
      return false;
    }
  }

  async function runChat(question, context, sessionId) {
    const { chatComplete } = await import("./openai.js");
    const { toBulletsOnly } = await import("./util.js").then((m) => m);

    const system = {
      role: "system",
      content:
        "You are Wurksy (amber-mode). Answer in concise bullet points grounded ONLY in the lecture notes provided.",
    };
    const user = {
      role: "user",
      content: `LECTURE NOTES (truncated):\n\n${context}\n\nQUESTION: ${question}`,
    };

    await logChat(sessionId, "user", user.content);
    const { text } = await chatComplete([system, user]);
    const reply = toBulletsOnly ? toBulletsOnly(text) : text;
    await logChat(sessionId, "assistant", reply);
    return reply;
  }

  // ---------- Routes ----------
  // Save extracted lecture
  app.post("/api/lectures/save", async (req, res) => {
    try {
      const { sessionId, title, pages } = req.body || {};
      if (!sessionId)
        return res.status(400).json({ error: "Missing sessionId" });
      if (!title) return res.status(400).json({ error: "Missing title" });
      if (!Array.isArray(pages) || !pages.length)
        return res.status(400).json({ error: "Missing pages" });

      const content = pages.map((p) => `# Page ${p.n}\n${p.text}`).join("\n\n");
      const meta = {
        pagesCount: pages.length,
        bytes: Buffer.byteLength(content, "utf8"),
      };

      const { data } = await insertArtifact({
        session_id: sessionId,
        kind: "lecture",
        title,
        meta,
        content,
      });

      res.json({ ok: true, id: data.id });
    } catch (e) {
      logger?.error({ err: e }, "lecture.save");
      res.status(500).json({ error: e.message });
    }
  });

  // List user’s lectures
  app.get("/api/lectures/list", async (req, res) => {
    try {
      const sessionId = req.query.sessionId || "";
      if (!sessionId) return res.json({ items: [] });
      const items = await listArtifacts(sessionId);
      res.json({ items });
    } catch (e) {
      logger?.error({ err: e }, "lecture.list");
      res.status(500).json({ error: e.message });
    }
  });

  // Get a lecture’s full content
  app.get("/api/lectures/:id", async (req, res) => {
    try {
      const item = await getArtifact(req.params.id);
      res.json({ item });
    } catch (e) {
      logger?.error({ err: e }, "lecture.get");
      res.status(404).json({ error: e.message || "Not found" });
    }
  });

  // Ask about one lecture
  app.post("/api/lectures/ask", async (req, res) => {
    try {
      const { sessionId, lectureId, question } = req.body || {};
      if (!sessionId)
        return res.status(400).json({ error: "Missing sessionId" });
      if (!lectureId)
        return res.status(400).json({ error: "Missing lectureId" });
      if (!question) return res.status(400).json({ error: "Missing question" });

      if (await checkLocked(sessionId))
        return res.status(423).json({ error: "This assignment is locked." });

      const row = await getArtifact(lectureId);
      const context = String(row.content || "").slice(0, 12000);
      const reply = await runChat(question, context, sessionId);
      res.json({ reply });
    } catch (e) {
      logger?.error({ err: e }, "lecture.ask");
      res.status(500).json({ error: e.message });
    }
  });

  // Ask across multiple lectures
  app.post("/api/lectures/ask-multi", async (req, res) => {
    try {
      const { sessionId, lectureIds, question } = req.body || {};
      if (!sessionId)
        return res.status(400).json({ error: "Missing sessionId" });
      if (!Array.isArray(lectureIds) || !lectureIds.length)
        return res.status(400).json({ error: "Missing lectureIds" });
      if (!question) return res.status(400).json({ error: "Missing question" });

      if (await checkLocked(sessionId))
        return res.status(423).json({ error: "This assignment is locked." });

      const joinedTexts = [];
      for (const id of lectureIds) {
        const row = await getArtifact(id);
        if (row?.content) joinedTexts.push(row.content);
      }

      const combined = joinedTexts.join("\n\n---\n\n").slice(0, 16000);
      const reply = await runChat(question, combined, sessionId);
      res.json({ reply });
    } catch (e) {
      logger?.error({ err: e }, "lecture.ask-multi");
      res.status(500).json({ error: e.message });
    }
  });
}
