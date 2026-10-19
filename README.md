# eKarolBagh

One Node backend that serves everything:

| Address | What it is |
|---|---|
| `/` | The website |
| `/app` | The mobile app (the Capacitor Android app opens this) |
| `/admin` | The admin panel (owner + staff) |
| `/api` | The API all three use |

Products, stock, accounts, carts, wishlists and orders are shared: a customer can add to cart on the website and check out in the app.

## Run it (on any computer)

Everything is in this folder. Needs Node.js 18 or newer and an internet connection.

```
cd ekarolbagh
npm install
copy .env.example .env          (Mac/Linux: cp .env.example .env)
npm run setup
npm start
```

`npm run setup` does the one-time work:
1. downloads every product, photo, review and policy from ekarolbagh.in into `ekarolbagh-export/`, making fast WebP copies of every photo (a few minutes);
2. loads it all into the database;
3. asks for your name, email and password for `/admin`.

Running it again skips whatever is already done. If you already have an `ekarolbagh-export` folder from before, copy it into this folder and setup won't download again.

Then open http://localhost:5000 (website), http://localhost:5000/app (app) and http://localhost:5000/admin (admin).

Without anything in `.env` it runs fully locally:
- database: `data/ekarolbagh.db`
- photos: inside the database (served at `/media`), unless R2 is set up
- emails (order confirmations, password resets): printed in the server window

Individual steps, if you need them: `npm run scrape`, `npm run seed` (`-- --overwrite` refreshes existing products too), `npm run create-admin`.

## Switching to Turso, R2 and Resend

Fill these in `.env` and restart. No code changes.

- **Turso**: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`. Then run `npm run setup` once, so the new database gets the catalogue and your login.
- **R2 (optional)**: without it, photos are saved in the database (Turso), which is enough for this store. To use R2 later, fill `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL` and run `npm run seed -- --overwrite` so the photos are uploaded to R2.
- **Resend**: `RESEND_API_KEY` and `MAIL_FROM` (an address on a domain you verified in Resend).

## Going live (e.g. on Render)

1. Push this folder to a GitHub repo (`.env`, `data/`, `storage/` are ignored).
2. On Render: New → Web Service → your repo. Build command `npm install`, start command `npm start`.
3. Add every value from your `.env` under Environment, with `BASE_URL=https://ekarolbagh.in`.
4. Point the `ekarolbagh.in` domain at the Render service.

Use Turso in production: Render's disk is wiped on every deploy, so a local database would be lost. Photos live in Turso too, so nothing is stored on Render's disk.

## The Android app (Capacitor)

The `capacitor/` folder is a small Android shell that opens `https://ekarolbagh.in/app/`. Because the app screens come from the server, any change you deploy shows up in the app straight away, with no Play Store update.

```
cd capacitor
npm install
npm run setup        (first time only: creates the android/ project)
npm run open         (opens Android Studio → Build → Generate Signed Bundle)
```

- If this replaces your existing `ekarolbaghapps.apk`, change `appId` in `capacitor.config.json` to that app's package name and sign with the same keystore, so phones update instead of installing a second app.
- App icon and splash: put them in Android Studio (or use `@capacitor/assets`).
- The Android back button goes back one screen and closes the app from Home.

## What's where

```
server/
  index.js          starts everything, serves /, /app, /admin, /media
  config.js         reads .env
  db.js             database tables + helpers (libSQL: Turso or local file)
  auth.js           sign-in sessions (cookie), staff permissions, security checks
  catalog.js        builds the public catalogue for the website/app (cached)
  orders.js         placing orders (server checks prices, stock, ₹ minimum), status changes
  storage.js        photo upload → WebP (400px + 1000px) → R2 or the database
  email.js          Resend emails
  routes/public.js  catalogue, sign up, sign in, password reset
  routes/account.js profile, cart, wishlist, addresses, orders
  routes/admin.js   dashboard, orders, products, Excel, categories, brands, customers, staff, settings, policies
public/
  web/   website     app/   mobile app     admin/   admin panel
  shared/ekb-assets.js (logo + icons)   shared/ekb-client.js (talks to the API)
scripts/
  setup.js          one-time setup (scrape → seed → admin login)
  scrape.js         download the catalogue + photos from ekarolbagh.in
  seed.js           load it into the database
  create-admin.js   create/reset an admin login
capacitor/          Android shell
```

## Rules the server enforces

- Prices and stock always come from the database, never from the phone or browser.
- Minimum order value (₹1,999 by default; change it in Admin → Settings).
- Cash on Delivery only.
- Out-of-stock, hidden and unpriced products can't be ordered.
- If a stock quantity is set, it counts down with each order, the product goes out of stock at 0, and cancelling puts the stock back.
- Customers can cancel while an order is still "New" (switch off in Settings).
- Deleting an account removes the person's data; their past orders stay for your records.
"# ekb" 
