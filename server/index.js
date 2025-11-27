// server/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import pino from "pino";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import crypto from "crypto";
import fs from "fs";

// feature routes
import { getClient } from "./supa.js";
import { chatComplete } from "./openai.js";
import { buildAiIndex } from "./pdf.js";
import * as util from "./util.js"; // read available helpers
import { searchCrossref, searchOpenAlex } from "./research.js";
import { registerLectureRoutes } from "./lectures.js";
import { registerPaperRoutes } from "./papers.js";

// Pull helpers (fallbacks if missing)
const {
  normaliseEvents = (xs) => xs || [],
  markdownToBullets = (s) => String(s || ""),
  violatesAmberPolicy = () => false,
  trimMessage = (s) => String(s || ""),
  uploadAndSign: uploadAndSignFromUtil,
} = util;

// ---------- ENV ----------
const Env = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),

  // Now optional because Azure might be used instead
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5-mini"),

  // Azure-specific vars (optional – openai.js handles defaults)
  AZURE_OPENAI_ENDPOINT: z.string().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_DEPLOYMENT: z.string().optional(),
  AZURE_OPENAI_API_VERSION: z.string().optional(),

  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  ADMIN_KEY: z.string().min(16).default("CHANGE_ME_ADMIN_KEY"),
  PROMPT_CAP: z.coerce.number().int().positive().default(100),
  CORS_ORIGIN: z.string().optional(),
  SESSION_SECRET: z
    .string()
    .min(16, "Set SESSION_SECRET")
    .default("CHANGE_ME_SESSION_SECRET"),
  DEMO_PASS: z.string().min(4, "Set DEMO_PASS for login"),
});
const env = Env.parse(process.env);

// ---------- LOGGER ----------
const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
});

// ---------- APP ----------
const app = express();
app.set("trust proxy", true);

// Crash guards
process.on("unhandledRejection", (err) =>
  console.error("UNHANDLED REJECTION", err),
);
process.on("uncaughtException", (err) =>
  console.error("UNCAUGHT EXCEPTION", err),
);

// Core middleware
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false, // pdf.js + inline bits
  }),
);
app.use(compression());
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use(
  cors({
    origin: env.CORS_ORIGIN ? [env.CORS_ORIGIN] : true,
    credentials: false,
  }),
);
app.use(pinoHttp({ logger }));

// ---------- STATIC FILES ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "../public");

function noStoreHtmlHeaders(res) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
}

const isDev = (process.env.NODE_ENV || "development") !== "production";

// ---------- SIMPLE LOGIN WALL (before static + routes) ----------
const COOKIE_NAME = "ws_auth";
const TOKEN_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function signToken(secret, ts = Date.now()) {
  const msg = String(ts);
  const sig = crypto.createHmac("sha256", secret).update(msg).digest("hex");
  return `${msg}.${sig}`;
}
function verifyToken(token, secret) {
  if (typeof token !== "string") return false;
  const [tsStr, sig] = token.split(".");
  if (!tsStr || !sig) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(tsStr)
    .digest("hex");
  if (sig !== expected) return false;
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < TOKEN_AGE_MS;
}

// Auth endpoints
app.post("/auth/login", (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "Password required" });
  if (password !== env.DEMO_PASS)
    return res.status(401).json({ error: "Invalid password" });

  const token = signToken(env.SESSION_SECRET);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    maxAge: TOKEN_AGE_MS,
    path: "/",
  });
  res.json({ ok: true });
});

app.get("/auth/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.redirect("/login.html");
});

// Allowlist and gate
const allowList = new Set([
  "/login.html",
  "/auth/login",
  "/auth/logout",
  "/health",
  "/__version",
  "/logo.svg",
  "/assets/generated-icon.png",
]);

app.use((req, res, next) => {
  // Always allow login endpoints
  if (allowList.has(req.path)) return next();

  // Allow static assets needed by login page
  const isStaticAsset =
    req.path.startsWith("/assets/") ||
    req.path.startsWith("/pdfjs/") ||
    req.path.startsWith("/pdfjs-legacy/") ||
    req.path.endsWith(".css") ||
    req.path.endsWith(".js") ||
    req.path.endsWith(".png") ||
    req.path.endsWith(".svg") ||
    req.path.endsWith(".ico");

  const token = req.cookies?.[COOKIE_NAME];
  const authed = verifyToken(token, env.SESSION_SECRET);

  if (authed) return next();

  // Unauthed: let static assets through (for login styling/scripts), block APIs, redirect others
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorised" });
  }
  if (isStaticAsset) return next();
  return res.redirect("/login.html");
});

// ---------- STATIC (after auth wall) ----------
app.use(
  express.static(
    publicDir,
    isDev
      ? {
          etag: false,
          lastModified: false,
          cacheControl: false,
          maxAge: 0,
          fallthrough: true,
        }
      : {
          etag: true,
          lastModified: true,
          cacheControl: true,
          maxAge: "1h",
          fallthrough: true,
          setHeaders: (res, filePath) => {
            if (filePath.endsWith(".html")) noStoreHtmlHeaders(res);
          },
        },
  ),
);

