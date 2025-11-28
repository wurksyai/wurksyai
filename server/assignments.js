// server/assignments.js
import crypto from "crypto";

/**
 * Generate a short human-friendly code for an assignment, e.g. "A7F3XQ".
 * We check Supabase to avoid collisions.
 */
async function generateUniqueCode(supabase, length = 6, maxTries = 10) {
  if (!supabase) {
    // Fallback: just random if no Supabase (dev mode)
    return crypto.randomBytes(4).toString("base64url").slice(0, length);
  }

  for (let i = 0; i < maxTries; i++) {
    const raw = crypto.randomBytes(8).toString("base64url").toUpperCase();
    const code = raw.replace(/[^A-Z0-9]/g, "").slice(0, length) || "ASSIGN";
    const { data, error } = await supabase
      .from("assignments")
      .select("id")
      .eq("short_code", code)
      .maybeSingle();
    if (error) throw error;
    if (!data) return code;
  }
  throw new Error("Failed to generate unique assignment code");
}

export function registerAssignmentRoutes(app, supabase, logger, ADMIN_KEY) {
  function requireAdmin(req, res, next) {
    const key = req.query.admin_key || req.headers["x-admin-key"] || "";
    if (key !== ADMIN_KEY)
      return res.status(401).json({ error: "Unauthorised" });
    next();
  }

  /**
   * POST /api/admin/assignments
   */
  app.post("/api/admin/assignments", requireAdmin, async (req, res) => {
    try {
      if (!supabase)
        return res
          .status(500)
          .json({ error: "Supabase required for assignments" });

      const {
        moduleCode,
        title,
        brief,
        deadline,
        promptCap,
        recommendedPdfs,
        createdBy,
      } = req.body || {};

      if (!moduleCode || !title) {
        return res
          .status(400)
          .json({ error: "moduleCode and title are required" });
      }

      const short_code = await generateUniqueCode(supabase);
      const cap =
        typeof promptCap === "number" && promptCap > 0 ? promptCap : 100;

      let recPdfs = null;
      if (Array.isArray(recommendedPdfs) && recommendedPdfs.length > 0) {
        recPdfs = recommendedPdfs.map((r) => ({
          label: r.label || r.url || "",
          url: r.url || "",
        }));
      }

      const payload = {
        short_code,
        module_code: moduleCode,
        title,
        brief: brief ?? "",
        deadline: deadline ?? null,
        prompt_cap: cap,
        recommended_pdfs: recPdfs,
        created_by: createdBy ?? null,
      };

      const { data, error } = await supabase
        .from("assignments")
        .insert(payload)
        .select("*")
        .single();
      if (error) throw error;

      const host = req.get("host");

      // FIXED: Removed TypeScript syntax "as string"
      const proto = req.headers["x-forwarded-proto"]
        ? String(req.headers["x-forwarded-proto"])
        : req.protocol || "https";

      const studentUrl = `${proto}://${host}/login.html?a=${encodeURIComponent(
        data.short_code,
      )}`;

      res.json({ assignment: data, studentUrl });
    } catch (e) {
      logger?.error({ err: e }, "admin.assignments.create");
      res.status(500).json({ error: e.message || "Failed to create" });
    }
  });

  /**
   * GET /api/admin/assignments
   */
  app.get("/api/admin/assignments", requireAdmin, async (req, res) => {
    try {
      if (!supabase)
        return res.json({ assignments: [], total: 0, page: 1, pageSize: 100 });

      const { q = "", from, to, page = "1", pageSize = "100" } = req.query;

      const pg = Math.max(1, parseInt(page, 10) || 1);
      const size = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 100));

      let query = supabase
        .from("assignments")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false });

      if (from) query = query.gte("created_at", String(from));
      if (to) query = query.lte("created_at", String(to));

      const fromIdx = (pg - 1) * size;
      const toIdx = fromIdx + size - 1;
      query = query.range(fromIdx, toIdx);

      const { data, error, count } = await query;
      if (error) throw error;

      let rows = data || [];
      if (q) {
        const needle = String(q).toLowerCase();
        rows = rows.filter((a) => {
          const mc = String(a.module_code || "").toLowerCase();
          const t = String(a.title || "").toLowerCase();
          const sc = String(a.short_code || "").toLowerCase();
          return (
            mc.includes(needle) || t.includes(needle) || sc.includes(needle)
          );
        });
      }

      const mapped = rows.map((a) => ({
        id: a.id,
        short_code: a.short_code,
        module_code: a.module_code,
        title: a.title,
        brief: a.brief,
        deadline: a.deadline,
        prompt_cap: a.prompt_cap,
        created_by: a.created_by ?? null,
        created_at: a.created_at,
      }));

      res.json({
        assignments: mapped,
        total: count || mapped.length,
        page: pg,
        pageSize: size,
      });
    } catch (e) {
      logger?.error({ err: e }, "admin.assignments.list");
      res.status(500).json({ error: e.message || "Failed to list" });
    }
  });

  /**
   * GET /api/assignments/:shortCode
   */
  app.get("/api/assignments/:shortCode", async (req, res) => {
    try {
      if (!supabase)
        return res
          .status(500)
          .json({ error: "Supabase required for assignments" });

      const shortCode = req.params.shortCode;
      if (!shortCode)
        return res.status(400).json({ error: "shortCode required" });

      const { data, error } = await supabase
        .from("assignments")
        .select("*")
        .eq("short_code", shortCode)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: "Not found" });

      res.json({
        id: data.id,
        short_code: data.short_code,
        module_code: data.module_code,
        title: data.title,
        brief: data.brief,
        deadline: data.deadline,
        prompt_cap: data.prompt_cap,
        recommended_pdfs: data.recommended_pdfs ?? null,
      });
    } catch (e) {
      logger?.error({ err: e }, "public.assignment.get");
      res.status(500).json({ error: e.message || "Failed" });
    }
  });
}
