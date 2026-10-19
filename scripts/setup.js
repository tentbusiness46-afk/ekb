#!/usr/bin/env node
/**
 * One-time setup in a new location:
 *   1. downloads the whole catalogue + photos from ekarolbagh.in (skipped if ./ekarolbagh-export already exists)
 *   2. loads it into the database
 *   3. asks for your admin login (skipped if one exists)
 * Then run: npm start
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (script, args = []) => {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], { cwd: root, stdio: "inherit", env: { ...process.env, EKB_SETUP: "1" } });
  if (r.status !== 0) { console.error(`\nSetup stopped: ${script} failed.`); process.exit(r.status || 1); }
};

console.log("eKarolBagh setup\n");
if (existsSync(path.join(root, "ekarolbagh-export", "catalog.json"))) {
  console.log("Step 1/3: catalogue already downloaded (ekarolbagh-export). Skipping. Delete that folder to download again.\n");
} else {
  console.log("Step 1/3: downloading products, photos and policies from ekarolbagh.in (a few minutes)…\n");
  run("scrape.js");
}
console.log("\nStep 2/3: loading the catalogue into the database…\n");
run("seed.js", [path.join(root, "ekarolbagh-export")]);

const { migrate, db } = await import("../server/db.js");
await migrate();
const admins = (await db.get("SELECT COUNT(*) n FROM users WHERE role='admin'")).n;
if (admins) console.log("\nStep 3/3: an admin login already exists. Skipping.");
else { console.log("\nStep 3/3: create your admin login for /admin\n"); run("create-admin.js"); }

console.log("\nAll set. Start the site with:  npm start");
process.exit(0);
