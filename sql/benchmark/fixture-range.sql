-- FixtureCoreRepository의 두 UID 범위 조회에 대응한다.
-- projection/provider_join/league_join은 코드의 고정 SQL 조각만 대입한다.
SELECT {{projection}}
FROM fixture_core f
{{league_join}}
{{provider_join}}
WHERE l.uid = $1 AND f.kickoff >= $2::timestamptz AND f.kickoff < $3::timestamptz
ORDER BY f.kickoff ASC
