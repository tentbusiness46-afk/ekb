import { bad } from "./auth.js";

/** Wrap async route handlers so errors reach the error handler. */
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);
export const phone10 = (v) => String(v ?? "").replace(/\D/g, "").slice(-10);
export const validPhone = (p) => /^[6-9]\d{9}$/.test(p);
export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
export const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
export const num = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

export function validateAddress(a = {}) {
  const out = {
    name: str(a.name, 80), phone: phone10(a.phone), line: str(a.line, 300), landmark: str(a.landmark, 120),
    pin: str(a.pin, 6), city: str(a.city, 60), state: str(a.state, 60),
  };
  if (!out.name) throw bad("Please enter the receiver's name");
  if (!validPhone(out.phone)) throw bad("Please enter a valid 10-digit mobile number");
  if (out.line.length < 8) throw bad("Please enter the full address");
  if (!/^\d{6}$/.test(out.pin)) throw bad("Please enter a valid 6-digit pincode");
  if (!out.city || !out.state) throw bad("Please enter city and state");
  return out;
}

/** Cart lines from a client: [{key:"123" | "123-456", qty}] */
export function cartLines(items) {
  if (!Array.isArray(items)) return [];
  const m = new Map();
  for (const it of items.slice(0, 200)) {
    const key = String(it?.key ?? "").trim();
    const qty = int(it?.qty);
    if (!/^\d+(-\d+)?$/.test(key) || qty < 1) continue;
    m.set(key, Math.min(9999, (m.get(key) || 0) + qty));
  }
  return [...m].map(([key, qty]) => ({ key, qty }));
}

/** Day start in India time (orders/dashboard use IST days). */
export const IST = 330 * 60e3;
export const istDayStart = (t = Date.now()) => Math.floor((t + IST) / 864e5) * 864e5 - IST;
export const istDate = (t) => new Date(t + IST).toISOString().slice(0, 10);
