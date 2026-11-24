const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes, randomUUID } = require('node:crypto');
const { mkdir } = require('node:fs/promises');
const { setTimeout } = require('node:timers/promises');

const execute = promisify(execFile);
const image = 'postgres:18-bookworm';
const user = 'midnight_test';
const database = 'midnight_test';
const dataDirectory = '/var/lib/postgresql';

async function docker(args, options = {}) {
  const { stdout } = await execute('docker', args, {
    timeout: 120_000,
    ...options,
  });
  return stdout.trim();
}

async function startPostgres({ password = randomBytes(24).toString('hex'), backupDirectory } = {}) {
  try {
    await docker(['info', '--format', '{{.ServerVersion}}']);
  } catch (cause) {
    throw new Error('Docker is required for database tests. Start Docker and rerun npm test.', { cause });
  }
  const name = `midnight-test-${randomUUID()}`;
  const remove = () => docker(['rm', '--force', '--volumes', name]);
  try {
    await docker([
      'create', '--name', name,
      '--label', 'midnight-books.test=true',
      '--publish', '127.0.0.1::5432',
      '--env', `POSTGRES_USER=${user}`,
      '--env', `POSTGRES_DB=${database}`,
      '--env', 'POSTGRES_PASSWORD',
      '--health-cmd', `pg_isready -h 127.0.0.1 -U ${user} -d ${database}`,
      '--health-interval', '1s', '--health-timeout', '3s', '--health-retries', '60',
      image,
    ], { env: { ...process.env, POSTGRES_PASSWORD: password } });
    if (backupDirectory)
      await docker(['cp', `${backupDirectory}/.`, `${name}:${dataDirectory}`]);
    await docker(['start', name]);

    const deadline = Date.now() + 60_000;
    while (true) {
      const state = JSON.parse(await docker(['inspect', '--format', '{{json .State}}', name]));
      if (state.Health?.Status === 'healthy') break;
      if (!state.Running || state.Health?.Status === 'unhealthy' || Date.now() >= deadline) {
        const logs = await docker(['logs', '--tail', '30', name]);
        throw new Error(`Test PostgreSQL failed to become ready.\n${logs}`);
      }
      await setTimeout(250);
    }
    const ports = JSON.parse(await docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]));
    const port = ports['5432/tcp'][0].HostPort;
    return {
      url: `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`,
      async backup(directory) {
        await docker(['stop', '--timeout', '10', name]);
        await mkdir(directory, { recursive: true });
        await docker(['cp', `${name}:${dataDirectory}/.`, directory]);
      },
      remove,
    };
  } catch (error) {
    await remove().catch(() => {});
    throw error;
  }
}

module.exports = { startPostgres };
