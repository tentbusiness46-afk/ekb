import { Router } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import { db, tx, now, json, getSettings } from "../db.js";
import { h, str, int, num, phone10, validPhone, validEmail, istDayStart, istDate } from "../util.js";
import { bad, HttpError, requireStaff, hashPassword, PERMS } from "../auth.js";
import { getOrder, setStatus, STATUSES } from "../orders.js";
import { invalidate } from "../catalog.js";
import { storeProductPhoto, storeBrandLogo, deleteFile } from "../storage.js";

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 12 } });
const WLABEL = { g: "Guarantee", n: "Non-Guarantee", u: "Other" };
const like = (q) => `%${String(q).replace(/[%_]/g, "")}%`;
const requireAdmin = (req, _res, next) => (req.user?.role === "admin" ? next() : next(new HttpError(403, "Only the admin can do this", "FORBIDDEN")));
const page = (req, def = 50) => { const per = Math.min(200, Math.max(1, int(req.query.per, def))), p = Math.max(1, int(req.query.page, 1)); return { per, p, off: (p - 1) * per }; };

r.use(requireStaff());

/* =================== dashboard =================== */
r.get("/dashboard", requireStaff("dashboard"), h(async (_req, res) => {
  const today = istDayStart(), d30 = today - 29 * 864e5, mStart = (() => { const d = new Date(Date.now() + 330 * 60e3); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 330 * 60e3; })();
  const [t, m, pending, recent30, best, recent, counts] = await Promise.all([
    db.get("SELECT COUNT(*) n, COALESCE(SUM(total),0) rev FROM orders WHERE created_at>=? AND status!='Cancelled'", [today]),
    db.get("SELECT COUNT(*) n, COALESCE(SUM(total),0) rev FROM orders WHERE created_at>=? AND status!='Cancelled'", [mStart]),
    db.all("SELECT status, COUNT(*) n FROM orders WHERE status IN ('New','Confirmed','Packed','Shipped') GROUP BY status"),
    db.all("SELECT created_at, total FROM orders WHERE created_at>=? AND status!='Cancelled'", [d30]),
    db.all(`SELECT oi.product_id id, oi.name, SUM(oi.qty) qty, SUM(oi.qty*oi.price) rev, MAX(oi.image) image FROM order_items oi JOIN orders o ON o.id=oi.order_id
            WHERE o.created_at>=? AND o.status!='Cancelled' GROUP BY oi.product_id ORDER BY qty DESC LIMIT 8`, [d30]),
    db.all("SELECT number FROM orders ORDER BY created_at DESC LIMIT 8"),
    db.get(`SELECT (SELECT COUNT(*) FROM products WHERE active=1) products, (SELECT COUNT(*) FROM products WHERE active=1 AND in_stock=0) oos,
            (SELECT COUNT(*) FROM users WHERE role='customer') customers, (SELECT COUNT(*) FROM users WHERE role='customer' AND created_at>=?) newCustomers`, [d30]),
  ]);
  const days = {};
  for (let i = 0; i < 30; i++) days[istDate(d30 + i * 864e5)] = { orders: 0, revenue: 0 };
  for (const o of recent30) { const d = days[istDate(o.created_at)]; if (d) { d.orders++; d.revenue += o.total; } }
  res.json({
    today: { orders: t.n, revenue: t.rev }, month: { orders: m.n, revenue: m.rev },
    pending: Object.fromEntries(pending.map((x) => [x.status, x.n])),
    series: Object.entries(days).map(([date, v]) => ({ date, ...v })),
    bestSellers: best, counts,
    recent: await Promise.all(recent.map((o) => getOrder(o.number, { admin: true }))),
  });
}));

