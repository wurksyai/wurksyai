// server/admin.js
import archiver from "archiver";
import crypto from "crypto";

/**
 * Helper: parse date strings (YYYY-MM-DD). Returns ISO bounds or null.
 */
function parseDateBounds(from, to) {
  const clamp = (d, end = false) => {
    if (!d) return null;
    const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const iso = end
      ? `${m[1]}-${m[2]}-${m[3]}T23:59:59.999Z`
      : `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`;
    return iso;
  };
  return { fromISO: clamp(from, false), toISO: clamp(to, true) };
}

/**
 * Simple red-flag heuristics. Adjust as needed.
 */
const FLAG_RULES = [
  {
    code: "essay_request",
    re: /(write|do|draft).{0,15}\b(essay|assignment|report)\b/i,
    weight: 3,
  },
  {
    code: "humanise_ai",
    re: /(humanis|humaniz|make it sound human|bypass ai|undetectable)/i,
    weight: 3,
  },
  { code: "paraphrase", re: /\b(paraphras|rephrase|spin)\b/i, weight: 2 },
  { code: "word_count", re: /\b(\d{3,5})\s*(words|word essay)\b/i, weight: 1 },
  {
    code: "citation_fabric",
    re: /\b(make up|fabricat|invent).{0,15}\b(citation|reference)/i,
    weight: 4,
  },
  {
    code: "full_solution",
    re: /(give.*full answer|solve.*entire|complete.*assignment)/i,
    weight: 2,
  },
];

function scoreFlagsForText(text = "") {
  const hits = [];
  let score = 0;
  for (const r of FLAG_RULES) {
    const m = text.match(r.re);
    if (m) {
      hits.push(r.code);
      score += r.weight;
    }
  }
  return { score, hits: [...new Set(hits)] };
}

function summariseFlags(events = []) {
  let total = 0;
  const counts = {};
  for (const e of events) {
    if (!e || !e.content) continue;
    const { hits, score } = scoreFlagsForText(e.content);
    total += score;
    hits.forEach((h) => {
      counts[h] = (counts[h] || 0) + 1;
    });
  }
  const level =
    total >= 6 ? "high" : total >= 3 ? "medium" : total > 0 ? "low" : "none";
  return { level, totalScore: total, counts };
}

