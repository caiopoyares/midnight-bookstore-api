# Nightjar Books API

A Node.js and TypeScript modular monolith for a physical horror bookstore. NestJS serves the API and PostgreSQL owns edition-level stock, orders, payment history, stock adjustments and the email outbox. The companion storefront runs in the sibling `horror-bookstore-frontend` repository. [Original launch plan](BOOKSTORE_PLAN.md)

## Run the local shop

Use Node.js 24 LTS and npm. Run these commands from this repository.

```sh
npm ci
npm run dev
```

The API listens on `http://127.0.0.1:4100`. Local mode starts a loopback PostgreSQL server on port 55432, runs migrations, seeds six titles and eight editions, and persists its data in `.local/`. Restarting the API preserves orders and stock counts. Start the storefront in a second terminal. Local checkout uses a demo payment and records a demo email job.

Open the storefront's **Staff desk** and use the credential in `.local/staff-key`. The launcher generates it on first start with owner-only file permissions. Individual production staff keys are configured separately. Set `PGPORT`, `PORT` or `LOCAL_DATA_DIR` to use a second isolated environment. To use an existing development PostgreSQL database, set `DATABASE_URL`.

## Checkout and inventory

The versioned contract is `contract/openapi-1.0.0.json`. The storefront pins its own copy. The public API is under `/v1`.

1. A checkout request carries a UUID attempt key, guest shipping details and SKU quantities. The API normalizes the request, snapshots catalog prices and reserves every line in sorted SKU order in one PostgreSQL transaction. Insufficient stock rolls back the whole order. Reusing an attempt key with a changed basket returns HTTP 409.
2. Stripe mode creates hosted card checkout after commit with a stable provider idempotency key. The API compares the signed payment event with the saved order. An order lock, unique event IDs and database constraints protect the stock counters on retries. Each paid order creates one confirmation job.
3. Every 15 seconds the worker checks overdue holds. It asks Stripe to close an open session or confirm its final status before releasing inventory. If Stripe is unreachable the hold stays in place. Old ambiguous session creations are reconciled against the provider ledger before release.
4. Staff can receive stock, record damage or corrections, inspect held stock and ship paid orders. Stock changes have a request ID, operator and reason. The guest receipt URL is private to its holder. Keep order URLs out of shared analytics and application logs.

## Verification

```sh
npm test
```

The suite starts an isolated native PostgreSQL cluster, exercises the HTTP API, and restores an offline backup into a second cluster. It uses local Stripe session fixtures, real signature verification and a simulated email transport. The one-copy race opens 20 concurrent checkout requests. The suite also covers atomic multi-line failure, concurrent retries, payment racing expiry, provider timeouts, stock audit entries and duplicate notifications.

## Deployment and operations

Build with `npm ci && npm run build`; run `npm start`. The Dockerfile packages the same entry point. Set `HOST=0.0.0.0` inside a container. The process runs migrations under a database lock. Leave `SEED_CATALOG` unset for an existing inventory. Set it to `yes` to install the sample catalog intentionally. The initial catalog and unit prices are in `db/sample.sql`; enter actual saleable stock before accepting live orders.

Use an always-on backend and a managed PostgreSQL database. Schedule database backups and rehearse restoration on an isolated database. The automated test exercises a cold backup of a stopped local cluster. For a managed live database, enable the host's snapshots and point-in-time recovery. Confirm edition counts and paid orders on a restored instance before directing traffic to it.

Set `NODE_ENV=production` and supply the following settings via the deployment secret manager. [Configuration example](.env.example)

| Setting | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string with the appropriate TLS settings for the host. |
| `STOREFRONT_URL` | Canonical HTTPS storefront origin for payment redirects and receipts. |
| `PAYMENT_MODE=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Card payments. Point a Stripe webhook at the public backend route `/v1/payments/webhook` for `checkout.session.completed` and `checkout.session.expired`. Preserve the raw body. |
| `SHIPPING_COUNTRY`, `SHIPPING_CENTS` | One accepted country and a flat charge expressed in USD cents. Local defaults are US and 495. Prices and shipping are tax-inclusive. Enter amounts appropriate for the launch market. |
| `STAFF_KEYS` | JSON object mapping staff names to separate random secrets of at least 32 characters. Rotate a key by changing the secret and restarting the service. |
| `RESEND_API_KEY`, `MAIL_FROM` | Confirmation delivery using a verified sending domain. Demo mode records a preview status without sending mail. |

Put the API behind TLS. Route shopper traffic through the storefront's same-origin API proxy and restrict direct public backend traffic to the webhook and required health checks. Configure per-client checkout limits at the storefront edge. Poll `GET /v1/health` from your monitoring service. A 503 flags a hold overdue by ten minutes, a failed email or a queued email older than thirty minutes. The staff desk identifies affected orders. Review provider delivery history before retrying an email outside its idempotency window. Run a Stripe test-mode purchase and verify receipt delivery in the intended environment before enabling live keys.
