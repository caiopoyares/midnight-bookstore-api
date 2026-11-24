CREATE TABLE books (
  slug text PRIMARY KEY, title text NOT NULL, author text NOT NULL,
  genre text NOT NULL, synopsis text NOT NULL, note text NOT NULL, position integer NOT NULL
);
CREATE TABLE editions (
  sku text PRIMARY KEY, book_slug text NOT NULL REFERENCES books, format text NOT NULL,
  price integer NOT NULL CHECK (price > 0), on_hand integer NOT NULL CHECK (on_hand >= 0),
  reserved integer NOT NULL DEFAULT 0 CHECK (reserved BETWEEN 0 AND on_hand)
);
CREATE INDEX editions_book ON editions(book_slug);
CREATE TABLE orders (
  id uuid PRIMARY KEY, attempt uuid NOT NULL UNIQUE, fingerprint text NOT NULL,
  email text NOT NULL, address jsonb NOT NULL, state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','paid','expired','shipped')),
  mode text NOT NULL CHECK (mode IN ('demo','stripe')), currency text NOT NULL,
  subtotal integer NOT NULL DEFAULT 0, shipping integer NOT NULL, total integer NOT NULL DEFAULT 0,
  session_id text UNIQUE, payment_url text, origin text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), last_checked timestamptz, shipped_at timestamptz, shipped_by text
);
CREATE INDEX orders_overdue ON orders(expires_at) WHERE state='pending';
CREATE TABLE order_lines (
  order_id uuid NOT NULL REFERENCES orders, sku text NOT NULL REFERENCES editions,
  title text NOT NULL, format text NOT NULL, quantity integer NOT NULL CHECK (quantity > 0),
  price integer NOT NULL CHECK (price > 0), PRIMARY KEY(order_id, sku)
);
CREATE TABLE stock_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, sku text NOT NULL REFERENCES editions,
  delta integer NOT NULL, reason text NOT NULL, actor text NOT NULL, request_id uuid NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payment_events (
  id text PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mail_jobs (
  order_id uuid PRIMARY KEY REFERENCES orders, state text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0, next_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), last_error text
);
