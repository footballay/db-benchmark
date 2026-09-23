import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type pg from 'pg';
import { root } from './config.js';
import { saveJson } from './db.js';

const suiteDirectory = resolve(root, 'queries', 'fixture-league-season', 'before');
const resultSuiteDirectory = resolve(root, 'results', 'fixture-league-season', 'before');

interface CapturedParameter { name: string; example: unknown; }
interface ExplainResult { Plan: { 'Actual Rows': number }; 'Execution Time': number; }
interface LeagueMonth { leagueUid: string; leagueId: number; startInclusive: string; endExclusive: string; }
interface BenchmarkCase { name: string; values: unknown[]; parameters: Record<string, unknown>; }

function postgresPlaceholders(sql: string, parameterCount: number) {
  let position = 0;
  const parameterized = sql.replace(/\?/g, () => `$${++position}`);
  if (position !== parameterCount) {
    throw new Error(`Captured SQL has ${position} placeholders, but params.json has ${parameterCount} parameters.`);
  }
  return parameterized;
}

async function selectLeagueMonth(client: pg.Client, apiSportsOnly: boolean): Promise<LeagueMonth> {
  const candidate = await client.query<{
    league_uid: string;
    league_id: string;
    start_inclusive: Date;
    end_exclusive: Date;
    fixture_count: number;
  }>(`
    SELECT
      league.uid AS league_uid,
      league.id AS league_id,
      date_trunc('month', fixture.kickoff) AS start_inclusive,
      date_trunc('month', fixture.kickoff) + INTERVAL '1 month' AS end_exclusive,
      count(*)::int AS fixture_count
    FROM fixture_core fixture
    ${apiSportsOnly ? 'JOIN fixture_api_sports api ON api.fixture_core_id = fixture.id' : ''}
    JOIN league_core league ON league.id = fixture.league_id
    GROUP BY league.uid, league.id, date_trunc('month', fixture.kickoff)
    HAVING count(*) >= 10
    ORDER BY fixture_count DESC, league.uid, start_inclusive
    LIMIT 1
  `);
  const selected = candidate.rows[0];
  if (!selected) {
    throw new Error('No league/month range with at least 10 fixtures exists in the seeded benchmark DB.');
  }
  return {
    leagueUid: selected.league_uid,
    leagueId: Number(selected.league_id),
    startInclusive: selected.start_inclusive.toISOString(),
    endExclusive: selected.end_exclusive.toISOString(),
  };
}

async function selectFinishedCollectCandidates(client: pg.Client): Promise<Pick<LeagueMonth, 'startInclusive' | 'endExclusive'>> {
  const candidate = await client.query<{ start_inclusive: Date; end_exclusive: Date }>(`
    SELECT date_trunc('month', fixture.kickoff) AS start_inclusive,
           date_trunc('month', fixture.kickoff) + INTERVAL '1 month' AS end_exclusive
    FROM fixture_core fixture
    JOIN league_core league ON league.id = fixture.league_id
    JOIN league_season_core season ON season.id = fixture.league_season_id
    JOIN fixture_match_collect_state state ON state.fixture_core_id = fixture.id
    WHERE league.available = true AND league.match_collect = 'FINISHED'
      AND season.current = true AND fixture.available = false AND fixture.kickoff IS NOT NULL
      AND state.match_collect_status NOT IN ('SUCCESS', 'NOT_PLAYED', 'DATA_INCOMPLETE_NEEDS_ADMIN', 'FAIL_END')
    GROUP BY date_trunc('month', fixture.kickoff)
    ORDER BY count(*) DESC, start_inclusive
    LIMIT 1
  `);
  const selected = candidate.rows[0];
  if (!selected) throw new Error('No finished match-collection candidates exist in the seeded benchmark DB.');
  return { startInclusive: selected.start_inclusive.toISOString(), endExclusive: selected.end_exclusive.toISOString() };
}

async function runCase(client: pg.Client, benchmark: BenchmarkCase) {
  const captureDirectory = resolve(suiteDirectory, benchmark.name);
  const resultDirectory = resolve(resultSuiteDirectory, benchmark.name);
  const [capturedSql, parametersJson] = await Promise.all([
    readFile(resolve(captureDirectory, 'query.sql'), 'utf8'),
    readFile(resolve(captureDirectory, 'params.json'), 'utf8'),
  ]);
  const declaredParameters = JSON.parse(parametersJson) as CapturedParameter[];
  const sql = postgresPlaceholders(capturedSql, declaredParameters.length);
  const explain = await client.query<{ 'QUERY PLAN': ExplainResult[] }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)\n${sql}`,
    benchmark.values,
  );
  const explainJson = explain.rows[0]?.['QUERY PLAN'];
  if (!explainJson) throw new Error('PostgreSQL returned no EXPLAIN JSON.');

  await saveJson(resolve(resultDirectory, 'params.json'), benchmark.parameters);
  await saveJson(resolve(resultDirectory, 'explain.json'), explainJson);

  console.log(`${benchmark.name}: ${JSON.stringify(benchmark.parameters)}`);
  console.log(`Result rows: ${explainJson[0].Plan['Actual Rows']}`);
  console.log(`Execution time: ${explainJson[0]['Execution Time']} ms`);
}

export async function benchmarkFixtureLeagueSeasonBefore(client: pg.Client) {
  const [apiSportsLeagueMonth, fixtureLeagueMonth, finishedCollectMonth] = await Promise.all([
    selectLeagueMonth(client, true),
    selectLeagueMonth(client, false),
    selectFinishedCollectCandidates(client),
  ]);
  await runCase(client, {
    name: 'findApiSportsBackedFixturesByLeagueUidInKickoffRange',
    values: [apiSportsLeagueMonth.leagueUid, apiSportsLeagueMonth.startInclusive, apiSportsLeagueMonth.endExclusive],
    parameters: { leagueUid: apiSportsLeagueMonth.leagueUid, startInclusive: apiSportsLeagueMonth.startInclusive, endExclusive: apiSportsLeagueMonth.endExclusive },
  });
  await runCase(client, {
    name: 'findFixturesByLeagueUidInKickoffRange',
    values: [fixtureLeagueMonth.leagueUid, fixtureLeagueMonth.startInclusive, fixtureLeagueMonth.endExclusive],
    parameters: { leagueUid: fixtureLeagueMonth.leagueUid, startInclusive: fixtureLeagueMonth.startInclusive, endExclusive: fixtureLeagueMonth.endExclusive },
  });
  await runCase(client, {
    name: 'findFixturesInKickoffRange',
    values: [fixtureLeagueMonth.leagueId, fixtureLeagueMonth.startInclusive, fixtureLeagueMonth.endExclusive],
    parameters: { leagueId: fixtureLeagueMonth.leagueId, startInclusive: fixtureLeagueMonth.startInclusive, endExclusive: fixtureLeagueMonth.endExclusive },
  });
  await runCase(client, {
    name: 'findFinishedCollectCandidateFixtures',
    values: ['FINISHED', finishedCollectMonth.startInclusive, finishedCollectMonth.endExclusive, 'SUCCESS', 'NOT_PLAYED', 'DATA_INCOMPLETE_NEEDS_ADMIN', 'FAIL_END', 100],
    parameters: { matchCollect: 'FINISHED', kickoffFromInclusive: finishedCollectMonth.startInclusive, kickoffToExclusive: finishedCollectMonth.endExclusive, excludedStatuses: ['SUCCESS', 'NOT_PLAYED', 'DATA_INCOMPLETE_NEEDS_ADMIN', 'FAIL_END'], pageSize: 100 },
  });
}