export function registerAdminRoutes(
  app,
  supabase,
  logger,
  ADMIN_KEY,
  buildAiIndex,
  normaliseEvents,
  uploadAndSign, // currently unused here but kept for future
) {
  function requireAdmin(req, res, next) {
    const key = req.query.admin_key || req.headers["x-admin-key"] || "";
    if (key !== ADMIN_KEY)
      return res.status(401).json({ error: "Unauthorised" });
    next();
  }

  /**
   * GET /api/admin/sessions
   * Query:
   *   admin_key,
   *   from=YYYY-MM-DD,
   *   to=YYYY-MM-DD,
   *   page=1,
   *   pageSize=50,
   *   q=,
   *   assignmentId=<uuid> (optional)
   */
  app.get("/api/admin/sessions", requireAdmin, async (req, res) => {
    try {
      if (!supabase)
        return res.json({ sessions: [], page: 1, pageSize: 50, total: 0 });

      const {
        from,
        to,
        page = "1",
        pageSize = "50",
        q = "",
        assignmentId,
      } = req.query || {};
      const { fromISO, toISO } = parseDateBounds(from, to);
      const pg = Math.max(1, parseInt(page, 10) || 1);
      const size = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50));

      let query = supabase
        .from("sessions")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false });

      if (fromISO) query = query.gte("created_at", fromISO);
      if (toISO) query = query.lte("created_at", toISO);
      if (assignmentId) query = query.eq("assignment_id", assignmentId);

      const fromIdx = (pg - 1) * size;
      const toIdx = fromIdx + size - 1;
      query = query.range(fromIdx, toIdx);

      const { data, error, count } = await query;
      if (error) throw error;

      let sessions = data || [];
      if (q) {
        const needle = String(q).toLowerCase();
        sessions = sessions.filter((r) => {
          const idStr = String(r.id || r.session_id || "").toLowerCase();
          const studentStr = String(r.student_id || "").toLowerCase();
          const moduleStr = String(r.student_module || "").toLowerCase();
          const assignmentCodeStr = String(
            r.assignment_code || "",
          ).toLowerCase();
          return (
            idStr.includes(needle) ||
            studentStr.includes(needle) ||
            moduleStr.includes(needle) ||
            assignmentCodeStr.includes(needle)
          );
        });
      }

      const mapped = sessions.map((row) => ({
        id: row.id || row.session_id,
        created_at: row.created_at,
        mode: row.mode ?? "guest",
        locked_at: row.locked_at ?? null,
        student_id: row.student_id ?? null,
        student_module: row.student_module ?? null,
        assignment_id: row.assignment_id ?? null,
        assignment_code: row.assignment_code ?? null,
      }));

      res.json({
        sessions: mapped,
        page: pg,
        pageSize: size,
        total: count || 0,
      });
    } catch (e) {
      logger?.error({ err: e }, "admin.sessions");
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  /**
   * GET /api/admin/events
   * Query: admin_key, sessionId, page, pageSize
   */
  app.get("/api/admin/events", requireAdmin, async (req, res) => {
    try {
      const sessionId = req.query.sessionId;
      if (!sessionId)
        return res.status(400).json({ error: "sessionId required" });
      if (!supabase) return res.json({ events: [], total: 0 });

      const pg = Math.max(1, parseInt(req.query.page, 10) || 1);
      const size = Math.min(
        500,
        Math.max(1, parseInt(req.query.pageSize, 10) || 200),
      );
      const fromIdx = (pg - 1) * size;
      const toIdx = fromIdx + size - 1;

      const { data, error, count } = await supabase
        .from("chat_events")
        .select("*", { count: "exact" })
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true })
        .range(fromIdx, toIdx);

      if (error) throw error;
      res.json({
        events: data || [],
        page: pg,
        pageSize: size,
        total: count || 0,
      });
    } catch (e) {
      logger?.error({ err: e }, "admin.events");
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  /**
   * GET /api/admin/flags
   * Either:
   *   - sessionId => returns summary + per-event matches
   *   - from/to (and optional assignmentId) => returns ranked sessions with risk
   *
   * Query:
   *   admin_key,
   *   sessionId?,
   *   from=YYYY-MM-DD?,
   *   to=YYYY-MM-DD?,
   *   assignmentId=<uuid>?
   */
  app.get("/api/admin/flags", requireAdmin, async (req, res) => {
    try {
      if (!supabase) return res.json({ items: [] });

      const { sessionId, from, to, assignmentId } = req.query || {};

      if (sessionId) {
        const { data, error } = await supabase
          .from("chat_events")
          .select("id,created_at,role,content")
          .eq("session_id", sessionId)
          .order("created_at", { ascending: true });
        if (error) throw error;

        const details = data.map((e) => {
          const { hits, score } = scoreFlagsForText(e.content || "");
          return { ...e, hits, score };
        });
        const summary = summariseFlags(data);
        return res.json({ sessionId, summary, events: details });
      }

      const { fromISO, toISO } = parseDateBounds(from, to);
      // Rough scan: pull recent sessions in range and compute score
      let q = supabase
        .from("sessions")
        .select("id,session_id,created_at,assignment_id,assignment_code")
        .order("created_at", { ascending: false })
        .limit(1000);

      if (fromISO) q = q.gte("created_at", fromISO);
      if (toISO) q = q.lte("created_at", toISO);
      if (assignmentId) q = q.eq("assignment_id", assignmentId);

      const { data: sessions, error: sErr } = await q;
      if (sErr) throw sErr;

      const items = [];
      for (const s of sessions || []) {
        const sid = s.id || s.session_id;
        const { data: evs } = await supabase
          .from("chat_events")
          .select("content")
          .eq("session_id", sid)
          .limit(500);
        const summary = summariseFlags(evs || []);
        if (summary.totalScore > 0) {
          items.push({
            sessionId: sid,
            created_at: s.created_at,
            level: summary.level,
            score: summary.totalScore,
            counts: summary.counts,
            assignment_id: s.assignment_id ?? null,
            assignment_code: s.assignment_code ?? null,
          });
        }
      }
      items.sort((a, b) => b.score - a.score);
      res.json({ items });
    } catch (e) {
      logger?.error({ err: e }, "admin.flags");
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  /**
   * GET /api/admin/export
   * Streams a ZIP: sessions.csv, events.csv, and AI Index PDFs (if Supabase storage available)
   * Query: admin_key, from, to
   */
  app.get("/api/admin/export", requireAdmin, async (req, res) => {
    try {
      if (!supabase)
        return res.status(500).json({ error: "Supabase required for export" });
      const { from, to } = req.query || {};
      const { fromISO, toISO } = parseDateBounds(from, to);

      let q = supabase
        .from("sessions")
        .select("*")
        .order("created_at", { ascending: true });
      if (fromISO) q = q.gte("created_at", fromISO);
      if (toISO) q = q.lte("created_at", toISO);

      const { data: sessions, error: sErr } = await q;
      if (sErr) throw sErr;

      // set headers
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="wurksy_export_${Date.now()}.zip"`,
      );

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.on("error", (err) => {
        try {
          res.destroy(err);
        } catch {}
      });
      archive.pipe(res);

      // sessions.csv (extended with student + assignment info)
      const sRows = [
        [
          "session_id",
          "created_at",
          "mode",
          "locked_at",
          "student_id",
          "student_module",
          "assignment_id",
          "assignment_code",
        ],
      ];
      (sessions || []).forEach((s) =>
        sRows.push([
          s.id || s.session_id,
          s.created_at,
          s.mode || "guest",
          s.locked_at || "",
          s.student_id || "",
          s.student_module || "",
          s.assignment_id || "",
          s.assignment_code || "",
        ]),
      );
      archive.append(
        sRows
          .map((r) =>
            r
              .map((v) => {
                const s = String(v ?? "");
                return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
              })
              .join(","),
          )
          .join("\n"),
        { name: "sessions.csv" },
      );

      // events.csv and AI Index PDFs
      const eHeader = ["created_at", "session_id", "role", "content", "tokens"];
      const eventsCsvChunks = [eHeader.join(",")];

      for (const s of sessions || []) {
        const sid = s.id || s.session_id;

        const { data: evs, error: eErr } = await supabase
          .from("chat_events")
          .select("*")
          .eq("session_id", sid)
          .order("created_at", { ascending: true });
        if (eErr) throw eErr;

        (evs || []).forEach((e) => {
          const row = [
            e.created_at,
            sid,
            e.role,
            e.content?.replace(/\r?\n/g, " ").slice(0, 32000) || "",
            e.tokens ?? "",
          ]
            .map((v) => {
              const s = String(v ?? "");
              return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            })
            .join(",");
          eventsCsvChunks.push(row);
        });

        // Build AI Index PDF and put into ZIP
        const shaped = normaliseEvents(evs || []);
        const pdfBuffer = await buildAiIndex({ session: s, events: shaped });
        archive.append(pdfBuffer, { name: `ai-index/${sid}.pdf` });
      }

      archive.append(eventsCsvChunks.join("\n"), { name: "events.csv" });
      await archive.finalize();
    } catch (e) {
      logger?.error({ err: e }, "admin.export");
      res.status(500).json({ error: e.message || "Export failed" });
    }
  });
}
