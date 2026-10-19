#!/usr/bin/env node
/**
 * eKarolBagh full store export
 * ------------------------------------------------------------
 * Pulls EVERYTHING public from ekarolbagh.in through the site's own
 * public WooCommerce Store API + WordPress API (no login, no keys):
 *
 *   • every category, with its full tree (Category → Guarantee/Non-Guarantee → Brand)
 *   • every product: name, SKU, short + full description (HTML and plain text),
 *     price, MRP, sale price, price ranges, on-sale flag, stock / availability,
 *     low-stock count, backorders, weight, dimensions, attributes, tags,
 *     rating, review count, every gallery photo (all sizes), link
 *   • every variation of variable products, with its own price and stock
 *   • every customer review: name, rating, text, date, verified buyer
 *   • every gallery photo DOWNLOADED to disk, ready to upload to R2
 *   • site pages (About, Refund, Shipping, Privacy…) as HTML + text
 *
 * Output (in the folder you run it from):
 *   ekarolbagh-data.js                  ← put next to index.html; the app mockup loads it
 *   ekarolbagh-export/catalog.json      ← the complete export, for seeding Turso
 *   ekarolbagh-export/products.csv      ← review in Excel / Google Sheets
 *   ekarolbagh-export/reviews.csv
 *   ekarolbagh-export/images/<productId>/<n>.<ext>
 *   ekarolbagh-export/images/<productId>/<n>-sm.webp and <n>-lg.webp
 *       (fast WebP copies, made only if sharp is installed: npm i sharp)
 *
 * Usage (Node 18+, no npm install):
 *   npm run scrape                       full export with photos (into ./ekarolbagh-export)
 *   npm run scrape -- --no-images        skip photo download
 *   npm run scrape -- --keep-originals   keep the original photos next to the WebP copies
 *
 * Safe to re-run: photos already on disk (original or WebP) are not downloaded again.
 * With sharp installed, originals are deleted once their WebP copies exist.
 * Only products the site shows publicly are exported (drafts and hidden
 * products are not visible to a public API).
 */
import { writeFile, readFile, mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Always work inside the project folder, wherever the command is run from
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

const args = process.argv.slice(2);
const BASE = (args.find((a) => /^https?:\/\//.test(a)) || "https://ekarolbagh.in").replace(/\/+$/, "");
const WITH_IMAGES = !args.includes("--no-images");
const KEEP_ORIGINALS = args.includes("--keep-originals");
const STORE = `${BASE}/wp-json/wc/store/v1`;
const WP = `${BASE}/wp-json/wp/v2`;
const OUT = "ekarolbagh-export";
const IMG_DIR = path.join(OUT, "images");
const UA = "eKarolBagh-store-export/2.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fetching
async function fetchRetry(url, opts = {}, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) } });
      if (res.ok || res.status === 400 || res.status === 404) return res;
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (attempt >= tries) throw new Error(`${url} — ${e.message}`);
      await sleep(1500 * attempt);
    }
  }
}

