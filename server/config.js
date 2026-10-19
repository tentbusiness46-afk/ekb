import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const port = Number(env.PORT) || 5000;
const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, "");

export const cfg = {
  port,
  baseUrl,
  secureCookies: baseUrl.startsWith("https://"),

  // Database: Turso when configured, otherwise a local SQLite file (same engine, same SQL)
  dbUrl: env.TURSO_DATABASE_URL || `file:${path.join(ROOT, "data", "ekarolbagh.db")}`,
  dbToken: env.TURSO_AUTH_TOKEN || undefined,
  usingTurso: !!env.TURSO_DATABASE_URL,

  // Photos: Cloudflare R2 when configured, otherwise stored in the database (Turso or the local file) and served at /media
  r2: {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    publicUrl: (env.R2_PUBLIC_URL || "").replace(/\/+$/, ""),
  },
  get usingR2() {
    const r = this.r2;
    return !!(r.accountId && r.accessKeyId && r.secretAccessKey && r.bucket && r.publicUrl);
  },
  storageDir: path.join(ROOT, "storage"), // only read now: photos saved here by older versions

  // Email: Resend when configured, otherwise printed to the server console
  resendKey: env.RESEND_API_KEY || "",
  mailFrom: env.MAIL_FROM || "eKarolBagh <orders@ekarolbagh.in>",

  sessionDays: 60,
};
