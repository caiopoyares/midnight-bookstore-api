import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from './db';

export async function migrate(
  db: Pick<Database, 'tx'>,
  { directory = join(__dirname, '../db'), seed = false } = {},
) {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d+_[a-z0-9_]+\.sql$/i.test(entry.name))
    .map((entry) => ({
      file: entry.name,
      name: entry.name.slice(0, -4),
      version: BigInt(entry.name.split('_')[0]),
    }))
    .sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  for (let i = 1; i < files.length; i++) {
    if (files[i].version === files[i - 1].version)
      throw new Error(
        `Duplicate migration number in ${files[i - 1].file} and ${files[i].file}`,
      );
  }

  return db.tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(724691)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY)',
    );
    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM migrations',
    );
    const applied = new Set(rows.map((row) => row.name));
    const pending = files.filter(({ name }) => !applied.has(name));
    for (const { file, name } of pending) {
      await client.query(await readFile(join(directory, file), 'utf8'));
      await client.query('INSERT INTO migrations (name) VALUES ($1)', [name]);
    }
    if (seed)
      await client.query(await readFile(join(directory, 'sample.sql'), 'utf8'));
    return pending.map(({ name }) => name);
  });
}

if (require.main === module) {
  const db = new Database();
  migrate(db, {
    seed: process.argv.includes('--seed') || process.env.SEED_CATALOG === 'yes',
  })
    .then((names) => {
      console.log(
        names.length
          ? `Applied migrations: ${names.join(', ')}`
          : 'Database migrations are up to date.',
      );
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(() => db.onModuleDestroy());
}
