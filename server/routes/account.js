import { Router } from "express";
import { db, tx, now } from "../db.js";
import { h, str, phone10, validPhone, cartLines, validateAddress, int } from "../util.js";
import { bad, HttpError, requireUser, checkPassword, hashPassword, publicUser, endSession } from "../auth.js";
import { placeOrder, getOrder, setStatus } from "../orders.js";

const r = Router();
r.use(requireUser);

/* ---------- profile ---------- */
r.patch("/me", h(async (req, res) => {
  const name = str(req.body.name, 80), phone = phone10(req.body.phone);
  if (!name) throw bad("Please enter your name");
  if (phone && !validPhone(phone)) throw bad("Please enter a valid 10-digit mobile number");
  await db.run("UPDATE users SET name=?, phone=? WHERE id=?", [name, phone ? "+91 " + phone : "", req.user.id]);
  res.json({ user: publicUser({ ...req.user, name, phone: phone ? "+91 " + phone : "" }) });
}));
r.post("/me/password", h(async (req, res) => {
  const u = await db.get("SELECT pass_hash FROM users WHERE id=?", [req.user.id]);
  if (!(await checkPassword(String(req.body.current || ""), u.pass_hash))) throw bad("Your current password is wrong");
  const pw = String(req.body.password || "");
  if (pw.length < 8) throw bad("New password must be at least 8 characters");
  await db.run("UPDATE users SET pass_hash=? WHERE id=?", [await hashPassword(pw), req.user.id]);
  res.json({ ok: true });
}));
// Google Play requires that users can delete their account from inside the app.
r.delete("/me", h(async (req, res) => {
  if (req.user.role !== "customer") throw bad("Staff accounts are removed by the admin");
  const u = await db.get("SELECT pass_hash FROM users WHERE id=?", [req.user.id]);
  if (!(await checkPassword(String(req.body.password || ""), u.pass_hash))) throw bad("Wrong password");
  await endSession(req, res);
  await tx(async (t) => {
    await t.run("UPDATE orders SET user_id=NULL WHERE user_id=?", [req.user.id]); // orders stay as business records
    for (const tbl of ["sessions", "cart_items", "wishlist", "addresses", "password_resets"]) await t.run(`DELETE FROM ${tbl} WHERE user_id=?`, [req.user.id]);
    await t.run("DELETE FROM users WHERE id=?", [req.user.id]);
  });
  res.json({ ok: true });
}));

/* ---------- cart (shared between website and app) ---------- */
const readCart = async (uid) => (await db.all("SELECT item_key AS key, qty FROM cart_items WHERE user_id=? ORDER BY updated_at", [uid]));
r.get("/cart", h(async (req, res) => res.json({ items: await readCart(req.user.id) })));
r.put("/cart", h(async (req, res) => {
  const lines = cartLines(req.body.items);
  await tx(async (t) => {
    await t.run("DELETE FROM cart_items WHERE user_id=?", [req.user.id]);
    for (const l of lines) await t.run("INSERT INTO cart_items(user_id,item_key,qty,updated_at) VALUES(?,?,?,?)", [req.user.id, l.key, l.qty, now()]);
  });
  res.json({ items: await readCart(req.user.id) });
}));
// After signing in: combine the guest cart with the saved one (keeps the larger quantity)
r.post("/cart/merge", h(async (req, res) => {
  for (const l of cartLines(req.body.items)) {
    await db.run(`INSERT INTO cart_items(user_id,item_key,qty,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id,item_key) DO UPDATE SET qty=MAX(qty,excluded.qty), updated_at=excluded.updated_at`, [req.user.id, l.key, l.qty, now()]);
  }
  res.json({ items: await readCart(req.user.id) });
}));

