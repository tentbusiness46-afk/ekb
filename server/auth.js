import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { cfg } from "./config.js";
import { db, now, json } from "./db.js";

export const COOKIE = "ekb_sid";
export const PERMS = ["dashboard", "orders", "products", "customers", "staff", "settings"];
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

export const hashPassword = (pw) => bcrypt.hash(pw, 10);
export const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const bad = (msg, code) => new HttpError(400, msg, code);

export async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = now() + cfg.sessionDays * 864e5;
  await db.run("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)", [sha(token), userId, expires, now()]);
  await db.run("UPDATE users SET last_login=? WHERE id=?", [now(), userId]);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: cfg.secureCookies, maxAge: cfg.sessionDays * 864e5, path: "/" });
  return token;
}

export async function endSession(req, res) {
  const t = tokenOf(req);
  if (t) await db.run("DELETE FROM sessions WHERE token_hash=?", [sha(t)]);
  res.clearCookie(COOKIE, { path: "/" });
}

const tokenOf = (req) => req.cookies?.[COOKIE] || (req.get("authorization") || "").replace(/^Bearer\s+/i, "") || null;

/** Attaches req.user when a valid session is present. */
export async function loadUser(req, _res, next) {
  try {
    const t = tokenOf(req);
    if (t) {
      const u = await db.get(
        `SELECT u.id,u.name,u.email,u.phone,u.role,u.perms,u.blocked FROM sessions s JOIN users u ON u.id=s.user_id
         WHERE s.token_hash=? AND s.expires_at>?`, [sha(t), now()]);
      if (u && !u.blocked) req.user = { ...u, perms: json(u.perms, []) };
    }
    next();
  } catch (e) { next(e); }
}

export const publicUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, phone: u.phone || "", role: u.role, perms: u.role === "admin" ? PERMS : u.perms || [] });

export function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, "Please sign in", "AUTH"));
  next();
}

/** Admin can do everything; staff only what their permissions allow. */
export const requireStaff = (perm) => (req, _res, next) => {
  const u = req.user;
  if (!u) return next(new HttpError(401, "Please sign in", "AUTH"));
  if (u.role === "admin") return next();
  if (u.role === "staff" && (!perm || u.perms.includes(perm))) return next();
  next(new HttpError(403, "You don't have access to this", "FORBIDDEN"));
};

/** Cross-site form posts can't add custom headers, so requiring one blocks CSRF. */
export function csrfGuard(req, _res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("x-ekb") !== "1") return next(new HttpError(403, "Missing request header", "CSRF"));
  next();
}

/** Simple in-memory limiter for login / reset attempts. */
const hits = new Map();
export function limit(key, max, windowMs) {
  const t = now(), arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  arr.push(t); hits.set(key, arr);
  if (arr.length > max) throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.", "RATE");
}

export async function createResetToken(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.run("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,?)", [sha(token), userId, now() + 3600e3]);
  return token;
}
export async function useResetToken(token) {
  const r = await db.get("SELECT * FROM password_resets WHERE token_hash=? AND used=0 AND expires_at>?", [sha(token), now()]);
  if (!r) return null;
  await db.run("UPDATE password_resets SET used=1 WHERE token_hash=?", [sha(token)]);
  return r.user_id;
}
