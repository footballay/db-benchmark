import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type pg from 'pg';
import { type Config, root, fixtureCount } from './config.js';
import { fixtures } from './generator/schedule.js';
import { matches } from './presets/matches.js';
import { tables } from './generator/tables.js';
import type { Loaded } from './loader.js';

/** FK만으로 보장되지 않는 도메인 관계와 예상 행 수를 SQL로 검증한다. */
export function expected(c: Config): Record<string, number> {
  let detailed = 0, events = 0;
  for (const f of fixtures(c)) if (f.detail) { detailed++; events += matches[f.preset].events.length; }
  const l = c.leagueCount, t = l * c.teamsPerLeague, p = t * c.playersPerTeam, s = l * c.seasonsPerLeague, f = fixtureCount(c);
  return { league_core: l, league_apisports: l, team_core: t, team_apisports: t, venue_apisports: t, league_team_core: t,
    player_core: p, player_apisports: p, team_player_core: p, league_season_core: s, league_apisports_season: s,
    fixture_core: f, fixture_api_sports: f, fixture_match_collect_state: f, apisports_match_team: f * 2,
    apisports_match_team_stat: detailed * 2, apisports_match_player: detailed * 36, apisports_match_player_stat: detailed * 28,
    apisports_match_team_xg: detailed * 6, apisports_match_event: events };
}
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
export async function validate(client: pg.Client, c: Config, loaded?: Loaded[]) {
  const counts = expected(c), checks: Record<string, number> = {};
  const check = async (name: string, sql: string) => {
    const n = Number((await client.query(sql)).rows[0].violations);
    checks[name] = n;
    if (n !== 0) throw new Error(`Validation ${name}: ${n} violations`);
  };
  for (const table of tables) {
    const actual = Number((await client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
    if (actual !== counts[table] || (loaded && loaded.find(r => r.table === table)?.count !== actual))
      throw new Error(`${table}: expected ${counts[table]}, actual ${actual}`);
  }
  const sql = await readFile(resolve(root, 'sql/validate.sql'), 'utf8');
  for (const part of sql.split('-- CHECK ').slice(1)) {
    const line = part.indexOf('\n');
    await check(part.slice(0, line).trim(), part.slice(line + 1));
  }
  for (const [name, sql] of Object.entries({
    teams_per_league: `SELECT count(*) violations FROM (SELECT l.id FROM league_core l LEFT JOIN league_team_core t ON t.league_core_id=l.id GROUP BY l.id HAVING count(t.id)<>${c.teamsPerLeague}) x`,
    players_per_team: `SELECT count(*) violations FROM (SELECT t.id FROM team_core t LEFT JOIN team_player_core p ON p.team_core_id=t.id GROUP BY t.id HAVING count(p.id)<>${c.playersPerTeam}) x`,
    seasons_per_league: `SELECT count(*) violations FROM (SELECT l.id FROM league_core l LEFT JOIN league_season_core s ON s.league_core_id=l.id GROUP BY l.id HAVING count(s.id)<>${c.seasonsPerLeague}) x`,
    round_robin: `SELECT count(*) violations FROM (SELECT league_season_id,home_team_id,away_team_id FROM fixture_core GROUP BY 1,2,3 HAVING count(*)<>${c.scheduleCycleFactor}) x`,
    fixtures_per_season: `SELECT count(*) violations FROM (SELECT s.id FROM league_season_core s LEFT JOIN fixture_core f ON f.league_season_id=s.id GROUP BY s.id HAVING count(f.id)<>${c.teamsPerLeague * (c.teamsPerLeague - 1) * c.scheduleCycleFactor}) x`,
  })) await check(name, sql);
  const fks = (await client.query(`SELECT c.conname,c.conrelid::regclass::text AS child,c.confrelid::regclass::text AS parent,c.convalidated,
    array_agg(a.attname::text ORDER BY k.ord) AS child_cols,array_agg(b.attname::text ORDER BY k.ord) AS parent_cols
    FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY k(ca,pa,ord)
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.ca
    JOIN pg_attribute b ON b.attrelid=c.confrelid AND b.attnum=k.pa
    WHERE c.contype='f' AND c.connamespace='public'::regnamespace GROUP BY c.oid`)).rows;
  for (const fk of fks) {
    if (!fk.convalidated) throw new Error(`Unvalidated FK: ${fk.conname}`);
    const child = fk.child_cols as string[], parent = fk.parent_cols as string[];
    await check(`fk:${fk.conname}`, `SELECT count(*) violations FROM ${quote(fk.child)} c WHERE ${child.map(x => `c.${quote(x)} IS NOT NULL`).join(' AND ')} AND NOT EXISTS(SELECT 1 FROM ${quote(fk.parent)} p WHERE ${child.map((x, i) => `c.${quote(x)}=p.${quote(parent[i])}`).join(' AND ')})`);
  }
  console.log(`Validation passed: ${tables.length} row counts, ${Object.keys(checks).length} relationship checks`);
  return { counts, checks };
}
