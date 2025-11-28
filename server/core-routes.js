// server/core-routes.js
import { chatComplete } from "./openai.js";
import { buildAiIndex } from "./pdf.js";
import { searchCrossref, searchOpenAlex } from "./research.js";

/**
 * Register core API routes:
 * - /health
 * - /api/config
 * - /api/start
 * - /api/session-meta
 * - /api/chat
 * - /api/chat/history
 * - /api/research  (legacy search)
 * - /api/ai-index
 * - /api/submit
 */
export function registerCoreRoutes(app, deps) {
  const {
    supabase,
    logger,
    PROMPT_CAP,
    uploadAndSign,
    chatLimiter,
    markdownToBullets,
    violatesAmberPolicy,
    trimMessage,
    sessionHelpers,
  } = deps;

  const {
    pickSessionId,
    getSessionRow,
    logEvent,
    countUserPrompts,
    createSessionRow,
    getCapForSession,
  } = sessionHelpers;

  // ---------- BASIC ----------
  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/api/config", (_req, res) =>
    res.json({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      cap: PROMPT_CAP,
      supabase: Boolean(supabase),
    }),
  );

  // ---------- START SESSION ----------
  app.post("/api/start", async (req, res, next) => {
    try {
      const {
        mode,
        assignmentCode,
        assignmentId, // allow "assignmentId" from front-end
        studentId,
        moduleCode,
      } = req.body || {};

      const shortCode = assignmentCode || assignmentId || null;

      let assignmentRow = null;
      const extra = {};

      if (mode) extra.mode = mode;

      if (supabase && shortCode) {
        const { data, error } = await supabase
          .from("assignments")
          .select("*")
          .eq("short_code", shortCode)
          .maybeSingle();

        if (error) throw error;

        assignmentRow = data || null;

        if (assignmentRow) {
          extra.assignment_id = assignmentRow.id;
          extra.assignment_code = assignmentRow.short_code;
          extra.student_module =
            moduleCode || assignmentRow.module_code || null;

          extra.assignment_snapshot = {
            module_code: assignmentRow.module_code,
            title: assignmentRow.title,
            brief: assignmentRow.brief,
            deadline: assignmentRow.deadline,
            prompt_cap: assignmentRow.prompt_cap,
          };
        }
      }

      if (studentId) extra.student_id = studentId;
      if (!extra.student_module && moduleCode)
        extra.student_module = moduleCode;

      const row = await createSessionRow(extra);
      const sessionId = pickSessionId(row);
      const cap = assignmentRow?.prompt_cap || PROMPT_CAP;

      res.json({
        sessionId,
        mode: row?.mode ?? mode ?? "guest",
        cap,
      });
    } catch (e) {
      next(e);
    }
  });

  // ---------- SESSION META ----------
  app.get("/api/session-meta", async (req, res, next) => {
    try {
      const { sessionId } = req.query || {};
      if (!sessionId)
        return res.status(400).json({ error: "sessionId required" });
      if (!supabase)
        return res.status(500).json({ error: "Supabase not configured" });

      const session = await getSessionRow(sessionId);
      if (!session) return res.status(404).json({ error: "Session not found" });

      let assignment = null;

      if (session.assignment_id) {
        const { data, error } = await supabase
          .from("assignments")
          .select("*")
          .eq("id", session.assignment_id)
          .maybeSingle();

        if (error) throw error;
        assignment = data || null;
      }

      const used = await countUserPrompts(sessionId);

      res.json({
        session: {
          id: pickSessionId(session),
          mode: session.mode ?? "guest",
          student_id: session.student_id ?? null,
          student_module: session.student_module ?? null,
          locked_at: session.locked_at ?? null,
          created_at: session.created_at ?? null,
          used_prompts: used,
          declaration: session.declaration ?? null,
        },
        assignment: assignment
          ? {
              id: assignment.id,
              short_code: assignment.short_code,
              module_code: assignment.module_code,
              title: assignment.title,
              brief: assignment.brief,
              deadline: assignment.deadline,
              prompt_cap: assignment.prompt_cap,
              recommended_pdfs: assignment.recommended_pdfs ?? null,
            }
          : null,
      });
    } catch (e) {
      next(e);
    }
  });

  // ---------- CHAT (channel-aware) ----------
  app.post("/api/chat", chatLimiter, async (req, res, next) => {
    try {
      const { sessionId, message, channel: rawChannel } = req.body || {};

      if (!sessionId)
        return res.status(400).json({ error: "Missing sessionId" });
      if (!message) return res.status(400).json({ error: "Missing message" });

      // Use provided channel (e.g. "research") or default to "chat"
      const channel =
        typeof rawChannel === "string" && rawChannel.trim()
          ? rawChannel.trim()
          : "chat";

      if (supabase) {
        const row = await getSessionRow(sessionId);
        if (row?.locked_at)
          return res
            .status(423)
            .json({ error: "This assignment is submitted and locked." });
      }

      const used = await countUserPrompts(sessionId);
      const cap = await getCapForSession(sessionId);

      if (used >= cap) {
        return res.status(429).json({
          error: `Prompt cap reached (${cap}).`,
          used,
          cap,
        });
      }

      const cleaned = trimMessage(message);

      // Amber-policy guard
      if (violatesAmberPolicy(cleaned)) {
        const policyReply = [
          "• Amber-mode: I can help with bullet summaries, outlines, definitions, methods, and marking-criteria checklists.",
          "• I can’t ghost-write or ‘humanise’ AI text.",
        ].join("\n");

        await logEvent(sessionId, "user", cleaned, channel);
        await logEvent(sessionId, "assistant", policyReply, channel);

        return res.json({
          reply: policyReply,
          used: used + 1,
          cap,
        });
      }

      // Log user message
      await logEvent(sessionId, "user", cleaned, channel);

      const sys = {
        role: "system",
        content:
          "You are Wurksy. Answer ONLY in bullet points, under 200 words total. No fabricated citations. No ghost-writing. No markdown symbols.",
      };

      const { text } = await chatComplete([
        sys,
        { role: "user", content: cleaned },
      ]);

      const reply = markdownToBullets(text);

      // Log assistant reply
      await logEvent(sessionId, "assistant", reply, channel);

      res.json({ reply, used: used + 1, cap });
    } catch (e) {
      next(e);
    }
  });

  // ---------- CHAT HISTORY ----------
  app.get("/api/chat/history", async (req, res, next) => {
    try {
      const { sessionId, channel } = req.query || {};
      if (!sessionId)
        return res.status(400).json({ error: "sessionId required" });
      if (!supabase) return res.json({ events: [] });

      let q = supabase
        .from("chat_events")
        .select("role,content,channel,created_at")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true });

      if (channel) {
        q = q.eq("channel", String(channel));
      }

      const { data, error } = await q;
      if (error) throw error;

      res.json({ events: data || [] });
    } catch (e) {
      next(e);
    }
  });

  // ---------- LEGACY RESEARCH SEARCH ----------
  app.get("/api/research", async (req, res, next) => {
    try {
      const q = req.query.q || "";
      if (!q) return res.json({ items: [] });

      const [cr, oa] = await Promise.allSettled([
        searchCrossref(q, 8),
        searchOpenAlex(q, 8),
      ]);

      const items = [
        ...(cr.status === "fulfilled" ? cr.value : []),
        ...(oa.status === "fulfilled" ? oa.value : []),
      ];

      res.json({ items });
    } catch (e) {
      next(e);
    }
  });

  // ---------- AI INDEX (Unified Timeline) ----------
  app.get("/api/ai-index", async (req, res, next) => {
    try {
      const sessionId = req.query.sessionId;

      if (!sessionId)
        return res.status(400).json({ error: "sessionId required" });

      if (!supabase)
        return res.status(500).json({ error: "Supabase not configured" });

      const sessionRow = await getSessionRow(sessionId);

      const { data: chatEvents, error: chatErr } = await supabase
        .from("chat_events")
        .select("*")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true });

      if (chatErr) throw chatErr;

      const { data: artEvents, error: artErr } = await supabase
        .from("artifacts")
        .select("id, session_id, kind, title, meta, created_at")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true });

      if (artErr) throw artErr;

      const artifactEvents = (artEvents || []).map((a) => ({
        role: "system",
        channel:
          a.kind === "lecture"
            ? "lecture_upload"
            : a.kind === "research"
              ? "research_artifact"
              : "artifact",
        content: a.title || "",
        meta: a.meta || {},
        created_at: a.created_at,
      }));

      const fullEvents = [...chatEvents, ...artifactEvents].sort(
        (a, b) => new Date(a.created_at) - new Date(b.created_at),
      );

      const pdfBuffer = await buildAiIndex({
        session: sessionRow,
        events: fullEvents,
      });

      const pathKey = `${sessionId}/ai-index-${Date.now()}.pdf`;

      const url = await uploadAndSign(
        supabase,
        pathKey,
        pdfBuffer,
        "application/pdf",
      );

      res.json({ url });
    } catch (e) {
      next(e);
    }
  });

  // ---------- SUBMIT & LOCK ----------
  app.post("/api/submit", async (req, res, next) => {
    try {
      const { sessionId, declaration } = req.body || {};

      if (!sessionId)
        return res.status(400).json({ error: "Missing sessionId" });

      const lockedAt = new Date().toISOString();
      let updated = null;

      if (supabase) {
        // Try updating by id
        let r = await supabase
          .from("sessions")
          .update({ locked_at: lockedAt, declaration: declaration ?? null })
          .eq("id", sessionId)
          .select("*")
          .maybeSingle();

        if (r?.data) updated = r.data;

        // Try updating by session_id
        if (!updated) {
          r = await supabase
            .from("sessions")
            .update({ locked_at: lockedAt, declaration: declaration ?? null })
            .eq("session_id", sessionId)
            .select("*")
            .maybeSingle();
          if (r?.data) updated = r.data;
        }

        // If no update worked, store a fallback artifact
        if (!updated) {
          await supabase.from("artifacts").insert({
            session_id: sessionId,
            kind: "submission",
            title: "AI Index submitted",
            meta: { locked_at: lockedAt, declaration: declaration ?? null },
            content: null,
          });
        }
      }

      res.json({ ok: true, locked_at: lockedAt });
    } catch (e) {
      next(e);
    }
  });
}
