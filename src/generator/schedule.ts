import { type Config, perSeason, roundCount } from '../config.js';
import { matches } from '../presets/matches.js';

/** 순수 좌표 계산으로 동일 seed와 설정에서 같은 일정과 FK를 생성한다. */
export function hash(n: number, seed: number): number {
  let x = (n ^ seed) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}
export function roundRobin(n: number): { round: number; home: number; away: number }[] {
  const ring = Array.from({ length: n }, (_, i) => i);
  const first = [];
  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < n / 2; i++) {
      const pair = [ring[i], ring[n - 1 - i]];
      first.push({ round: r, home: pair[r % 2], away: pair[1 - r % 2] });
    }
    ring.splice(1, 0, ring.pop()!);
  }
  return [...first, ...first.map(p => ({ round: p.round + n - 1, home: p.away, away: p.home }))];
}
export const uid = (kind: string, id: number) => `bench-${kind}-${id.toString().padStart(12, '0')}`;
export const matchTeamId = (fixture: number, side: number) => (fixture - 1) * 2 + side + 1;
export const matchPlayerId = (fixture: number, side: number, slot: number) => (fixture - 1) * 36 + side * 18 + slot + 1;
export const slotPositions = ['G','D','D','D','D','M','M','M','F','F','F','F','F','F','G','D','M','D'];
export function rosterGroups(c: Config) {
  const extra = c.playersPerTeam - 18;
  return [2, 6 + Math.floor(extra / 2), 4 + Math.ceil(extra / 2), 6];
}
export function rosterPosition(c: Config, localPlayer: number) {
  let offset = 0;
  for (const [i, count] of rosterGroups(c).entries()) {
    if (localPlayer < offset + count) return ['G','D','M','F'][i];
    offset += count;
  }
  throw new Error('Player outside roster');
}
export function playerId(c: Config, team: number, fixture: number, slot: number) {
  const group = ['G','D','M','F'].indexOf(slotPositions[slot]);
  const groups = rosterGroups(c), offset = groups.slice(0, group).reduce((a, b) => a + b, 0);
  const ordinal = slotPositions.slice(0, slot).filter(p => p === slotPositions[slot]).length;
  return (team - 1) * c.playersPerTeam + offset + (ordinal + hash(fixture + group, c.seed) % groups[group]) % groups[group] + 1;
}
export interface Fixture { id: number; league: number; season: number; year: number; home: number; away: number; kickoff: string; round: number; detail: boolean; preset: number; available: boolean }
export function* fixtures(c: Config): Generator<Fixture> {
  const schedule = roundRobin(c.teamsPerLeague);
  const n = perSeason(c);
  for (let l = 0; l < c.leagueCount; l++) for (let s = 0; s < c.seasonsPerLeague; s++) {
    const year = c.latestSeasonYear - c.seasonsPerLeague + 1 + s;
    const august = new Date(Date.UTC(year, 7, 1));
    const firstSaturday = august.getTime() + ((6 - august.getUTCDay() + 7) % 7) * 86400000;
    for (let cycle = 0; cycle < c.scheduleCycleFactor; cycle++) for (let i = 0; i < schedule.length; i++) {
      const p = schedule[i], local = cycle * schedule.length + i;
      const id = (l * c.seasonsPerLeague + s) * n + local + 1;
      const round = cycle * 2 * (c.teamsPerLeague - 1) + p.round;
      const roundDays = c.scheduleCycleFactor === 1 && c.teamsPerLeague === 20 ? round * 7 : round * 280 / roundCount(c);
      const kickoff = new Date(firstSaturday + Math.floor(roundDays * 86400000) + (12 + i % (c.teamsPerLeague / 2) * 0.5) * 3600000).toISOString();
      yield { id, league: l + 1, season: l * c.seasonsPerLeague + s + 1, year,
        home: l * c.teamsPerLeague + p.home + 1, away: l * c.teamsPerLeague + p.away + 1,
        kickoff, round: round + 1, detail: hash(id, c.seed) % c.matchDetailEvery === 0,
        preset: (id - 1 + c.seed % matches.length) % matches.length, available: id % 10 < 8 };
    }
  }
}
