import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { from as copyFrom } from 'pg-copy-streams';
import type pg from 'pg';
import { resolve } from 'node:path';
import { type Config, root } from './config.js';
import { tables, rows, type Value } from './generator/tables.js';
import { assertMigrated, environment, saveJson, schema, implementationManifest } from './db.js';
import { validate } from './validation.js';

/** CSV의 NULL과 빈 문자열을 구별하고 COPY backpressure로 메모리를 제한한다. */
export function csv(value: Value): string {
  if (value === null) return '';
  if (typeof value !== 'string') return String(value);
  return '"' + value.replaceAll('"', '""') + '"';
}
export interface Loaded { table: string; count: number; sha256: string }
export async function load(client: pg.Client, c: Config) {
  const source = await assertMigrated(client);
  for (const table of tables) if ((await client.query(`SELECT EXISTS(SELECT 1 FROM ${table}) AS present`)).rows[0].present)
    throw new Error(`Table ${table} is not empty. Use explicit db:reset before replacing the dataset.`);
  const started = Date.now(), loaded: Loaded[] = [];
  const runDir = resolve(root, 'results', c.name, `seed-${new Date().toISOString().replaceAll(':', '-')}`);
  await saveJson(resolve(runDir, 'pending.json'), { config: c, source });
  await client.query('BEGIN');
  try {
    for (const table of tables) {
      const iter = rows(table, c), first = iter.next(), hash = createHash('sha256');
      let count = 0;
      if (!first.done) {
        const columns = Object.keys(first.value);
        function* chunks() {
          let current = first, chunk = '';
          while (!current.done) {
            const line = columns.map(k => csv(current.value[k])).join(',') + '\n';
            hash.update(line); chunk += line; count++;
            if (chunk.length >= 65536) { yield chunk; chunk = ''; }
            current = iter.next();
          }
          if (chunk) yield chunk;
        }
        await pipeline(Readable.from(chunks()), client.query(copyFrom(`COPY ${table} (${columns.join(',')}) FROM STDIN WITH (FORMAT csv)`)));
        await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT max(id) FROM ${table}), true)`);
      }
      loaded.push({ table, count, sha256: hash.digest('hex') });
      console.log(`${table}: ${count.toLocaleString()} rows`);
    }
    await validate(client, c, loaded);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    await saveJson(resolve(runDir, 'failure.json'), { loaded, error: e instanceof Error ? { ...e, message: e.message, stack: e.stack } : String(e) });
    throw e;
  }
  await client.query('ANALYZE');
  const manifest = { config: c, source, implementation: await implementationManifest(), loaded, elapsedMs: Date.now() - started, runDir,
    schema: await schema(client), environment: await environment(client) };
  await saveJson(resolve(runDir, 'manifest.json'), manifest);
  await saveJson(resolve(root, 'results', 'active.json'), manifest);
  return manifest;
}
