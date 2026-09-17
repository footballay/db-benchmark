# Footballay PostgreSQL benchmark

`footballay-core`의 Flyway 스키마에서 legacy League 조회와 season-aware 조회를 비교하는 독립 TypeScript 프로젝트입니다. 원본 저장소는 수정하지 않습니다. JPA·Python·row-by-row bulk INSERT를 사용하지 않습니다.

## 준비와 실행

- Node.js 22 이상, npm, 실행 중인 Docker Desktop/Engine과 Compose v2가 필요합니다.
- 형제 경로 `../footballay-core`가 필요합니다. migration은 `src/main/resources/db/migration`에서 read-only mount합니다.
- 기본 DB는 `127.0.0.1:55432/footballay_benchmark`입니다. PostgreSQL 17.4, Flyway 11.18.0을 고정했습니다.
- 필요하면 `.env.example`을 `.env`로 복사해 포트/benchmark 전용 비밀번호를 바꿉니다. 외부 DB URL은 받지 않습니다.
- **Windows PowerShell에서는 아래 `npm`을 `npm.cmd`로 실행하십시오.** 일부 npm.ps1 환경은 `--` 뒤의 옵션을 npm 설정으로 잘못 처리합니다. macOS에서는 그대로 `npm`을 사용합니다.

두 저장소는 같은 상위 디렉터리에 clone해야 합니다. 아래 URL은 업로드 후 실제 GitHub URL로 바꾸십시오.

```sh
mkdir footballay-workspace
cd footballay-workspace

git clone <footballay-core-url> footballay-core
git clone <benchmark-url> footballay-db-benchmark
```

그 다음 benchmark 저장소에서 실행합니다.

```sh
cd footballay-db-benchmark
npm ci
```

```sh
npm run db:up
npm run db:migrate
npm run seed:realistic
npm run validate
npm run benchmark
```

`db:migrate`는 빈 DB에 V1부터 모든 migration을 적용합니다. JPA나 baseline 생략으로 테이블을 만들지 않습니다. PostgreSQL 데이터는 Compose의 전용 named volume에 저장됩니다. `db:down`은 volume을 보존합니다.

`seed`는 빈 테이블만 허용하며 COPY → sequence 보정 → 무결성 검증 → COMMIT → ANALYZE를 수행합니다. 실패한 COPY/검증은 전체 적재를 rollback합니다. sequence 값 자체는 PostgreSQL 특성상 rollback되지 않을 수 있으나 다음 성공 적재에서 다시 보정합니다. 빈 schema로 되돌리려면 아래 명령을 명시적으로 실행합니다. **benchmark 전용 volume의 데이터가 삭제됩니다.** 기존 results는 보존합니다.

```sh
npm run db:reset -- --confirm footballay-benchmark
npm run seed:scale -- --preset leagues-1m
npm run benchmark
```

## Dataset 설정

`realistic`: 5리그 × 20팀 × 10시즌 × 380경기 = 19,000 Fixture입니다. 팀당 선수 25명, 모든 경기 상세 Match Data를 생성합니다. 2017~2026 시즌이 종료된 스냅샷이며 최신 시즌만 `current=true`입니다. 실제 오늘 날짜는 사용하지 않습니다.

Scale preset은 설정의 편의 이름이며 generator 구현 분기가 아닙니다.

| Preset | League | Season/League | Cycle | Fixture |
|---|---:|---:|---:|---:|
| leagues-100k | 27 | 10 | 1 | 102,600 |
| leagues-500k | 132 | 10 | 1 | 501,600 |
| leagues-1m | 264 | 10 | 1 | 1,003,200 |
| seasons-100k | 5 | 53 | 1 | 100,700 |
| seasons-500k | 5 | 264 | 1 | 501,600 |
| seasons-1m | 5 | 527 | 1 | 1,001,300 |
| cycles-1m | 5 | 10 | 53 | 1,007,000 |
| smoke | 2 | 2 | 1 | 1,520 |

Scale 기본 상세 Match Data 비율은 약 1/100입니다. hash 기반 표본이므로 정확한 행 수는 seed manifest에 기록됩니다. `smoke`는 약 1/20입니다. 모든 Fixture의 Core/Backbone와 두 Match Team 연결은 유지합니다.

```sh
npm run seed:scale -- --preset leagues-100k --leagueCount 12 --seasonsPerLeague 20 --scheduleCycleFactor 2 --matchDetailEvery 1000 --seed 20260917
```

