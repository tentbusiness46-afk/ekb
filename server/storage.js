import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { cfg } from "./config.js";
import { db } from "./db.js";

sharp.cache(false);
let s3 = null;
async function r2() {
  if (s3) return s3;
  const { S3Client, PutObjectCommand, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${cfg.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: cfg.r2.accessKeyId, secretAccessKey: cfg.r2.secretAccessKey },
  });
  s3 = { client, PutObjectCommand, DeleteObjectCommand };
  return s3;
}

/** Store a file; returns its public URL. Key like "products/123/abc-sm.webp". */
export async function putFile(key, buffer, contentType) {
  key = key.replace(/^\/+/, "");
  if (cfg.usingR2) {
    const { client, PutObjectCommand } = await r2();
    await client.send(new PutObjectCommand({
      Bucket: cfg.r2.bucket, Key: key, Body: buffer, ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }));
    return `${cfg.r2.publicUrl}/${key}`;
  }
  // no R2: keep the photo in the database (Turso in production), served at /media/<key>
  await db.run("INSERT OR REPLACE INTO media(key,type,data,size,created_at) VALUES(?,?,?,?,?)",
    [key, contentType, new Uint8Array(buffer), buffer.length, Date.now()]);
  memo.delete(key);
  return `/media/${key}`;
}

/* ---- reading photos stored in the database (with a small in-memory cache) ---- */
const memo = new Map();             // key -> { type, data }
let memoBytes = 0;
const MEMO_MAX = 64 * 1024 * 1024;  // keep up to 64 MB of recent photos in memory
const TYPES = { webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", svg: "image/svg+xml" };

export async function getMedia(key) {
  key = key.replace(/^\/+/, "");
  const hit = memo.get(key);
  if (hit) { memo.delete(key); memo.set(key, hit); return hit; }
  let item = null;
  const row = await db.get("SELECT type, data FROM media WHERE key=?", [key]);
  if (row) item = { type: row.type, data: Buffer.from(row.data) };
  else if (!key.split("/").includes("..")) { // photos saved in storage/ by older versions
    const data = await readFile(path.join(cfg.storageDir, key)).catch(() => null);
    if (data) item = { type: TYPES[key.split(".").pop().toLowerCase()] || "application/octet-stream", data };
  }
  if (!item) return null;
  memo.set(key, item); memoBytes += item.data.length;
  while (memoBytes > MEMO_MAX && memo.size > 1) { const [k, v] = memo.entries().next().value; memo.delete(k); memoBytes -= v.data.length; }
  return item;
}

export async function deleteFile(key) {
  if (!key) return;
  try {
    if (cfg.usingR2) {
      const { client, DeleteObjectCommand } = await r2();
      await client.send(new DeleteObjectCommand({ Bucket: cfg.r2.bucket, Key: key }));
    } else {
      await db.run("DELETE FROM media WHERE key=?", [key]);
      const m = memo.get(key); if (m) { memo.delete(key); memoBytes -= m.data.length; }
      await unlink(path.join(cfg.storageDir, key)).catch(() => {});
    }
  } catch { /* already gone */ }
}

const rand = () => Math.random().toString(36).slice(2, 10);

/** A brand logo -> one WebP (max 400px, transparency kept), stored. */
export async function storeBrandLogo(brandId, input) {
  const meta = await sharp(input).metadata();
  if (!meta.width) throw new Error("Not an image");
  const buf = await sharp(input).resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
  const key = `brands/${brandId}-${Date.now().toString(36)}${rand()}.webp`;
  return { logo_url: await putFile(key, buf, "image/webp"), logo_key: key };
}

/** Any uploaded photo -> small (400px) + large (1000px) WebP, stored. */
export async function storeProductPhoto(productId, input) {
  const base = `products/${productId}/${Date.now().toString(36)}${rand()}`;
  const meta = await sharp(input).metadata(); // throws on non-images
  if (!meta.width) throw new Error("Not an image");
  const [sm, lg] = await Promise.all([
    sharp(input).rotate().resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true }).webp({ quality: 72 }).toBuffer(),
    sharp(input).rotate().resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(),
  ]);
  const smallKey = `${base}-sm.webp`, largeKey = `${base}-lg.webp`;
  const [small_url, large_url] = await Promise.all([putFile(smallKey, sm, "image/webp"), putFile(largeKey, lg, "image/webp")]);
  return { small_url, large_url, small_key: smallKey, large_key: largeKey };
}
