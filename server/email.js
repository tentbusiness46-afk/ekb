import { cfg } from "./config.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");

/** Send an email through Resend; without RESEND_API_KEY it is printed to the console instead. */
export async function sendMail({ to, subject, html, text }) {
  if (!to) return;
  if (!cfg.resendKey) {
    console.log(`\n[email — not sent, RESEND_API_KEY not set]\nTo: ${to}\nSubject: ${subject}\n${text || html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}\n`);
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: cfg.mailFrom, to: [to], subject, html, text }),
    });
    if (!res.ok) console.error("Email failed:", res.status, await res.text());
  } catch (e) {
    console.error("Email failed:", e.message);
  }
}

const shell = (title, body) => `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f1b33">
<div style="background:#1456d9;color:#fff;padding:18px 22px;border-radius:12px 12px 0 0;font-size:18px;font-weight:bold">eKarolBagh</div>
<div style="border:1px solid #dbe5fa;border-top:0;padding:22px;border-radius:0 0 12px 12px"><h2 style="margin:0 0 12px;font-size:18px">${esc(title)}</h2>${body}</div></div>`;

export function resetEmail(name, link) {
  return {
    subject: "Reset your eKarolBagh password",
    html: shell("Reset your password", `<p>Hi ${esc(name)},</p><p>Tap the button below to set a new password. The link works for 1 hour.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#1456d9;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Set a new password</a></p>
<p style="color:#60708f;font-size:13px">If you didn't ask for this, you can ignore this email.</p>`),
    text: `Reset your eKarolBagh password: ${link} (valid for 1 hour)`,
  };
}

export function orderEmail(order, items, forStore = false) {
  const a = order.address;
  const rows = items.map((i) => `<tr><td style="padding:6px 0">${esc(i.name)}${i.label ? ` (${esc(i.label)})` : ""} × ${i.qty}</td><td style="text-align:right">${inr(i.price * i.qty)}</td></tr>`).join("");
  const body = `<p>${forStore ? `New order from <b>${esc(order.customer_name)}</b> (${esc(order.customer_phone)}).` : `Hi ${esc(order.customer_name)}, thanks for your order! We'll keep you posted as it moves.`}</p>
<p><b>Order ${esc(order.number)}</b> · Cash on Delivery</p>
<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}<tr><td style="padding-top:10px;border-top:1px dashed #dbe5fa"><b>Total</b></td><td style="text-align:right;padding-top:10px;border-top:1px dashed #dbe5fa"><b>${inr(order.total)}</b></td></tr></table>
<p style="margin-top:16px"><b>Deliver to</b><br>${esc(a.name)}, ${esc(a.phone)}<br>${esc(a.line)}${a.landmark ? ", " + esc(a.landmark) : ""}<br>${esc(a.city)}, ${esc(a.state)} – ${esc(a.pin)}</p>`;
  return {
    subject: forStore ? `New order ${order.number} · ${inr(order.total)}` : `Order ${order.number} placed · eKarolBagh`,
    html: shell(forStore ? "New order" : "Order placed", body),
  };
}

export function statusEmail(order, status) {
  const msg = {
    Confirmed: "Your order is confirmed.",
    Packed: "Your order is packed and will leave soon.",
    Shipped: "Your order is on its way.",
    Delivered: "Your order has been delivered. Thank you for shopping with us!",
    Cancelled: "Your order has been cancelled.",
  }[status];
  if (!msg) return null;
  return { subject: `Order ${order.number}: ${status}`, html: shell(`Order ${status}`, `<p>Hi ${esc(order.customer_name)},</p><p>${msg}</p><p>Order <b>${esc(order.number)}</b> · ${inr(order.total)} · Cash on Delivery</p>`) };
}
