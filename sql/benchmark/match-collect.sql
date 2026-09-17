-- findFinishedCollectCandidateFixtures. 기존 mixed legacy/season 경로를 보존한다.
SELECT f.*, l.*, s.*
FROM fixture_core f
JOIN league_core l ON l.id=f.league_id
JOIN league_season_core ls ON ls.id=f.league_season_id
LEFT JOIN fixture_match_collect_state s ON s.fixture_core_id=f.id
WHERE l.available=true AND l.match_collect=$1 AND ls.current=true
 AND f.available=false AND f.kickoff IS NOT NULL
 AND f.kickoff >= $2::timestamptz AND f.kickoff < $3::timestamptz
 AND (s.id IS NULL OR s.match_collect_status NOT IN ('SUCCESS','NOT_PLAYED','DATA_INCOMPLETE_NEEDS_ADMIN','FAIL_END'))
ORDER BY f.kickoff ASC, f.id ASC
LIMIT $4
