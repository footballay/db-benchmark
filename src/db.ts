import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, migrationDir } from './config.js';

/** 접속 대상을 전용 로컬 DB로 제한하고 스키마 출처를 결과에 남긴다. */
export async function connect() {
  const client = new pg.Client({ host: '127.0.0.1', port: Number(process.env.BENCH_PORT ?? 55432), user: 'benchmark', password: process.env.BENCH_PASSWORD ?? 'footballay_benchmark_only', database: 'footballay_benchmark', application_name: 'footballay-benchmark' });
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  return client;
}
export function compose(...args: string[]) {
  const r = spawnSync('docker', ['compose', '--project-directory', root, '-f', resolve(root, 'docker-compose.yml'), ...args], { cwd: root, stdio: 'inherit', shell: false });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`docker compose failed (${r.status})`);
}
export async function sourceManifest() {
  const files = (await readdir(migrationDir)).filter(n => /^V\d+__.*\.sql$/.test(n)).sort((a, b) => Number(a.match(/^V(\d+)/)![1]) - Number(b.match(/^V(\d+)/)![1]));
  const migrations = await Promise.all(files.map(async name => ({ name, sha256: createHash('sha256').update(await readFile(resolve(migrationDir, name))).digest('hex') })));
  const git = spawnSync('git', ['-C', resolve(root, '../footballay-core'), 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return { commit: git.status === 0 ? git.stdout.trim() : null, migrations };
}
export async function implementationManifest() {
  const paths: string[] = ['package.json', 'package-lock.json', 'docker-compose.yml'];
  async function walk(relative: string) {
    for (const entry of await readdir(resolve(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path); else paths.push(path);
    }
  }
  await walk('src'); await walk('sql');
  return Promise.all(paths.sort().map(async path => ({ path, sha256: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') })));
}
export async function schema(client: pg.Client) {
  return {
    columns: (await client.query("SELECT table_name,column_name,data_type,is_nullable,column_default,is_identity FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows,
    constraints: (await client.query("SELECT conrelid::regclass::text AS table_name,conname,contype,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conrelid::regclass::text,conname")).rows,
    indexes: (await client.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")).rows,
    history: (await client.query('SELECT installed_rank,version,description,script,checksum,success FROM flyway_schema_history ORDER BY installed_rank')).rows,
  };
}
export async function assertMigrated(client: pg.Client) {
  const source = await sourceManifest();
  const history = (await client.query('SELECT version,script,success FROM flyway_schema_history ORDER BY installed_rank')).rows;
  if (history.length !== source.migrations.length || history.some((h, i) => !h.success || h.script !== source.migrations[i].name)) throw new Error('Migration history differs from source. Run db:migrate.');
  return source;
}
export async function environment(client: pg.Client) {
  return { node: process.version, platform: process.platform, architecture: process.arch,
    postgres: (await client.query('SELECT version()')).rows[0].version,
    settings: (await client.query("SELECT name,setting,unit FROM pg_settings WHERE name IN ('shared_buffers','work_mem','effective_cache_size','random_page_cost','seq_page_cost','default_statistics_target','max_parallel_workers_per_gather','jit','plan_cache_mode','TimeZone') ORDER BY name")).rows,
    relations: (await client.query("SELECT relname,n_live_tup,pg_total_relation_size(relid)::text AS total_bytes FROM pg_stat_user_tables ORDER BY relname")).rows };
}
export async function saveJson(path: string, value: unknown) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}
