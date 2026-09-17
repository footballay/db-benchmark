# 측정 방법과 판단 기준

## 비교 원칙

같은 DB와 데이터, projection, fetch join, 정렬, 날짜 범위에서 League FK 경로만 변경합니다. main suite에는 core/admin/public 대응 쌍과 실제 collect SQL이 있습니다. SQL은 저장소 JPQL의 수동 대응이며 Hibernate가 실제 생성한 SQL 전체와 동일하다는 주장은 하지 않습니다.

기본 seed의 legacy League와 season League는 항상 같습니다. 전체 결과 집합을 EXCEPT ALL 양방향으로 검사합니다. 운영 migration 중 season이 NULL인 데이터가 있으면 두 경로는 의미상 달라질 수 있으며 별도 integration test에서 차이를 확인합니다.

1일/7일/30일은 최신 시즌 첫 실제 kickoff부터 시작합니다. 시즌 범위는 8월1일~다음7월1일, 여러 시즌은 최대 최근3시즌, all은 대상 League 전체 일정입니다. empty는 마지막 경기 이후입니다. 모든 범위는 UTC [inclusive,exclusive)입니다.

## 실험 절차

1. Flyway checksum 검증 및 빈 테이블 확인.
2. FK/UNIQUE가 활성화된 실제 schema에 COPY.
3. row count와 도메인 무결성 검사, sequence 보정 및 ANALYZE.
4. schema/source drift 검사 및 query 결과 동등성 검사.
5. EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON), 첫 실행과 warm 5회.
6. 원본 plan, SQL, params, 환경, 노드별 지표, 요약 저장.

동시 benchmark는 advisory lock으로 직렬화합니다. query는 unnamed pg parameterized execution이며 prepared generic plan의 영향은 별도 연구 대상입니다. planner GUC를 강제로 바꾸지 않습니다. ANALYZE 기본 통계를 사용합니다. VACUUM은 baseline에서 실행하지 않습니다.

인덱스 실험은 DROP INDEX를 transaction 안에서 실행하고 ROLLBACK합니다. 단일 season index 제거 시 다른 season index가 대신 쓰일 수 있으므로 두 개 제거 실험도 제공합니다. global scan index는 collect 쿼리로 별도 비교합니다. schema catalog가 원본과 일치하는지 종료 시 확인합니다.

## 읽는 법

- Fixture 노드 Index Cond에 league_season_id뿐 아니라 kickoff 양 경계가 포함되는지 확인합니다.
- Actual Rows와 Actual Loops는 함께 읽습니다. 반복 노드 행 수는 loop당 평균이며 병렬 worker 정보도 원본에 보존합니다.
- Rows Removed by Filter가 큰 경우 날짜 조건이 index 범위가 아니라 후처리인지 확인합니다.
- root buffer는 전체 쿼리 비교에 사용하고 세부 노드는 접근 경로 분석에 사용합니다. 부모/자식 buffer를 합산하지 않습니다.
- Bitmap Index/Heap Scan도 정상적인 선택입니다. 넓은 범위에서는 Seq Scan·Hash Join이 더 효율적일 수 있습니다.
- 첫 쿼리 이전 validation과 ANALYZE, 다른 query 실행이 cache를 덥힙니다. cold-ish first조차 순서 영향을 받으며 OS cache를 비우지 않습니다.
- EXPLAIN 시간에는 서버 실행이 포함되지만 대규모 결과의 네트워크 전송과 ORM hydration은 포함되지 않습니다.

## 분포의 의미

리그 증가 preset은 대상 리그의 3,800 Fixture를 유지하면서 전체 테이블만 키웁니다. 시즌 증가 preset은 대상 League 자체의 연관 Fixture와 season 수를 늘립니다. cycle 증가 preset은 season 행 수를 유지하면서 season당 Fixture를 늘립니다. 세 축을 섞어 하나의 scaling 곡선으로 해석하지 않습니다.

현재 index 조합 그대로의 결과가 우선입니다. 특정 index가 사용되지 않아도 제거 결론을 내리지 않습니다. `(available,kickoff,league_id)`는 global scan prefix 가치가 있습니다. 후보 index는 관측된 비용/scan 증거가 있을 때 별도 명명된 실험으로 추가하며 production에는 적용하지 않습니다.
