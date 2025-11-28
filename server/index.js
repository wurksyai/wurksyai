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

import { buildAiIndex } from "./pdf.js";

// feature routes
import { getClient } from "./supa.js";
import * as util from "./util.js";
import { registerLectureRoutes } from "./lectures.js";
import { registerPaperRoutes } from "./papers.js";
import { registerAdminRoutes } from "./admin.js";
import { registerAssignmentRoutes } from "./assignments.js";
import { makeSessionHelpers } from "./session-helpers.js";
import { registerCoreRoutes } from "./core-routes.js";

// ---------- UTIL FALLBACKS ----------
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

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5-mini"),

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

// Guards
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
    contentSecurityPolicy: false,
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

// ---------- PATHS ----------
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

// ---------- LOGIN WALL ----------
const COOKIE_NAME = "ws_auth";
const TOKEN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

// ---------- AUTH ENDPOINTS ----------
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

// ---------- AUTH WALL ----------
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
  if (allowList.has(req.path)) return next();

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
  if (req.path.startsWith("/api/"))
    return res.status(401).json({ error: "Unauthorised" });
  if (isStaticAsset) return next();

  return res.redirect("/login.html");
});

// ---------- STATIC FILES ----------
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

// ---------- PDF.JS SERVING ----------
const pdfjsDir = path.join(__dirname, "../node_modules/pdfjs-dist/build");
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

const pdfjsLegacyDir = path.join(
  __dirname,
  "../node_modules/pdfjs-dist/legacy/build",
);

app.use(
  "/pdfjs-legacy",
  express.static(pdfjsLegacyDir, {
    index: false,
  }),
);

// ---------- EXPLICIT HTML ROUTES ----------
app.get("/login.html", (_req, res) => {
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

// ---------- DEBUG VERSION ROUTE ----------
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

    res.json({
      publicDir,
      env: process.env.NODE_ENV || "development",
      out,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- SUPABASE ----------
const supabase = getClient();
const ADMIN_KEY = env.ADMIN_KEY;
const PROMPT_CAP = env.PROMPT_CAP;

// ---------- RATE LIMITING ----------
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

// ---------- SESSION HELPERS ----------
const sessionHelpers = makeSessionHelpers(supabase, logger, PROMPT_CAP);

// ---------- FALLBACK UPLOAD ----------
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
      .upload(pathKey, buffer, { contentType, upsert: true });

    if (upErr) throw upErr;

    const { data, error: urlErr } = await sp.storage
      .from(bucket)
      .createSignedUrl(pathKey, 60 * 60 * 24);

    if (urlErr) throw urlErr;

    return data?.signedUrl;
  };

// ---------- CORE API ROUTES (chat, ai-index, etc.) ----------
registerCoreRoutes(app, {
  supabase,
  logger,
  PROMPT_CAP,
  uploadAndSign,
  chatLimiter,
  markdownToBullets,
  violatesAmberPolicy,
  trimMessage,
  sessionHelpers,
});

// ---------- FEATURE ROUTES ----------
registerLectureRoutes(app, supabase, logger);
registerPaperRoutes(app, logger, supabase);
registerAssignmentRoutes(app, supabase, logger, ADMIN_KEY);

registerAdminRoutes(
  app,
  supabase,
  logger,
  ADMIN_KEY,
  buildAiIndex, // NOTE: if your admin.js still needs it – otherwise remove
  normaliseEvents,
  uploadAndSign,
);

// ---------- 404 ----------
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// ---------- ERROR HANDLER ----------
app.use((err, req, res, _next) => {
  req.log?.error({ err }, "Unhandled error");
  res.status(err.status || 500).json({
    error: err.message || "Server error",
  });
});

// ---------- BOOT ----------
app.listen(env.PORT, () =>
  logger.info(`Wurksy listening on http://localhost:${env.PORT}`),
);
