// server/lectures.js
import crypto from "crypto";

export function registerLectureRoutes(app, supabase, logger) {
  const mem = { artifacts: [] };

  // ---------- Utility helpers ----------
  async function insertArtifact(row) {
    if (!supabase) {
      const id = mem.artifacts.length + 1;
      mem.artifacts.push({
        id,
        created_at: new Date().toISOString(),
        ...row,
      });
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

  // Log into chat_events
  async function logLectureEvent(
    sessionId,
    role,
    content,
    channel = "lecture",
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
      logger?.warn({ err: e }, "lecture.chat_events.insert.failed");
    }
  }

  // Check locked session
  async function checkLocked(sessionId) {
    if (!supabase) return false;

    try {
      const { data } = await supabase
        .from("sessions")
        .select("locked_at")
        .eq("id", sessionId)
        .maybeSingle();

      return !!data?.locked_at;
    } catch {
      return false;
    }
  }

  // Run a lecture-based chat (single or multi)
  async function runChat(question, context, sessionId, lectureMeta = {}) {
    const { chatComplete } = await import("./openai.js");
    const { toBulletsOnly } = await import("./util.js").then((m) => m);

    const system = {
      role: "system",
      content:
        "You are Wurksy (amber-mode). Answer ONLY in concise bullet points grounded strictly in the lecture content provided.",
    };

    const user = {
      role: "user",
      content: `LECTURE CONTENT (truncated):\n\n${context}\n\nQUESTION: ${question}`,
    };

    // Log user question
    await logLectureEvent(sessionId, "user", user.content, "lecture", {
      ...lectureMeta,
      direction: "user",
    });

    // Generate reply
    const { text } = await chatComplete([system, user]);
    const reply = toBulletsOnly ? toBulletsOnly(text) : text;

    // Log assistant reply
    await logLectureEvent(sessionId, "assistant", reply, "lecture", {
      ...lectureMeta,
      direction: "assistant",
    });

    return reply;
  }

  // ---------- Parse PPTX ----------
  async function extractPptxSlides(buffer) {
    // lightweight placeholder parsing
    // (You can later upgrade this to a proper PPTX XML parser)
    return [
      {
        n: 1,
        text: "PPTX parsing placeholder — slide text extraction not implemented.",
      },
    ];
  }

  // ---------- ROUTES ----------

  // Save extracted lecture (PDF or PPTX)
  app.post("/api/lectures/save", async (req, res) => {
    try {
      const { sessionId, title, pages, pptxBase64 } = req.body || {};

      if (!sessionId)
        return res.status(400).json({ error: "Missing sessionId" });
      if (!title) return res.status(400).json({ error: "Missing title" });

      if (await checkLocked(sessionId))
        return res.status(423).json({ error: "This assignment is locked." });

      // ---- PDF upload (client already extracted pages) ----
      if (Array.isArray(pages)) {
        const content = pages
          .map((p) => `# Page ${p.n}\n${p.text}`)
          .join("\n\n");

        const meta = {
          type: "pdf",
          pagesCount: pages.length,
          lecture_name: title,
        };

        // Save artifact
        const { data } = await insertArtifact({
          session_id: sessionId,
          kind: "lecture",
          title,
          meta,
          content,
        });

        // Also log event for AI Index timeline
        await logLectureEvent(
          sessionId,
          "system",
          `Lecture uploaded: ${title} (${pages.length} pages)`,
          "lecture_upload",
          meta,
        );

        return res.json({ ok: true, id: data.id });
      }

      // ---- PPTX upload (still placeholder text extraction) ----
      if (pptxBase64) {
        const buffer = Buffer.from(pptxBase64, "base64");

        const slides = await extractPptxSlides(buffer);
        const content = slides
          .map((s) => `# Slide ${s.n}\n${s.text}`)
          .join("\n\n");

        const meta = {
          type: "pptx",
          slidesCount: slides.length,
          pagesCount: slides.length,
          lecture_name: title,
        };

        const { data } = await insertArtifact({
          session_id: sessionId,
          kind: "lecture",
          title,
          meta,
          content,
          pptx_buffer: buffer,
        });

        await logLectureEvent(
          sessionId,
          "system",
          `Lecture uploaded: ${title} (${slides.length} slides)`,
          "lecture_upload",
          meta,
        );

        return res.json({ ok: true, id: data.id });
      }

      return res.status(400).json({ error: "No PDF or PPTX data provided." });
    } catch (e) {
      logger?.error({ err: e }, "lecture.save");
      res.status(500).json({ error: e.message });
    }
  });

  // List lectures
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

  // Get lecture content
  app.get("/api/lectures/:id", async (req, res) => {
    try {
      const item = await getArtifact(req.params.id);
      res.json({ item });
    } catch (e) {
      logger?.error({ err: e }, "lecture.get");
      res.status(404).json({ error: e.message || "Not found" });
    }
  });

  // Q&A about one lecture
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

      const lectureMeta = {
        lecture_name: row.title || "Lecture",
        lecture_id: lectureId,
      };

      const reply = await runChat(question, context, sessionId, lectureMeta);

      res.json({ reply });
    } catch (e) {
      logger?.error({ err: e }, "lecture.ask");
      res.status(500).json({ error: e.message });
    }
  });

  // Q&A across multiple lectures
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

      const lectureMeta = {
        lecture_scope: "multi",
        lecture_ids: lectureIds,
      };

      const reply = await runChat(question, combined, sessionId, lectureMeta);

      res.json({ reply });
    } catch (e) {
      logger?.error({ err: e }, "lecture.ask-multi");
      res.status(500).json({ error: e.message });
    }
  });
}
