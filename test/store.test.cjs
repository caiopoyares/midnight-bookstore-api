const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, cp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { createServer } = require('node:net');
const { Client } = require('pg');
const Stripe = require('stripe');
const staff = randomBytes(32).toString('hex');
const password = randomBytes(24).toString('hex');
const hook = 'whsec_local_fixture';
let app, db, pg, dir, url, payments, jobs, openCluster, port;
let failAfterCreate, completeDuringExpiry;
const sessions = new Map(),
  keys = new Map();
const address = {
  name: 'Demo Reader',
  street: '1 Test Lane',
  city: 'Salem',
  region: 'MA',
  postal: '01970',
  country: 'US',
};
const line = (sku, quantity = 1) => ({ sku, quantity });
const basket = (lines) => ({ email: 'reader@example.test', address, lines });
async function request(
  path,
  body,
  headers = {},
  method = body ? 'POST' : 'GET',
) {
  const res = await fetch(url + '/v1/' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const buy = (items, key = randomUUID()) =>
  request('checkout', basket(items), { 'Idempotency-Key': key });
async function stock(sku) {
  return (
    await db.pool.query('SELECT on_hand,reserved FROM editions WHERE sku=$1', [
      sku,
    ])
  ).rows[0];
}
async function sendEvent(session, id = randomUUID(), signature = true) {
  const event = {
    id,
    type: 'checkout.session.' + session.status.replace('complete', 'completed'),
    data: { object: session },
  };
  const signatureValue = Stripe.webhooks.generateTestHeaderString({
    payload: JSON.stringify(event),
    secret: signature ? hook : 'other-fixture',
  });
  return request('payments/webhook', event, {
    'stripe-signature': signatureValue,
  });
}
async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
before(async () => {
  openCluster = (await import('../scripts/cluster.mjs')).startCluster;
  dir = await mkdtemp(join(tmpdir(), 'nightjar-qa-'));
  port = await availablePort();
  pg = await openCluster(join(dir, 'original'), port, password);
  Object.assign(process.env, {
    DATABASE_URL: pg.url,
    NODE_ENV: 'test',
    PAYMENT_MODE: 'stripe',
    STRIPE_SECRET_KEY: 'sk_test_fixture',
    STRIPE_WEBHOOK_SECRET: hook,
    PORT: '0',
    SEED_CATALOG: 'yes',
    STAFF_KEYS: JSON.stringify({ tester: staff }),
  });
  const { bootstrap } = require('../dist/main'),
    { Database } = require('../dist/db'),
    { Payments } = require('../dist/payments'),
    { Jobs } = require('../dist/jobs');
  app = await bootstrap();
  db = app.get(Database);
  payments = app.get(Payments);
  jobs = app.get(Jobs);
  jobs.onModuleDestroy();
  url = 'http://127.0.0.1:' + app.getHttpServer().address().port;
  const gateway = payments.stripe.checkout.sessions;
  gateway.create = async (args, options) => {
    let session = keys.get(options.idempotencyKey);
    if (!session) {
      session = {
        id: 'cs_' + randomUUID(),
        metadata: args.metadata,
        client_reference_id: args.client_reference_id,
        currency: 'usd',
        amount_total: args.line_items[0].price_data.unit_amount,
        status: 'open',
        payment_status: 'unpaid',
        url: 'https://checkout.example.test/pay',
      };
      keys.set(options.idempotencyKey, session);
      sessions.set(session.id, session);
    }
    if (failAfterCreate) {
      failAfterCreate = false;
      throw Error('Simulated provider timeout');
    }
    return session;
  };
  gateway.retrieve = async (id) => sessions.get(id);
  gateway.expire = async (id) => {
    const session = sessions.get(id);
    if (completeDuringExpiry) {
      Object.assign(session, { status: 'complete', payment_status: 'paid' });
      throw Error('Session already completed');
    }
    session.status = 'expired';
    return session;
  };
  gateway.list = async function* () {
    yield* sessions.values();
  };
});
beforeEach(async () => {
  failAfterCreate = false;
  completeDuringExpiry = false;
  keys.clear();
  sessions.clear();
  // This database lives in a new temporary cluster for this suite.
  await db.pool.query('TRUNCATE books,orders CASCADE');
  await db.migrate(true);
});
after(async () => {
  if (app) await app.close();
  if (pg) await pg.cluster.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('20 simultaneous attempts for one copy create exactly one order and one hold', async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () => buy([line('HILL-HC')])),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 19);
  assert.deepEqual(await stock('HILL-HC'), { on_hand: 1, reserved: 1 });
  assert.equal(
    (await db.pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n,
    1,
  );
});
test('a failed multi-edition order rolls back every line', async () => {
  await buy([line('HILL-HC')]);
  const before = await stock('CARM-HC');
  assert.equal((await buy([line('CARM-HC'), line('HILL-HC')])).status, 409);
  assert.deepEqual(await stock('CARM-HC'), before);
  assert.equal((await buy([line('CARM-HC', -1)])).status, 400);
});
test('concurrent retries share a reservation and a provider session', async () => {
  const key = randomUUID(),
    before = await stock('WILL-PB');
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      buy([line('WILL-PB'), line('WILL-PB')], key),
    ),
  );
  assert.ok(
    results.every((r) => r.status === 200 && r.body.id === results[0].body.id),
  );
  assert.equal((await stock('WILL-PB')).reserved, before.reserved + 2);
  assert.equal((await buy([line('WILL-PB')], key)).status, 409);
});
test('provider creation timeout recovers the original session', async () => {
  const key = randomUUID();
  failAfterCreate = true;
  assert.ok((await buy([line('KING-PB')], key)).status >= 500);
  const retry = await buy([line('KING-PB')], key);
  assert.equal(retry.status, 200);
  const saved = (
    await db.pool.query('SELECT * FROM orders WHERE attempt=$1', [key])
  ).rows[0];
  assert.equal(saved.session_id, keys.get('nightjar-' + saved.id).id);
  assert.equal((await stock('KING-PB')).reserved, 1);
});
test('verified payment settles once, queues one receipt and allows shipping', async () => {
  const initial = await stock('FRAN-PB');
  const {
    body: { id },
  } = await buy([line('FRAN-PB')]);
  const session = keys.get('nightjar-' + id);
  Object.assign(session, { status: 'complete', payment_status: 'paid' });
  assert.equal((await sendEvent(session, randomUUID(), false)).status, 400);
  assert.equal((await sendEvent({ ...session, amount_total: 1 })).status, 409);
  const event = randomUUID();
  assert.deepEqual(
    (
      await Promise.all([
        sendEvent(session, event),
        sendEvent(session, event),
        sendEvent(session),
      ])
    ).map((r) => r.status),
    [200, 200, 200],
  );
  assert.deepEqual(await stock('FRAN-PB'), {
    on_hand: initial.on_hand - 1,
    reserved: initial.reserved,
  });
  assert.equal(
    (await db.pool.query('SELECT * FROM mail_jobs WHERE order_id=$1', [id]))
      .rowCount,
    1,
  );
  assert.equal((await request('orders/' + id)).body.state, 'paid');
  assert.equal((await request('staff/orders/' + id + '/ship', {})).status, 401);
  assert.equal(
    (
      await request(
        'staff/orders/' + id + '/ship',
        {},
        { Authorization: 'Bearer ' + staff },
      )
    ).body.state,
    'shipped',
  );
  assert.equal((await request('orders/' + id + '/demo-pay', {})).status, 404);
});
test('expiry releases abandoned holds and reconciles payment racing expiry', async () => {
  for (const paid of [false, true]) {
    const initial = await stock('TURN-PB'),
      {
        body: { id },
      } = await buy([line('TURN-PB')]);
    await db.pool.query(
      "UPDATE orders SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [id],
    );
    completeDuringExpiry = paid;
    const order = (
      await db.pool.query('SELECT * FROM orders WHERE id=$1', [id])
    ).rows[0];
    await payments.reconcile(order);
    await payments.reconcile(order);
    assert.equal(
      (await request('orders/' + id)).body.state,
      paid ? 'paid' : 'expired',
    );
    assert.deepEqual(await stock('TURN-PB'), {
      on_hand: initial.on_hand - Number(paid),
      reserved: initial.reserved,
    });
  }
});
test('an old ambiguous checkout recovers its provider session without starting another', async () => {
  const {
      body: { id },
    } = await buy([line('KING-PB')]),
    session = keys.get('nightjar-' + id);
  await db.pool.query(
    "UPDATE orders SET session_id=NULL,created_at=now()-interval '30 hours',expires_at=now()-interval '29 hours' WHERE id=$1",
    [id],
  );
  Object.assign(session, { status: 'complete', payment_status: 'paid' });
  const prior = keys.size;
  await payments.reconcile(
    (await db.pool.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0],
  );
  assert.equal((await request('orders/' + id)).body.state, 'paid');
  assert.equal(keys.size, prior);
});
test('receipt delivery retries a transient failure with the same provider key', async () => {
  const {
    body: { id },
  } = await buy([line('CARM-HC')]);
  const session = keys.get('nightjar-' + id);
  await sendEvent(
    Object.assign(session, { status: 'complete', payment_status: 'paid' }),
  );
  const originalFetch = global.fetch,
    delivered = [];
  global.fetch = async (url, options) => {
    if (url !== 'https://api.resend.com/emails')
      throw Error('Unexpected destination');
    delivered.push(options.headers['Idempotency-Key']);
    return new Response(null, { status: delivered.length === 1 ? 503 : 200 });
  };
  try {
    await jobs.deliverOne();
    assert.equal(
      (
        await db.pool.query(
          'SELECT attempts FROM mail_jobs WHERE order_id=$1',
          [id],
        )
      ).rows[0].attempts,
      1,
    );
    await db.pool.query(
      'UPDATE mail_jobs SET next_at=now() WHERE order_id=$1',
      [id],
    );
    await jobs.deliverOne();
    assert.equal(
      (
        await db.pool.query('SELECT state FROM mail_jobs WHERE order_id=$1', [
          id,
        ])
      ).rows[0].state,
      'sent',
    );
    assert.deepEqual(delivered, ['order/' + id, 'order/' + id]);
  } finally {
    global.fetch = originalFetch;
  }
});
test('stock changes enforce reserved quantities and retain an idempotent audit trail', async () => {
  await buy([line('HILL-HC')]);
  const headers = { Authorization: 'Bearer ' + staff },
    item = {
      sku: 'HILL-HC',
      delta: -1,
      reason: 'Damage',
      requestId: randomUUID(),
    };
  assert.equal((await request('staff/stock', item, headers)).status, 409);
  item.delta = 1;
  item.reason = 'Delivery';
  assert.equal((await request('staff/stock', item, headers)).status, 201);
  assert.equal((await request('staff/stock', item, headers)).status, 201);
  assert.deepEqual(await stock('HILL-HC'), { on_hand: 2, reserved: 1 });
  assert.equal((await request('staff', null, headers)).body.log.length, 1);
});
test('a cold backup restores inventory and settled orders to a separate PostgreSQL cluster', async () => {
  const {
    body: { id },
  } = await buy([line('HILL-HC')]);
  const session = keys.get('nightjar-' + id);
  await sendEvent(
    Object.assign(session, { status: 'complete', payment_status: 'paid' }),
  );
  await request(
    'staff/orders/' + id + '/ship',
    {},
    { Authorization: 'Bearer ' + staff },
  );
  const original = await stock('HILL-HC'),
    orders = (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM orders WHERE state='shipped'",
      )
    ).rows[0].n;
  await app.close();
  app = null;
  await pg.cluster.stop();
  pg = null;
  const copy = join(dir, 'restored');
  await cp(join(dir, 'original'), copy, { recursive: true });
  const restored = await openCluster(copy, await availablePort(), password);
  const client = new Client({ connectionString: restored.url });
  try {
    await client.connect();
    assert.deepEqual(
      (
        await client.query(
          "SELECT on_hand,reserved FROM editions WHERE sku='HILL-HC'",
        )
      ).rows[0],
      original,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM orders WHERE state='shipped'",
        )
      ).rows[0].n,
      orders,
    );
    assert.ok(orders > 0);
  } finally {
    await client.end();
    await restored.cluster.stop();
  }
});