/* ---------- wishlist ---------- */
r.get("/wishlist", h(async (req, res) => res.json({ ids: (await db.all("SELECT product_id FROM wishlist WHERE user_id=? ORDER BY created_at DESC", [req.user.id])).map((x) => x.product_id) })));
r.put("/wishlist/:pid", h(async (req, res) => {
  await db.run("INSERT OR IGNORE INTO wishlist(user_id,product_id,created_at) VALUES(?,?,?)", [req.user.id, int(req.params.pid), now()]);
  res.json({ ok: true });
}));
r.delete("/wishlist/:pid", h(async (req, res) => {
  await db.run("DELETE FROM wishlist WHERE user_id=? AND product_id=?", [req.user.id, int(req.params.pid)]);
  res.json({ ok: true });
}));
r.post("/wishlist/merge", h(async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).slice(0, 500).map(int).filter((x) => x > 0);
  for (const id of ids) await db.run("INSERT OR IGNORE INTO wishlist(user_id,product_id,created_at) VALUES(?,?,?)", [req.user.id, id, now()]);
  res.json({ ids: (await db.all("SELECT product_id FROM wishlist WHERE user_id=?", [req.user.id])).map((x) => x.product_id) });
}));

/* ---------- addresses ---------- */
const addrOut = (a) => ({ id: a.id, name: a.name, phone: a.phone, line: a.line, landmark: a.landmark || "", pin: a.pin, city: a.city, state: a.state, isDefault: !!a.is_default });
r.get("/addresses", h(async (req, res) => res.json({ addresses: (await db.all("SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC, id DESC", [req.user.id])).map(addrOut) })));
r.post("/addresses", h(async (req, res) => {
  const a = validateAddress(req.body);
  const n = await db.get("SELECT COUNT(*) AS n FROM addresses WHERE user_id=?", [req.user.id]);
  if (n.n >= 20) throw bad("You can save up to 20 addresses");
  if (req.body.isDefault || !n.n) await db.run("UPDATE addresses SET is_default=0 WHERE user_id=?", [req.user.id]);
  const r1 = await db.run("INSERT INTO addresses(user_id,name,phone,line,landmark,pin,city,state,is_default,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [req.user.id, a.name, a.phone, a.line, a.landmark, a.pin, a.city, a.state, req.body.isDefault || !n.n ? 1 : 0, now()]);
  res.status(201).json(addrOut(await db.get("SELECT * FROM addresses WHERE id=?", [r1.lastId])));
}));
r.put("/addresses/:id", h(async (req, res) => {
  const a = validateAddress(req.body), id = int(req.params.id);
  if (!(await db.get("SELECT id FROM addresses WHERE id=? AND user_id=?", [id, req.user.id]))) throw new HttpError(404, "Address not found");
  if (req.body.isDefault) await db.run("UPDATE addresses SET is_default=0 WHERE user_id=?", [req.user.id]);
  await db.run("UPDATE addresses SET name=?,phone=?,line=?,landmark=?,pin=?,city=?,state=?,is_default=CASE WHEN ? THEN 1 ELSE is_default END WHERE id=?",
    [a.name, a.phone, a.line, a.landmark, a.pin, a.city, a.state, req.body.isDefault ? 1 : 0, id]);
  res.json(addrOut(await db.get("SELECT * FROM addresses WHERE id=?", [id])));
}));
r.delete("/addresses/:id", h(async (req, res) => {
  await db.run("DELETE FROM addresses WHERE id=? AND user_id=?", [int(req.params.id), req.user.id]);
  res.json({ ok: true });
}));

/* ---------- orders ---------- */
r.post("/orders", h(async (req, res) => res.status(201).json(await placeOrder(req.user, req.body))));
r.get("/orders", h(async (req, res) => {
  const rows = await db.all("SELECT number FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 200", [req.user.id]);
  res.json({ orders: await Promise.all(rows.map((o) => getOrder(o.number))) });
}));
r.get("/orders/:number", h(async (req, res) => res.json(await getOrder(req.params.number, { userId: req.user.id }))));
r.post("/orders/:number/cancel", h(async (req, res) => {
  const o = await getOrder(req.params.number, { userId: req.user.id });
  if (!o.canCancel) throw bad("This order can't be cancelled any more. Please call us for help.");
  await setStatus(o.number, "Cancelled", { byUser: req.user.id, note: "Cancelled by customer" });
  res.json(await getOrder(o.number, { userId: req.user.id }));
}));

export default r;
