# StoreApp — QR-scan storefront + admin

A "mini Amazon for a single physical store." A store owner adds products in an
admin dashboard and prints a QR code. A walk-in customer scans the QR, opens
the store's web page, picks items, and pays online (Razorpay) or with cash.
Stock is decremented atomically, every movement is logged, and the owner sees
daily earnings, top sellers, and low-stock alerts.

## Stack

- **API**: Node.js + Express + Prisma (PostgreSQL)
- **Web**: React (Vite) SPA — admin dashboard + public storefront in one app
- **Payments**: Razorpay (INR), plus cash
- **Auth**: JWT (store owners / staff / super admin)
- **Motion**: GSAP entrance/tilt animations, Lenis smooth scroll

## Project layout

```
storeapp/
├── docker-compose.yml          # local Postgres (dev)
├── docker-compose.prod.yml     # production stack: SPA+API in one container + DB
├── .env.prod.example           # production env template
├── api/
│   ├── Dockerfile              # multi-stage build (web SPA + API + Prisma)
│   ├── prisma/schema.prisma
│   ├── prisma/seed.js
│   └── src/
│       ├── server.js  app.js
│       ├── lib/       # prisma, inventory (atomic stock), razorpay, utils, motion
│       ├── middleware/# auth, storeAccess, error+validate
│       └── routes/    # auth, stores, products, orders, public(checkout)
└── web/
    └── src/
        ├── pages/      # Login, Register, Stores, Dashboard, Products,
        │               # Orders, Storefront (customer), Receipt
        ├── components/ # AdminLayout
        ├── store/      # zustand: auth + cart
        └── lib/        # api.js, motion.js (gsap + lenis helpers)
```

## Quick start (development)

### 1. Database
```bash
docker compose up -d                 # Postgres on :5434 (host) → :5432 (container)
```

> Host port is **5434** to avoid colliding with other local Postgres
> installations. The `DATABASE_URL` in `api/.env.example` already points
> there.

### 2. API
```bash
cd api
cp .env.example .env                 # fill in JWT_SECRET + Razorpay keys
npm install
npm run prisma:generate
npm run prisma:migrate -- --name init
npm run seed                         # demo store + products
npm run dev                          # http://localhost:4000
```

Seeded login: **owner@demo.com / password123**

### 3. Web
```bash
cd web
cp .env.example .env
npm install
npm run dev                          # http://localhost:5173
```

Open http://localhost:5173 → log in → open the demo store → **QR code** button.
The QR points at `/store/<slug>` (the customer view). Scan it — or just open
the URL — to shop and check out.

## Production deployment

The production build serves the API and the built SPA from **one container**
behind a managed Postgres. Single image, single port.

