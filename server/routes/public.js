import { Router } from "express";
import { db, now } from "../db.js";
import { getCatalog } from "../catalog.js";
import { h, str, phone10, validPhone, validEmail } from "../util.js";
import { cfg } from "../config.js";
import {
  bad, HttpError, hashPassword, checkPassword, startSession, endSession, publicUser, limit,
  createResetToken, useResetToken,
} from "../auth.js";
import { sendMail, resetEmail } from "../email.js";

const r = Router();

/* ---------- catalogue (public) ---------- */
r.get("/catalog", h(async (req, res) => {
  const c = await getCatalog(), etag = `"c${c.version}"`;
  res.set("ETag", etag).set("Cache-Control", "no-cache");
  if (req.get("if-none-match") === etag) return res.status(304).end();
  res.json(c.data);
}));
r.get("/products/:id", h(async (req, res) => {
  const p = (await getCatalog()).data.products.find((x) => x.id === Number(req.params.id));
  if (!p) throw new HttpError(404, "Product not found", "NOT_FOUND");
  res.json(p);
}));
r.get("/pages", h(async (_req, res) => res.json((await getCatalog()).data.pages)));

/* ---------- accounts ---------- */
r.post("/auth/signup", h(async (req, res) => {
  limit(`signup:${req.ip}`, 20, 3600e3);
  const name = str(req.body.name, 80), email = str(req.body.email, 120).toLowerCase(), phone = phone10(req.body.phone), pw = String(req.body.password || "");
  if (!name) throw bad("Please enter your name");
  if (!validPhone(phone)) throw bad("Please enter a valid 10-digit mobile number");
  if (!validEmail(email)) throw bad("Please enter a valid email");
  if (pw.length < 8) throw bad("Password must be at least 8 characters");
  if (await db.get("SELECT id FROM users WHERE email=?", [email])) throw new HttpError(409, "An account with this email already exists. Please sign in.", "EXISTS");
  const r1 = await db.run("INSERT INTO users(name,email,phone,pass_hash,role,created_at) VALUES(?,?,?,?,'customer',?)", [name, email, "+91 " + phone, await hashPassword(pw), now()]);
  await startSession(res, r1.lastId);
  res.status(201).json({ user: publicUser({ id: r1.lastId, name, email, phone: "+91 " + phone, role: "customer" }) });
}));

r.post("/auth/login", h(async (req, res) => {
  const email = str(req.body.email, 120).toLowerCase(), pw = String(req.body.password || "");
  limit(`login:${req.ip}:${email}`, 10, 15 * 60e3);
  const u = await db.get("SELECT * FROM users WHERE email=?", [email]);
  if (!u || !(await checkPassword(pw, u.pass_hash))) throw new HttpError(401, "Wrong email or password", "BAD_LOGIN");
  if (u.blocked) throw new HttpError(403, "This account has been disabled. Please contact us.", "BLOCKED");
  await startSession(res, u.id);
  res.json({ user: publicUser({ ...u, perms: JSON.parse(u.perms || "[]") }) });
}));

r.post("/auth/logout", h(async (req, res) => { await endSession(req, res); res.json({ ok: true }); }));
r.get("/auth/me", (req, res) => res.json({ user: publicUser(req.user) || null }));

r.post("/auth/forgot", h(async (req, res) => {
  const email = str(req.body.email, 120).toLowerCase();
  limit(`forgot:${req.ip}`, 8, 3600e3);
  const u = email && (await db.get("SELECT id,name,email,blocked FROM users WHERE email=?", [email]));
  if (u && !u.blocked) {
    const token = await createResetToken(u.id);
    sendMail({ to: u.email, ...resetEmail(u.name, `${cfg.baseUrl}/#/reset/${token}`) });
  }
  res.json({ ok: true }); // same answer either way, so emails can't be probed
}));

r.post("/auth/reset", h(async (req, res) => {
  limit(`reset:${req.ip}`, 15, 3600e3);
  const pw = String(req.body.password || "");
  if (pw.length < 8) throw bad("Password must be at least 8 characters");
  const userId = await useResetToken(String(req.body.token || ""));
  if (!userId) throw bad("This reset link has expired or was already used. Please ask for a new one.", "BAD_TOKEN");
  await db.run("UPDATE users SET pass_hash=? WHERE id=?", [await hashPassword(pw), userId]);
  await db.run("DELETE FROM sessions WHERE user_id=?", [userId]); // sign out everywhere else
  await startSession(res, userId);
  const u = await db.get("SELECT * FROM users WHERE id=?", [userId]);
  res.json({ user: publicUser({ ...u, perms: JSON.parse(u.perms || "[]") }) });
}));

export default r;
