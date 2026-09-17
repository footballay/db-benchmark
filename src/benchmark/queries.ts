import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type pg from 'pg';
import { root, type Config } from '../config.js';
import { uid } from '../generator/schedule.js';

export interface QueryCase { name: string; family: string; range: string; model: string; sql: string; params: (string | number)[] }
/** JPQL projection과 fetch join을 유지하고 League 연결 경로만 변경한다. */
export async function queryCases(client: pg.Client, c: Config, onlyRanges?: string[], onlyFamilies?: string[]): Promise<QueryCase[]> {
  const template = await readFile(resolve(root, 'sql/benchmark/fixture-range.sql'), 'utf8');
  const global = await readFile(resolve(root, 'sql/benchmark/match-collect.sql'), 'utf8');
  const { first, last, anchor } = (await client.query(`SELECT min(f.kickoff) AS first,max(f.kickoff) AS last,min(f.kickoff) FILTER(WHERE s.current) AS anchor FROM fixture_core f JOIN league_season_core s ON s.id=f.league_season_id WHERE s.league_core_id=1`)).rows[0];
  const plus = (d: Date, days: number) => new Date(d.getTime() + days * 86400000).toISOString();
  const ranges: Record<string, [string, string]> = {
    '1day': [anchor.toISOString(), plus(anchor, 1)], '7day': [anchor.toISOString(), plus(anchor, 7)],
    '30day': [anchor.toISOString(), plus(anchor, 30)],
    'season': [`${c.latestSeasonYear}-08-01T00:00:00Z`, `${c.latestSeasonYear + 1}-07-01T00:00:00Z`],
    'multi-season': [`${Math.max(c.latestSeasonYear - c.seasonsPerLeague + 1, c.latestSeasonYear - 2)}-08-01T00:00:00Z`, `${c.latestSeasonYear + 1}-07-01T00:00:00Z`],
    'all': [first.toISOString(), plus(last, 1)],
    'empty': [plus(last, 10), plus(last, 11)],
  };
  for (const name of onlyRanges ?? []) if (!(name in ranges)) throw new Error(`Unknown range: ${name}`);
  const families = ['core', 'admin', 'public', 'collect'];
  for (const name of onlyFamilies ?? []) if (!families.includes(name)) throw new Error(`Unknown family: ${name}`);
  const cases: QueryCase[] = [];
  for (const [range, [from, to]] of Object.entries(ranges)) {
    if (onlyRanges && !onlyRanges.includes(range)) continue;
    for (const family of families) {
      if (onlyFamilies && !onlyFamilies.includes(family)) continue;
      if (family === 'collect') {
        cases.push({ name: `collect-${range}`, family, range, model: 'repository', sql: global, params: ['FINISHED', from, to, 100] }); continue;
      }
      for (const model of ['legacy', 'season-aware']) {
        const leagueJoin = model === 'legacy' ? 'JOIN league_core l ON l.id=f.league_id' : 'JOIN league_season_core ls ON ls.id=f.league_season_id JOIN league_core l ON l.id=ls.league_core_id';
        const providerJoin = family === 'core' ? '' : `${family === 'public' ? 'JOIN' : 'LEFT JOIN'} fixture_api_sports fas ON fas.fixture_core_id=f.id
LEFT JOIN team_core ht ON ht.id=f.home_team_id LEFT JOIN team_core at ON at.id=f.away_team_id
LEFT JOIN team_apisports hta ON hta.team_core_id=ht.id LEFT JOIN team_apisports ata ON ata.team_core_id=at.id`;
        const sql = template.replace('{{projection}}', family === 'core' ? 'f.*' : 'f.*, fas.*, ht.*, at.*, hta.*, ata.*').replace('{{league_join}}', leagueJoin).replace('{{provider_join}}', providerJoin);
        cases.push({ name: `${family}-${model}-${range}`, family, range, model, sql, params: [uid('league', 1), from, to] });
      }
    }
  }
  return cases;
}
export async function verifyEquivalent(client: pg.Client, cases: QueryCase[]) {
  for (const a of cases.filter(q => q.model === 'legacy')) {
    const b = cases.find(q => q.model === 'season-aware' && q.family === a.family && q.range === a.range)!;
    const ids = (sql: string) => sql.replace(/SELECT [^\n]+\nFROM/, 'SELECT f.id\nFROM').replace(/ORDER BY f.kickoff ASC\s*$/, '');
    const sql = `WITH a AS (${ids(a.sql)}),b AS (${ids(b.sql)}) SELECT count(*) AS n FROM ((SELECT * FROM a EXCEPT ALL SELECT * FROM b) UNION ALL (SELECT * FROM b EXCEPT ALL SELECT * FROM a)) diff`;
    if (Number((await client.query(sql, a.params)).rows[0].n)) throw new Error(`Result mismatch: ${a.name}`);
  }
}
