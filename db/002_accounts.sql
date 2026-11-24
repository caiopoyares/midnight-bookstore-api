CREATE TABLE customers (
 id uuid PRIMARY KEY, email text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE login_links (
 hash text PRIMARY KEY, email text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE customer_sessions (
 hash text PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers, expires_at timestamptz NOT NULL
);
CREATE TABLE login_requests (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 email text NOT NULL, ip text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_requests_recent ON login_requests(created_at);
ALTER TABLE orders ADD COLUMN customer_id uuid REFERENCES customers;
CREATE INDEX orders_customer ON orders(customer_id);
