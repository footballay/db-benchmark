import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { config, fixtureCount } from '../src/config.js';
import { roundRobin, fixtures, playerId } from '../src/generator/schedule.js';
import { rows, tables } from '../src/generator/tables.js';
import { matches } from '../src/presets/matches.js';
import { expected } from '../src/validation.js';
import { csv } from '../src/loader.js';

test('round robin gives each directed pair exactly once and one match per team per round', () => {
  const schedule = roundRobin(20);
  assert.equal(schedule.length, 380);
  assert.equal(new Set(schedule.map(p => `${p.home}/${p.away}`)).size, 380);
  for (let round = 0; round < 38; round++) {
    const teams = schedule.filter(p => p.round === round).flatMap(p => [p.home, p.away]);
    assert.equal(teams.length, 20); assert.equal(new Set(teams).size, 20);
  }
  for (let team = 0; team < 20; team++) {
    assert.equal(schedule.filter(p => p.home === team).length, 19);
    assert.equal(schedule.filter(p => p.away === team).length, 19);
  }
});
test('realistic has the documented exact cardinalities', () => {
  const counts = expected(config('realistic'));
  assert.equal(counts.fixture_core, 19000);
  assert.equal(counts.apisports_match_player, 684000);
  assert.equal(counts.apisports_match_player_stat, 532000);
  assert.equal(counts.apisports_match_event, 212800);
  assert.equal(counts.apisports_match_team_xg, 114000);
});
test('scale parameters preserve complete cycles and deterministic bounded dates', () => {
  const c = config('smoke', { leagueCount: '1', seasonsPerLeague: '1', scheduleCycleFactor: '3' });
  const fs = [...fixtures(c)];
  assert.equal(fs.length, 1140);
  const pairs = new Map<string, number>();
  for (const f of fs) {
    const pair = `${f.home}/${f.away}`; pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
    assert.ok(f.kickoff >= '2026-08-01' && f.kickoff < '2027-07-01');
    assert.notEqual(f.home, f.away);
  }
  assert.ok([...pairs.values()].every(n => n === 3));
  assert.equal(fixtureCount(config('leagues-1m')), 1003200);
  assert.equal(fixtureCount(config('seasons-1m')), 1001300);
  assert.throws(() => config('realistic', { scheduleCycleFactor: '2' }));
  assert.throws(() => config('smoke', { teamsPerLeague: '3' }));
});
test('all table streams repeat byte for byte and player mappings stay in the squad', () => {
  const c = config('smoke', { leagueCount: '1', seasonsPerLeague: '1', teamsPerLeague: '4', matchDetailEvery: '1' });
  const digest = () => {
    const h = createHash('sha256');
    for (const table of tables) for (const row of rows(table, c)) h.update(JSON.stringify(row));
    return h.digest('hex');
  };
  assert.equal(digest(), digest());
  for (const f of fixtures(c)) for (const team of [f.home, f.away]) {
    const ids = Array.from({ length: 18 }, (_, slot) => playerId(c, team, f.id, slot));
    assert.equal(new Set(ids).size, 18);
    assert.ok(ids.every(id => Math.floor((id - 1) / c.playersPerTeam) + 1 === team));
  }
});
test('presets reconcile goals, substitutions, dismissals and event order', () => {
  assert.deepEqual(matches.map(m => m.events.length), [8,9,11,16,12]);
  for (const m of matches) for (let side = 0; side < 2; side++) {
    assert.equal(m.events.filter(e => e.side === side && e.type === 'Goal').length, m.score[side]);
    assert.equal(m.events.filter(e => e.side === side && e.type === 'Subst').length, 3);
    assert.ok(m.events.every((e, i) => i === 0 || e.minute >= m.events[i - 1].minute));
    for (const red of m.events.filter(e => e.detail === 'Red Card')) assert.ok(!m.events.some(e => e.side === red.side && e.minute > red.minute && (e.player === red.player || e.assist === red.player)));
  }
});
test('CSV keeps NULL distinct from empty strings and quotes arbitrary text', () => {
  assert.equal(csv(null), ''); assert.equal(csv(''), '""');
  assert.equal(csv('서울,"FC"\nline'), '"서울,""FC""\nline"');
  assert.equal(csv(false), 'false');
});