추가 매개변수는 `teamsPerLeague`(짝수), `playersPerTeam`(18 이상), `latestSeasonYear`입니다. `fixturesPerSeason`은 직접 지정하지 않습니다. `teams × (teams−1) × scheduleCycleFactor`로 결정합니다. realistic의 cardinality는 고정합니다. 동일 설정/seed는 동일 CSV SHA256을 생성합니다. ID와 FK는 삽입 결과 조회 없이 좌표로 계산합니다.

시즌 증가/cycle 증가 preset은 planner용 인위적 분포입니다. 현실적인 리그 구조와 구분해 해석하십시오. 같은 팀·선수 pool을 여러 시즌 재사용하며 이적·승강·선수 노화는 모델링하지 않습니다.

## 쿼리와 결과

```sh
npm run benchmark -- --families core,public --ranges 1day,7day,30day,season,multi-season,all --repeats 5
npm run benchmark -- --suite indexes
npm run inspect
```

- `core`: `f.*`를 반환하는 최소 조회 쌍.
- `admin`: 실제 Repository의 ApiSports LEFT JOIN FETCH에 대응하는 조회 쌍.
- `public`: 실제 Repository의 ApiSports INNER JOIN FETCH에 대응하는 조회 쌍.
- `collect`: 실제 global MatchCollect 후보 조회. LIMIT 100, FINISHED 모드입니다.
- 범위: `1day,7day,30day,season,multi-season,all,empty`.
- `indexes`: baseline, 첫 season 인덱스 제거, 두 season 인덱스 제거, global scan 인덱스 제거입니다. 각 실험은 transaction rollback 후 복구를 검증합니다.

`results/<preset>/seed-<timestamp>/manifest.json`은 설정·테이블 행 수/해시·원본 commit/migration SHA256·스키마·환경을 보관합니다. `results/active.json`은 현재 DB dataset을 가리킵니다. 결과 파일을 보존한 채 DB만 외부에서 교체하지 마십시오.

`results/<preset>/run-<timestamp>/`에는 SQL/매개변수를 포함한 manifest, 모든 EXPLAIN JSON/TXT, metrics.json, summary.md가 저장됩니다. 파일명은 variant·query·range·반복 번호를 포함합니다. TXT는 JSON plan에서 만든 노드별 표현이며 별도 재실행한 EXPLAIN이 아닙니다.

첫 실행은 cold cache 측정이 아닙니다. 검증·ANALYZE·다른 쿼리가 캐시에 영향을 줍니다. 각 쿼리는 unnamed parameterized SQL이며 JDBC prepared statement의 generic plan 전환이나 Hibernate 전체 응답 시간을 재현하지 않습니다. `EXPLAIN ANALYZE`의 서버 실행 시간과 plan/buffer scaling을 비교합니다.

기존 `(available,kickoff,league_id)` 인덱스는 제거 대상으로 단정하지 않습니다. `available+kickoff` prefix를 쓰는 collect 결과와 함께 판단합니다. production index 변경은 수행하지 않습니다.

## 검증

```sh
npm run typecheck
npm test
# migration과 seed 이후 실제 PostgreSQL 통합 테스트.
npm run test:integration
```

통합 테스트는 transaction rollback으로 종료하며 기존 dataset을 보존합니다. seed 검증은 row count·catalog의 모든 FK orphan·라운드로빈·Core/provider 일치·선수 소속·이벤트/통계 관계를 검사합니다. `benchmark`도 검증 및 legacy/season-aware 결과 집합 비교 후 시작합니다. 특정 Index Scan을 테스트 통과 조건으로 강제하지 않습니다.

전체 1m benchmark는 대량 COPY, FK 검증, 반복 EXPLAIN을 포함하므로 저장장치/메모리에 따라 시간이 걸립니다. 상세 통계를 전부 만들면 Fixture 수보다 Match Player 행 수가 훨씬 많아집니다. 전용 DB에서 실행하고 baseline 도중 설정이나 통계를 바꾸지 마십시오.

설계 근거는 [schema-analysis.md](docs/schema-analysis.md), 측정 해석은 [benchmark-methodology.md](docs/benchmark-methodology.md)에 있습니다. 새 Git repository는 이 디렉터리를 루트로 초기화하면 됩니다. 결과는 기본 Git 제외이며 공유할 summary/manifest는 선별하여 추가하십시오.
