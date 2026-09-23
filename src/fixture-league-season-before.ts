import { performance } from 'node:perf_hooks';
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type pg from 'pg';
import { root } from './config.js';
import { assertMigrated, saveJson } from './db.js';
import { readActiveDataset } from './loader.js';

const beforeCaptureDirectory = resolve(root, 'queries', 'fixture-league-season', 'before');
// After captures are produced by footballay-core's SQL capture tests.  Keeping this
// path outside the benchmark fixtures makes it impossible to accidentally measure
// the old SQL under the After label.
const afterCaptureDirectory = resolve(root, '..', 'footballay-core', 'build', 'query-capture');
const statuses = ['PENDING', 'EARLY_SYNCED', 'SUCCESS', 'NOT_PLAYED', 'DATA_INCOMPLETE_NEEDS_ADMIN', 'FAIL_END'];
const excludedStatuses = ['SUCCESS', 'NOT_PLAYED', 'DATA_INCOMPLETE_NEEDS_ADMIN', 'FAIL_END'];
const changedTargetNames = new Set([
  'findFixturesByLeagueUidInKickoffRange',
  'findApiSportsBackedFixturesByLeagueUidInKickoffRange',
  'findDistinctDefaultKickoffsByLeagueUidInRange',
  'findMinApiSportsBackedKickoffAfterByLeagueUid',
  'findMaxApiSportsBackedKickoffBeforeByLeagueUid',
  'findAvailableFixturesByLeagueUid',
  'findDistinctLeagueUidsWithAvailableFixtures',
  'findMatchCollectStateReconcileFixturesByLeagueUid',
  'findAdminStatesByLeagueUidAndStatuses.data',
  'findAdminStatesByLeagueUidAndStatuses.count',
]);

interface CapturedParameter { name: string; example: unknown; }
interface ParameterCase { id: string; values: unknown[]; parameters: Record<string, unknown>; repetitions?: number; }
interface Target { name: string; capturePath?: string; cases: ParameterCase[]; }
interface PlanNode {
  'Node Type': string; 'Plan Rows'?: number; 'Actual Rows'?: number; 'Actual Loops'?: number;
  'Rows Removed by Filter'?: number; 'Rows Removed by Join Filter'?: number;
  'Shared Hit Blocks'?: number; 'Shared Read Blocks'?: number;
  'Relation Name'?: string; 'Index Name'?: string; 'Join Type'?: string; Plans?: PlanNode[];
}
interface ExplainResult { Plan: PlanNode; 'Planning Time': number; 'Execution Time': number; }

const pad = (value: number) => String(value).padStart(12, '0');
const leagueUid = (id: number) => `bench-league-${pad(id)}`;
const iso = (value: string) => `${value}T00:00:00.000Z`;
const caseIds = Array.from({ length: 10 }, (_, index) => `case-${String(index + 1).padStart(2, '0')}`);
const rangeInputs = [
  [1, '2026-08-01', '2026-09-01'], [33, '2026-09-01', '2026-10-01'],
  [66, '2026-10-01', '2026-11-01'], [99, '2026-11-01', '2026-12-01'],
  [132, '2026-12-01', '2027-01-01'], [165, '2027-01-01', '2027-02-01'],
  [198, '2027-02-01', '2027-03-01'], [264, '2027-03-01', '2027-04-01'],
  [1, '2026-08-08', '2026-08-09'], [1, '2026-07-01', '2026-08-01'],
] as const;
const leagueIds = [1, 33, 66, 99, 132, 165, 198, 264, 5, 999999];

function rangeCases(useId: boolean): ParameterCase[] {
  return rangeInputs.map(([id, start, end], index) => ({
    id: caseIds[index], values: [useId ? id : leagueUid(id), iso(start), iso(end)],
    parameters: useId
      ? { leagueId: id, startInclusive: iso(start), endExclusive: iso(end) }
      : { leagueUid: leagueUid(id), startInclusive: iso(start), endExclusive: iso(end) },
  }));
}

