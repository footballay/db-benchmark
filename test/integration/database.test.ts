import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { assertMigrated, connect } from '../../src/db.js';
import { csv, readActiveDataset } from '../../src/loader.js';

test('COPY inserts an explicit ID into the migrated PostgreSQL schema', async () => {
  const database = await connect();
  try {
    await database.query('SELECT pg_advisory_lock(20260917)');
    await assertMigrated(database);
    const active = await readActiveDataset();
    const fixtureMetadata = active.loaded.find((entry) => entry.table === 'fixture_core');
    assert.ok(fixtureMetadata);
    assert.equal(
      Number((await database.query('SELECT count(*) AS count FROM fixture_core')).rows[0].count),
      fixtureMetadata.count,
    );
    const sequence = (
      await database.query('SELECT last_value FROM fixture_core_id_seq')
    ).rows[0].last_value;
    const maximumId = (
      await database.query('SELECT max(id) AS id FROM fixture_core')
    ).rows[0].id;
    assert.equal(Number(sequence), Number(maximumId), 'loader must advance the identity sequence');

    const source = (
      await database.query(`
        SELECT kickoff, status_text, status_code, elapsed_min, league_id, home_team_id, away_team_id,
          goals_home, goals_away, finished, available, auto_generated, league_season_id
        FROM fixture_core ORDER BY id LIMIT 1`)
    ).rows[0];
    assert.ok(source, 'seeded fixture is required; run seed:realistic or seed:scale first');
    const id = Number(maximumId) + 1_000_000;
    const values = [
      id,
      `integration-copy-${id}`,
      source.kickoff instanceof Date ? source.kickoff.toISOString() : source.kickoff,
      source.status_text,
      source.status_code,
      source.elapsed_min,
      source.league_id,
      source.home_team_id,
      source.away_team_id,
      source.goals_home,
      source.goals_away,
      source.finished,
      source.available,
      source.auto_generated,
      source.league_season_id,
    ];

    await database.query('BEGIN');
    try {
      await pipeline(
        Readable.from([`${values.map(csv).join(',')}\n`]),
        database.query(copyFrom(`
          COPY fixture_core (
            id, uid, kickoff, status_text, status_code, elapsed_min, league_id, home_team_id,
            away_team_id, goals_home, goals_away, finished, available, auto_generated, league_season_id
          ) FROM STDIN WITH (FORMAT csv)`)),
      );
      assert.equal(
        Number((await database.query('SELECT count(*) AS count FROM fixture_core WHERE id = $1', [id])).rows[0].count),
        1,
      );
    } finally {
      await database.query('ROLLBACK');
    }
  } finally {
    await database.end();
  }
});
