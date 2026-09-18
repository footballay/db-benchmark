import type pg from 'pg';
import { type Config, fixtureCount } from './config.js';
import { fixtures } from './generator/schedule.js';
import { tables } from './generator/tables.js';
import type { Loaded } from './loader.js';
import { matches } from './presets/matches.js';

export function expected(config: Config): Record<string, number> {
  let detailed = 0;
  let events = 0;
  for (const fixture of fixtures(config)) {
    if (fixture.detail) {
      detailed++;
      events += matches[fixture.preset].events.length;
    }
  }
  const leagues = config.leagueCount;
  const teams = leagues * config.teamsPerLeague;
  const players = teams * config.playersPerTeam;
  const seasons = leagues * config.seasonsPerLeague;
  const fixtureTotal = fixtureCount(config);
  return {
    league_core: leagues,
    league_apisports: leagues,
    team_core: teams,
    team_apisports: teams,
    venue_apisports: teams,
    league_team_core: teams,
    player_core: players,
    player_apisports: players,
    team_player_core: players,
    league_season_core: seasons,
    league_apisports_season: seasons,
    fixture_core: fixtureTotal,
    fixture_api_sports: fixtureTotal,
    fixture_match_collect_state: fixtureTotal,
    apisports_match_team: fixtureTotal * 2,
    apisports_match_team_stat: detailed * 2,
    apisports_match_player: detailed * 36,
    apisports_match_player_stat: detailed * 28,
    apisports_match_team_xg: detailed * 6,
    apisports_match_event: events,
  };
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

export async function validate(client: pg.Client, config: Config, loaded?: Loaded[]) {
  const counts = expected(config);
  for (const table of tables) {
    const actual = Number((await client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
    const copied = loaded?.find((entry) => entry.table === table)?.count;
    if (actual !== counts[table] || (copied !== undefined && copied !== actual)) {
      throw new Error(`${table}: expected ${counts[table]}, actual ${actual}`);
    }
  }

  const checks: Record<string, string> = {
    fixture_relationships: `
      SELECT count(*) AS violations
      FROM fixture_core f
      LEFT JOIN league_season_core s ON s.id = f.league_season_id
      LEFT JOIN league_team_core home_team
        ON home_team.league_core_id = f.league_id AND home_team.team_core_id = f.home_team_id
      LEFT JOIN league_team_core away_team
        ON away_team.league_core_id = f.league_id AND away_team.team_core_id = f.away_team_id
      WHERE s.id IS NULL OR s.league_core_id IS DISTINCT FROM f.league_id
        OR home_team.id IS NULL OR away_team.id IS NULL OR f.home_team_id = f.away_team_id
        OR f.kickoff IS NULL OR f.kickoff::date < s.season_start OR f.kickoff::date > s.season_end`,
    backbone_relationships: `
      SELECT count(*) AS violations
      FROM fixture_api_sports api
      LEFT JOIN fixture_core core ON core.id = api.fixture_core_id
      LEFT JOIN league_apisports_season season ON season.id = api.season_id
      LEFT JOIN league_apisports league ON league.id = season.league_apisports_id
      LEFT JOIN apisports_match_team home_match ON home_match.id = api.home_team_id
      LEFT JOIN apisports_match_team away_match ON away_match.id = api.away_team_id
      LEFT JOIN team_apisports home_team ON home_team.id = home_match.team_apisports_id
      LEFT JOIN team_apisports away_team ON away_team.id = away_match.team_apisports_id
      WHERE core.id IS NULL OR season.id IS NULL OR league.id IS NULL
        OR home_match.id IS NULL OR away_match.id IS NULL
        OR home_team.team_core_id IS DISTINCT FROM core.home_team_id
        OR away_team.team_core_id IS DISTINCT FROM core.away_team_id
        OR season.league_season_core_id IS DISTINCT FROM core.league_season_id
        OR league.league_core_id IS DISTINCT FROM core.league_id`,
    teams_per_league: `
      SELECT count(*) AS violations FROM (
        SELECT league.id FROM league_core league
        LEFT JOIN league_team_core team ON team.league_core_id = league.id
        GROUP BY league.id HAVING count(team.id) <> ${config.teamsPerLeague}
      ) invalid`,
    players_per_team: `
      SELECT count(*) AS violations FROM (
        SELECT team.id FROM team_core team
        LEFT JOIN team_player_core player ON player.team_core_id = team.id
        GROUP BY team.id HAVING count(player.id) <> ${config.playersPerTeam}
      ) invalid`,
    fixtures_per_season: `
      SELECT count(*) AS violations FROM (
        SELECT season.id FROM league_season_core season
        LEFT JOIN fixture_core fixture ON fixture.league_season_id = season.id
        GROUP BY season.id
        HAVING count(fixture.id) <> ${config.teamsPerLeague * (config.teamsPerLeague - 1) * config.scheduleCycleFactor}
      ) invalid`,
    round_robin: `
      SELECT count(*) AS violations FROM (
        SELECT league_season_id, home_team_id, away_team_id
        FROM fixture_core GROUP BY 1, 2, 3
        HAVING count(*) <> ${config.scheduleCycleFactor}
      ) invalid`,
  };

  for (const [name, sql] of Object.entries(checks)) {
    const violations = Number((await client.query(sql)).rows[0].violations);
    if (violations !== 0) throw new Error(`Validation ${name}: ${violations} violations`);
  }

  const foreignKeys = (
    await client.query(`
      SELECT constraint_row.conname,
        constraint_row.conrelid::regclass::text AS child,
        constraint_row.confrelid::regclass::text AS parent,
        constraint_row.convalidated,
        array_agg(child_column.attname::text ORDER BY key_column.ordinality) AS child_columns,
        array_agg(parent_column.attname::text ORDER BY key_column.ordinality) AS parent_columns
      FROM pg_constraint constraint_row
      CROSS JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
        WITH ORDINALITY key_column(child_number, parent_number, ordinality)
      JOIN pg_attribute child_column
        ON child_column.attrelid = constraint_row.conrelid AND child_column.attnum = key_column.child_number
      JOIN pg_attribute parent_column
        ON parent_column.attrelid = constraint_row.confrelid AND parent_column.attnum = key_column.parent_number
      WHERE constraint_row.contype = 'f' AND constraint_row.connamespace = 'public'::regnamespace
      GROUP BY constraint_row.oid`)
  ).rows;

  for (const foreignKey of foreignKeys) {
    if (!foreignKey.convalidated) throw new Error(`Unvalidated FK: ${foreignKey.conname}`);
    const childColumns = foreignKey.child_columns as string[];
    const parentColumns = foreignKey.parent_columns as string[];
    const result = await client.query(`
      SELECT count(*) AS violations FROM ${quote(foreignKey.child)} child
      WHERE ${childColumns.map((column) => `child.${quote(column)} IS NOT NULL`).join(' AND ')}
        AND NOT EXISTS (
          SELECT 1 FROM ${quote(foreignKey.parent)} parent
          WHERE ${childColumns.map((column, index) =>
            `child.${quote(column)} = parent.${quote(parentColumns[index])}`).join(' AND ')}
        )`);
    const violations = Number(result.rows[0].violations);
    if (violations !== 0) throw new Error(`Validation fk:${foreignKey.conname}: ${violations} violations`);
  }

  console.log(`Validation passed: ${tables.length} row counts, ${Object.keys(checks).length} generator relationships, ${foreignKeys.length} foreign keys`);
  return { counts };
}
