import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 25,
  });
  async tx<T>(operation: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async migrate(seed = false) {
    await this.tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(724691)');
      await client.query(
        'CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY)',
      );
      if (
        !(await client.query("SELECT 1 FROM migrations WHERE name='001_store'"))
          .rowCount
      ) {
        await client.query(
          await readFile(join(__dirname, '../db/001_store.sql'), 'utf8'),
        );
        await client.query("INSERT INTO migrations VALUES ('001_store')");
      }
      if (seed)
        await client.query(
          await readFile(join(__dirname, '../db/sample.sql'), 'utf8'),
        );
    });
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
}
@Global()
@Module({ providers: [Database], exports: [Database] })
export class DataModule {}
