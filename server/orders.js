import { db, tx, now, json, getSettings } from "./db.js";
import { bad, HttpError } from "./auth.js";
import { cartLines, validateAddress } from "./util.js";
import { sendMail, orderEmail, statusEmail } from "./email.js";
import { invalidate } from "./catalog.js";

export const STATUSES = ["New", "Confirmed", "Packed", "Shipped", "Delivered", "Cancelled"];
const inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");

/** Place a Cash-on-Delivery order. Prices, stock and the minimum are always checked here, never trusted from the client. */
export async function placeOrder(user, body) {
  const s = await getSettings();
  const min = Number(s.min_order) || 0;
  const lines = cartLines(body.items);
  if (!lines.length) throw bad("Your cart is empty", "EMPTY");
  const address = validateAddress(body.address);
  const source = body.source === "app" ? "app" : "web";
  let stockChanged = false;

  const result = await tx(async (t) => {
    const items = [];
    for (const { key, qty } of lines) {
      const [pid, vid] = key.split("-").map(Number);
      const p = await t.get("SELECT * FROM products WHERE id=? AND active=1", [pid]);
      if (!p) throw bad("A product in your cart is no longer available. Please remove it and try again.", "GONE");
      const v = vid ? await t.get("SELECT * FROM variations WHERE id=? AND product_id=?", [vid, pid]) : null;
      if (vid && !v) throw bad(`The option you chose for ${p.name} is no longer available`, "GONE");
      const price = v && v.price != null ? v.price : p.price;
      if (!(price > 0) || !p.purchasable) throw bad(`${p.name} can't be ordered online`, "NOT_FOR_SALE");
      if (!(v ? v.in_stock : p.in_stock)) throw bad(`${p.name} is out of stock`, "OOS");
      const left = v ? v.stock_qty : p.stock_qty;
      if (left != null && left < qty) throw bad(`Only ${left} left of ${p.name}`, "STOCK");
      const img = await t.get("SELECT small_url FROM product_images WHERE product_id=? ORDER BY sort, id LIMIT 1", [pid]);
      items.push({ product_id: pid, variation_id: v ? v.id : null, name: p.name, label: v ? Object.values(json(v.attributes, {})).join(" / ") : "", sku: (v && v.sku) || p.sku || "", image: img?.small_url || "", price, qty });
    }
    const itemsTotal = items.reduce((a, i) => a + i.price * i.qty, 0);
    if (itemsTotal < min) throw bad(`Minimum order value is ${inr(min)}. Add ${inr(min - itemsTotal)} more.`, "MIN_ORDER");

    const ts = now();
    const ins = await t.run(
      `INSERT INTO orders(user_id,status,items_total,delivery,total,payment,address,customer_name,customer_email,customer_phone,source,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [user.id, "New", itemsTotal, 0, itemsTotal, "COD", JSON.stringify(address), address.name, user.email, address.phone, source, ts, ts]);
    const orderId = ins.lastId, number = "EKB-" + (100000 + orderId);
    await t.run("UPDATE orders SET number=? WHERE id=?", [number, orderId]);
    for (const i of items) {
      await t.run("INSERT INTO order_items(order_id,product_id,variation_id,name,label,sku,image,price,qty) VALUES(?,?,?,?,?,?,?,?,?)",
        [orderId, i.product_id, i.variation_id, i.name, i.label, i.sku, i.image, i.price, i.qty]);
      // count down stock where a count is kept; at zero the item becomes out of stock
      const tbl = i.variation_id ? "variations" : "products", id = i.variation_id || i.product_id;
      const r = await t.run(`UPDATE ${tbl} SET stock_qty=stock_qty-?, in_stock=CASE WHEN stock_qty-?<=0 THEN 0 ELSE in_stock END WHERE id=? AND stock_qty IS NOT NULL`, [i.qty, i.qty, id]);
      if (r.changes) stockChanged = true;
    }
    await t.run("INSERT INTO order_events(order_id,status,note,by_user,created_at) VALUES(?,?,?,?,?)", [orderId, "New", "Order placed", user.id, ts]);
    // remember the address for next time
    const same = await t.get("SELECT id FROM addresses WHERE user_id=? AND name=? AND phone=? AND line=? AND pin=?", [user.id, address.name, address.phone, address.line, address.pin]);
    if (!same) {
      await t.run("UPDATE addresses SET is_default=0 WHERE user_id=?", [user.id]);
      await t.run("INSERT INTO addresses(user_id,name,phone,line,landmark,pin,city,state,is_default,created_at) VALUES(?,?,?,?,?,?,?,?,1,?)",
        [user.id, address.name, address.phone, address.line, address.landmark, address.pin, address.city, address.state, ts]);
    }
    await t.run("DELETE FROM cart_items WHERE user_id=?", [user.id]);
    return { orderId, number, items, itemsTotal };
  });

  if (stockChanged) invalidate();
  const order = { number: result.number, total: result.itemsTotal, address, customer_name: address.name, customer_phone: address.phone };
  const m = orderEmail(order, result.items);
  sendMail({ to: user.email, ...m });
  if (s.notify_email) sendMail({ to: s.notify_email, ...orderEmail(order, result.items, true) });
  return getOrder(result.number);
}

export async function getOrder(number, { userId = null, admin = false } = {}) {
  const o = await db.get("SELECT * FROM orders WHERE number=?", [number]);
  if (!o || (!admin && userId != null && o.user_id !== userId)) throw new HttpError(404, "Order not found", "NOT_FOUND");
  const [items, events] = await Promise.all([
    db.all("SELECT * FROM order_items WHERE order_id=? ORDER BY id", [o.id]),
    db.all(`SELECT e.status,e.note,e.created_at,u.name AS by_name FROM order_events e LEFT JOIN users u ON u.id=e.by_user WHERE order_id=? ORDER BY e.id`, [o.id]),
  ]);
  const s = await getSettings();
  return {
    number: o.number, status: o.status, createdAt: o.created_at, updatedAt: o.updated_at,
    itemsTotal: o.items_total, delivery: o.delivery, total: o.total, payment: o.payment, source: o.source,
    address: json(o.address, {}), customer: { id: o.user_id, name: o.customer_name, email: o.customer_email, phone: o.customer_phone },
    note: o.note || "",
    items: items.map((i) => ({ productId: i.product_id, variationId: i.variation_id, name: i.name, label: i.label, sku: i.sku, image: i.image, price: i.price, qty: i.qty })),
    events: events.map((e) => ({ status: e.status, note: e.note, at: e.created_at, ...(admin ? { by: e.by_name } : {}) })),
    canCancel: o.status === "New" && s.allow_cancel === "1",
  };
}

/** Move an order to a new status (admin, staff, or a customer cancelling). Cancelling puts counted stock back. */
export async function setStatus(number, status, { byUser, note = "" } = {}) {
  if (!STATUSES.includes(status)) throw bad("Unknown status");
  const o = await db.get("SELECT * FROM orders WHERE number=?", [number]);
  if (!o) throw new HttpError(404, "Order not found", "NOT_FOUND");
  if (o.status === status) return getOrder(number, { admin: true });
  if (o.status === "Cancelled") throw bad("This order is already cancelled");
  if (o.status === "Delivered" && status === "Cancelled") throw bad("A delivered order can't be cancelled");
  let restocked = false;
  await tx(async (t) => {
    await t.run("UPDATE orders SET status=?, updated_at=? WHERE id=?", [status, now(), o.id]);
    await t.run("INSERT INTO order_events(order_id,status,note,by_user,created_at) VALUES(?,?,?,?,?)", [o.id, status, note || null, byUser || null, now()]);
    if (status === "Cancelled") {
      for (const i of await t.all("SELECT * FROM order_items WHERE order_id=?", [o.id])) {
        const tbl = i.variation_id ? "variations" : "products", id = i.variation_id || i.product_id;
        const r = await t.run(`UPDATE ${tbl} SET stock_qty=stock_qty+?, in_stock=1 WHERE id=? AND stock_qty IS NOT NULL`, [i.qty, id]);
        if (r.changes) restocked = true;
      }
    }
  });
  if (restocked) invalidate();
  const m = statusEmail({ number: o.number, total: o.total, customer_name: o.customer_name }, status);
  if (m && o.customer_email) sendMail({ to: o.customer_email, ...m });
  return getOrder(number, { admin: true });
}
