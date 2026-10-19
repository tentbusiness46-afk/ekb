#!/usr/bin/env node
/**
 * Load the scraped catalogue into the database (photos go to R2 if set up, otherwise into the database too).
 *
 *   npm run seed                                   uses the ekarolbagh-export folder inside this project
 *   npm run seed -- C:\path\to\ekarolbagh-export
 *   npm run seed -- --overwrite                    also refresh products that already exist
 *
 * Safe to run again: existing products are skipped unless --overwrite is given,
 * so edits made in the admin panel are kept.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { migrate, db, batch, now } from "../server/db.js";
import { putFile, storeProductPhoto, storeBrandLogo } from "../server/storage.js";
import { cfg, ROOT } from "../server/config.js";

const args = process.argv.slice(2);
const OVERWRITE = args.includes("--overwrite");
const exists = async (f) => !!(await stat(f).catch(() => null))?.size;

async function findCatalog() {
  const given = args.find((a) => !a.startsWith("--"));
  const tries = given ? [given, path.join(given, "catalog.json")] : [path.join(ROOT, "ekarolbagh-export", "catalog.json"), "ekarolbagh-export/catalog.json", "../ekarolbagh-export/catalog.json"];
  for (const t of tries) { const f = path.resolve(t); if (f.endsWith(".json") && (await exists(f))) return f; }
  throw new Error(`catalog.json not found. Run the scraper first, then:\n  npm run seed -- <path to ekarolbagh-export folder>`);
}

const ICONS = { watch: "watch", airpods: "airpods", battery: "battery", cable: "cables", charger: "charger", headphone: "headphones", neckband: "neckband", "power bank": "powerbank", powerbank: "powerbank", speaker: "speaker", earphone: "wired" };
const iconFor = (name) => { const k = String(name).toLowerCase(); for (const [w, ic] of Object.entries(ICONS)) if (k.includes(w)) return ic; return "others"; };
const POLICY = /polic|terms|condition|refund|return|cancel|shipping|delivery|privacy|warranty|guarantee|disclaimer|exchange/i;

async function pool(items, n, fn) {
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); done++; if (done % 20 === 0 || done === items.length) process.stdout.write(`\r  products: ${done}/${items.length}   `); }
  }));
  process.stdout.write("\n");
}

await migrate();
const file = await findCatalog(), dir = path.dirname(file);
const cat = JSON.parse(await readFile(file, "utf8"));
console.log(`Seeding from ${file}\n  database: ${cfg.usingTurso ? "Turso" : "local file"} · photos: ${cfg.usingR2 ? "Cloudflare R2" : cfg.usingTurso ? "Turso" : "local database file"}`);

/* categories */
const counts = {};
for (const p of cat.products) counts[p.cat] = (counts[p.cat] || 0) + 1;
const isOthers = (c) => /^others?$/i.test(String(c.name).trim());
const cats = [...cat.categories].sort((a, b) => isOthers(a) - isOthers(b) || a.name.localeCompare(b.name)); // "Others" last
const haveRanks = (await db.get("SELECT COUNT(*) n FROM categories WHERE home_rank IS NOT NULL")).n > 0;
const top4 = haveRanks ? [] : cats.slice().sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0)).slice(0, 4).map((c) => c.id);
await batch(cats.map((c, i) => [
  `INSERT INTO categories(id,name,slug,icon,sort,home_rank,active) VALUES(?,?,?,?,?,?,1)
   ON CONFLICT(id) DO ${OVERWRITE ? "UPDATE SET name=excluded.name, slug=excluded.slug" : "NOTHING"}`,
  [c.id, c.name, c.slug || null, iconFor(c.name), i + 1, top4.includes(c.id) ? top4.indexOf(c.id) + 1 : null],
]));
console.log(`  categories: ${cats.length}`);

/* brands */
const brandNames = [...new Set(cat.products.map((p) => p.brand).filter((b) => b && b !== "Other brands"))];
await batch(brandNames.map((b) => ["INSERT OR IGNORE INTO brands(name) VALUES(?)", [b]]));
const brandId = Object.fromEntries((await db.all("SELECT id,name FROM brands")).map((b) => [b.name.toLowerCase(), b.id]));
console.log(`  brands: ${brandNames.length}`);

/* brand logos (only for brands without one, unless --overwrite) */
let logos = 0;
for (const b of cat.brands || []) {
  const row = await db.get("SELECT id, logo_url FROM brands WHERE name=?", [b.name]);
  if (!row || (row.logo_url && !OVERWRITE)) continue;
  try {
    let saved = null;
    const webp = b.webp && path.join(dir, b.webp), file = b.file && path.join(dir, b.file);
    if (webp && (await exists(webp))) { const key = `brands/${row.id}.webp`; saved = { logo_url: await putFile(key, await readFile(webp), "image/webp"), logo_key: key }; }
    else if (file && (await exists(file))) saved = await storeBrandLogo(row.id, await readFile(file));
    else if (b.src) saved = { logo_url: b.src, logo_key: null }; // still on the old website
    if (saved) { await db.run("UPDATE brands SET logo_url=?, logo_key=? WHERE id=?", [saved.logo_url, saved.logo_key, row.id]); logos++; }
  } catch (e) { console.warn(`  logo skipped for ${b.name}: ${e.message}`); }
}
console.log(`  brand logos: ${logos} added`);

