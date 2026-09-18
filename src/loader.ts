import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { type Config, root } from './config.js';
import { assertMigrated, saveJson } from './db.js';
import { rows, tables, type Value } from './generator/tables.js';
import { validate } from './validation.js';

export function csv(value: Value): string {
  if (value === null) return '';
  if (typeof value !== 'string') return String(value);
  return `"${value.replaceAll('"', '""')}"`;
}

export interface Loaded {
  table: string;
  count: number;
  sha256: string;
}

export interface ActiveDataset {
  config: Config;
  loaded: Loaded[];
  source: Awaited<ReturnType<typeof assertMigrated>>;
  createdAt: string;
  elapsedMs: number;
}

export async function load(client: pg.Client, config: Config): Promise<ActiveDataset> {
  const source = await assertMigrated(client);
  for (const table of tables) {
    const present = (await client.query(`SELECT EXISTS(SELECT 1 FROM ${table}) AS present`)).rows[0].present;
    if (present) throw new Error(`Table ${table} is not empty. Run db:reset before replacing the dataset.`);
  }

  const started = Date.now();
  const loaded: Loaded[] = [];
  await client.query('BEGIN');
  try {
    for (const table of tables) {
      const iterator = rows(table, config);
      const first = iterator.next();
      const hash = createHash('sha256');
      let count = 0;

      if (!first.done) {
        const columns = Object.keys(first.value);
        function* chunks() {
          let current = first;
          let chunk = '';
          while (!current.done) {
            const line = `${columns.map((column) => csv(current.value[column])).join(',')}\n`;
            hash.update(line);
            chunk += line;
            count++;
            if (chunk.length >= 65_536) {
              yield chunk;
              chunk = '';
            }
            current = iterator.next();
          }
          if (chunk) yield chunk;
        }
        await pipeline(
          Readable.from(chunks()),
          client.query(copyFrom(`COPY ${table} (${columns.join(',')}) FROM STDIN WITH (FORMAT csv)`)),
        );
        await client.query(
          `SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT max(id) FROM ${table}), true)`,
        );
      }

      loaded.push({ table, count, sha256: hash.digest('hex') });
      console.log(`${table}: ${count.toLocaleString()} rows`);
    }

    await validate(client, config, loaded);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  await client.query('ANALYZE');
  const active: ActiveDataset = {
    config,
    loaded,
    source,
    createdAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
  };
  await saveJson(resolve(root, 'results', 'active.json'), active);
  return active;
}

export async function readActiveDataset(): Promise<ActiveDataset> {
  const path = resolve(root, 'results', 'active.json');
  const active = JSON.parse(await readFile(path, 'utf8')) as ActiveDataset | null;
  if (!active?.config || !Array.isArray(active.loaded)) {
    throw new Error('No active dataset metadata. Run seed:realistic or seed:scale first.');
  }
  return active;
}
