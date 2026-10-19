import { db, json, getSettings } from "./db.js";

/**
 * The whole public catalogue in the shape the website and app use
 * (the same shape the scraper produced, so both frontends work unchanged).
 * Cached in memory; any admin change calls invalidate().
 */
let cache = null;
export const invalidate = () => { cache = null; };
const MAX_AGE = 30e3; // also refresh every 30 s, so changes made outside this server (npm run seed, another server) show up
const WL = { g: "Guarantee", n: "Non-Guarantee", u: "" };

export async function getCatalog() {
  if (cache && Date.now() - cache.version < MAX_AGE) return cache;
  const [cats, prods, imgs, vars, revs, pages, s, logos] = await Promise.all([
    db.all("SELECT id,name,slug,icon,home_rank FROM categories WHERE active=1 ORDER BY sort, name"),
    db.all(`SELECT p.*, b.name AS brand_name FROM products p LEFT JOIN brands b ON b.id=p.brand_id
            JOIN categories c ON c.id=p.cat_id WHERE p.active=1 AND c.active=1 ORDER BY p.sort, p.id DESC`),
    db.all("SELECT product_id,small_url,large_url,alt FROM product_images ORDER BY product_id, sort, id"),
    db.all("SELECT * FROM variations ORDER BY product_id, id"),
    db.all("SELECT product_id,reviewer,rating,text,verified,created_at FROM reviews ORDER BY created_at DESC"),
    db.all("SELECT id,slug,title,html FROM pages WHERE active=1 ORDER BY sort, id"),
    getSettings(),
    db.all("SELECT name, logo_url FROM brands WHERE logo_url IS NOT NULL AND logo_url != ''"),
  ]);
  const group = (rows, key = "product_id") => rows.reduce((m, r) => ((m[r[key]] ||= []).push(r), m), {});
  const I = group(imgs), Vr = group(vars), R = group(revs);
  const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));

  const products = prods.map((p) => {
    const reviews = (R[p.id] || []).map((r) => ({ reviewer: r.reviewer, rating: r.rating, text: r.text, verified: !!r.verified, date: new Date(r.created_at).toISOString() }));
    const brand = p.brand_name || "Other brands";
    return {
      id: p.id, name: p.name, slug: p.slug, cat: p.cat_id, g: p.warranty, brand,
      categoryPath: [catName[p.cat_id], WL[p.warranty], p.brand_name].filter(Boolean).join(" > "),
      price: p.price ?? 0, mrp: p.mrp ?? p.price ?? 0,
      inStock: !!p.in_stock, stockLeft: p.stock_qty != null && p.stock_qty > 0 && p.stock_qty <= 5 ? p.stock_qty : null,
      purchasable: !!p.purchasable, deal: !!p.deal, sku: p.sku || "",
      shortDescriptionHtml: p.short_html || "", descriptionHtml: p.desc_html || "",
      weight: p.weight || "", dimensionsText: p.dimensions || "",
      attributes: json(p.attributes, []), tags: json(p.tags, []),
      rating: reviews.length ? Math.round((reviews.reduce((t, r) => t + r.rating, 0) / reviews.length) * 10) / 10 : 0,
      reviewCount: reviews.length, reviews,
      variations: (Vr[p.id] || []).map((v) => ({ id: v.id, attributes: json(v.attributes, {}), sku: v.sku || "", price: v.price, mrp: v.mrp, inStock: !!v.in_stock, stockLeft: v.stock_qty != null && v.stock_qty > 0 && v.stock_qty <= 5 ? v.stock_qty : null })),
      images: (I[p.id] || []).map((im) => ({ webpSmall: im.small_url, webpLarge: im.large_url, thumbnail: im.small_url, src: im.large_url, alt: im.alt || "" })),
    };
  });
  const used = new Set(products.map((p) => p.cat));
  cache = {
    version: Date.now(),
    data: {
      source: "eKarolBagh", scrapedAt: new Date().toISOString(),
      categories: cats.filter((c) => used.has(c.id)).map((c) => ({ id: c.id, name: c.name, slug: c.slug, icon: c.icon || "", homeRank: c.home_rank || null })),
      products,
      pages,
      brandLogos: Object.fromEntries(logos.map((b) => [b.name, b.logo_url])),
      settings: { storeName: s.store_name, phone: s.phone, email: s.email, minOrder: Number(s.min_order) || 0, allowCancel: s.allow_cancel === "1" },
    },
  };
  return cache;
}