/* products, photos, options, reviews */
const reviewsBy = {};
for (const r of cat.reviews || []) (reviewsBy[r.productId] ||= []).push(r);
let added = 0, refreshed = 0, skipped = 0, photos = 0, remotePhotos = 0;
const existing = new Set((await db.all("SELECT id FROM products")).map((r) => r.id));

await pool(cat.products, 4, async (p) => {
  const has = existing.has(p.id);
  if (has && !OVERWRITE) { skipped++; return; }
  // photos first (slowest part), then one batch of SQL per product
  const imgs = [];
  for (const [i, im] of (p.images || []).entries()) {
    const sm = im.webpSmall && path.join(dir, im.webpSmall), lg = im.webpLarge && path.join(dir, im.webpLarge), orig = im.file && path.join(dir, im.file);
    try {
      if (sm && lg && (await exists(sm)) && (await exists(lg))) {
        const ks = `products/${p.id}/${i + 1}-sm.webp`, kl = `products/${p.id}/${i + 1}-lg.webp`;
        imgs.push({ small_url: await putFile(ks, await readFile(sm), "image/webp"), large_url: await putFile(kl, await readFile(lg), "image/webp"), small_key: ks, large_key: kl, alt: im.alt || "" });
      } else if (orig && !orig.endsWith(".webp") && (await exists(orig))) {
        imgs.push({ ...(await storeProductPhoto(p.id, await readFile(orig))), alt: im.alt || "" });
      } else if (im.src) { // no local copy: keep the website's link for now
        imgs.push({ small_url: im.thumbnail || im.src, large_url: im.medium || im.src, small_key: null, large_key: null, alt: im.alt || "" }); remotePhotos++;
      }
      photos++;
    } catch (e) { console.warn(`\n  photo skipped for product ${p.id}: ${e.message}`); }
  }
  const t = now(), price = p.price > 0 ? p.price : null, mrp = p.mrp > 0 ? p.mrp : price;
  const vals = [p.name, p.slug || null, p.cat, ["g", "n", "u"].includes(p.g) ? p.g : "u", p.brand && p.brand !== "Other brands" ? brandId[p.brand.toLowerCase()] : null,
    price, mrp, p.inStock === false ? 0 : 1, p.purchasable === false ? 0 : 1, p.sku || "", p.shortDescriptionHtml || "", p.descriptionHtml || "",
    p.weight || "", p.dimensionsText || "", JSON.stringify(p.attributes || []), JSON.stringify(p.tags || []), p.url || null];
  const stmts = has
    ? [["UPDATE products SET name=?,slug=?,cat_id=?,warranty=?,brand_id=?,price=?,mrp=?,in_stock=?,purchasable=?,sku=?,short_html=?,desc_html=?,weight=?,dimensions=?,attributes=?,tags=?,source_url=?,updated_at=? WHERE id=?", [...vals, t, p.id]],
       ["DELETE FROM product_images WHERE product_id=?", [p.id]], ["DELETE FROM variations WHERE product_id=?", [p.id]], ["DELETE FROM reviews WHERE product_id=?", [p.id]]]
    : [["INSERT INTO products(name,slug,cat_id,warranty,brand_id,price,mrp,in_stock,purchasable,sku,short_html,desc_html,weight,dimensions,attributes,tags,source_url,created_at,updated_at,id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [...vals, t, t, p.id]]];
  imgs.forEach((im, i) => stmts.push(["INSERT INTO product_images(product_id,sort,small_url,large_url,small_key,large_key,alt) VALUES(?,?,?,?,?,?,?)", [p.id, i, im.small_url, im.large_url, im.small_key, im.large_key, im.alt]]));
  for (const v of p.variations || []) stmts.push(["INSERT INTO variations(id,product_id,attributes,sku,price,mrp,in_stock) VALUES(?,?,?,?,?,?,?)", [v.id, p.id, JSON.stringify(v.attributes || {}), v.sku || "", v.price, v.mrp, v.inStock === false ? 0 : 1]]);
  for (const r of reviewsBy[p.id] || p.reviews || []) stmts.push(["INSERT INTO reviews(product_id,reviewer,rating,text,verified,created_at) VALUES(?,?,?,?,?,?)", [p.id, r.reviewer || "", r.rating || 0, r.text || "", r.verified ? 1 : 0, Date.parse(r.date) || t]]);
  await batch(stmts);
  has ? refreshed++ : added++;
});
console.log(`  products: ${added} added, ${refreshed} refreshed, ${skipped} already there · photos: ${photos}${remotePhotos ? ` (${remotePhotos} still linked to the old website — run the scraper with sharp to get local copies)` : ""}`);

/* policy pages */
const pages = (cat.pages || []).filter((pg) => POLICY.test(`${pg.title} ${pg.slug}`) && (pg.html || "").trim());
let pAdded = 0;
for (const [i, pg] of pages.entries()) {
  const r = await db.run(`INSERT INTO pages(slug,title,html,sort,active,updated_at) VALUES(?,?,?,?,1,?) ON CONFLICT(slug) DO ${OVERWRITE ? "UPDATE SET title=excluded.title, html=excluded.html" : "NOTHING"}`, [pg.slug, pg.title, pg.html, i + 1, now()]);
  pAdded += r.changes;
}
console.log(`  policy pages: ${pAdded} added (${pages.length} found)`);

const admins = (await db.get("SELECT COUNT(*) n FROM users WHERE role='admin'")).n;
console.log(admins || process.env.EKB_SETUP ? "\nDone." : "\nDone. Next, create your admin login:\n  npm run create-admin");
process.exit(0);
