import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { config, root } from './config.js';
import { compose, connect, schema, sourceManifest, saveJson } from './db.js';
import { load } from './loader.js';
import { validate } from './validation.js';
import { active, benchmark } from './benchmark/run.js';

/** 운영 DB URL을 받지 않는 전용 benchmark 명령 진입점이다. */
async function main() {
  const command = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: Object.fromEntries([
    'preset','seed','leagueCount','teamsPerLeague','playersPerTeam','seasonsPerLeague','latestSeasonYear','scheduleCycleFactor','matchDetailEvery',
    'suite','repeats','ranges','families','confirm',
  ].map(k => [k, { type: 'string' as const }])) });
  if (command === 'db:up') return compose('up', '-d', '--wait', 'postgres');
  if (command === 'db:down') return compose('down');
  if (command === 'db:migrate') {
    await sourceManifest();
    compose('run', '--rm', 'flyway', 'migrate');
    compose('run', '--rm', 'flyway', 'validate');
    return;
  }
  if (command === 'db:reset') {
    if (values.confirm !== 'footballay-benchmark') throw new Error('This deletes the dedicated benchmark volume. Supply --confirm footballay-benchmark.');
    compose('down', '--volumes');
    await writeFile(resolve(root, 'results/active.json'), 'null\n');
    compose('up', '-d', '--wait', 'postgres');
    compose('run', '--rm', 'flyway', 'migrate');
    return;
  }
  if (!['seed','validate','benchmark','inspect'].includes(command)) throw new Error('Commands: db:up db:down db:migrate db:reset seed validate benchmark inspect');
  const client = await connect();
  try {
    // 같은 DB의 seed, benchmark, index 변경을 직렬화한다.
    await client.query('SELECT pg_advisory_lock(20260917)');
    if (command === 'seed') {
      const overrides = Object.fromEntries(Object.entries(values).filter(([k]) => k !== 'preset')) as Record<string, string>;
      const c = config(values.preset ?? 'leagues-100k', overrides);
      compose('run', '--rm', 'flyway', 'validate');
      await load(client, c);
    } else if (command === 'validate') {
      const m = await active(client);
      await saveJson(resolve(root, 'results/validation.json'), await validate(client, m.config, m.loaded));
    } else if (command === 'inspect') {
      await saveJson(resolve(root, 'results/schema.json'), { source: await sourceManifest(), schema: await schema(client) });
    } else {
      const repeats = Number(values.repeats ?? 5), suite = values.suite ?? 'main';
      if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100) throw new Error('repeats must be 1..100');
      if (!['main','indexes'].includes(suite)) throw new Error('suite must be main or indexes');
      await benchmark(client, { suite, repeats, ranges: values.ranges?.split(','), families: values.families?.split(',') });
    }
  } finally { await client.end(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