```bash
cp .env.prod.example .env.prod       # fill in real secrets
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

This brings up:
- `db` — Postgres 16 (named volume `pgdata`)
- `app` — multi-stage built image:
  - stage 1 builds the React SPA (`vite build` → `web/dist`)
  - stage 2 installs API production deps + `prisma generate`
  - runtime image runs as a non-root user, applies pending migrations on
    boot (`prisma migrate deploy`), then starts the Express server, which
    serves `/api/*` and falls through to `public/index.html` for SPA routes
- Exposes the app on `APP_PORT` (default `80`).

**Required env vars (`.env.prod`)** — see [`.env.prod.example`](./.env.prod.example).
At minimum set:
- `POSTGRES_PASSWORD` — strong random password
- `JWT_SECRET` — ≥ 32 random chars
- `CLIENT_ORIGIN` / `PUBLIC_WEB_URL` — your public HTTPS origin
- `RAZORPAY_KEY_ID` / `_SECRET` / `_WEBHOOK_SECRET` — live keys

**Behind a reverse proxy:** terminate TLS in your proxy (Caddy / nginx /
fly.io / Render) and forward to the container's port. The CSP in
[api/src/app.js](api/src/app.js) already allows Razorpay's checkout JS, the
Razorpay frame, and Google Fonts.

**Logs:** Morgan in `combined` format on stdout. Pipe `docker logs -f app`
to your log shipper.

**Health check:** `GET /api/health` → `{ ok: true, ts: <epoch ms> }`. The
Dockerfile registers it as the container `HEALTHCHECK`.

## Deploy to Render + Neon

A [`render.yaml`](./render.yaml) blueprint deploys the whole app as **one Render
web service** (Docker) that serves both `/api/*` and the React SPA, backed by a
**Neon** Postgres database.

1. **Neon** — create a project, then copy the connection string. Keep the
   `?sslmode=require` suffix (Neon refuses non-TLS connections).
2. **Render** — *New → Blueprint*, point it at this repo. Render reads
   `render.yaml` and creates the `storeapp` web service.
3. **Set the secret env vars** (marked `sync: false`) in the Render dashboard:
   - `DATABASE_URL` — the Neon connection string from step 1
   - `JWT_SECRET` — a long random string (≥ 32 chars)
   - `RAZORPAY_KEY_ID` / `_SECRET` / `_WEBHOOK_SECRET` — live keys (optional;
     the cash flow works without them)
4. **First deploy** runs `prisma migrate deploy` automatically on boot. Once the
   service is live, set `CLIENT_ORIGIN` and `PUBLIC_WEB_URL` to the service URL
   (`https://<service>.onrender.com`) and redeploy so CORS and the QR codes use
   the real origin.

Health check: Render polls `GET /api/health`. The server refuses to start in
production if `DATABASE_URL`, a real `JWT_SECRET`, or `CLIENT_ORIGIN` are missing.

> To seed a demo store on Neon, run `DATABASE_URL=<neon-url> npm run seed` from
> `api/` once, locally.

## Razorpay setup

1. Create a Razorpay account → Settings → API Keys → generate **test** keys.
2. Put `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in `api/.env`.
3. The storefront's `index.html` already loads Razorpay's checkout script.
4. Use Razorpay's test cards to simulate payments. Without keys, the **Cash**
   flow still works end-to-end.

For production, also set `RAZORPAY_WEBHOOK_SECRET` and point a Razorpay
webhook at your server (a webhook handler stub lives in `lib/razorpay.js` —
`verifyWebhookSignature` — wire it to a route to reconcile payments that
complete out-of-band).

## Key design decisions

- **Atomic stock with a race-safe conditional UPDATE.** `lib/inventory.js`
  uses `UPDATE … WHERE stock + Δ >= 0 RETURNING stock` so concurrent SALEs
  on the same product cannot oversell, even under READ COMMITTED. The
  inventory-log row writes in the same transaction.
- **Razorpay order is created BEFORE the DB transaction.** A Razorpay
  failure can never leave stock decremented with no order in hand.
- **Client-side cart.** A QR customer has no login, so the cart lives in
  the browser (zustand) and only hits the DB at checkout. No
  abandoned-cart rows.
- **Order line items snapshot `productName` + `unitPrice`** so changing a
  price later never rewrites historical invoices.
- **`orders → stores` uses `onDelete: Restrict`** (not cascade): you can't
  accidentally delete a store and wipe its sales history. Products
  soft-delete (`isActive = false`) for the same reason.
- **Prices are always recomputed server-side** at checkout. The client's
  prices are never trusted.
- **Razorpay verification** uses HMAC signature checking, wrapped in a
  try/catch so a malformed signature can't crash the route; on failed
  verification the held stock is released (`RETURN` log) and the order is
  marked `FAILED`.
- **Dashboard analytics** are computed live via SQL aggregates (today's
  revenue, top sellers over 30 days, low-stock list, 14-day revenue
  series). The `daily_analytics` table remains as an optional rollup
  cache you can populate with a cron job once volume grows.
- **Production CSP** is set in `app.js` (Razorpay + Google Fonts allowed).

## API surface (selected)

```
POST /api/auth/register | /login            GET /api/auth/me
GET  /api/stores                            POST /api/stores
GET  /api/stores/:id/qr
CRUD /api/stores/:id/products  + /restock   GET  /api/stores/:id/categories
GET  /api/stores/:id/dashboard | /orders | /analytics/daily | /inventory-logs

# Public (no auth — customer)
GET  /api/public/storefront/:slug
POST /api/public/checkout
POST /api/public/payment/verify
GET  /api/public/order/:orderNumber
```

## Operational notes

- Migrations: `npm run prisma:deploy` (`prisma migrate deploy`) is run
  automatically by the container on boot. To run by hand:
  `docker compose -f docker-compose.prod.yml exec app npx prisma migrate deploy`.
- Database backup: `docker compose -f docker-compose.prod.yml exec db pg_dump -U $POSTGRES_USER $POSTGRES_DB > backup.sql`.
- The web `dist/` bundle is split (react / charts / motion / vendor) so
  charts code (recharts) only loads on the admin Dashboard.
