import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/** 실행 위치와 무관하게 benchmark 내부 경로와 재현 가능한 설정을 사용한다. */
export const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
export const migrationDir = resolve(root, '../footballay-core/src/main/resources/db/migration');
export interface Config {
  name: string; seed: number; leagueCount: number; teamsPerLeague: number;
  playersPerTeam: number; seasonsPerLeague: number; latestSeasonYear: number;
  scheduleCycleFactor: number; matchDetailEvery: number;
}
const base: Config = { name: 'realistic', seed: 20260917, leagueCount: 5,
  teamsPerLeague: 20, playersPerTeam: 25, seasonsPerLeague: 10,
  latestSeasonYear: 2026, scheduleCycleFactor: 1, matchDetailEvery: 1 };
export const presets: Record<string, Partial<Config>> = {
  realistic: {}, smoke: { leagueCount: 2, seasonsPerLeague: 2, matchDetailEvery: 20 },
  'leagues-100k': { leagueCount: 27, matchDetailEvery: 100 },
  'leagues-500k': { leagueCount: 132, matchDetailEvery: 100 },
  'leagues-1m': { leagueCount: 264, matchDetailEvery: 100 },
  'seasons-100k': { seasonsPerLeague: 53, matchDetailEvery: 100 },
  'seasons-500k': { seasonsPerLeague: 264, matchDetailEvery: 100 },
  'seasons-1m': { seasonsPerLeague: 527, matchDetailEvery: 100 },
  'cycles-1m': { scheduleCycleFactor: 53, matchDetailEvery: 100 },
};
export function config(name: string, overrides: Record<string, string> = {}): Config {
  if (!(name in presets)) throw new Error(`Unknown preset: ${name}`);
  const c = { ...base, ...presets[name], name };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in c) || key === 'name') throw new Error(`Unknown generator option: ${key}`);
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${key} must be a positive safe integer`);
    (c as unknown as Record<string, unknown>)[key] = n;
  }
  if (c.teamsPerLeague < 2 || c.teamsPerLeague % 2) throw new Error('teamsPerLeague must be even and >= 2');
  if (c.playersPerTeam < 18) throw new Error('playersPerTeam must be >= 18');
  if (c.latestSeasonYear - c.seasonsPerLeague < 99 || c.latestSeasonYear > 9997)
    throw new Error('Season years must fit UTC years 100..9997');
  if (name === 'realistic' && (c.leagueCount !== 5 || c.teamsPerLeague !== 20 || c.playersPerTeam !== 25 || c.seasonsPerLeague !== 10 || c.scheduleCycleFactor !== 1 || c.matchDetailEvery !== 1))
    throw new Error('realistic cardinalities are fixed; use another preset for overrides');
  if (![fixtureCount(c), c.leagueCount * c.teamsPerLeague * c.playersPerTeam].every(n => Number.isSafeInteger(n * 1000)))
    throw new Error('ID range exceeds JavaScript safe integer range');
  if (roundCount(c) > 3000) throw new Error('Too many rounds to schedule within a season (max 3000)');
  return c;
}
export const perSeason = (c: Config) => c.teamsPerLeague * (c.teamsPerLeague - 1) * c.scheduleCycleFactor;
export const fixtureCount = (c: Config) => c.leagueCount * c.seasonsPerLeague * perSeason(c);
export const roundCount = (c: Config) => 2 * (c.teamsPerLeague - 1) * c.scheduleCycleFactor;
