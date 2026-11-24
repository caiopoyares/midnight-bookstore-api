> Plano inicial de referência. Os requisitos atuais de autenticação, Docker e localização estão documentados no README.md.

# Horror bookstore launch plan

Start with two Git repositories, one Node.js backend and one PostgreSQL database. The first engineering milestone is a checkout test in which two readers try to buy the last copy of the same edition. Exactly one should succeed.

The plan assumes physical books, one stock location, one currency, guest checkout and payment methods that confirm immediately. Choose the launch market, shipping rates, tax treatment and payment provider before integrating checkout. If another channel sells from the same shelf, have it reserve stock through this backend or allocate a separate stock pool to the website.

## Architecture and repository ownership

| Repository under `~/projects` | Proposed stack | Responsibilities |
| --- | --- | --- |
| `horror-bookstore-frontend` | Next.js, React, TypeScript | Server-rendered catalog and book pages, interactive cart, checkout handoff, order status and staff screens. |
| `horror-bookstore-backend` | Node.js LTS, TypeScript, NestJS, PostgreSQL | REST API, database migrations, stock and order transactions, payment events and background jobs. |

Organize the backend into Catalog, Inventory, Orders and Payments modules. Catalog owns titles, authors, editions and prices. Inventory owns all stock changes. Orders coordinates checkout and fulfillment. Payments handles the provider integration. A checkout operation passes one database transaction through the relevant modules. Splitting Orders and Inventory into microservices now would turn that operation into a distributed workflow with more failure cases. Revisit a service split when one module needs its own scaling or release cycle. Search would be an easier first candidate.

Keep the OpenAPI contract in the backend repository. Have the frontend pin a released contract version and generate its TypeScript client from it. Each repository gets its own build, tests and deployment. For a breaking API change, run both versions until the storefront has migrated. [NestJS modules](https://docs.nestjs.com/modules) · [Next.js rendering](https://nextjs.org/docs/app/getting-started/server-and-client-components) · [Node.js LTS releases](https://nodejs.org/en/about/previous-releases)

## How checkout protects the last copy

1. **Track each sellable edition.** Give each paperback, hardcover or signed edition its own SKU. Store unsold units (`on_hand`) and active holds (`reserved`). Available units equal `on_hand - reserved`. Enforce `0 <= reserved <= on_hand` with database constraints. Record receipts, damage and corrections with quantity, reason and staff identity.
2. **Reserve when checkout starts.** A cart expresses interest. At checkout, validate positive quantities, consolidate repeated SKUs, then claim each line in a consistent SKU order inside one PostgreSQL transaction. Use a conditional update that adds the requested quantity to `reserved` only when enough units are available. If any line fails, roll back the whole cart and return the affected edition to the shopper. On success, commit the holds and pending order with a snapshot of prices and currency. A unique checkout-attempt key makes retries return the original result. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED)
3. **Open hosted payment after the commit.** Create a provider session for the server-calculated total using the order's idempotency key. If the call times out, retry or look up the original session before releasing the hold. Save the provider reference and align the hold with the provider's session expiry. For Stripe Checkout, a 30-minute payment window is a starting point. [Stripe limited-inventory checkout](https://docs.stripe.com/payments/checkout/managing-limited-inventory.md?ui=full-page)
4. **Settle once.** A verified payment webhook checks the order, amount, currency and paid status. In one transaction, lock the order, transition it from pending to paid, and reduce both `reserved` and `on_hand` by the purchased quantities. Record the event ID and guard the order transition so duplicate or reordered notifications cannot apply the sale twice. The confirmation page reads the resulting order status. [Stripe fulfillment guide](https://docs.stripe.com/checkout/fulfillment.md?ui=full-page)
5. **Reclaim abandoned stock safely.** A scheduled job reconciles overdue holds with the provider. Release the hold and restore availability only after confirming the session cannot still accept or settle a payment. If payment won the race, settle the sale. If the provider is unreachable, retain the hold and retry. A failed card attempt can still be retried in an open session. Staff can inspect unresolved holds.

## Storefront direction

Design it like a specialist bookseller's late-night window display. Use charcoal shelves, warm ivory type, oxblood accents and unfiltered cover artwork. Pair a literary serif such as **Spectral** for book titles with **Inter** for prices, filters and controls.

| Screen | What the reader sees and does |
| --- | --- |
| Home | One bookseller's pick with a short handwritten-style recommendation, followed by browsable shelves such as Folk Horror, Cosmic Dread and Gothic Hauntings. |
| Browse and search | Search by title or author. Filter by subgenre, format and availability. Show the cover, title, author and price on each card. |
| Book detail | Choose an edition and see its price and stock status beside **Add to cart**. Include the synopsis and a short staff note about the book's atmosphere. |
| Cart and checkout | Show edition, quantity, shipping and total. If a copy sells out, identify the affected line and preserve the rest of the cart. Use clear labels, visible keyboard focus and a quiet, high-contrast payment flow. |
| Staff | Receive stock by SKU, record adjustments with reasons and mark paid orders as shipped. Restrict staff actions to authorized accounts. |

## Infrastructure choices

| Component | Launch decision | When to revisit |
| --- | --- | --- |
| PostgreSQL | Own catalog, inventory, orders and durable background work. Start with indexed catalog queries. | Profile slow requests and measure database load as the catalog grows. |
| Background jobs | Save email jobs in the same transaction that marks the order paid. Use a scheduled worker from the backend repo for retries and hold reconciliation. Track failed jobs and make handlers safe to retry. | Add a dedicated queue when sustained backlog misses delivery targets or workers need to scale independently. |
| Redis | Defer it. Cache book covers and public editorial content at the CDN. Checkout always reads and writes authoritative stock in PostgreSQL. | Consider Redis if profiling shows repeated catalog reads still dominate after indexing and HTTP caching. |

## Build sequence and acceptance criteria

| Milestone | Deliverable | Ready when |
| --- | --- | --- |
| 1. Catalog and design | API contract, migrations, sample editions, mobile storefront and book detail. | A reader can find a book by author, select a format and see the correct edition price. |
| 2. Inventory and staff | Stock receiving, audited adjustments and atomic checkout reservations. | Of 20 simultaneous attempts for one copy, exactly one obtains a hold. A failed multi-book checkout leaves no partial holds. Retrying a successful request leaves quantities unchanged. |
| 3. Payment and fulfillment | Hosted checkout, verified webhooks, expiry reconciliation, confirmation email and staff shipping view. | Duplicate events, a closed browser, a session-creation timeout and a payment racing expiry all resolve to the correct order and stock counts. |
| 4. Launch rehearsal | Independent deployments, integration and accessibility checks, database backups and operational alerts. | Complete a mobile and keyboard-only purchase in staging, restore a backup, and demonstrate that staff can find a stuck payment or overdue hold. |
