import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export async function startCluster(dir, port, password) {
  const cluster = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: 'nightjar',
    password,
    authMethod: 'scram-sha-256',
    persistent: true,
    postgresFlags: ['-h', '127.0.0.1', '-c', 'unix_socket_directories='],
    onLog: (message) => {
      if (/FATAL|PANIC/.test(message)) console.error(message);
    },
  });
  if (!existsSync(join(dir, 'PG_VERSION'))) await cluster.initialise();
  await cluster.start();
  return {
    cluster,
    url: `postgresql://nightjar:${password}@127.0.0.1:${port}/postgres`,
  };
}
