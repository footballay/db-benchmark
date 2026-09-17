import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type pg from 'pg';
import { root, type Config } from '../config.js';
import { environment, saveJson, schema, assertMigrated, implementationManifest } from '../db.js';
import { queryCases, verifyEquivalent, type QueryCase } from './queries.js';
import { validate } from '../validation.js';

export interface PlanNode { [key: string]: any; Plans?: PlanNode[] }
/** EXPLAIN 노드 값을 보존하고 부모와 자식의 buffer를 이중 합산하지 않는다. */
export function flatten(node: PlanNode, path = '0'): Record<string, unknown>[] {
  const keys = ['Node Type','Join Type','Relation Name','Alias','Index Name','Index Cond','Filter','Actual Rows','Actual Loops','Rows Removed by Filter','Rows Removed by Join Filter','Shared Hit Blocks','Shared Read Blocks','Temp Read Blocks','Temp Written Blocks','Heap Fetches','Workers Planned','Workers Launched','Workers'];
  return [{ path, ...Object.fromEntries(keys.filter(k => k in node).map(k => [k, node[k]])) }, ...(node.Plans ?? []).flatMap((p, i) => flatten(p, `${path}.${i}`))];
}
export async function active(client: pg.Client) {
  const manifest = JSON.parse(await readFile(resolve(root, 'results/active.json'), 'utf8'));
  if (!manifest) throw new Error('No active dataset. Run seed first.');
  const source = await assertMigrated(client);
  if (JSON.stringify(source) !== JSON.stringify(manifest.source)) throw new Error('Source changed since seed; reset/migrate/seed before benchmarking.');
  const current = await schema(client);
  if (JSON.stringify(current) !== JSON.stringify(manifest.schema)) throw new Error('Schema changed since seed; restore baseline before benchmarking.');
  return manifest as { config: Config; loaded: any[]; source: unknown; schema: unknown; runDir: string };
}
export async function benchmark(client: pg.Client, options: { suite: string; repeats: number; ranges?: string[]; families?: string[] }) {
  const manifest = await active(client), c = manifest.config;
  await validate(client, c, manifest.loaded);
  const cases = await queryCases(client, c, options.ranges, options.families);
  await verifyEquivalent(client, cases);
  const dir = resolve(root, 'results', c.name, `run-${new Date().toISOString().replaceAll(':', '-')}`);
  await mkdir(dir, { recursive: true });
  const originalSchema = await schema(client);
  await saveJson(resolve(dir, 'manifest.json'), { dataset: manifest, implementation: await implementationManifest(), options, environment: await environment(client), cases });
  const variants = [{ name: 'baseline', drop: [] as string[], globalOnly: false }];
  if (options.suite === 'indexes') variants.push(
    { name: 'without-season-kickoff', drop: ['idx_fixture_core_league_season_kickoff'], globalOnly: false },
    { name: 'without-both-season-indexes', drop: ['idx_fixture_core_league_season_kickoff','idx_fixture_core_league_season_available_kickoff'], globalOnly: false },
    { name: 'without-global-scan-index', drop: ['idx_fixture_core_match_collect_scan'], globalOnly: true },
  );
  const records: any[] = [];
  for (const variant of variants) {
    await client.query('BEGIN');
    try {
      for (const index of variant.drop) await client.query(`DROP INDEX ${index}`);
      const selected = cases.filter(q => variant.globalOnly ? q.family === 'collect' : variant.name === 'baseline' || q.family !== 'collect');
      for (let repeat = 0; repeat <= options.repeats; repeat++) {
        const order = repeat % 2 ? [...selected].reverse() : selected;
        for (const q of order) {
          const plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.sql}`, q.params)).rows[0]['QUERY PLAN'][0];
          const nodes = flatten(plan.Plan);
          const name = `${variant.name}-${q.name}-${repeat === 0 ? 'first' : `warm-${repeat}`}`;
          await saveJson(resolve(dir, `${name}.json`), { query: q, variant, repeat, plan, nodes });
          await writeFile(resolve(dir, `${name}.txt`), `${q.sql}\nParameters: ${JSON.stringify(q.params)}\n${nodes.map(n => JSON.stringify(n)).join('\n')}\nPlanning Time: ${plan['Planning Time']} ms\nExecution Time: ${plan['Execution Time']} ms\n`);
          records.push({ variant: variant.name, query: q.name, family: q.family, range: q.range, repeat,
            executionMs: plan['Execution Time'], planningMs: plan['Planning Time'], rows: plan.Plan['Actual Rows'],
            sharedHit: plan.Plan['Shared Hit Blocks'] ?? 0, sharedRead: plan.Plan['Shared Read Blocks'] ?? 0,
            scanTypes: [...new Set(nodes.map(n => n['Node Type']))],
            indexes: [...new Set(nodes.map(n => n['Index Name']).filter(Boolean))],
            fixtureNodes: nodes.filter(n => n['Relation Name'] === 'fixture_core' || String(n['Index Name'] ?? '').includes('fixture_core')),
          });
          console.log(`${name}: ${plan['Execution Time']} ms`);
        }
      }
    } finally { await client.query('ROLLBACK'); }
  }
  if (JSON.stringify(await schema(client)) !== JSON.stringify(originalSchema)) throw new Error('Index rollback verification failed');
  await saveJson(resolve(dir, 'metrics.json'), records);
  await writeFile(resolve(dir, 'summary.md'), summarize(records));
  console.log(`Results: ${dir}`);
  return dir;
}
function summarize(records: any[]) {
  const lines = ['# Fixture benchmark', '',
    '첫 실행은 검증/ANALYZE/앞선 쿼리의 영향을 받습니다. cold cache 측정이 아닙니다. Warm은 5회가 기본이며 아래 중앙값을 표시합니다.',
    '각 EXPLAIN JSON의 Index Cond, Actual Rows × Actual Loops, Filter 제거 행을 함께 확인하십시오. 상위/하위 buffer는 합산하지 않습니다.', '',
    '| Variant | Query | First ms | Warm median ms | Root hit/read (median run) | Rows | Indexes (all runs) |',
    '|---|---|---:|---:|---|---:|---|'];
  for (const key of new Set(records.map(r => `${r.variant}/${r.query}`))) {
    const group = records.filter(r => `${r.variant}/${r.query}` === key), first = group.find(r => r.repeat === 0);
    const warm = group.filter(r => r.repeat > 0).sort((a, b) => a.executionMs - b.executionMs);
    const mid = warm[Math.floor(warm.length / 2)] ?? first;
    lines.push(`| ${first.variant} | ${first.query} | ${first.executionMs.toFixed(3)} | ${mid.executionMs.toFixed(3)} | ${mid.sharedHit}/${mid.sharedRead} | ${mid.rows} | ${[...new Set(group.flatMap(r => r.indexes))].join(', ')} |`);
  }
  lines.push('', '## Fixture access evidence', '', '| Variant / Query | Fixture node | Index condition | Rows / loops | Removed by filter |', '|---|---|---|---|---|');
  for (const r of records.filter(r => r.repeat === 1)) for (const n of r.fixtureNodes)
    lines.push(`| ${r.variant} / ${r.query} | ${n['Node Type']} ${n['Index Name'] ?? ''} | ${String(n['Index Cond'] ?? '').replaceAll('|', '\\|')} | ${n['Actual Rows'] ?? ''} / ${n['Actual Loops'] ?? ''} | ${n['Rows Removed by Filter'] ?? 0} |`);
  lines.push('', 'Seq Scan/Hash Join을 실패로 판정하지 않습니다. 넓은 범위는 전체 스캔이 합리적일 수 있습니다. index 제거 실험은 transaction rollback으로 원복했습니다.', '');
  return lines.join('\n');
}
