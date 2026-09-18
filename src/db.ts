import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { migrationDir, root } from './config.js';

export async function connect() {
  const client = new pg.Client({
    host: '127.0.0.1',
    port: Number(process.env.BENCH_PORT ?? 55432),
    user: 'benchmark',
    password: process.env.BENCH_PASSWORD ?? 'footballay_benchmark_only',
    database: 'footballay_benchmark',
    application_name: 'footballay-db-builder',
  });
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  return client;
}

export function compose(...args: string[]) {
  const result = spawnSync(
    'docker',
    ['compose', '--project-directory', root, '-f', resolve(root, 'docker-compose.yml'), ...args],
    { cwd: root, stdio: 'inherit', shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker compose failed (${result.status})`);
}

export async function sourceManifest() {
  const files = (await readdir(migrationDir))
    .filter((name) => /^V\d+__.*\.sql$/.test(name))
    .sort((a, b) => Number(a.match(/^V(\d+)/)![1]) - Number(b.match(/^V(\d+)/)![1]));
  const migrations = await Promise.all(
    files.map(async (name) => ({
      name,
      sha256: createHash('sha256').update(await readFile(resolve(migrationDir, name))).digest('hex'),
    })),
  );
  return { migrations };
}

export async function assertMigrated(client: pg.Client) {
  const source = await sourceManifest();
  const history = (
    await client.query('SELECT version, script, success FROM flyway_schema_history ORDER BY installed_rank')
  ).rows;
  if (
    history.length !== source.migrations.length ||
    history.some((migration, index) =>
      !migration.success || migration.script !== source.migrations[index].name)
  ) {
    throw new Error('Migration history differs from footballay-core. Run db:migrate.');
  }
  return source;
}

export async function saveJson(path: string, value: unknown) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function clearActiveDataset() {
  await saveJson(resolve(root, 'results', 'active.json'), null);
}