// ---------- SERVE LOCAL PDF.JS (ESM build) ----------
const pdfjsDir = path.join(__dirname, "../node_modules/pdfjs-dist/build");
console.log("Serving PDF.js ESM from:", pdfjsDir);
app.use(
  "/pdfjs",
  express.static(pdfjsDir, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".mjs")) {
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      }
    },
  }),
);

// ---------- SERVE LOCAL PDF.JS (LEGACY UMD build) ----------
const pdfjsLegacyDir = path.join(
  __dirname,
  "../node_modules/pdfjs-dist/legacy/build",
);
console.log("Serving PDF.js Legacy UMD from:", pdfjsLegacyDir);
app.use(
  "/pdfjs-legacy",
  express.static(pdfjsLegacyDir, {
    index: false,
  }),
);

// Explicit HTML routes (no-store headers)
app.get("/login.html", (_req, res) => {
  // lightly no-cache the login page
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(publicDir, "login.html"));
});
app.get("/", (_req, res) => {
  noStoreHtmlHeaders(res);
  res.sendFile(path.join(publicDir, "index.html"));
});
app.get("/lectures.html", (_req, res) => {
  noStoreHtmlHeaders(res);
  res.sendFile(path.join(publicDir, "lectures.html"));
});
app.get("/research.html", (_req, res) => {
  noStoreHtmlHeaders(res);
  res.sendFile(path.join(publicDir, "research.html"));
});
app.get("/admin.html", (_req, res) => {
  noStoreHtmlHeaders(res);
  res.sendFile(path.join(publicDir, "admin.html"));
});
app.get("/privacy.html", (_req, res) => {
  noStoreHtmlHeaders(res);
  res.sendFile(path.join(publicDir, "privacy.html"));
});
app.get("/terms.html", (_req, res) => {
  noStoreHtmlHeaders(res);
  res.sendFile(path.join(publicDir, "terms.html"));
});