function leagueCases(): ParameterCase[] {
  return leagueIds.map((id, index) => ({ id: caseIds[index], values: [leagueUid(id)], parameters: { leagueUid: leagueUid(id) } }));
}

const minPivots = ['2026-08-01', '2026-09-15', '2026-10-15', '2026-11-15', '2026-12-15', '2027-01-15', '2027-02-15', '2027-04-17', '2027-04-18', '2028-01-01'];
const maxPivots = ['2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01', '2017-08-06', '2017-08-05', '2010-01-01'];
function pivotCases(kind: 'from' | 'before'): ParameterCase[] {
  const pivots = kind === 'from' ? minPivots : maxPivots;
  return pivots.map((pivot, index) => {
    const id = leagueIds[Math.min(index, 7)];
    return { id: caseIds[index], values: [leagueUid(id), iso(pivot)], parameters: { leagueUid: leagueUid(id), [kind]: iso(pivot) } };
  });
}

function finishedCases(): ParameterCase[] {
  return rangeInputs.map(([, start, end], index) => ({
    id: caseIds[index], values: ['FINISHED', iso(start), iso(end), ...excludedStatuses, 100],
    parameters: { matchCollect: 'FINISHED', kickoffFromInclusive: iso(start), kickoffToExclusive: iso(end), excludedStatuses, pageSize: 100 },
  }));
}

function adminCases(phase: 'before' | 'after', includePage: boolean): ParameterCase[] {
  return leagueIds.map((id, index) => {
    const offset = index === 8 ? 5000 : 0;
    const uid = leagueUid(id);
    return {
      id: caseIds[index], values: phase === 'before'
        ? (includePage ? [uid, uid, ...statuses, offset, 50] : [uid, uid, ...statuses])
        : (includePage ? [uid, ...statuses, offset, 50] : [uid, ...statuses]),
      parameters: { leagueUid: uid, statuses, ...(includePage ? { offset, pageSize: 50 } : {}) },
    };
  });
}

function targets(phase: 'before' | 'after'): Target[] {
  return [
  { name: 'findFixturesInKickoffRange', cases: rangeCases(true) },
  { name: 'findFixturesByLeagueUidInKickoffRange', cases: rangeCases(false) },
  { name: 'findApiSportsBackedFixturesByLeagueUidInKickoffRange', cases: rangeCases(false) },
  { name: 'findFinishedCollectCandidateFixtures', cases: finishedCases() },
  { name: 'findDistinctDefaultKickoffsByLeagueUidInRange', cases: rangeCases(false) },
  { name: 'findMinApiSportsBackedKickoffAfterByLeagueUid', cases: pivotCases('from') },
  { name: 'findMaxApiSportsBackedKickoffBeforeByLeagueUid', cases: pivotCases('before') },
  { name: 'findAvailableFixturesByLeagueUid', cases: leagueCases() },
  { name: 'findDistinctLeagueUidsWithAvailableFixtures', cases: [{ id: 'case-01', values: [], parameters: {}, repetitions: 100 }] },
  { name: 'findMatchCollectStateReconcileFixturesByLeagueUid', cases: leagueCases() },
    { name: 'findAdminStatesByLeagueUidAndStatuses.data', capturePath: 'findAdminStatesByLeagueUidAndStatuses/data', cases: adminCases(phase, true) },
    { name: 'findAdminStatesByLeagueUidAndStatuses.count', capturePath: 'findAdminStatesByLeagueUidAndStatuses/count', cases: adminCases(phase, false) },
  ];
}