/* =================== orders =================== */
function orderFilter(q) {
  const w = [], a = [];
  if (q.status && STATUSES.includes(q.status)) { w.push("o.status=?"); a.push(q.status); }
  if (q.status === "open") w.push("o.status IN ('New','Confirmed','Packed','Shipped')");
  if (q.from) { w.push("o.created_at>=?"); a.push(istDayStart(Date.parse(q.from + "T00:00:00+05:30"))); }
  if (q.to) { w.push("o.created_at<?"); a.push(istDayStart(Date.parse(q.to + "T00:00:00+05:30")) + 864e5); }
  if (q.q) { w.push("(o.number LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ? OR o.customer_email LIKE ?)"); a.push(...Array(4).fill(like(q.q))); }
  if (q.customer) { w.push("o.user_id=?"); a.push(int(q.customer)); }
  return { where: w.length ? "WHERE " + w.join(" AND ") : "", args: a };
}
r.get("/orders", requireStaff("orders"), h(async (req, res) => {
  const { where, args } = orderFilter(req.query), { per, p, off } = page(req);
  const [rows, total, counts] = await Promise.all([
    db.all(`SELECT o.*, (SELECT COUNT(*) FROM order_items WHERE order_id=o.id) lines, (SELECT SUM(qty) FROM order_items WHERE order_id=o.id) units
            FROM orders o ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`, [...args, per, off]),
    db.get(`SELECT COUNT(*) n FROM orders o ${where}`, args),
    db.all("SELECT status, COUNT(*) n FROM orders GROUP BY status"),
  ]);
  res.json({
    total: total.n, page: p, per,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    orders: rows.map((o) => ({ number: o.number, status: o.status, createdAt: o.created_at, total: o.total, lines: o.lines, units: o.units, source: o.source, customer: { id: o.user_id, name: o.customer_name, phone: o.customer_phone, email: o.customer_email }, city: json(o.address, {}).city || "" })),
  });
}));
r.get("/orders/:number", requireStaff("orders"), h(async (req, res) => res.json(await getOrder(req.params.number, { admin: true }))));
r.patch("/orders/:number", requireStaff("orders"), h(async (req, res) => {
  if (req.body.note != null) await db.run("UPDATE orders SET note=?, updated_at=? WHERE number=?", [str(req.body.note, 2000), now(), req.params.number]);
  if (req.body.status) return res.json(await setStatus(req.params.number, req.body.status, { byUser: req.user.id, note: str(req.body.statusNote, 300) }));
  res.json(await getOrder(req.params.number, { admin: true }));
}));
r.get("/orders-export.xlsx", requireStaff("orders"), h(async (req, res) => {
  const { where, args } = orderFilter(req.query);
  const orders = await db.all(`SELECT o.* FROM orders o ${where} ORDER BY o.created_at DESC LIMIT 20000`, args);
  const items = orders.length ? await db.all(`SELECT oi.*, o.number FROM order_items oi JOIN orders o ON o.id=oi.order_id ${where} ORDER BY o.created_at DESC, oi.id`, args) : [];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Orders");
  ws.columns = [
    { header: "Order", key: "number", width: 14 }, { header: "Date", key: "date", width: 18 }, { header: "Status", key: "status", width: 12 },
    { header: "Customer", key: "name", width: 22 }, { header: "Phone", key: "phone", width: 14 }, { header: "Email", key: "email", width: 26 },
    { header: "Address", key: "address", width: 48 }, { header: "Pincode", key: "pin", width: 9 }, { header: "City", key: "city", width: 14 }, { header: "State", key: "state", width: 14 },
    { header: "Items", key: "items", width: 60 }, { header: "Total (₹)", key: "total", width: 11 }, { header: "Payment", key: "payment", width: 9 }, { header: "From", key: "source", width: 7 }, { header: "Note", key: "note", width: 30 },
  ];
  const byOrder = items.reduce((m, i) => ((m[i.number] ||= []).push(`${i.name}${i.label ? ` (${i.label})` : ""} × ${i.qty}`), m), {});
  for (const o of orders) {
    const a = json(o.address, {});
    ws.addRow({ number: o.number, date: new Date(o.created_at + 330 * 60e3).toISOString().slice(0, 16).replace("T", " "), status: o.status, name: o.customer_name, phone: o.customer_phone, email: o.customer_email,
      address: [a.line, a.landmark].filter(Boolean).join(", "), pin: a.pin, city: a.city, state: a.state, items: (byOrder[o.number] || []).join("; "), total: o.total, payment: o.payment, source: o.source, note: o.note || "" });
  }
  const wi = wb.addWorksheet("Order items");
  wi.columns = [{ header: "Order", key: "number", width: 14 }, { header: "Product ID", key: "product_id", width: 10 }, { header: "Product", key: "name", width: 50 }, { header: "Option", key: "label", width: 16 }, { header: "SKU", key: "sku", width: 12 }, { header: "Price (₹)", key: "price", width: 10 }, { header: "Qty", key: "qty", width: 6 }, { header: "Line total (₹)", key: "line", width: 13 }];
  for (const i of items) wi.addRow({ ...i, line: i.price * i.qty });
  for (const s of [ws, wi]) { s.getRow(1).font = { bold: true }; s.views = [{ state: "frozen", ySplit: 1 }]; }
  res.set("Content-Disposition", `attachment; filename="ekarolbagh-orders-${istDate(Date.now())}.xlsx"`).type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await wb.xlsx.write(res); res.end();
}));

/* =================== products =================== */
async function brandId(t, name) {
  name = str(name, 60);
  if (!name || /^other brands?$/i.test(name)) return null;
  const b = await t.get("SELECT id FROM brands WHERE name=?", [name]);
  return b ? b.id : (await t.run("INSERT INTO brands(name) VALUES(?)", [name])).lastId;
}
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

r.get("/products", requireStaff("products"), h(async (req, res) => {
  const q = req.query, w = [], a = [];
  if (q.q) { w.push("(p.name LIKE ? OR p.sku LIKE ? OR b.name LIKE ? OR CAST(p.id AS TEXT)=?)"); a.push(like(q.q), like(q.q), like(q.q), String(q.q).trim()); }
  if (q.cat) { w.push("p.cat_id=?"); a.push(int(q.cat)); }
  if (["g", "n", "u"].includes(q.warranty)) { w.push("p.warranty=?"); a.push(q.warranty); }
  if (q.brand) { w.push(q.brand === "none" ? "p.brand_id IS NULL" : "p.brand_id=?"); if (q.brand !== "none") a.push(int(q.brand)); }
  if (q.stock === "in") w.push("p.in_stock=1"); if (q.stock === "out") w.push("p.in_stock=0");
  if (q.active === "1") w.push("p.active=1"); if (q.active === "0") w.push("p.active=0");
  if (q.deal === "1") w.push("p.deal=1");
  if (q.noprice === "1") w.push("(p.price IS NULL OR p.price<=0)");
  const where = w.length ? "WHERE " + w.join(" AND ") : "";
  const sort = { name: "p.name", price: "p.price", priceDesc: "p.price DESC", updated: "p.updated_at DESC" }[q.sort] || "p.id DESC";
  const { per, p, off } = page(req);
  const from = "FROM products p LEFT JOIN brands b ON b.id=p.brand_id LEFT JOIN categories c ON c.id=p.cat_id";
  const [rows, total] = await Promise.all([
    db.all(`SELECT p.id,p.name,p.cat_id,c.name cat,p.warranty,p.brand_id,b.name brand,p.price,p.mrp,p.in_stock,p.stock_qty,p.deal,p.active,p.sku,p.updated_at,
            (SELECT small_url FROM product_images WHERE product_id=p.id ORDER BY sort,id LIMIT 1) image,
            (SELECT COUNT(*) FROM variations WHERE product_id=p.id) variations ${from} ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`, [...a, per, off]),
    db.get(`SELECT COUNT(*) n ${from} ${where}`, a),
  ]);
  res.json({ total: total.n, page: p, per, products: rows });
}));

