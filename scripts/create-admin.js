#!/usr/bin/env node
/**
 * Create (or reset) an admin login for /admin.
 *   npm run create-admin                         asks for name, email and password
 *   npm run create-admin -- you@example.com "Your Name" "password123"
 */
import readline from "node:readline/promises";
import { migrate, db, now } from "../server/db.js";
import { hashPassword } from "../server/auth.js";

await migrate();
let [email, name, password] = process.argv.slice(2);
if (!email || !password) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q) => { process.stdout.write(q); const { value } = await lines.next(); return String(value ?? "").trim(); };
  name = name || (await ask("Your name: "));
  email = email || (await ask("Admin email: "));
  password = password || (await ask("Password (8+ characters): "));
  rl.close();
}
email = String(email).toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { console.error("That email doesn't look right."); process.exit(1); }
if (String(password).length < 8) { console.error("Password must be at least 8 characters."); process.exit(1); }

const hash = await hashPassword(password), u = await db.get("SELECT id FROM users WHERE email=?", [email]);
if (u) await db.run("UPDATE users SET role='admin', perms='[]', blocked=0, pass_hash=?, name=COALESCE(NULLIF(?,''),name) WHERE id=?", [hash, name || "", u.id]);
else await db.run("INSERT INTO users(name,email,phone,pass_hash,role,created_at) VALUES(?,?,'',?,'admin',?)", [name || "Admin", email, hash, now()]);
console.log(`${u ? "Updated" : "Created"} admin login for ${email}. Sign in at /admin`);
process.exit(0);