/** Every page of a paginated WordPress/WooCommerce list endpoint. */
async function getAll(base, pathAndQuery, label, { optional = false } = {}) {
  const out = [];
  for (let page = 1; ; page++) {
    const url = `${base}${pathAndQuery}${pathAndQuery.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
    let res;
    try {
      res = await fetchRetry(url, { headers: { Accept: "application/json" } });
    } catch (e) {
      if (optional) { console.log(`  ${label}: skipped (${e.message})`); return out; }
      throw e;
    }
    if (res.status === 400) break; // past the last page
    if (res.status === 404) {
      if (optional) { console.log(`  ${label}: not available on this site`); return out; }
      throw new Error(`${url} — 404`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error(`Unexpected response from ${url}`);
    out.push(...batch);
    const pages = Number(res.headers.get("x-wp-totalpages")) || 0;
    process.stdout.write(`\r  ${label}: ${out.length}${pages ? ` (page ${page}/${pages})` : ""}      `);
    if (!batch.length || batch.length < 100 || (pages && page >= pages)) break;
    await sleep(250);
  }
  process.stdout.write("\n");
  return out;
}

/** Run fn over items with limited parallelism. */
async function pool(items, limit, fn, label) {
  let i = 0, done = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
      done++;
      if (label && (done % 10 === 0 || done === items.length)) process.stdout.write(`\r  ${label}: ${done}/${items.length}      `);
    }
  });
  await Promise.all(workers);
  if (label && items.length) process.stdout.write("\n");
}

// ---------------------------------------------------------------- cleaning
const text = (s) =>
  String(s ?? "")
    .replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#8217;|&rsquo;|&#8216;|&lsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&#8377;/g, "₹")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
const oneLine = (s) => text(s).replace(/\s+/g, " ");

const money = (prices, key) => {
  if (!prices || prices[key] == null || prices[key] === "") return null;
  return Number(prices[key]) / 10 ** (prices.currency_minor_unit ?? 2);
};
const priceBlock = (pr) => ({
  price: money(pr, "price"),
  mrp: money(pr, "regular_price") ?? money(pr, "price"),
  sale: money(pr, "sale_price"),
  range: pr?.price_range ? { min: money(pr.price_range, "min_amount") ?? Number(pr.price_range.min_amount) / 10 ** (pr.currency_minor_unit ?? 2), max: Number(pr.price_range.max_amount) / 10 ** (pr.currency_minor_unit ?? 2) } : null,
  currency: pr?.currency_code || "INR",
});

// Guarantee spelling varies on the site: Guarantee, Guaranty, Warranty, Non-Guaranty, non-warranty…
const isNon = (c) => /non[\s-]*(guarant|warrant)/i.test(`${c.name} ${c.slug}`);
const isGuar = (c) => !isNon(c) && /(guarant|warrant)/i.test(`${c.name} ${c.slug}`);
const isSplit = (c) => isGuar(c) || isNon(c);

// ---------------------------------------------------------------- export
console.log(`Exporting ${BASE}${WITH_IMAGES ? "" : " (without photos)"}\n`);
await mkdir(IMG_DIR, { recursive: true });

const rawCats = await getAll(STORE, "/products/categories", "categories");
const rawProds = await getAll(STORE, "/products", "products");
const rawReviews = await getAll(STORE, "/products/reviews", "reviews", { optional: true });
const rawPages = await getAll(WP, "/pages?_fields=id,slug,link,title,content,modified", "site pages", { optional: true });

// Variations of variable products (each has its own price + stock)
const variationIds = [...new Set(rawProds.flatMap((p) => (p.variations || []).map((v) => v.id)))];
const variationById = new Map();
await pool(variationIds, 4, async (vid) => {
  const res = await fetchRetry(`${STORE}/products/${vid}`, { headers: { Accept: "application/json" } });
  if (res.ok) variationById.set(vid, await res.json());
}, "variations");

// Category tree
const byId = new Map(rawCats.map((c) => [c.id, c]));
const chainOf = (id) => {
  const chain = [];
  let c = byId.get(id);
  for (let i = 0; c && i < 12; i++) { chain.unshift(c); c = c.parent ? byId.get(c.parent) : null; }
  return chain;
};

// Merge brand spellings like boAt / BoAt / Boat
const brandKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const brandVotes = new Map();
const voteBrand = (name) => {
  const k = brandKey(name);
  if (!k) return;
  const m = brandVotes.get(k) || new Map();
  m.set(name, (m.get(name) || 0) + 1);
  brandVotes.set(k, m);
};

// Reviews grouped by product
const reviews = rawReviews.map((r) => ({
  id: r.id,
  productId: r.product_id,
  reviewer: oneLine(r.reviewer),
  rating: Number(r.rating) || 0,
  text: text(r.review),
  verified: !!r.verified,
  date: r.date_created_gmt || r.date_created || "",
}));
const reviewsByProduct = new Map();
for (const r of reviews) {
  if (!reviewsByProduct.has(r.productId)) reviewsByProduct.set(r.productId, []);
  reviewsByProduct.get(r.productId).push(r);
}

const OTHER = "Other brands";
const brandImg = new Map(); // brand key -> image URL
const products = [];
const skipped = [];
const imageJobs = [];

for (const p of rawProds) {
  const chains = (p.categories || []).map((c) => chainOf(c.id)).filter((ch) => ch.length);
  const withSplit = chains.filter((ch) => ch.some(isSplit));
  const pick = (withSplit.length ? withSplit : chains).sort((a, b) => b.length - a.length)[0];
  if (!pick) { skipped.push(oneLine(p.name)); continue; }

  const top = pick[0];
  const gi = pick.findIndex(isSplit);
  const g = gi < 0 ? "u" : isNon(pick[gi]) ? "n" : "g"; // u = no guarantee label on the site
  const brandCat = gi >= 0 ? pick[gi + 1] : pick[1] && !isSplit(pick[1]) ? pick[1] : null;
  const brand = oneLine(brandCat?.name || p.brands?.[0]?.name || "") || OTHER;
  if (brand !== OTHER) voteBrand(brand);
  if (brand !== OTHER && brandCat?.image?.src && !brandImg.has(brandKey(brand))) brandImg.set(brandKey(brand), brandCat.image.src); // brand logo set on the subcategory

  const pr = priceBlock(p.prices);
  const images = (p.images || []).map((im, i) => {
    const ext = (path.extname(new URL(im.src).pathname) || ".jpg").toLowerCase();
    const rel = `images/${p.id}/${i + 1}`;
    // WordPress serves smaller copies in srcset; pick one ~800px wide for the product page
    const sizes = String(im.srcset || "").split(",").map((s) => s.trim().split(/\s+/)).filter((a) => a[0] && /w$/.test(a[1] || "")).map((a) => ({ u: a[0], w: parseInt(a[1], 10) }));
    const near = (t) => (sizes.length ? sizes.reduce((b, s) => (Math.abs(s.w - t) < Math.abs(b.w - t) ? s : b)).u : null);
    const image = { src: im.src, medium: near(800) || im.src, thumbnail: im.thumbnail || near(300) || im.src, alt: oneLine(im.alt || im.name || ""), file: `${rel}${ext}` };
    if (WITH_IMAGES) imageJobs.push({ url: im.src, file: path.join(OUT, `${rel}${ext}`), base: path.join(OUT, rel), rel, image });
    return image;
  });

  const variations = (p.variations || []).map((v) => {
    const full = variationById.get(v.id);
    const vp = priceBlock(full?.prices);
    return {
      id: v.id,
      attributes: Object.fromEntries((v.attributes || []).map((a) => [oneLine(a.name), oneLine(a.value)])),
      sku: full?.sku || "",
      price: vp.price, mrp: vp.mrp, sale: vp.sale,
      inStock: full ? full.is_in_stock !== false : null,
      stockLeft: full?.low_stock_remaining ?? null,
      image: full?.images?.[0]?.src || "",
    };
  });

  const own = reviewsByProduct.get(p.id) || [];
  products.push({
    id: p.id,
    name: oneLine(p.name),
    slug: p.slug,
    url: p.permalink,
    type: p.type, // simple | variable | grouped | external
    sku: p.sku || "",
    cat: top.id,
    category: oneLine(top.name),
    categoryPath: pick.map((c) => oneLine(c.name)).join(" > "),
    allCategories: (p.categories || []).map((c) => oneLine(c.name)),
    g,
    warranty: { g: "Guarantee", n: "Non-Guarantee", u: "Not labelled" }[g],
    brand,
    price: pr.price,
    mrp: pr.mrp,
    salePrice: pr.sale,
    priceRange: pr.range,
    currency: pr.currency,
    onSale: !!p.on_sale,
    priceHtml: oneLine(p.price_html),
    inStock: p.is_in_stock !== false,
    stockStatus: oneLine(p.stock_availability?.text || (p.is_in_stock === false ? "Out of stock" : "In stock")),
    stockLeft: p.low_stock_remaining ?? null,
    onBackorder: !!p.is_on_backorder,
    purchasable: p.is_purchasable !== false,
    soldIndividually: !!p.sold_individually,
    weight: oneLine(p.formatted_weight) || p.weight || "",
    dimensions: p.dimensions || null,
    dimensionsText: oneLine(p.formatted_dimensions) || "",
    attributes: (p.attributes || []).map((a) => ({ name: oneLine(a.name), values: (a.terms || []).map((t) => oneLine(t.name)), variation: !!a.has_variations })),
    variations,
    tags: (p.tags || []).map((t) => oneLine(t.name)),
    rating: Number(p.average_rating) || 0,
    reviewCount: Number(p.review_count) || own.length,
    reviews: own,
    shortDescription: text(p.short_description),
    description: text(p.description),
    shortDescriptionHtml: p.short_description || "",
    descriptionHtml: p.description || "",
    images,
    // fields the app mockup reads
    img: images[0]?.src || "",
    thumb: images[0]?.thumbnail || "",
    desc: text(p.short_description || p.description).slice(0, 600),
  });
}

const canon = new Map([...brandVotes].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
for (const p of products) if (p.brand !== OTHER) p.brand = canon.get(brandKey(p.brand)) || p.brand;
const brands = [...brandImg].map(([k, src]) => ({ name: canon.get(k) || k, key: k, src, file: "", webp: "" }));

// ---------------------------------------------------------------- photos
// With sharp installed, each photo becomes two WebP files (small for lists, large for the
// product page) and the downloaded original is deleted to save space (--keep-originals keeps it).
const sharp = WITH_IMAGES ? await import("sharp").then((m) => m.default).catch(() => null) : null;
if (sharp) sharp.cache(false); // so Windows doesn't keep the original file locked
const exists = async (f) => { const s = await stat(f).catch(() => null); return !!(s && s.size > 0); };
const webpDone = async (job) => !!sharp && (await exists(`${job.base}-sm.webp`)) && (await exists(`${job.base}-lg.webp`));

let imgOk = 0, imgSkip = 0, webpMade = 0, deleted = 0, freed = 0;
const imgFail = [];
if (WITH_IMAGES) {
  await pool(imageJobs, 6, async (job) => {
    try {
      if ((await webpDone(job)) || (await exists(job.file))) { imgSkip++; return; } // already have it
      const res = await fetchRetry(job.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await mkdir(path.dirname(job.file), { recursive: true });
      await writeFile(job.file, Buffer.from(await res.arrayBuffer()));
      imgOk++;
    } catch (e) {
      imgFail.push(`${job.url} (${e.message})`);
    }
  }, "photos");
}

if (sharp) {
  await pool(imageJobs, 3, async (job) => {
    try {
      const haveOriginal = await exists(job.file);
      if (!haveOriginal && !(await webpDone(job))) return; // download failed
      if (haveOriginal) {
        const input = await readFile(job.file);
        for (const [suffix, width, quality] of [["sm", 400, 72], ["lg", 1000, 80]]) {
          const out = `${job.base}-${suffix}.webp`;
          if (!(await exists(out))) {
            await sharp(input).resize({ width, height: width, fit: "inside", withoutEnlargement: true }).webp({ quality }).toFile(out);
            webpMade++;
          }
        }
      }
      job.image.webpSmall = `${job.rel}-sm.webp`;
      job.image.webpLarge = `${job.rel}-lg.webp`;
      if (haveOriginal && !KEEP_ORIGINALS && (await webpDone(job))) {
        const size = (await stat(job.file)).size;
        await unlink(job.file);
        deleted++; freed += size;
      }
      if (!(await exists(job.file))) job.image.file = job.image.webpLarge;
    } catch (e) {
      imgFail.push(`${job.url} (webp: ${e.message})`);
    }
  }, "webp");
}

// ---------------------------------------------------------------- brand logos
let logosOk = 0;
if (WITH_IMAGES && brands.length) {
  await mkdir(path.join(OUT, "brands"), { recursive: true });
  await pool(brands, 4, async (b) => {
    const ext = (path.extname(new URL(b.src).pathname) || ".jpg").toLowerCase();
    const file = path.join(OUT, "brands", b.key + ext), webp = path.join(OUT, "brands", b.key + ".webp");
    try {
      if (sharp && (await exists(webp))) { b.webp = `brands/${b.key}.webp`; logosOk++; return; }
      if (!(await exists(file))) {
        const res = await fetchRetry(b.src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await writeFile(file, Buffer.from(await res.arrayBuffer()));
      }
      b.file = `brands/${b.key}${ext}`;
      if (sharp) {
        await sharp(await readFile(file)).resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toFile(webp);
        b.webp = `brands/${b.key}.webp`;
        if (!KEEP_ORIGINALS && ext !== ".webp") { await unlink(file); b.file = b.webp; }
      }
      logosOk++;
    } catch (e) { imgFail.push(`${b.src} (brand ${b.name}: ${e.message})`); }
  }, "brand logos");
}

// ---------------------------------------------------------------- write
const usedTop = new Set(products.map((p) => p.cat));
const categories = rawCats
  .filter((c) => usedTop.has(c.id))
  .map((c) => ({ id: c.id, name: oneLine(c.name), slug: c.slug, image: c.image?.src || "" }))
  .sort((a, b) => a.name.localeCompare(b.name));
const categoryTree = rawCats.map((c) => ({
  id: c.id, name: oneLine(c.name), slug: c.slug, parent: c.parent || 0,
  path: chainOf(c.id).map((x) => oneLine(x.name)).join(" > "),
  description: text(c.description), image: c.image?.src || "", count: c.count ?? null, link: c.permalink || "",
}));
const pages = rawPages.map((pg) => ({
  id: pg.id, slug: pg.slug, url: pg.link, modified: pg.modified,
  title: oneLine(pg.title?.rendered), html: pg.content?.rendered || "", text: text(pg.content?.rendered),
}));

const scrapedAt = new Date().toISOString();
const catalog = { source: BASE, scrapedAt, counts: { categories: categoryTree.length, products: products.length, variations: variationIds.length, reviews: reviews.length, pages: pages.length, photos: imageJobs.length }, categories, categoryTree, brands, products, reviews, pages };
await writeFile(path.join(OUT, "catalog.json"), JSON.stringify(catalog, null, 1));

// Copy for the app mockup: keeps both descriptions (with formatting) and reviews.
// When WebP copies exist, the mockup loads those local files (much faster than the live site).
const POLICY = /polic|terms|condition|refund|return|cancel|shipping|delivery|privacy|warranty|guarantee|disclaimer|exchange/i;
const slim = {
  source: BASE, scrapedAt, categories,
  pages: pages.filter((pg) => POLICY.test(`${pg.title} ${pg.slug}`)).map(({ id, slug, title, html }) => ({ id, slug, title, html })),
  products: products.map(({ priceHtml, description, shortDescription, desc, ...rest }) => ({
    ...rest,
    images: rest.images.map((im) => ({
      src: im.src, medium: im.medium, thumbnail: im.thumbnail,
      ...(im.webpSmall ? { webpSmall: `${OUT}/${im.webpSmall}`, webpLarge: `${OUT}/${im.webpLarge}` } : {}),
    })),
  })),
};
await writeFile("ekarolbagh-data.js", "window.EKB_DATA = " + JSON.stringify(slim) + ";\n");

const cell = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (rows) => "﻿" + rows.map((r) => r.map(cell).join(",")).join("\n");
await writeFile(path.join(OUT, "products.csv"), csv([
  ["id", "name", "category", "warranty", "brand", "price", "mrp", "on_sale", "in_stock", "stock_status", "stock_left", "type", "variations", "sku", "rating", "reviews", "tags", "photos", "short_description", "description", "url"],
  ...products.map((p) => [p.id, p.name, p.category, p.warranty, p.brand, p.price, p.mrp, p.onSale ? "yes" : "no", p.inStock ? "yes" : "no", p.stockStatus, p.stockLeft ?? "", p.type, p.variations.length, p.sku, p.rating, p.reviewCount, p.tags.join("; "), p.images.length, p.shortDescription, p.description, p.url]),
]));
const nameOf = new Map(products.map((p) => [p.id, p.name]));
await writeFile(path.join(OUT, "reviews.csv"), csv([
  ["review_id", "product_id", "product", "reviewer", "rating", "verified", "date", "review"],
  ...reviews.map((r) => [r.id, r.productId, nameOf.get(r.productId) || "", r.reviewer, r.rating, r.verified ? "yes" : "no", r.date, r.text]),
]));

// ---------------------------------------------------------------- summary
console.log(`\nDone. ${products.length} products · ${variationIds.length} variations · ${reviews.length} reviews · ${pages.length} pages · ${imageJobs.length} photos\n`);
for (const c of categories) {
  const ps = products.filter((p) => p.cat === c.id);
  const n = (g) => ps.filter((p) => p.g === g).length;
  const b = (g) => new Set(ps.filter((p) => p.g === g).map((p) => p.brand)).size;
  const out = ps.filter((p) => !p.inStock).length;
  console.log(`  ${c.name.padEnd(18)} guarantee ${String(n("g")).padStart(3)} (${b("g")} brands)   non-guarantee ${String(n("n")).padStart(3)} (${b("n")} brands)` + (n("u") ? `   not labelled ${n("u")}` : "") + (out ? `   out of stock ${out}` : ""));
}
if (WITH_IMAGES) console.log(`\n  Photos: ${imgOk} downloaded, ${imgSkip} already on disk${imgFail.length ? `, ${imgFail.length} failed` : ""}`);
if (WITH_IMAGES) console.log(sharp ? `  WebP: ${webpMade} new copies made${deleted ? ` · ${deleted} originals deleted, ${(freed / 1048576).toFixed(1)} MB freed` : ""}` : "  Tip: run  npm i sharp  then re-run this script to make fast WebP copies (originals are then deleted)");
if (imgFail.length) {
  await writeFile(path.join(OUT, "failed-photos.txt"), imgFail.join("\n"));
  console.log(`  Failed photo links saved to ${OUT}/failed-photos.txt — re-run to retry them`);
}
if (skipped.length) console.log(`  Skipped ${skipped.length} products with no category: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}`);
if (WITH_IMAGES) console.log(`  Brand logos: ${logosOk} of ${brands.length}`);
console.log(`\nWritten: ekarolbagh-data.js and the ${OUT}/ folder`);
