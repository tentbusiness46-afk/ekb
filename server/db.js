import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { cfg, ROOT } from "./config.js";

if (!cfg.usingTurso) mkdirSync(path.join(ROOT, "data"), { recursive: true });

export const client = createClient({ url: cfg.dbUrl, authToken: cfg.dbToken });

/** libSQL rows -> plain objects */
const plain = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
const wrap = (exec) => ({
  all: async (sql, args = []) => plain(await exec({ sql, args })),
  get: async (sql, args = []) => plain(await exec({ sql, args }))[0] || null,
  run: async (sql, args = []) => {
    const rs = await exec({ sql, args });
    return { changes: rs.rowsAffected, lastId: rs.lastInsertRowid != null ? Number(rs.lastInsertRowid) : null };
  },
});

export const db = wrap((q) => client.execute(q));

/** Run fn inside one write transaction (all-or-nothing). */
export async function tx(fn) {
  const t = await client.transaction("write");
  try {
    const out = await fn(wrap((q) => t.execute(q)));
    await t.commit();
    return out;
  } catch (e) {
    await t.rollback().catch(() => {});
    throw e;
  } finally {
    t.close();
  }
}

/** Many statements in one round trip (fast for imports). */
export async function batch(stmts) {
  if (!stmts.length) return;
  await client.batch(stmts.map(([sql, args]) => ({ sql, args: args || [] })), "write");
}

export const now = () => Date.now();
export const json = (v, d) => { try { return v == null ? d : JSON.parse(v); } catch { return d; } };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',          -- customer | staff | admin
  perms TEXT NOT NULL DEFAULT '[]',               -- staff: ["orders","products",...]
  blocked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS password_resets(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  icon TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  home_rank INTEGER,                               -- 1..4 = shown as a big button on Home
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS brands(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  logo_url TEXT,
  logo_key TEXT
);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT,
  cat_id INTEGER NOT NULL REFERENCES categories(id),
  warranty TEXT NOT NULL DEFAULT 'u' CHECK (warranty IN ('g','n','u')),
  brand_id INTEGER REFERENCES brands(id),
  price REAL,
  mrp REAL,
  in_stock INTEGER NOT NULL DEFAULT 1,
  stock_qty INTEGER,                               -- optional count; NULL = not tracked
  purchasable INTEGER NOT NULL DEFAULT 1,
  sku TEXT,
  short_html TEXT NOT NULL DEFAULT '',
  desc_html TEXT NOT NULL DEFAULT '',
  weight TEXT,
  dimensions TEXT,
  attributes TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  deal INTEGER NOT NULL DEFAULT 0,                 -- pinned to "Deals of the day"
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  source_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS products_cat ON products(cat_id, warranty);
CREATE INDEX IF NOT EXISTS products_brand ON products(brand_id);
CREATE TABLE IF NOT EXISTS product_images(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  small_url TEXT NOT NULL,
  large_url TEXT NOT NULL,
  small_key TEXT,
  large_key TEXT,
  alt TEXT
);
CREATE INDEX IF NOT EXISTS images_product ON product_images(product_id, sort);
CREATE TABLE IF NOT EXISTS variations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  attributes TEXT NOT NULL DEFAULT '{}',
  sku TEXT,
  price REAL,
  mrp REAL,
  in_stock INTEGER NOT NULL DEFAULT 1,
  stock_qty INTEGER
);
CREATE INDEX IF NOT EXISTS variations_product ON variations(product_id);
CREATE TABLE IF NOT EXISTS reviews(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  reviewer TEXT,
  rating INTEGER NOT NULL,
  text TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_product ON reviews(product_id);
CREATE TABLE IF NOT EXISTS pages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE,
  title TEXT NOT NULL,
  html TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS media(                  -- photos, when Cloudflare R2 isn't set up
  key TEXT PRIMARY KEY,                            -- e.g. products/12/1-sm.webp
  type TEXT NOT NULL,
  data BLOB NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cart_items(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,                          -- "productId" or "productId-variationId"
  qty INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, item_key)
);
CREATE TABLE IF NOT EXISTS wishlist(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, product_id)
);
CREATE TABLE IF NOT EXISTS addresses(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT, phone TEXT, line TEXT, landmark TEXT, pin TEXT, city TEXT, state TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'New',
  items_total REAL NOT NULL,
  delivery REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  payment TEXT NOT NULL DEFAULT 'COD',
  address TEXT NOT NULL,
  customer_name TEXT, customer_email TEXT, customer_phone TEXT,
  source TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status, created_at);
CREATE TABLE IF NOT EXISTS order_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER, variation_id INTEGER,
  name TEXT, label TEXT, sku TEXT, image TEXT,
  price REAL NOT NULL, qty INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items(order_id);
CREATE TABLE IF NOT EXISTS order_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT,
  by_user INTEGER,
  created_at INTEGER NOT NULL
);
`;

export const DEFAULT_SETTINGS = {
  store_name: "eKarolBagh",
  phone: "+91 84481 39455",
  email: "ekarolbagh@gmail.com",
  min_order: "1999",
  notify_email: "ekarolbagh@gmail.com", // gets a copy of every new order
  allow_cancel: "1",                     // customers may cancel while an order is still "New"
};

export async function migrate() {
  if (!cfg.usingTurso) await client.execute("PRAGMA foreign_keys = ON");
  await client.executeMultiple(SCHEMA);
  // columns added after the first release (older databases get them here)
  const has = async (t, c) => (await db.all(`PRAGMA table_info(${t})`)).some((x) => x.name === c);
  for (const [t, c, type] of [["brands", "logo_url", "TEXT"], ["brands", "logo_key", "TEXT"]]) {
    if (!(await has(t, c))) await client.execute(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`);
  }
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await db.run("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", [k, v]);
  }
}

export async function getSettings() {
  const rows = await db.all("SELECT key, value FROM settings");
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
