import { parseArgs } from 'node:util';
import { config } from './config.js';
import { clearActiveDataset, compose, connect, sourceManifest } from './db.js';
import { load, readActiveDataset } from './loader.js';
import { validate } from './validation.js';
import { benchmarkFixtureLeagueSeasonBefore } from './fixture-league-season-before.js';

const generatorOptions = [
  'preset',
  'seed',
  'leagueCount',
  'teamsPerLeague',
  'playersPerTeam',
  'seasonsPerLeague',
  'latestSeasonYear',
  'scheduleCycleFactor',
  'matchDetailEvery',
] as const;

async function main() {
  const command = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: Object.fromEntries(
      [...generatorOptions, 'confirm'].map((key) => [key, { type: 'string' as const }]),
    ),
  });

  if (command === 'db:up') return compose('up', '-d', '--wait', 'postgres');
  if (command === 'db:down') return compose('down');
  if (command === 'benchmark:fixture-league-season:before') {
    const client = await connect();
    try {
      await benchmarkFixtureLeagueSeasonBefore(client);
    } finally {
      await client.end();
    }
    return;
  }
  if (command === 'db:migrate') {
    await sourceManifest();
    compose('run', '--rm', 'flyway', 'migrate');
    compose('run', '--rm', 'flyway', 'validate');
    return;
  }
  if (command === 'db:reset') {
    if (values.confirm !== 'footballay-benchmark') {
      throw new Error('This deletes the dedicated PostgreSQL volume. Supply --confirm footballay-benchmark.');
    }
    compose('down', '--volumes');
    await clearActiveDataset();
    compose('up', '-d', '--wait', 'postgres');
    compose('run', '--rm', 'flyway', 'migrate');
    return;
  }
  if (!['seed', 'validate'].includes(command ?? '')) {
    throw new Error('Commands: db:up db:down db:migrate db:reset seed validate benchmark:fixture-league-season:before');
  }

  const client = await connect();
  try {
    await client.query('SELECT pg_advisory_lock(20260917)');
    if (command === 'seed') {
      const overrides = Object.fromEntries(
        Object.entries(values).filter(([key]) => key !== 'preset' && key !== 'confirm'),
      ) as Record<string, string>;
      const dataset = config(values.preset ?? 'leagues-100k', overrides);
      compose('run', '--rm', 'flyway', 'validate');
      await load(client, dataset);
    } else {
      const active = await readActiveDataset();
      await validate(client, active.config, active.loaded);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
