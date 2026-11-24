import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startCluster } from './cluster.mjs';

if (process.env.NODE_ENV === 'production')
  throw Error(
    'Use npm start with an external PostgreSQL database in production.',
  );
const dir = resolve(process.env.LOCAL_DATA_DIR ?? '.local');
await mkdir(dir, { recursive: true, mode: 0o700 });
async function secret(name) {
  const path = resolve(dir, name);
  if (!existsSync(path))
    await writeFile(path, randomBytes(32).toString('hex'), {
      mode: 0o600,
      flag: 'wx',
    });
  return (await readFile(path, 'utf8')).trim();
}
let db;
if (!process.env.DATABASE_URL) {
  db = await startCluster(
    resolve(dir, 'postgres'),
    Number(process.env.PGPORT ?? 55432),
    await secret('database-key'),
  );
  process.env.DATABASE_URL = db.url;
}
process.env.STAFF_KEYS ??= JSON.stringify({
  bookseller: await secret('staff-key'),
});
process.env.SEED_CATALOG ??= 'yes';
const { bootstrap } = await import('../dist/main.js');
try {
  const app = await bootstrap();
  console.log('Local staff key is stored in .local/staff-key.');
  if (db) app.getHttpServer().once('close', () => void db.cluster.stop());
} catch (error) {
  if (db) await db.cluster.stop();
  throw error;
}
