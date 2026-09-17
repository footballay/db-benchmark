import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { connect, schema } from '../../src/db.js';
import { active } from '../../src/benchmark/run.js';
import { queryCases, verifyEquivalent } from '../../src/benchmark/queries.js';
import { csv } from '../../src/loader.js';

test('real schema supports explicit IDs, COPY escaping, boundaries, nullable joins and index rollback', async () => {
  const db = await connect();
  try {
    await db.query('SELECT pg_advisory_lock(20260917)');
    const m = await active(db), before = await schema(db);
    await verifyEquivalent(db, await queryCases(db, m.config));
    await db.query('BEGIN');
    try {
      // 임시 테이블은 CSV codec 테스트에만 쓰이며 benchmark SQL에는 사용하지 않는다.
      await db.query('CREATE TEMP TABLE copy_codec_test(value text) ON COMMIT DROP');
      const values = [null, '', '서울,"FC"\nline', '\\N'];
      await pipeline(Readable.from([values.map(csv).join('\n') + '\n']), db.query(copyFrom('COPY copy_codec_test FROM STDIN WITH(FORMAT csv)')));
      assert.deepEqual((await db.query('SELECT value FROM copy_codec_test')).rows.map(r => r.value), values);
      const f = (await db.query('SELECT * FROM fixture_core ORDER BY id LIMIT 1')).rows[0];
      assert.equal(Number((await db.query('SELECT count(*) n FROM fixture_core WHERE id=$1 AND kickoff >= $2 AND kickoff < $2', [f.id, f.kickoff])).rows[0].n), 0);
      assert.equal(Number((await db.query("SELECT count(*) n FROM fixture_core WHERE id=$1 AND kickoff >= $2 AND kickoff < $2::timestamptz + interval '1 second'", [f.id, f.kickoff])).rows[0].n), 1);
      const id = Number((await db.query('SELECT max(id) n FROM fixture_core')).rows[0].n) + 100;
      await db.query("INSERT INTO fixture_core(id,uid,league_id,kickoff,finished,available,auto_generated) VALUES($1,'integration-null-season',$2,$3,false,false,false)", [id,f.league_id,f.kickoff]);
      assert.equal((await db.query('SELECT id FROM fixture_core WHERE id=$1 AND league_season_id IS NULL AND home_team_id IS NULL', [id])).rowCount, 1);
      assert.equal((await db.query('SELECT f.id FROM fixture_core f JOIN league_season_core s ON s.id=f.league_season_id WHERE f.id=$1', [id])).rowCount, 0);
      await db.query('DROP INDEX idx_fixture_core_league_season_kickoff');
    } finally { await db.query('ROLLBACK'); }
    assert.deepEqual(await schema(db), before);
    await db.query('BEGIN');
    try {
      await assert.rejects(db.query("INSERT INTO fixture_core(id,uid,league_id,finished,available,auto_generated) VALUES(9000000000000,'bad-fk',9000000000000,false,false,false)"), (e: any) => e.code === '23503');
    } finally { await db.query('ROLLBACK'); }
  } finally { await db.end(); }
});
