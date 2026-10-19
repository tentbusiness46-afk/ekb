import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { cfg, ROOT } from "./config.js";
import { migrate } from "./db.js";
import { loadUser, csrfGuard, HttpError } from "./auth.js";
import { getCatalog } from "./catalog.js";
import { getMedia } from "./storage.js";
import publicRoutes from "./routes/public.js";
import accountRoutes from "./routes/account.js";
import adminRoutes from "./routes/admin.js";

await migrate();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // behind Render / Cloudflare
app.use((req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "SAMEORIGIN" });
  next();
});
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(loadUser);

/* ---------- API ---------- */
app.use("/api", csrfGuard);
app.use("/api", publicRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api", accountRoutes);
app.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found", "NOT_FOUND")));

/* ---------- live catalogue for the website and app (same shape as the scraper's file) ---------- */
app.get(["/ekarolbagh-data.js", "/app/ekarolbagh-data.js"], async (_req, res, next) => {
  try {
    const c = await getCatalog();
    res.type("application/javascript").set("Cache-Control", "no-cache")
      .send(`window.EKB_API=true;window.EKB_DATA=${JSON.stringify(c.data).replace(/</g, "\\u003c")};`);
  } catch (e) { next(e); }
});

/* ---------- photos stored in the database (when R2 isn't set up) ---------- */
app.get("/media/*", async (req, res, next) => {
  try {
    const m = await getMedia(decodeURIComponent(req.params[0] || ""));
    if (!m) return res.status(404).set("Cache-Control", "no-store").end();
    res.set({ "Content-Type": m.type, "Cache-Control": "public, max-age=31536000, immutable" }).send(m.data);
  } catch (e) { next(e); }
});

/* ---------- shared assets + the three frontends ---------- */
const pub = (...p) => path.join(ROOT, "public", ...p);
// ekb-assets.js, ekb-client.js: browsers re-check them on every load, so updates show up straight away
for (const base of ["/", "/app", "/admin"]) app.use(base, express.static(pub("shared"), { maxAge: 0, index: false }));
app.use("/admin", express.static(pub("admin"), { index: "index.html" }));
app.use("/app", express.static(pub("app"), { index: "index.html" }));
app.use("/", express.static(pub("web"), { index: "index.html" }));
app.get("/admin/*", (_req, res) => res.sendFile(pub("admin", "index.html")));
app.get("/app/*", (_req, res) => res.sendFile(pub("app", "index.html")));

/* ---------- errors ---------- */
app.use((err, req, res, _next) => {
  const status = err.status || (err.type === "entity.too.large" ? 413 : err.code === "LIMIT_FILE_SIZE" ? 413 : 500);
  if (status >= 500) console.error(err);
  const message = status >= 500 ? "Something went wrong. Please try again." : err.message;
  if (req.path.startsWith("/api") || req.path.startsWith("/media")) return res.status(status).json({ error: message, code: err.code || null });
  res.status(status).send(message);
});

app.listen(cfg.port, () => {
  console.log(`eKarolBagh running at ${cfg.baseUrl}`);
  console.log(`  website  ${cfg.baseUrl}/\n  app      ${cfg.baseUrl}/app\n  admin    ${cfg.baseUrl}/admin`);
  console.log(`  database ${cfg.usingTurso ? "Turso" : "local file (data/ekarolbagh.db)"} · photos ${cfg.usingR2 ? "Cloudflare R2" : cfg.usingTurso ? "Turso" : "local database file"} · email ${cfg.resendKey ? "Resend" : "printed to console"}`);
});