// Debug: what’s on disk
app.get("/__version", (_req, res) => {
  try {
    const files = [
      "index.html",
      "lectures.html",
      "research.html",
      "admin.html",
      "privacy.html",
      "terms.html",
      "styles.css",
      "app.js",
      "theme.js",
      "login.html",
    ];
    const out = files.map((f) => {
      const p = path.join(publicDir, f);
      if (!fs.existsSync(p)) return { file: f, exists: false };
      const buf = fs.readFileSync(p);
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      const mtime = fs.statSync(p).mtime.toISOString();
      return { file: f, exists: true, bytes: buf.length, sha256: sha, mtime };
    });
    res.json({ publicDir, env: process.env.NODE_ENV || "development", out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- DEPS ----------
const supabase = getClient();
const ADMIN_KEY = env.ADMIN_KEY;
const PROMPT_CAP = env.PROMPT_CAP;

// ---------- RATE LIMITS ----------
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }),
);
const chatLimiter = rateLimit({
  windowMs: 30_000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.body?.sessionId || "no-session"}`,
});
const papersLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
app.use("/api/papers", papersLimiter);

// ---------- HELPERS ----------
const pickSessionId = (row) => row?.id || row?.session_id || null;

async function getSessionRow(sessionId) {
  if (!supabase) return { id: sessionId, mode: "guest" };
  // try id
  let r = await supabase
    .from("sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();
  if (r?.data) return r.data;
  // try session_id
  r = await supabase
    .from("sessions")
    .select("*")
    .eq("session_id", sessionId)
    .maybeSingle();
  return r?.data || null;
}

async function logEvent(sessionId, role, content, tokens = null) {
  if (!supabase) return;
  const { error } = await supabase
    .from("chat_events")
    .insert({ session_id: sessionId, role, content, tokens });
  if (error) logger.error({ err: error }, "logEvent error");
}
async function countUserPrompts(sessionId) {
  if (!supabase) return 0;
  const { count, error } = await supabase
    .from("chat_events")
    .select("*", { count: "exact", head: true })
    .eq("session_id", sessionId)
    .eq("role", "user");
  if (error) throw error;
  return count ?? 0;
}
async function createSessionRow() {
  if (!supabase) return { local: true, id: `local_${Date.now()}` };
  const uuid = crypto.randomUUID();
  const tries = [
    { id: uuid, session_id: uuid },
    { id: uuid },
    { session_id: uuid },
    {},
  ];
  let lastErr;
  for (const payload of tries) {
    const { data, error } = await supabase
      .from("sessions")
      .insert(payload)
      .select("*")
      .single();
    if (!error && data) return data;
    lastErr = error;
  }
  throw lastErr || new Error("Failed to create session");
}

// Fallback uploadAndSign if util.uploadAndSign is missing
const uploadAndSign =
  uploadAndSignFromUtil ??
  async function uploadAndSignLocal(
    sp,
    pathKey,
    buffer,
    contentType = "application/pdf",
  ) {
    if (!sp?.storage) throw new Error("Supabase storage not configured");
    const bucket = "ai-index";
    try {
      await sp.storage.createBucket(bucket, { public: false });
    } catch (_) {}
    const { error: upErr } = await sp.storage
      .from(bucket)
      .upload(pathKey, buffer, {
        contentType,
        upsert: true,
      });
    if (upErr) throw upErr;
    const { data, error: urlErr } = await sp.storage
      .from(bucket)
      .createSignedUrl(pathKey, 60 * 60 * 24);
    if (urlErr) throw urlErr;
    return data?.signedUrl;
  };

// ---------- ROUTES ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/config", (_req, res) =>
  res.json({
    model: env.OPENAI_MODEL,
    cap: PROMPT_CAP,
    supabase: Boolean(supabase),
  }),
);

// Start session
app.post("/api/start", async (_req, res, next) => {
  try {
    const row = await createSessionRow();
    res.json({
      sessionId: pickSessionId(row),
      mode: row?.mode ?? "guest",
      cap: PROMPT_CAP,
    });
  } catch (e) {
    next(e);
  }
});

// Chat (blocks when locked, amber-guarded, bullet-clean)
app.post("/api/chat", chatLimiter, async (req, res, next) => {
  try {
    const { sessionId, message } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
    if (!message) return res.status(400).json({ error: "Missing message" });

    if (supabase) {
      const row = await getSessionRow(sessionId);
      if (row?.locked_at)
        return res
          .status(423)
          .json({ error: "This assignment is submitted and locked." });
    }

    const used = await countUserPrompts(sessionId);
    if (used >= PROMPT_CAP) {
      return res.status(429).json({
        error: `Prompt cap reached (${PROMPT_CAP}).`,
        used,
        cap: PROMPT_CAP,
      });
    }

    const cleaned = trimMessage(message);

    // amber guard
    if (violatesAmberPolicy(cleaned)) {
      const policyReply = [
        "• Amber-mode: I can help with bullet summaries, outlines, definitions, methods, and marking-criteria checklists.",
        "• I can’t ghost-write or ‘humanise’ your submission text.",
      ].join("\n");
      await logEvent(sessionId, "user", cleaned);
      await logEvent(sessionId, "assistant", policyReply);
      return res.json({ reply: policyReply, used: used + 1, cap: PROMPT_CAP });
    }

    await logEvent(sessionId, "user", cleaned);

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
    await logEvent(sessionId, "assistant", reply);

    res.json({ reply, used: used + 1, cap: PROMPT_CAP });
  } catch (e) {
    next(e);
  }
});

// Admin
function requireAdmin(req, res, next) {
  const key = req.query.admin_key || req.headers["x-admin-key"] || "";
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorised" });
  next();
}
app.get("/api/admin/sessions", requireAdmin, async (_req, res, next) => {
  try {
    if (!supabase) return res.json({ sessions: [] });
    const { data, error } = await supabase
      .from("sessions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    res.json({
      sessions: (data || []).map((r) => ({
        id: pickSessionId(r),
        created_at: r.created_at,
        mode: r.mode ?? "guest",
        locked_at: r.locked_at ?? null,
      })),
    });
  } catch (e) {
    next(e);
  }
});
app.get("/api/admin/events", requireAdmin, async (req, res, next) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId)
      return res.status(400).json({ error: "sessionId required" });
    if (!supabase) return res.json({ events: [] });
    const { data, error } = await supabase
      .from("chat_events")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    res.json({ events: data });
  } catch (e) {
    next(e);
  }
});

// Legacy search (kept for old UI bits)
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

// AI Index
app.get("/api/ai-index", async (req, res, next) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId)
      return res.status(400).json({ error: "sessionId required" });
    if (!supabase)
      return res.status(500).json({ error: "Supabase not configured" });

    const sessionRow = await getSessionRow(sessionId);
    const { data: events, error: eErr } = await supabase
      .from("chat_events")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });
    if (eErr) throw eErr;

    const shaped = normaliseEvents(events);
    const pdfBuffer = await buildAiIndex({
      session: sessionRow,
      events: shaped,
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

// -------- SUBMIT & LOCK --------
app.post("/api/submit", async (req, res, next) => {
  try {
    const { sessionId, declaration } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

    const lockedAt = new Date().toISOString();
    let updated = null;

    if (supabase) {
      // Try id
      let r = await supabase
        .from("sessions")
        .update({ locked_at: lockedAt, declaration: declaration ?? null })
        .eq("id", sessionId)
        .select("*")
        .maybeSingle();
      if (r?.data) updated = r.data;

      // Try session_id
      if (!updated) {
        r = await supabase
          .from("sessions")
          .update({ locked_at: lockedAt, declaration: declaration ?? null })
          .eq("session_id", sessionId)
          .select("*")
          .maybeSingle();
        if (r?.data) updated = r.data;
      }

      // Fallback: store a submission artifact if update not possible
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

// Feature routes
registerLectureRoutes(app, supabase, logger);
registerPaperRoutes(app, logger);

// 404 + errors
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, _next) => {
  req.log?.error({ err }, "Unhandled error");
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

// Boot
app.listen(env.PORT, () =>
  logger.info(`Wurksy listening on http://localhost:${env.PORT}`),
);
