const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Database } = require('../dist/db');
const { migrate } = require('../dist/migrate');
const { startPostgres } = require('./helpers/postgres.cjs');
const execute = promisify(execFile);
let dir, directory, pg, db;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'midnight-migrations-'));
  pg = await startPostgres();
  process.env.DATABASE_URL = pg.url;
  db = new Database();
  directory = join(dir, 'sql');
});

beforeEach(async () => {
  await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory);
  await Promise.all([
    writeFile(join(directory, '2_create.sql'), 'CREATE TABLE probe (value text PRIMARY KEY);'),
    writeFile(join(directory, '010_insert.sql'), "INSERT INTO probe VALUES ('migration');"),
    writeFile(join(directory, 'sample.sql'), "INSERT INTO probe VALUES ('seed');"),
    writeFile(join(directory, 'notes.sql'), 'SELECT 1 / 0;'),
    mkdir(join(directory, '3_directory.sql')),
  ]);
});

after(async () => {
  try {
    if (db) await db.onModuleDestroy();
  } finally {
    try {
      if (pg) await pg.remove();
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }
});

test('discovers SQL files in numeric order and seeds only when requested', async () => {
  assert.deepEqual(await migrate(db, { directory }), ['2_create', '010_insert']);
  assert.deepEqual((await db.pool.query('SELECT * FROM probe')).rows, [{ value: 'migration' }]);
  assert.deepEqual(await migrate(db, { directory, seed: true }), []);
  assert.deepEqual(
    (await db.pool.query('SELECT value FROM probe ORDER BY value')).rows,
    [{ value: 'migration' }, { value: 'seed' }],
  );
});

test('preserves the existing migration ledger and discovers new files on later runs', async () => {
  await db.pool.query("CREATE TABLE migrations (name text PRIMARY KEY); INSERT INTO migrations VALUES ('001_store');");
  await writeFile(join(directory, '001_store.sql'), 'SELECT 1 / 0;');
  assert.deepEqual(await migrate(db, { directory }), ['2_create', '010_insert']);
  await writeFile(join(directory, '011_new.sql'), "INSERT INTO probe VALUES ('new');");
  assert.deepEqual(await migrate(db, { directory }), ['011_new']);
  assert.deepEqual(await migrate(db, { directory }), []);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM migrations')).rows[0].n, 4);
});

test('concurrent migration runs apply each file exactly once', async () => {
  const results = await Promise.all(
    Array.from({ length: 4 }, () => migrate(db, { directory })),
  );
  assert.deepEqual(results.flat().sort(), ['010_insert', '2_create']);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM probe')).rows[0].n, 1);
});

test('a failed migration rolls back the whole pending batch and its ledger entries', async () => {
  await writeFile(join(directory, '011_broken.sql'), 'SELECT 1 / 0;');
  await assert.rejects(migrate(db, { directory }), /division by zero/);
  const { rows } = await db.pool.query("SELECT to_regclass('probe') AS probe, to_regclass('migrations') AS migrations");
  assert.deepEqual(rows[0], { probe: null, migrations: null });
  await rm(join(directory, '011_broken.sql'));
  assert.deepEqual(await migrate(db, { directory }), ['2_create', '010_insert']);
});

test('rejects ambiguous migration numbers before applying SQL', async () => {
  await writeFile(join(directory, '002_duplicate.sql'), 'SELECT 1;');
  await assert.rejects(migrate(db, { directory }), /Duplicate migration number/);
  assert.equal((await db.pool.query("SELECT to_regclass('migrations') AS name")).rows[0].name, null);
});

test('the migration command initializes the real schema, supports seeding and closes its connection', async () => {
  const options = {
    cwd: join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: pg.url, SEED_CATALOG: 'no' },
    timeout: 20_000,
  };
  await execute('npm', ['run', 'db:migrate'], options);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM books')).rows[0].n, 0);
  await execute('npm', ['run', 'db:migrate', '--', '--seed'], options);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM books')).rows[0].n, 12);
  const { stdout } = await execute('npm', ['run', 'db:migrate'], options);
  assert.match(stdout, /up to date/);
});