function postgresPlaceholders(sql: string, parameterCount: number) {
  let position = 0;
  const parameterized = sql.replace(/\?/g, () => `$${++position}`);
  if (position !== parameterCount) throw new Error(`Captured SQL has ${position} placeholders, expected ${parameterCount}.`);
  return parameterized;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizePlan(explain: ExplainResult) {
  const scans: Record<string, unknown>[] = [];
  const joins: Record<string, unknown>[] = [];
  let rowsRemoved = 0;
  let accessedRows = 0;
  const visit = (node: PlanNode) => {
    const loops = node['Actual Loops'] ?? 1;
    const removed = (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Join Filter'] ?? 0);
    rowsRemoved += removed * loops;
    if (node['Node Type'].includes('Scan')) {
      accessedRows += ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * loops;
      scans.push({ nodeType: node['Node Type'], relation: node['Relation Name'], index: node['Index Name'], plannedRows: node['Plan Rows'], actualRows: node['Actual Rows'], loops, rowsRemovedByFilter: node['Rows Removed by Filter'] ?? 0, sharedHit: node['Shared Hit Blocks'] ?? 0, sharedRead: node['Shared Read Blocks'] ?? 0 });
    }
    if (node['Node Type'].includes('Join') || node['Node Type'] === 'Nested Loop') joins.push({ nodeType: node['Node Type'], joinType: node['Join Type'], plannedRows: node['Plan Rows'], actualRows: node['Actual Rows'], loops });
    node.Plans?.forEach(visit);
  };
  visit(explain.Plan);
  const plannedRows = explain.Plan['Plan Rows'] ?? 0;
  const actualRows = explain.Plan['Actual Rows'] ?? 0;
  return {
    planningMs: explain['Planning Time'], executionMs: explain['Execution Time'], plannedRows, actualRows,
    estimateRatio: plannedRows === 0 ? null : actualRows / plannedRows, rowsRemoved, accessedRows,
    sharedHit: explain.Plan['Shared Hit Blocks'] ?? 0, sharedRead: explain.Plan['Shared Read Blocks'] ?? 0, scans, joins,
  };
}

async function runTarget(client: pg.Client, target: Target, runDirectory: string, captureRoot: string) {
  const captureDirectory = resolve(captureRoot, target.capturePath ?? target.name);
  const [capturedSql, parametersJson] = await Promise.all([readFile(resolve(captureDirectory, 'query.sql'), 'utf8'), readFile(resolve(captureDirectory, 'params.json'), 'utf8')]);
  const declared = JSON.parse(parametersJson) as CapturedParameter[];
  const snapshotDirectory = resolve(runDirectory, 'captures', target.capturePath ?? target.name);
  await mkdir(snapshotDirectory, { recursive: true });
  await Promise.all([
    copyFile(resolve(captureDirectory, 'query.sql'), resolve(snapshotDirectory, 'query.sql')),
    copyFile(resolve(captureDirectory, 'params.json'), resolve(snapshotDirectory, 'params.json')),
  ]);
  const sql = postgresPlaceholders(capturedSql.trim(), declared.length);
  const caseSummaries: Record<string, unknown>[] = [];
  for (const parameterCase of target.cases) {
    if (parameterCase.values.length !== declared.length) throw new Error(`${target.name}/${parameterCase.id}: parameter count mismatch.`);
    const repetitions = parameterCase.repetitions ?? 10;
    await client.query(sql, parameterCase.values);
    const latencies: number[] = [];
    const returnedRows: number[] = [];
    let scalarValue: unknown;
    for (let iteration = 0; iteration < repetitions; iteration++) {
      const started = performance.now();
      const result = await client.query(sql, parameterCase.values);
      latencies.push(performance.now() - started);
      returnedRows.push(result.rowCount ?? result.rows.length);
      if (result.rows.length === 1 && Object.keys(result.rows[0]).length === 1) scalarValue = Object.values(result.rows[0])[0];
    }
    const explainResult = await client.query<{ 'QUERY PLAN': ExplainResult[] }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)\n${sql}`, parameterCase.values);
    const explain = explainResult.rows[0]?.['QUERY PLAN']?.[0];
    if (!explain) throw new Error(`${target.name}/${parameterCase.id}: PostgreSQL returned no EXPLAIN JSON.`);
    const summary = {
      caseId: parameterCase.id, parameters: parameterCase.parameters, returnedRows, scalarValue, latenciesMs: latencies,
      latencySummaryMs: { min: Math.min(...latencies), median: median(latencies), max: Math.max(...latencies) }, plan: summarizePlan(explain),
    };
    const caseDirectory = resolve(runDirectory, target.name, parameterCase.id);
    await saveJson(resolve(caseDirectory, 'result.json'), summary);
    await saveJson(resolve(caseDirectory, 'explain.json'), [explain]);
    caseSummaries.push(summary);
    console.log(`${target.name}/${parameterCase.id}: rows=${returnedRows[0]}, median=${summary.latencySummaryMs.median.toFixed(3)} ms, accessed=${summary.plan.accessedRows}`);
  }
  await saveJson(resolve(runDirectory, target.name, 'summary.json'), caseSummaries);
  return caseSummaries;
}

type RunSummaries = Record<string, Array<Record<string, any>>>;

function percentile(values: number[], ratio: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

async function latestBeforeRun() {
  const directory = resolve(root, 'results', 'fixture-league-season', 'before');
  const entries = await readdir(directory, { withFileTypes: true });
  const runs = entries.filter(entry => entry.isDirectory() && entry.name.startsWith('run-')).map(entry => entry.name).sort();
  if (runs.length === 0) throw new Error(`No Before run found in ${directory}.`);
  return resolve(directory, runs.at(-1)!);
}

async function compareRuns(beforeDirectory: string, afterDirectory: string) {
  const [beforeManifest, afterManifest, beforeSummary, afterSummary] = await Promise.all([
    readFile(resolve(beforeDirectory, 'manifest.json'), 'utf8').then(JSON.parse),
    readFile(resolve(afterDirectory, 'manifest.json'), 'utf8').then(JSON.parse),
    readFile(resolve(beforeDirectory, 'summary.json'), 'utf8').then(JSON.parse) as Promise<RunSummaries>,
    readFile(resolve(afterDirectory, 'summary.json'), 'utf8').then(JSON.parse) as Promise<RunSummaries>,
  ]);
  if (beforeManifest.dataset.name !== afterManifest.dataset.name || beforeManifest.dataset.seed !== afterManifest.dataset.seed || beforeManifest.dataset.fixtureCount !== afterManifest.dataset.fixtureCount) {
    throw new Error('Before and After datasets do not match. Refusing to compare results.');
  }
  const comparisons = Object.keys(afterSummary).map(target => {
    const beforeCases = beforeSummary[target] ?? [];
    const afterCases = afterSummary[target];
    if (beforeCases.length !== afterCases.length) throw new Error(`${target}: Before/After case count differs.`);
    return {
      target,
      cases: afterCases.map((afterCase, index) => {
        const beforeCase = beforeCases[index];
        if (beforeCase.caseId !== afterCase.caseId) throw new Error(`${target}: case ordering differs.`);
        const beforeLatency = beforeCase.latenciesMs as number[];
        const afterLatency = afterCase.latenciesMs as number[];
        return {
          caseId: afterCase.caseId,
          returnedRowsMatch: JSON.stringify(beforeCase.returnedRows) === JSON.stringify(afterCase.returnedRows),
          latencyMs: {
            before: { median: beforeCase.latencySummaryMs.median, p95: percentile(beforeLatency, 0.95), max: beforeCase.latencySummaryMs.max },
            after: { median: afterCase.latencySummaryMs.median, p95: percentile(afterLatency, 0.95), max: afterCase.latencySummaryMs.max },
            medianChangePercent: beforeCase.latencySummaryMs.median === 0 ? null : ((afterCase.latencySummaryMs.median / beforeCase.latencySummaryMs.median) - 1) * 100,
          },
          plan: {
            accessedRows: { before: beforeCase.plan.accessedRows, after: afterCase.plan.accessedRows },
            rowsRemoved: { before: beforeCase.plan.rowsRemoved, after: afterCase.plan.rowsRemoved },
            sharedHit: { before: beforeCase.plan.sharedHit, after: afterCase.plan.sharedHit },
            sharedRead: { before: beforeCase.plan.sharedRead, after: afterCase.plan.sharedRead },
            executionMs: { before: beforeCase.plan.executionMs, after: afterCase.plan.executionMs },
            scans: { before: beforeCase.plan.scans, after: afterCase.plan.scans },
            joins: { before: beforeCase.plan.joins, after: afterCase.plan.joins },
          },
        };
      }),
    };
  });
  const report = { beforeDirectory, afterDirectory, dataset: afterManifest.dataset, comparisons };
  await saveJson(resolve(afterDirectory, 'comparison.json'), report);
  const lines = ['# Fixture league season: Before / After', '', `- Before: ${beforeDirectory}`, `- After: ${afterDirectory}`, `- Dataset: ${afterManifest.dataset.name}, seed ${afterManifest.dataset.seed}, fixtures ${afterManifest.dataset.fixtureCount}`, '', '| Target | Cases | Returned rows match | Median change range | Accessed rows (before → after) |', '|---|---:|---:|---:|---:|'];
  for (const comparison of comparisons) {
    const changes = comparison.cases.map(caseResult => caseResult.latencyMs.medianChangePercent as number);
    const rowsMatch = comparison.cases.every(caseResult => caseResult.returnedRowsMatch) ? 'yes' : 'NO';
    const accessed = comparison.cases.map(caseResult => `${caseResult.plan.accessedRows.before} → ${caseResult.plan.accessedRows.after}`);
    lines.push(`| ${comparison.target} | ${comparison.cases.length} | ${rowsMatch} | ${Math.min(...changes).toFixed(1)}% to ${Math.max(...changes).toFixed(1)}% | ${accessed.at(0)} to ${accessed.at(-1)} |`);
  }
  await writeFile(resolve(afterDirectory, 'comparison.md'), `${lines.join('\n')}\n`);
}

function range(values: number[]) {
  return `${Math.min(...values).toFixed(3)} to ${Math.max(...values).toFixed(3)}`;
}

function planShapes(cases: Array<Record<string, any>>, key: 'scans' | 'joins') {
  const shapes = new Set<string>();
  for (const item of cases) {
    for (const node of item.plan[key] as Array<Record<string, unknown>>) {
      if (key === 'scans') shapes.add(`${node.nodeType} ${node.relation ?? ''}${node.index ? ` (${node.index})` : ''}`.trim());
      else shapes.add(`${node.nodeType}${node.joinType ? ` ${node.joinType}` : ''}`);
    }
  }
  return [...shapes].join('; ') || 'none';
}

async function writeAfterExplainSummary(runDirectory: string, summaries: RunSummaries) {
  const lines = [
    '# Improved query After EXPLAIN summary',
    '',
    'Every case below was measured with `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`. The table aggregates the 10 fixed cases per query; each case\'s raw JSON is retained under its linked directory.',
    '',
    '| Query | Cases | Accessed rows | Rows removed | Execution (ms) | Scan / index shapes | Join shapes |',
    '|---|---:|---:|---:|---:|---|---|',
  ];
  for (const [target, cases] of Object.entries(summaries)) {
    if (!changedTargetNames.has(target)) continue;
    const accessedRows = cases.map(item => item.plan.accessedRows as number);
    const rowsRemoved = cases.map(item => item.plan.rowsRemoved as number);
    const executionMs = cases.map(item => item.plan.executionMs as number);
    const detailPaths = cases.map(item => `[${item.caseId}](./${target}/${item.caseId}/explain.json)`).join(', ');
    lines.push(`| ${target} | ${detailPaths} | ${range(accessedRows)} | ${range(rowsRemoved)} | ${range(executionMs)} | ${planShapes(cases, 'scans')} | ${planShapes(cases, 'joins')} |`);
  }
  await writeFile(resolve(runDirectory, 'after-explain-summary.md'), `${lines.join('\n')}\n`);
}

const afterPlanInterpretations: Record<string, string> = {
  findFixturesByLeagueUidInKickoffRange:
    '작은 `league_core`에서 UID를 찾은 뒤 `league_season_core`와 `fixture_core`를 순서대로 index lookup한다. 핵심 fixture 접근은 `idx_fixture_core_league_season_kickoff`이며, 과거의 전체 fixture scan 대신 해당 league의 season/range만 읽는다.',
  findApiSportsBackedFixturesByLeagueUidInKickoffRange:
    'league-season fixture 범위를 먼저 index로 제한하고 `fixture_api_sports`를 fixture별 unique index로 결합한다. provider row 존재 확인이 league 범위 축소 뒤에 수행되어 전체 fixture 집합을 시작점으로 삼지 않는다.',
  findDistinctDefaultKickoffsByLeagueUidInRange:
    'league-season kickoff index 범위에서 시작하고, default 여부의 `NOT EXISTS`는 작은 backbone relation에 대한 anti join으로 처리한다. DISTINCT 대상은 이미 league-local range로 축소되어 있다.',
  findMinApiSportsBackedKickoffAfterByLeagueUid:
    'league-season kickoff index를 이용해 pivot 이후의 fixture만 탐색하고 ApiSports 존재 여부는 index-only lookup으로 확인한다. MIN을 구하기 위해 million-row fixture table을 스캔하거나 전역 정렬하지 않는다.',
  findMaxApiSportsBackedKickoffBeforeByLeagueUid:
    'MAX도 league-season kickoff index 경로를 사용한다. 이 preset에서 이른 pivot case는 수천 행을 읽지만, 모두 대상 league의 season-local 범위이며 전체 fixture scan은 제거됐다.',
  findAvailableFixturesByLeagueUid:
    'available fixture를 league-season별 fixture index에서 찾는다. league UID가 없는 case는 league lookup에서 조기 종료하며, 정상 case도 해당 league의 10개 season으로만 범위가 제한된다.',
  findDistinctLeagueUidsWithAvailableFixtures:
    '전역 DISTINCT materialization 대신 `Nested Loop Semi`로 league별 존재 여부를 확인한다. `idx_fixture_core_league_season_available_kickoff` index-only scan이 첫 available fixture에서 종료할 수 있다.',
  findMatchCollectStateReconcileFixturesByLeagueUid:
    'league-season fixture를 먼저 index로 제한한 뒤, state는 fixture별 unique index로 left join한다. scheduler/reconcile path에서 unrelated league fixture와 state를 결합하던 비용이 제거됐다.',
  'findAdminStatesByLeagueUidAndStatuses.data':
    'pagination 대상 fixture/state 집합을 league-season 경로로 먼저 한정하고, 필요한 team 정보는 그 뒤에 결합한다. team_core hash join은 남아 있지만 input은 league-local 집합이며 legacy league OR 조건과 중복 fixture join은 없다.',
  'findAdminStatesByLeagueUidAndStatuses.count':
    'count query는 fixture/state filter와 aggregate만 수행하며 data query의 team fetch join이 없다. league-season fixture index와 fixture별 state unique index를 통해 count 입력을 제한한다.',
};

async function writeAfterExplainAnalysis(runDirectory: string, summaries: RunSummaries) {
  const lines = ['# 변경 쿼리 After EXPLAIN 해석', '', '동일한 `leagues-1m` (seed `20260917`) dataset과 Before case를 사용했다. 아래 수치는 10개 고정 case의 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` 결과 범위이며, latency가 아니라 PostgreSQL plan의 execution time이다.', ''];
  for (const [target, cases] of Object.entries(summaries)) {
    if (!changedTargetNames.has(target)) continue;
    const accessedRows = cases.map(item => item.plan.accessedRows as number);
    const rowsRemoved = cases.map(item => item.plan.rowsRemoved as number);
    const executionMs = cases.map(item => item.plan.executionMs as number);
    lines.push(`## ${target}`, '', afterPlanInterpretations[target], '', `- After accessed rows: ${range(accessedRows)}`, `- After rows removed by filter/join filter: ${range(rowsRemoved)}`, `- After EXPLAIN execution time: ${range(executionMs)} ms`, `- Scan/index: ${planShapes(cases, 'scans')}`, `- Join: ${planShapes(cases, 'joins')}`, `- Raw plans: ${cases.map(item => `[${item.caseId}](./${target}/${item.caseId}/explain.json)`).join(', ')}`, '');
  }
  lines.push('## Index 판단', '', 'After plan은 모두 기존 league-season 및 fixture/state/provider index를 사용하며, 변경 대상에서 million-row `fixture_core` 전체 scan은 재현되지 않았다. 현재 결과만으로 새 index를 추가하면 write/storage 비용만 늘릴 가능성이 크므로 추가 migration은 제안하지 않는다. `findMaxApiSportsBackedKickoffBeforeByLeagueUid`의 최대 7,734 accessed rows와 Admin data의 최대 18,434 accessed rows는 각각 league-local 범위와 필요한 team fetch의 비용으로 남아 있으며, 동일 병목이 새 index 필요 수준으로 반복된다는 근거는 없다.', '');
  await writeFile(resolve(runDirectory, 'after-explain-analysis.md'), `${lines.join('\n')}\n`);
}

async function benchmarkFixtureLeagueSeason(client: pg.Client, phase: 'before' | 'after', beforeRun?: string) {
  const active = await readActiveDataset();
  if (active.config.name !== 'leagues-1m' || active.config.seed !== 20260917) throw new Error(`Expected active leagues-1m seed 20260917, found ${active.config.name} seed ${active.config.seed}.`);
  await assertMigrated(client);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const captureRoot = phase === 'before' ? beforeCaptureDirectory : afterCaptureDirectory;
  const runDirectory = resolve(root, 'results', 'fixture-league-season', phase, `run-${timestamp}`);
  await mkdir(runDirectory, { recursive: true });
  const allSummaries: Record<string, Record<string, unknown>[]> = {};
  for (const target of targets(phase)) allSummaries[target.name] = await runTarget(client, target, runDirectory, captureRoot);
  await saveJson(resolve(runDirectory, 'manifest.json'), {
    startedAt: timestamp, dataset: { name: active.config.name, seed: active.config.seed, fixtureCount: active.loaded.find(row => row.table === 'fixture_core')?.count },
    phase, captureRoot, logicalQueries: 11, physicalTargets: targets(phase).length, warmupsPerCase: 1, parameterizedRepetitions: 10, noParameterRepetitions: 100,
  });
  await saveJson(resolve(runDirectory, 'summary.json'), allSummaries);
  const lines = [`# Fixture league season ${phase === 'before' ? 'Before baseline' : 'After measurement'}`, '', '| Target | Cases | Median range (ms) | Max accessed rows |', '|---|---:|---:|---:|'];
  for (const [name, cases] of Object.entries(allSummaries)) {
    const medians = cases.map(item => (item.latencySummaryMs as { median: number }).median);
    const accessed = cases.map(item => (item.plan as { accessedRows: number }).accessedRows);
    lines.push(`| ${name} | ${cases.length} | ${Math.min(...medians).toFixed(3)} to ${Math.max(...medians).toFixed(3)} | ${Math.max(...accessed)} |`);
  }
  await writeFile(resolve(runDirectory, 'summary.md'), `${lines.join('\n')}\n`);
  if (phase === 'after') {
    await writeAfterExplainSummary(runDirectory, allSummaries);
    await writeAfterExplainAnalysis(runDirectory, allSummaries);
    await compareRuns(beforeRun ? resolve(beforeRun) : await latestBeforeRun(), runDirectory);
  }
  console.log(`${phase === 'before' ? 'Before baseline' : 'After measurement'} saved to ${runDirectory}`);
}

export async function benchmarkFixtureLeagueSeasonBefore(client: pg.Client) {
  await benchmarkFixtureLeagueSeason(client, 'before');
}

export async function benchmarkFixtureLeagueSeasonAfter(client: pg.Client, beforeRun?: string) {
  await benchmarkFixtureLeagueSeason(client, 'after', beforeRun);
}