async function fullProduct(id) {
  const p = await db.get("SELECT p.*, b.name brand FROM products p LEFT JOIN brands b ON b.id=p.brand_id WHERE p.id=?", [id]);
  if (!p) throw new HttpError(404, "Product not found");
  const [images, variations, reviews] = await Promise.all([
    db.all("SELECT id,small_url,large_url,alt,sort FROM product_images WHERE product_id=? ORDER BY sort,id", [id]),
    db.all("SELECT * FROM variations WHERE product_id=? ORDER BY id", [id]),
    db.get("SELECT COUNT(*) n FROM reviews WHERE product_id=?", [id]),
  ]);
  return { ...p, attributes: json(p.attributes, []), tags: json(p.tags, []), images, variations: variations.map((v) => ({ ...v, attributes: json(v.attributes, {}) })), reviewCount: reviews.n };
}
r.get("/products/:id", requireStaff("products"), h(async (req, res) => res.json(await fullProduct(int(req.params.id)))));

function productFields(b) {
  const f = {
    name: str(b.name, 200), cat_id: int(b.cat_id), warranty: ["g", "n", "u"].includes(b.warranty) ? b.warranty : "u",
    price: num(b.price), mrp: num(b.mrp), in_stock: b.in_stock ? 1 : 0, stock_qty: b.stock_qty === "" || b.stock_qty == null ? null : Math.max(0, int(b.stock_qty)),
    purchasable: b.purchasable === false || b.purchasable === 0 ? 0 : 1, sku: str(b.sku, 60), short_html: String(b.short_html ?? "").slice(0, 20000), desc_html: String(b.desc_html ?? "").slice(0, 100000),
    weight: str(b.weight, 40), dimensions: str(b.dimensions, 60), deal: b.deal ? 1 : 0, active: b.active === false || b.active === 0 ? 0 : 1,
    tags: JSON.stringify((Array.isArray(b.tags) ? b.tags : String(b.tags || "").split(",")).map((t) => str(t, 60)).filter(Boolean).slice(0, 40)),
    attributes: JSON.stringify((Array.isArray(b.attributes) ? b.attributes : []).map((a) => ({ name: str(a.name, 60), values: (a.values || []).map((v) => str(v, 60)).filter(Boolean), variation: !!a.variation })).filter((a) => a.name)),
  };
  if (!f.name) throw bad("Please enter the product name");
  if (!f.cat_id) throw bad("Please choose a category");
  if (f.price != null && f.price < 0) throw bad("Price can't be negative");
  if (f.mrp != null && f.price != null && f.mrp && f.mrp < f.price) throw bad("MRP should be equal to or more than the price");
  if (f.stock_qty === 0) f.in_stock = 0;
  return f;
}
async function saveVariations(t, pid, list) {
  if (!Array.isArray(list)) return;
  const keep = [];
  for (const v of list.slice(0, 100)) {
    const vals = [JSON.stringify(v.attributes || {}), str(v.sku, 60), num(v.price), num(v.mrp), v.in_stock === false || v.in_stock === 0 ? 0 : 1, v.stock_qty === "" || v.stock_qty == null ? null : Math.max(0, int(v.stock_qty))];
    if (v.id && (await t.get("SELECT id FROM variations WHERE id=? AND product_id=?", [int(v.id), pid]))) {
      await t.run("UPDATE variations SET attributes=?,sku=?,price=?,mrp=?,in_stock=?,stock_qty=? WHERE id=?", [...vals, int(v.id)]); keep.push(int(v.id));
    } else keep.push((await t.run("INSERT INTO variations(product_id,attributes,sku,price,mrp,in_stock,stock_qty) VALUES(?,?,?,?,?,?,?)", [pid, ...vals])).lastId);
  }
  await t.run(`DELETE FROM variations WHERE product_id=? ${keep.length ? `AND id NOT IN (${keep.map(() => "?").join(",")})` : ""}`, [pid, ...keep]);
}
r.post("/products", requireStaff("products"), h(async (req, res) => {
  const f = productFields(req.body);
  if (!(await db.get("SELECT id FROM categories WHERE id=?", [f.cat_id]))) throw bad("That category doesn't exist");
  const id = await tx(async (t) => {
    const bid = await brandId(t, req.body.brand);
    const r1 = await t.run(`INSERT INTO products(name,slug,cat_id,warranty,brand_id,price,mrp,in_stock,stock_qty,purchasable,sku,short_html,desc_html,weight,dimensions,deal,active,tags,attributes,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [f.name, slugify(f.name), f.cat_id, f.warranty, bid, f.price, f.mrp, f.in_stock, f.stock_qty, f.purchasable, f.sku, f.short_html, f.desc_html, f.weight, f.dimensions, f.deal, f.active, f.tags, f.attributes, now(), now()]);
    await saveVariations(t, r1.lastId, req.body.variations);
    return r1.lastId;
  });
  invalidate();
  res.status(201).json(await fullProduct(id));
}));
r.put("/products/:id", requireStaff("products"), h(async (req, res) => {
  const id = int(req.params.id), f = productFields(req.body);
  if (!(await db.get("SELECT id FROM products WHERE id=?", [id]))) throw new HttpError(404, "Product not found");
  await tx(async (t) => {
    const bid = await brandId(t, req.body.brand);
    await t.run(`UPDATE products SET name=?,cat_id=?,warranty=?,brand_id=?,price=?,mrp=?,in_stock=?,stock_qty=?,purchasable=?,sku=?,short_html=?,desc_html=?,weight=?,dimensions=?,deal=?,active=?,tags=?,attributes=?,updated_at=? WHERE id=?`,
      [f.name, f.cat_id, f.warranty, bid, f.price, f.mrp, f.in_stock, f.stock_qty, f.purchasable, f.sku, f.short_html, f.desc_html, f.weight, f.dimensions, f.deal, f.active, f.tags, f.attributes, now(), id]);
    if (req.body.variations) await saveVariations(t, id, req.body.variations);
  });
  invalidate();
  res.json(await fullProduct(id));
}));
// Quick edits from the product list: [{id, price, mrp, in_stock, stock_qty, deal, active}]
r.patch("/products", requireStaff("products"), h(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 1000) : [];
  let n = 0;
  await tx(async (t) => {
    for (const it of items) {
      const sets = [], a = [];
      if ("price" in it) { sets.push("price=?"); a.push(num(it.price)); }
      if ("mrp" in it) { sets.push("mrp=?"); a.push(num(it.mrp)); }
      if ("in_stock" in it) { sets.push("in_stock=?"); a.push(it.in_stock ? 1 : 0); }
      if ("stock_qty" in it) { const q = it.stock_qty === "" || it.stock_qty == null ? null : Math.max(0, int(it.stock_qty)); sets.push("stock_qty=?"); a.push(q); if (q === 0) sets.push("in_stock=0"); }
      if ("deal" in it) { sets.push("deal=?"); a.push(it.deal ? 1 : 0); }
      if ("active" in it) { sets.push("active=?"); a.push(it.active ? 1 : 0); }
      if (!sets.length) continue;
      n += (await t.run(`UPDATE products SET ${sets.join(",")}, updated_at=? WHERE id=?`, [...a, now(), int(it.id)])).changes;
    }
  });
  invalidate();
  res.json({ updated: n });
}));
r.delete("/products/:id", requireStaff("products"), h(async (req, res) => {
  const id = int(req.params.id);
  const used = await db.get("SELECT 1 x FROM order_items WHERE product_id=? LIMIT 1", [id]);
  if (used) { // keep it for order history; just hide it
    await db.run("UPDATE products SET active=0, updated_at=? WHERE id=?", [now(), id]);
    invalidate(); return res.json({ hidden: true });
  }
  const imgs = await db.all("SELECT small_key,large_key FROM product_images WHERE product_id=?", [id]);
  await tx(async (t) => {
    for (const tbl of ["product_images", "variations", "reviews", "wishlist"]) await t.run(`DELETE FROM ${tbl} WHERE product_id=?`, [id]);
    await t.run("DELETE FROM products WHERE id=?", [id]);
  });
  for (const i of imgs) { deleteFile(i.small_key); deleteFile(i.large_key); }
  invalidate();
  res.json({ deleted: true });
}));

/* photos */
r.post("/products/:id/images", requireStaff("products"), upload.array("photos", 12), h(async (req, res) => {
  const id = int(req.params.id);
  if (!(await db.get("SELECT id FROM products WHERE id=?", [id]))) throw new HttpError(404, "Product not found");
  if (!req.files?.length) throw bad("Choose at least one photo");
  let sort = (await db.get("SELECT COALESCE(MAX(sort),-1) m FROM product_images WHERE product_id=?", [id])).m;
  const failed = [];
  for (const f of req.files) {
    try {
      const s = await storeProductPhoto(id, f.buffer);
      await db.run("INSERT INTO product_images(product_id,sort,small_url,large_url,small_key,large_key,alt) VALUES(?,?,?,?,?,?,?)", [id, ++sort, s.small_url, s.large_url, s.small_key, s.large_key, ""]);
    } catch { failed.push(f.originalname); }
  }
  invalidate();
  res.json({ images: (await fullProduct(id)).images, failed });
}));
r.delete("/products/:id/images/:img", requireStaff("products"), h(async (req, res) => {
  const im = await db.get("SELECT * FROM product_images WHERE id=? AND product_id=?", [int(req.params.img), int(req.params.id)]);
  if (im) { await db.run("DELETE FROM product_images WHERE id=?", [im.id]); deleteFile(im.small_key); deleteFile(im.large_key); invalidate(); }
  res.json({ images: (await fullProduct(int(req.params.id))).images });
}));
r.put("/products/:id/images/order", requireStaff("products"), h(async (req, res) => {
  const ids = (req.body.ids || []).map(int);
  await tx(async (t) => { for (let i = 0; i < ids.length; i++) await t.run("UPDATE product_images SET sort=? WHERE id=? AND product_id=?", [i, ids[i], int(req.params.id)]); });
  invalidate();
  res.json({ images: (await fullProduct(int(req.params.id))).images });
}));

/* bulk edit via Excel */
const XCOLS = [["ID", "id", 8], ["Name", "name", 50], ["Category", "cat", 16], ["Warranty", "warranty", 14], ["Brand", "brand", 16], ["Price", "price", 9], ["MRP", "mrp", 9], ["In stock", "in_stock", 9], ["Stock qty", "stock_qty", 9], ["SKU", "sku", 12], ["Deal", "deal", 7], ["Active", "active", 7]];
r.get("/products-export.xlsx", requireStaff("products"), h(async (_req, res) => {
  const rows = await db.all("SELECT p.*, c.name cat, b.name brand FROM products p LEFT JOIN categories c ON c.id=p.cat_id LEFT JOIN brands b ON b.id=p.brand_id ORDER BY c.sort, c.name, p.warranty, b.name, p.name");
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet("Products");
  ws.columns = XCOLS.map(([header, key, width]) => ({ header, key, width }));
  const yn = (v) => (v ? "yes" : "no");
  for (const p of rows) ws.addRow({ ...p, warranty: WLABEL[p.warranty], brand: p.brand || "", in_stock: yn(p.in_stock), deal: yn(p.deal), active: yn(p.active), stock_qty: p.stock_qty ?? "" });
  ws.getRow(1).font = { bold: true }; ws.views = [{ state: "frozen", ySplit: 1, xSplit: 2 }];
  const help = wb.addWorksheet("How to use");
  ["Edit the Products sheet and upload it back in Admin → Products → Import from Excel.", "Change any cell; leave ID as it is so the right product is updated.", "To add a new product, leave ID empty and fill at least Name and Category.",
    "Warranty: Guarantee, Non-Guarantee or Other. In stock / Deal / Active: yes or no.", "Stock qty is optional: leave it empty if you don't count stock. At 0 the product becomes out of stock.", "New brand names are created automatically. Categories must already exist."].forEach((l) => help.addRow([l]));
  help.getColumn(1).width = 110;
  res.set("Content-Disposition", `attachment; filename="ekarolbagh-products-${istDate(Date.now())}.xlsx"`).type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await wb.xlsx.write(res); res.end();
}));
r.post("/products-import", requireStaff("products"), upload.single("file"), h(async (req, res) => {
  if (!req.file) throw bad("Choose an Excel file");
  const apply = req.query.apply === "1";
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(req.file.buffer); } catch { throw bad("That file isn't a valid Excel (.xlsx) file"); }
  const ws = wb.getWorksheet("Products") || wb.worksheets[0];
  const head = {}; ws.getRow(1).eachCell((c, i) => { head[String(c.value || "").trim().toLowerCase()] = i; });
  const col = (row, name) => { const i = head[name.toLowerCase()]; if (!i) return undefined; let v = row.getCell(i).value; if (v && typeof v === "object") v = v.result ?? v.text ?? (v.richText ? v.richText.map((x) => x.text).join("") : ""); return v == null ? "" : String(v).trim(); };
  if (!head.name && !head.id) throw bad("The first row must have the column names (ID, Name, Category, …)");
  const cats = await db.all("SELECT id,name FROM categories"), catBy = Object.fromEntries(cats.map((c) => [c.name.toLowerCase(), c.id]));
  const existing = Object.fromEntries((await db.all("SELECT p.*, b.name brand FROM products p LEFT JOIN brands b ON b.id=p.brand_id")).map((p) => [p.id, p]));
  const wl = (v) => { v = String(v || "").toLowerCase().replace(/[^a-z]/g, ""); return v.startsWith("non") ? "n" : v.startsWith("guar") || v === "g" ? "g" : v === "" ? undefined : "u"; };
  const yn = (v) => (v === undefined || v === "" ? undefined : /^(y|yes|true|1)$/i.test(v) ? 1 : 0);
  const changes = [], creates = [], errors = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const idS = col(row, "ID"), name = col(row, "Name");
    if (!idS && !name) return;
    const f = {};
    if (name !== undefined && name !== "") f.name = name.slice(0, 200);
    const cat = col(row, "Category"); if (cat) { if (!catBy[cat.toLowerCase()]) { errors.push({ row: n, error: `Unknown category "${cat}"` }); return; } f.cat_id = catBy[cat.toLowerCase()]; }
    const w = wl(col(row, "Warranty")); if (w) f.warranty = w;
    const br = col(row, "Brand"); if (br !== undefined) f.brand = br;
    for (const k of ["Price", "MRP"]) { const v = col(row, k); if (v !== undefined) { if (v !== "" && !Number.isFinite(Number(v))) { errors.push({ row: n, error: `${k} "${v}" isn't a number` }); return; } f[k.toLowerCase()] = v === "" ? null : Number(v); } }
    const sq = col(row, "Stock qty"); if (sq !== undefined) f.stock_qty = sq === "" ? null : Math.max(0, int(sq));
    for (const [k, key] of [["In stock", "in_stock"], ["Deal", "deal"], ["Active", "active"]]) { const v = yn(col(row, k)); if (v !== undefined) f[key] = v; }
    const sku = col(row, "SKU"); if (sku !== undefined) f.sku = sku.slice(0, 60);
    if (f.stock_qty === 0) f.in_stock = 0;
    if (idS) {
      const p = existing[int(idS)];
      if (!p) { errors.push({ row: n, error: `No product with ID ${idS}` }); return; }
      const diff = {};
      for (const [k, v] of Object.entries(f)) { const cur = k === "brand" ? p.brand || "" : p[k]; if (String(cur ?? "") !== String(v ?? "")) diff[k] = { from: cur ?? "", to: v ?? "" }; }
      if (Object.keys(diff).length) changes.push({ row: n, id: p.id, name: p.name, diff });
    } else {
      if (!f.name || !f.cat_id) { errors.push({ row: n, error: "New products need at least Name and Category" }); return; }
      creates.push({ row: n, ...f });
    }
  });
  if (apply && !errors.length) {
    await tx(async (t) => {
      for (const c of changes) {
        const sets = [], a = [];
        for (const [k, d] of Object.entries(c.diff)) { if (k === "brand") { sets.push("brand_id=?"); a.push(await brandId(t, d.to)); } else { sets.push(`${k}=?`); a.push(d.to === "" ? null : d.to); } }
        await t.run(`UPDATE products SET ${sets.join(",")}, updated_at=? WHERE id=?`, [...a, now(), c.id]);
      }
      for (const f of creates) {
        await t.run(`INSERT INTO products(name,slug,cat_id,warranty,brand_id,price,mrp,in_stock,stock_qty,sku,deal,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [f.name, slugify(f.name), f.cat_id, f.warranty || "u", await brandId(t, f.brand), f.price ?? null, f.mrp ?? null, f.in_stock ?? 1, f.stock_qty ?? null, f.sku || "", f.deal ?? 0, f.active ?? 1, now(), now()]);
      }
    });
    invalidate();
  }
  res.json({ applied: apply && !errors.length, updated: changes.length, created: creates.length, errors, changes: changes.slice(0, 200), creates: creates.slice(0, 50) });
}));

/* =================== categories & brands =================== */
r.get("/categories", requireStaff("products"), h(async (_req, res) => res.json({
  categories: await db.all(`SELECT c.*, (SELECT COUNT(*) FROM products WHERE cat_id=c.id) products, (SELECT COUNT(*) FROM products WHERE cat_id=c.id AND warranty='g') g, (SELECT COUNT(*) FROM products WHERE cat_id=c.id AND warranty='n') n FROM categories c ORDER BY c.sort, c.name`),
})));
r.post("/categories", requireStaff("products"), h(async (req, res) => {
  const name = str(req.body.name, 60); if (!name) throw bad("Please enter a name");
  const m = (await db.get("SELECT COALESCE(MAX(sort),0) m FROM categories")).m;
  const r1 = await db.run("INSERT INTO categories(name,slug,icon,sort,active) VALUES(?,?,?,?,1)", [name, slugify(name) + "-" + Date.now().toString(36), str(req.body.icon, 30) || "others", m + 1]);
  invalidate(); res.status(201).json(await db.get("SELECT * FROM categories WHERE id=?", [r1.lastId]));
}));
r.put("/categories/:id", requireStaff("products"), h(async (req, res) => {
  const id = int(req.params.id), c = await db.get("SELECT * FROM categories WHERE id=?", [id]);
  if (!c) throw new HttpError(404, "Category not found");
  const name = req.body.name != null ? str(req.body.name, 60) : c.name; if (!name) throw bad("Please enter a name");
  const rank = req.body.home_rank === undefined ? c.home_rank : req.body.home_rank ? Math.min(4, Math.max(1, int(req.body.home_rank))) : null;
  await tx(async (t) => {
    if (rank) await t.run("UPDATE categories SET home_rank=NULL WHERE home_rank=? AND id!=?", [rank, id]); // one category per Home slot
    await t.run("UPDATE categories SET name=?, icon=?, active=?, home_rank=? WHERE id=?", [name, req.body.icon != null ? str(req.body.icon, 30) : c.icon, req.body.active === undefined ? c.active : req.body.active ? 1 : 0, rank, id]);
  });
  invalidate(); res.json(await db.get("SELECT * FROM categories WHERE id=?", [id]));
}));
r.put("/categories-order", requireStaff("products"), h(async (req, res) => {
  const ids = (req.body.ids || []).map(int);
  await tx(async (t) => { for (let i = 0; i < ids.length; i++) await t.run("UPDATE categories SET sort=? WHERE id=?", [i + 1, ids[i]]); });
  invalidate(); res.json({ ok: true });
}));
r.delete("/categories/:id", requireStaff("products"), h(async (req, res) => {
  const n = await db.get("SELECT COUNT(*) n FROM products WHERE cat_id=?", [int(req.params.id)]);
  if (n.n) throw bad(`Move or delete its ${n.n} products first`);
  await db.run("DELETE FROM categories WHERE id=?", [int(req.params.id)]); invalidate(); res.json({ ok: true });
}));
r.get("/brands", requireStaff("products"), h(async (_req, res) => res.json({
  brands: await db.all("SELECT b.*, (SELECT COUNT(*) FROM products WHERE brand_id=b.id) products FROM brands b ORDER BY b.name"),
  unbranded: (await db.get("SELECT COUNT(*) n FROM products WHERE brand_id IS NULL")).n,
})));
r.post("/brands", requireStaff("products"), h(async (req, res) => {
  const name = str(req.body.name, 60); if (!name) throw bad("Please enter a name");
  if (await db.get("SELECT id FROM brands WHERE name=?", [name])) throw bad("That brand already exists");
  res.status(201).json(await db.get("SELECT * FROM brands WHERE id=?", [(await db.run("INSERT INTO brands(name) VALUES(?)", [name])).lastId]));
}));
// Renaming to a name that already exists merges the two brands
r.put("/brands/:id", requireStaff("products"), h(async (req, res) => {
  const id = int(req.params.id), name = str(req.body.name, 60);
  if (!name) throw bad("Please enter a name");
  const other = await db.get("SELECT id FROM brands WHERE name=? AND id!=?", [name, id]);
  await tx(async (t) => {
    if (other) {
      await t.run("UPDATE products SET brand_id=? WHERE brand_id=?", [other.id, id]);
      await t.run("UPDATE brands SET logo_url=COALESCE(logo_url,(SELECT logo_url FROM brands WHERE id=?)), logo_key=COALESCE(logo_key,(SELECT logo_key FROM brands WHERE id=?)) WHERE id=?", [id, id, other.id]); // keep a logo if only the merged one had it
      await t.run("DELETE FROM brands WHERE id=?", [id]);
    }
    else await t.run("UPDATE brands SET name=? WHERE id=?", [name, id]);
  });
  invalidate(); res.json({ merged: !!other });
}));
r.post("/brands/:id/logo", requireStaff("products"), upload.single("logo"), h(async (req, res) => {
  const id = int(req.params.id), b = await db.get("SELECT * FROM brands WHERE id=?", [id]);
  if (!b) throw new HttpError(404, "Brand not found");
  if (!req.file) throw bad("Choose an image");
  let s; try { s = await storeBrandLogo(id, req.file.buffer); } catch { throw bad("That file isn't an image"); }
  await db.run("UPDATE brands SET logo_url=?, logo_key=? WHERE id=?", [s.logo_url, s.logo_key, id]);
  if (b.logo_key && b.logo_key !== s.logo_key) deleteFile(b.logo_key);
  invalidate(); res.json({ logo_url: s.logo_url });
}));
r.delete("/brands/:id/logo", requireStaff("products"), h(async (req, res) => {
  const b = await db.get("SELECT * FROM brands WHERE id=?", [int(req.params.id)]);
  if (b) { await db.run("UPDATE brands SET logo_url=NULL, logo_key=NULL WHERE id=?", [b.id]); deleteFile(b.logo_key); invalidate(); }
  res.json({ ok: true });
}));
r.delete("/brands/:id", requireStaff("products"), h(async (req, res) => {
  const n = await db.get("SELECT COUNT(*) n FROM products WHERE brand_id=?", [int(req.params.id)]);
  if (n.n) throw bad(`${n.n} products use this brand. Rename it into another brand to merge instead.`);
  await db.run("DELETE FROM brands WHERE id=?", [int(req.params.id)]); res.json({ ok: true });
}));

/* =================== customers =================== */
r.get("/customers", requireStaff("customers"), h(async (req, res) => {
  const w = ["u.role='customer'"], a = [];
  if (req.query.q) { w.push("(u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)"); a.push(like(req.query.q), like(req.query.q), like(req.query.q)); }
  if (req.query.blocked === "1") w.push("u.blocked=1");
  const { per, p, off } = page(req);
  const sort = { spent: "spent DESC", orders: "orders DESC", name: "u.name" }[req.query.sort] || "u.created_at DESC";
  const [rows, total] = await Promise.all([
    db.all(`SELECT u.id,u.name,u.email,u.phone,u.blocked,u.created_at,u.last_login,
      (SELECT COUNT(*) FROM orders WHERE user_id=u.id) orders, (SELECT COALESCE(SUM(total),0) FROM orders WHERE user_id=u.id AND status!='Cancelled') spent,
      (SELECT MAX(created_at) FROM orders WHERE user_id=u.id) last_order FROM users u WHERE ${w.join(" AND ")} ORDER BY ${sort} LIMIT ? OFFSET ?`, [...a, per, off]),
    db.get(`SELECT COUNT(*) n FROM users u WHERE ${w.join(" AND ")}`, a),
  ]);
  res.json({ total: total.n, page: p, per, customers: rows });
}));
r.get("/customers/:id", requireStaff("customers"), h(async (req, res) => {
  const id = int(req.params.id);
  const u = await db.get("SELECT id,name,email,phone,blocked,created_at,last_login FROM users WHERE id=? AND role='customer'", [id]);
  if (!u) throw new HttpError(404, "Customer not found");
  const [addresses, orders, wl] = await Promise.all([
    db.all("SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC, id DESC", [id]),
    db.all("SELECT number FROM orders WHERE user_id=? ORDER BY created_at DESC", [id]),
    db.get("SELECT COUNT(*) n FROM wishlist WHERE user_id=?", [id]),
  ]);
  res.json({ ...u, addresses, wishlist: wl.n, orders: await Promise.all(orders.map((o) => getOrder(o.number, { admin: true }))) });
}));
r.patch("/customers/:id", requireStaff("customers"), h(async (req, res) => {
  const id = int(req.params.id);
  if (req.body.blocked !== undefined) {
    await db.run("UPDATE users SET blocked=? WHERE id=? AND role='customer'", [req.body.blocked ? 1 : 0, id]);
    if (req.body.blocked) await db.run("DELETE FROM sessions WHERE user_id=?", [id]); // signs them out everywhere
  }
  res.json(await db.get("SELECT id,name,email,phone,blocked FROM users WHERE id=?", [id]));
}));

/* =================== staff (admin only) =================== */
const staffOut = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, perms: u.role === "admin" ? PERMS : json(u.perms, []), blocked: !!u.blocked, last_login: u.last_login, created_at: u.created_at });
r.get("/staff", requireAdmin, h(async (_req, res) => res.json({ staff: (await db.all("SELECT * FROM users WHERE role IN ('admin','staff') ORDER BY role, name")).map(staffOut), perms: PERMS })));
r.post("/staff", requireAdmin, h(async (req, res) => {
  const name = str(req.body.name, 80), email = str(req.body.email, 120).toLowerCase(), pw = String(req.body.password || "");
  const role = req.body.role === "admin" ? "admin" : "staff", perms = (req.body.perms || []).filter((p) => PERMS.includes(p) && p !== "staff");
  if (!name) throw bad("Please enter a name");
  if (!validEmail(email)) throw bad("Please enter a valid email");
  const ex = await db.get("SELECT * FROM users WHERE email=?", [email]);
  if (ex && ex.role !== "customer") throw bad("This person already has admin access");
  if (!ex && pw.length < 8) throw bad("Password must be at least 8 characters");
  if (ex) await db.run("UPDATE users SET role=?, perms=?, blocked=0, name=? WHERE id=?", [role, JSON.stringify(perms), name, ex.id]); // give an existing customer account staff access
  else await db.run("INSERT INTO users(name,email,phone,pass_hash,role,perms,created_at) VALUES(?,?,?,?,?,?,?)", [name, email, "", await hashPassword(pw), role, JSON.stringify(perms), now()]);
  res.status(201).json(staffOut(await db.get("SELECT * FROM users WHERE email=?", [email])));
}));
r.put("/staff/:id", requireAdmin, h(async (req, res) => {
  const id = int(req.params.id), u = await db.get("SELECT * FROM users WHERE id=? AND role IN ('admin','staff')", [id]);
  if (!u) throw new HttpError(404, "Not found");
  const role = req.body.role === "admin" ? "admin" : req.body.role === "staff" ? "staff" : u.role;
  if (u.role === "admin" && role !== "admin" && (await db.get("SELECT COUNT(*) n FROM users WHERE role='admin' AND blocked=0")).n <= 1) throw bad("There must be at least one admin");
  const perms = req.body.perms ? req.body.perms.filter((p) => PERMS.includes(p) && p !== "staff") : json(u.perms, []);
  await db.run("UPDATE users SET name=?, role=?, perms=?, blocked=? WHERE id=?", [str(req.body.name, 80) || u.name, role, JSON.stringify(perms), req.body.blocked === undefined ? u.blocked : req.body.blocked ? 1 : 0, id]);
  if (req.body.password) { if (String(req.body.password).length < 8) throw bad("Password must be at least 8 characters"); await db.run("UPDATE users SET pass_hash=? WHERE id=?", [await hashPassword(String(req.body.password)), id]); }
  if (req.body.blocked) await db.run("DELETE FROM sessions WHERE user_id=?", [id]);
  res.json(staffOut(await db.get("SELECT * FROM users WHERE id=?", [id])));
}));
r.delete("/staff/:id", requireAdmin, h(async (req, res) => {
  const id = int(req.params.id);
  if (id === req.user.id) throw bad("You can't remove your own access");
  const u = await db.get("SELECT role FROM users WHERE id=?", [id]);
  if (u?.role === "admin" && (await db.get("SELECT COUNT(*) n FROM users WHERE role='admin'")).n <= 1) throw bad("There must be at least one admin");
  await db.run("UPDATE users SET role='customer', perms='[]' WHERE id=?", [id]); // keeps their shopping account
  await db.run("DELETE FROM sessions WHERE user_id=?", [id]);
  res.json({ ok: true });
}));

/* =================== settings & policy pages =================== */
r.get("/settings", requireStaff("settings"), h(async (_req, res) => res.json(await getSettings())));
r.put("/settings", requireStaff("settings"), h(async (req, res) => {
  const b = req.body, out = {};
  if (b.store_name != null) out.store_name = str(b.store_name, 60) || "eKarolBagh";
  if (b.phone != null) { if (!validPhone(phone10(b.phone))) throw bad("Please enter a valid 10-digit phone number"); const p = phone10(b.phone); out.phone = `+91 ${p.slice(0, 5)} ${p.slice(5)}`; }
  if (b.email != null) { if (!validEmail(str(b.email))) throw bad("Please enter a valid email"); out.email = str(b.email, 120); }
  if (b.notify_email != null) { if (b.notify_email && !validEmail(str(b.notify_email))) throw bad("Please enter a valid email for order alerts"); out.notify_email = str(b.notify_email, 120); }
  if (b.min_order != null) { const m = int(b.min_order, -1); if (m < 0) throw bad("Minimum order must be a number"); out.min_order = String(m); }
  if (b.allow_cancel != null) out.allow_cancel = b.allow_cancel ? "1" : "0";
  for (const [k, v] of Object.entries(out)) await db.run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  invalidate(); res.json(await getSettings());
}));
r.get("/pages", requireStaff("settings"), h(async (_req, res) => res.json({ pages: await db.all("SELECT * FROM pages ORDER BY sort, id") })));
r.post("/pages", requireStaff("settings"), h(async (req, res) => {
  const title = str(req.body.title, 120); if (!title) throw bad("Please enter a title");
  const m = (await db.get("SELECT COALESCE(MAX(sort),0) m FROM pages")).m;
  const r1 = await db.run("INSERT INTO pages(slug,title,html,sort,active,updated_at) VALUES(?,?,?,?,1,?)", [slugify(title) + "-" + Date.now().toString(36), title, String(req.body.html || "").slice(0, 200000), m + 1, now()]);
  invalidate(); res.status(201).json(await db.get("SELECT * FROM pages WHERE id=?", [r1.lastId]));
}));
r.put("/pages/:id", requireStaff("settings"), h(async (req, res) => {
  const id = int(req.params.id), pg = await db.get("SELECT * FROM pages WHERE id=?", [id]);
  if (!pg) throw new HttpError(404, "Page not found");
  const title = req.body.title != null ? str(req.body.title, 120) : pg.title; if (!title) throw bad("Please enter a title");
  await db.run("UPDATE pages SET title=?, html=?, active=?, updated_at=? WHERE id=?", [title, req.body.html != null ? String(req.body.html).slice(0, 200000) : pg.html, req.body.active === undefined ? pg.active : req.body.active ? 1 : 0, now(), id]);
  invalidate(); res.json(await db.get("SELECT * FROM pages WHERE id=?", [id]));
}));
r.put("/pages-order", requireStaff("settings"), h(async (req, res) => {
  const ids = (req.body.ids || []).map(int);
  await tx(async (t) => { for (let i = 0; i < ids.length; i++) await t.run("UPDATE pages SET sort=? WHERE id=?", [i + 1, ids[i]]); });
  invalidate(); res.json({ ok: true });
}));
r.delete("/pages/:id", requireStaff("settings"), h(async (req, res) => { await db.run("DELETE FROM pages WHERE id=?", [int(req.params.id)]); invalidate(); res.json({ ok: true }); }));

export default r;
