import { type Config } from '../config.js';
import { fixtures, uid, matchTeamId, matchPlayerId, playerId, slotPositions, rosterPosition } from './schedule.js';
import { matches } from '../presets/matches.js';

export type Value = string | number | boolean | null;
export type Row = Record<string, Value>;
/** FK가 참조하는 부모부터 COPY하도록 테이블 순서를 고정한다. */
export const tables = [
  'league_core', 'team_core', 'player_core', 'venue_apisports',
  'league_apisports', 'team_apisports', 'player_apisports', 'league_team_core', 'team_player_core',
  'league_season_core', 'league_apisports_season', 'fixture_core',
  'apisports_match_team_stat', 'apisports_match_team', 'fixture_api_sports',
  'apisports_match_player', 'apisports_match_player_stat', 'apisports_match_team_xg',
  'apisports_match_event', 'fixture_match_collect_state',
] as const;
export type Table = typeof tables[number];
const position = (slot: number) => slotPositions[slot];
export function* rows(table: Table, c: Config): Generator<Row> {
  const teamCount = c.leagueCount * c.teamsPerLeague;
  if (['league_core', 'league_apisports'].includes(table)) {
    for (let id = 1; id <= c.leagueCount; id++) yield table === 'league_core'
      ? { id, uid: uid('league', id), name: `League ${id}`, available: true, auto_generated: false, match_collect: id % 5 === 0 ? 'LIVE' : 'FINISHED' }
      : { id, league_core_id: id, api_id: 100000 + id, name: `League ${id}`, type: 'League', available: true, current_season: c.latestSeasonYear };
    return;
  }
  if (['team_core', 'team_apisports', 'venue_apisports', 'league_team_core'].includes(table)) {
    for (let id = 1; id <= teamCount; id++) {
      if (table === 'team_core') yield { id, uid: uid('team', id), name: `Team ${id}`, code: `T${id}`, country: 'Synthetic', founded: 1900 + id % 100, national: false, auto_generated: false };
      if (table === 'team_apisports') yield { id, team_core_id: id, venue_id: id, api_id: 200000 + id, name: `Team ${id}`, code: `T${id}`, prevent_update: false };
      if (table === 'venue_apisports') yield { id, api_id: 300000 + id, name: `Stadium ${id}`, city: `City ${id}`, capacity: 25000 + id % 30 * 1000, surface: 'grass', prevent_update: false };
      if (table === 'league_team_core') yield { id, league_core_id: Math.floor((id - 1) / c.teamsPerLeague) + 1, team_core_id: id };
    }
    return;
  }
  if (['player_core', 'player_apisports', 'team_player_core'].includes(table)) {
    for (let id = 1; id <= teamCount * c.playersPerTeam; id++) {
      const slot = (id - 1) % c.playersPerTeam;
      if (table === 'player_core') yield { id, uid: uid('player', id), name: `Player ${id}`, nationality: 'Synthetic', position: rosterPosition(c, slot), auto_generated: false };
      if (table === 'player_apisports') yield { id, player_core_id: id, api_id: 400000 + id, name: `Player ${id}`, number: slot + 1, position: rosterPosition(c, slot), prevent_update: false };
      if (table === 'team_player_core') yield { id, team_core_id: Math.floor((id - 1) / c.playersPerTeam) + 1, player_core_id: id };
    }
    return;
  }
  if (['league_season_core', 'league_apisports_season'].includes(table)) {
    for (let l = 1; l <= c.leagueCount; l++) for (let s = 0; s < c.seasonsPerLeague; s++) {
      const id = (l - 1) * c.seasonsPerLeague + s + 1, year = c.latestSeasonYear - c.seasonsPerLeague + 1 + s;
      const common = { id, season_year: year, season_start: `${year}-08-01`, season_end: `${year + 1}-06-30` };
      yield table === 'league_season_core'
        ? { ...common, league_core_id: l, current: s === c.seasonsPerLeague - 1, auto_generated: false }
        : { ...common, league_apisports_id: l, league_season_core_id: id, fixtures_events: true, fixtures_lineups: true, fixtures_statistics: true, fixtures_players: true };
    }
    return;
  }
  for (const f of fixtures(c)) {
    const preset = matches[f.preset], score = preset.score;
    if (table === 'fixture_core') yield { id: f.id, uid: uid('fixture', f.id), kickoff: f.kickoff, status_text: 'Full Time', status_code: 'FT', elapsed_min: 90, league_id: f.league, league_season_id: f.season, home_team_id: f.home, away_team_id: f.away, goals_home: score[0], goals_away: score[1], finished: true, available: f.available, auto_generated: false };
    if (table === 'fixture_api_sports') yield { id: f.id, fixture_core_id: f.id, api_id: 10000000 + f.id, referee: 'Synthetic Referee', date: f.kickoff, round: `Regular Season - ${f.round}`, prevent_update: false, available: f.available, venue_id: f.home, season_id: f.season, home_team_id: matchTeamId(f.id, 0), away_team_id: matchTeamId(f.id, 1), long_status: 'Match Finished', short_status: 'FT', elapsed: 90, total_home: score[0], total_away: score[1], halftime_home: score[0], halftime_away: score[1], fulltime_home: score[0], fulltime_away: score[1] };
    if (table === 'fixture_match_collect_state') yield { id: f.id, fixture_core_id: f.id, match_collect_status: f.id % 10 < 8 ? 'SUCCESS' : f.id % 10 === 8 ? 'PENDING' : 'FAIL_END', last_collected_at: f.id % 10 === 8 ? null : new Date(Date.parse(f.kickoff) + 7200000).toISOString() };
    for (let side = 0; side < 2; side++) {
      const mt = matchTeamId(f.id, side), team = side === 0 ? f.home : f.away;
      const events = preset.events.filter(e => e.side === side);
      const yellows = events.filter(e => e.detail === 'Yellow Card').length;
      const reds = events.filter(e => e.detail === 'Red Card').length;
      if (table === 'apisports_match_team') yield { id: mt, team_apisports_id: team, formation: f.detail ? '4-3-3' : null, winner: score[0] === score[1] ? null : score[side] > score[1 - side], team_statistics_id: f.detail ? mt : null, player_color_primary: side === 0 ? 'FF0000' : '0000FF', player_color_number: 'FFFFFF' };
      if (!f.detail) continue;
      if (table === 'apisports_match_team_stat') yield { id: mt, shots_on_goal: score[side] + 3, shots_off_goal: 4, total_shots: score[side] + 9, blocked_shots: 2, shots_inside_box: score[side] + 6, shots_outside_box: 3, fouls: 10 + yellows, corner_kicks: 4, offsides: 1, ball_possession: side === 0 ? '52%' : '48%', yellow_cards: yellows, red_cards: reds, goalkeeper_saves: 3, total_passes: 420, passes_accurate: 350, passes_percentage: '83%', goals_prevented: 0 };
      if (table === 'apisports_match_team_xg') for (let sample = 1; sample <= 3; sample++) yield { id: (mt - 1) * 3 + sample, match_team_statistics_id: mt, elapsed_time: sample * 30, expected_goals: Number(((score[side] + 0.7) * sample / 3).toFixed(2)) };
      if (table === 'apisports_match_player' || table === 'apisports_match_player_stat') for (let slot = 0; slot < 18; slot++) {
        const mp = matchPlayerId(f.id, side, slot), player = playerId(c, team, f.id, slot);
        const number = (player - 1) % c.playersPerTeam + 1;
        if (table === 'apisports_match_player') yield { id: mp, match_player_uid: uid('mp', mp), player_apisports_id: player, name: `Player ${player}`, number, position: position(slot), grid: slot === 0 ? '1:1' : slot < 5 ? `2:${slot}` : slot < 8 ? `3:${slot - 4}` : slot < 11 ? `4:${slot - 7}` : null, substitute: slot >= 11, match_team_id: mt };
        if (table === 'apisports_match_player_stat' && slot < 14) {
          const mine = events.filter(e => e.player === slot);
          const goals = mine.filter(e => e.type === 'Goal').length;
          let minutes = slot < 8 ? 90 : slot < 11 ? 60 + (slot - 8) * 10 : 30 - (slot - 11) * 10;
          if (mine.some(e => e.detail === 'Red Card')) minutes = 85;
          yield { id: mp, match_player_id: mp, minutes_played: minutes, shirt_number: number, position: position(slot), rating: 6.5 + goals * 0.5, is_captain: slot === 1, is_substitute: slot >= 11, goals_total: goals, goals_conceded: slot === 0 ? score[1 - side] : 0, assists: events.filter(e => e.type === 'Goal' && e.assist === slot).length, saves: slot === 0 ? 3 : 0, yellow_cards: mine.filter(e => e.detail === 'Yellow Card').length, red_cards: mine.filter(e => e.detail === 'Red Card').length };
        }
      }
    }
    if (table === 'apisports_match_event' && f.detail) for (let sequence = 0; sequence < preset.events.length; sequence++) {
      const e = preset.events[sequence];
      yield { id: (f.id - 1) * 100 + sequence + 1, fixture_api_id: f.id, match_team_id: matchTeamId(f.id, e.side), player_id: matchPlayerId(f.id, e.side, e.player), assist_id: e.assist === null ? null : matchPlayerId(f.id, e.side, e.assist), sequence, elapsed_time: e.minute, extra_time: null, event_type: e.type, detail: e.detail, comments: null };
    }
  }
}
