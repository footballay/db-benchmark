# Footballay benchmark DB builder

이 프로젝트는 query benchmark framework가 아니다. `footballay-core`의 실제 Flyway migration으로 PostgreSQL schema를 만들고, 재현 가능한 대규모 synthetic data를 생성해 PostgreSQL `COPY`로 적재하는 도구다.

```text
footballay-core Flyway migration
        ↓
PostgreSQL Docker schema
        ↓
deterministic dummy data generator
        ↓
COPY bulk load
        ↓
benchmark용 PostgreSQL DB 준비 완료
```

실제 query/index 성능을 측정하기 전에, 동일한 schema와 동일한 seed로 대규모 dataset을 반복해서 준비하기 위해 존재한다. `footballay-core`와 migration 파일은 수정하지 않고 read-only로 참조한다.

## 준비

- Node.js 22 이상
- npm
- Docker Compose v2
- 이 저장소와 형제 경로의 `../footballay-core`

Flyway source는 `../footballay-core/src/main/resources/db/migration`이다. PostgreSQL은 기본적으로 `127.0.0.1:55432/footballay_benchmark`에서 실행된다. 포트와 전용 비밀번호는 `.env.example`을 `.env`로 복사해 변경할 수 있다.

```sh
npm ci
npm run db:up
npm run db:migrate
```

`db:migrate`는 V1부터 현재 migration까지 적용한 뒤 Flyway validation을 실행한다.

## Dataset 생성과 적재

현실적인 소규모 dataset은 다음과 같이 만든다.

```sh
npm run seed:realistic
npm run validate
```

대규모 dataset은 scale preset을 선택한다.

```sh
npm run seed:scale -- --preset leagues-1m
npm run validate
```

seed는 다음 순서로 동작한다.

1. 현재 DB가 `footballay-core` migration과 일치하고 대상 테이블이 비어 있는지 확인한다.
2. deterministic generator가 Core, ApiSports backbone, Match Data row를 만든다.
3. 각 테이블을 streaming `COPY`로 적재한다.
4. explicit ID에 맞춰 identity sequence를 보정한다.
5. row count와 주요 관계를 검증한 뒤 transaction을 commit한다.
6. PostgreSQL 통계를 갱신하고 `results/active.json`에 config, row count, CSV SHA256을 기록한다.

같은 generator config와 seed는 같은 row stream과 SHA256을 만든다. 적재나 검증에 실패하면 전체 seed transaction을 rollback한다.

기존 dataset을 지우고 빈 schema를 다시 만들려면 전용 volume 삭제를 명시적으로 확인해야 한다.

```sh
npm run db:reset -- --confirm footballay-benchmark
```

## Preset

`realistic`은 5개 리그, 리그당 20개 팀, 팀당 25명, 리그당 10개 시즌으로 구성된다. 모든 경기에 상세 Match Data를 생성하며 Fixture는 19,000개다.

| Preset | League | Season/League | Cycle | Fixture |
|---|---:|---:|---:|---:|
| realistic | 5 | 10 | 1 | 19,000 |
| leagues-100k | 27 | 10 | 1 | 102,600 |
| leagues-500k | 132 | 10 | 1 | 501,600 |
| leagues-1m | 264 | 10 | 1 | 1,003,200 |
| seasons-100k | 5 | 53 | 1 | 100,700 |
| seasons-500k | 5 | 264 | 1 | 501,600 |
| seasons-1m | 5 | 527 | 1 | 1,001,300 |
| cycles-1m | 5 | 10 | 53 | 1,007,000 |
| smoke | 2 | 2 | 1 | 1,520 |

scale preset은 generator의 별도 구현이 아니라 설정 묶음이다. 기본적으로 상세 Match Data는 약 100경기당 1경기만 생성해 규모를 제어하고, 모든 Fixture의 Core/ApiSports backbone과 양 팀 연결은 유지한다.

필요하면 scale preset 값을 override할 수 있다.

```sh
npm run seed:scale -- --preset leagues-100k --leagueCount 12 --seasonsPerLeague 20 --scheduleCycleFactor 2 --matchDetailEvery 1000 --seed 20260917
```

지원 값은 `seed`, `leagueCount`, `teamsPerLeague`, `playersPerTeam`, `seasonsPerLeague`, `latestSeasonYear`, `scheduleCycleFactor`, `matchDetailEvery`다. `teamsPerLeague`는 2 이상의 짝수이고 `playersPerTeam`은 18 이상이어야 한다. `realistic` cardinality는 고정이다.

## Validation과 테스트

`npm run validate`는 active dataset의 예상 row count, PostgreSQL의 모든 FK, Fixture의 league/leagueSeason/team 관계, Core↔ApiSports backbone 연결, round-robin cardinality를 확인한다.

```sh
npm run typecheck
npm test
npm run test:integration
```

integration test는 migration과 seed가 완료된 실제 PostgreSQL에서 실행한다. 실제 `fixture_core`에 explicit ID를 `COPY`한 뒤 transaction을 rollback하므로 기존 dataset은 보존된다.

## 향후 성능 테스트 흐름

query benchmark, Hibernate SQL 추출, EXPLAIN, before/after 비교, report 생성은 현재 범위에 포함하지 않는다. 필요한 기능은 실제 작업이 생길 때 별도 단계로 추가한다.

```text
footballay-core 실제 Repository 실행
→ Hibernate 실제 SQL 확보
→ 이 프로젝트가 만든 PostgreSQL DB에 SQL 실행
→ EXPLAIN / latency 측정
→ query/index 변경
→ 다시 측정
→ before/after 비교
```
