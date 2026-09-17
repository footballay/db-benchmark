-- 각 statement는 불일치 개수만 반환한다. 검증은 CHECK 이름으로 보고한다.
-- CHECK fixture_links
SELECT count(*) AS violations FROM fixture_core f
LEFT JOIN league_season_core s ON s.id=f.league_season_id
LEFT JOIN league_core l ON l.id=f.league_id
LEFT JOIN team_core h ON h.id=f.home_team_id
LEFT JOIN team_core a ON a.id=f.away_team_id
WHERE s.id IS NULL OR l.id IS NULL OR h.id IS NULL OR a.id IS NULL
 OR s.league_core_id<>f.league_id OR h.id=a.id
 OR f.kickoff IS NULL OR f.kickoff::date<s.season_start OR f.kickoff::date>s.season_end;
-- CHECK provider_links
SELECT count(*) AS violations FROM fixture_api_sports p
LEFT JOIN fixture_core f ON f.id=p.fixture_core_id
LEFT JOIN league_apisports_season s ON s.id=p.season_id
LEFT JOIN league_apisports l ON l.id=s.league_apisports_id
LEFT JOIN apisports_match_team h ON h.id=p.home_team_id
LEFT JOIN apisports_match_team a ON a.id=p.away_team_id
LEFT JOIN team_apisports ht ON ht.id=h.team_apisports_id
LEFT JOIN team_apisports at ON at.id=a.team_apisports_id
WHERE f.id IS NULL OR s.id IS NULL OR l.id IS NULL OR h.id IS NULL OR a.id IS NULL
 OR ht.team_core_id IS DISTINCT FROM f.home_team_id OR at.team_core_id IS DISTINCT FROM f.away_team_id
 OR s.league_season_core_id IS DISTINCT FROM f.league_season_id OR l.league_core_id IS DISTINCT FROM f.league_id
 OR p.date IS DISTINCT FROM f.kickoff OR p.total_home IS DISTINCT FROM f.goals_home OR p.total_away IS DISTINCT FROM f.goals_away;
-- CHECK season_current
SELECT count(*) AS violations FROM (SELECT league_core_id FROM league_season_core GROUP BY league_core_id HAVING count(*) FILTER (WHERE current)<>1) x;
-- CHECK backbone_core_required
SELECT (SELECT count(*) FROM league_apisports a LEFT JOIN league_core c ON c.id=a.league_core_id WHERE c.id IS NULL)
 + (SELECT count(*) FROM team_apisports a LEFT JOIN team_core c ON c.id=a.team_core_id WHERE c.id IS NULL)
 + (SELECT count(*) FROM player_apisports a LEFT JOIN player_core c ON c.id=a.player_core_id WHERE c.id IS NULL) AS violations;
-- CHECK provider_season_binding
SELECT count(*) AS violations FROM league_apisports_season p
LEFT JOIN league_season_core c ON c.id=p.league_season_core_id LEFT JOIN league_apisports l ON l.id=p.league_apisports_id
WHERE c.id IS NULL OR l.id IS NULL OR l.league_core_id IS DISTINCT FROM c.league_core_id
 OR p.season_year IS DISTINCT FROM c.season_year OR p.season_start IS DISTINCT FROM c.season_start OR p.season_end IS DISTINCT FROM c.season_end;
-- CHECK fixture_team_membership
SELECT count(*) AS violations FROM fixture_core f
LEFT JOIN league_team_core h ON h.league_core_id=f.league_id AND h.team_core_id=f.home_team_id
LEFT JOIN league_team_core a ON a.league_core_id=f.league_id AND a.team_core_id=f.away_team_id
WHERE h.id IS NULL OR a.id IS NULL;
-- CHECK duplicate_team_player
SELECT count(*) AS violations FROM (SELECT team_core_id,player_core_id FROM team_player_core GROUP BY 1,2 HAVING count(*)<>1) x;
-- CHECK match_team_reuse
SELECT count(*) AS violations FROM (SELECT id FROM (SELECT home_team_id AS id FROM fixture_api_sports UNION ALL SELECT away_team_id FROM fixture_api_sports) u GROUP BY id HAVING count(*)<>1 OR id IS NULL) x;
-- CHECK match_player_squad
SELECT count(*) AS violations FROM apisports_match_player p
LEFT JOIN player_apisports pa ON pa.id=p.player_apisports_id
LEFT JOIN apisports_match_team mt ON mt.id=p.match_team_id
LEFT JOIN team_apisports ta ON ta.id=mt.team_apisports_id
LEFT JOIN team_player_core tp ON tp.team_core_id=ta.team_core_id AND tp.player_core_id=pa.player_core_id
WHERE tp.id IS NULL OR p.position IS DISTINCT FROM pa.position;
-- CHECK event_ownership
SELECT count(*) AS violations FROM apisports_match_event e
LEFT JOIN fixture_api_sports f ON f.id=e.fixture_api_id
LEFT JOIN apisports_match_player p ON p.id=e.player_id
LEFT JOIN apisports_match_player a ON a.id=e.assist_id
WHERE f.id IS NULL OR e.match_team_id IS NULL OR e.match_team_id NOT IN (f.home_team_id,f.away_team_id)
 OR p.id IS NULL OR p.match_team_id IS DISTINCT FROM e.match_team_id
 OR (e.assist_id IS NOT NULL AND (a.id IS NULL OR a.match_team_id IS DISTINCT FROM e.match_team_id));
-- CHECK event_sequence
SELECT count(*) AS violations FROM (SELECT fixture_api_id FROM apisports_match_event GROUP BY fixture_api_id HAVING min(sequence)<>0 OR max(sequence)<>count(*)-1 OR count(DISTINCT sequence)<>count(*)) x;
-- CHECK match_cardinality
SELECT count(*) AS violations FROM (
 SELECT mt.id FROM apisports_match_team mt LEFT JOIN apisports_match_player p ON p.match_team_id=mt.id
 GROUP BY mt.id,mt.team_statistics_id HAVING count(p.id)<>CASE WHEN mt.team_statistics_id IS NULL THEN 0 ELSE 18 END
 OR (mt.team_statistics_id IS NOT NULL AND count(p.id) FILTER (WHERE NOT p.substitute)<>11)
) x;
-- CHECK shared_team_statistics
SELECT count(*) AS violations FROM (SELECT team_statistics_id FROM apisports_match_team WHERE team_statistics_id IS NOT NULL GROUP BY 1 HAVING count(*)<>1) x;
-- CHECK detailed_player_statistics
SELECT count(*) AS violations FROM (SELECT mt.id FROM apisports_match_team mt
LEFT JOIN apisports_match_player p ON p.match_team_id=mt.id LEFT JOIN apisports_match_player_stat s ON s.match_player_id=p.id
GROUP BY mt.id,mt.team_statistics_id HAVING count(s.id)<>CASE WHEN mt.team_statistics_id IS NULL THEN 0 ELSE 14 END) x;
-- CHECK xg_samples
SELECT count(*) AS violations FROM (SELECT s.id FROM apisports_match_team_stat s LEFT JOIN apisports_match_team_xg x ON x.match_team_statistics_id=s.id GROUP BY s.id
HAVING count(x.id)<>3 OR min(x.elapsed_time)<>30 OR max(x.elapsed_time)<>90) x;
-- CHECK goal_consistency
SELECT count(*) AS violations FROM fixture_api_sports f JOIN apisports_match_team mt ON mt.id IN(f.home_team_id,f.away_team_id)
LEFT JOIN (SELECT fixture_api_id,match_team_id,count(*) AS goals FROM apisports_match_event WHERE event_type='Goal' GROUP BY 1,2) e ON e.fixture_api_id=f.id AND e.match_team_id=mt.id
WHERE mt.team_statistics_id IS NOT NULL AND coalesce(e.goals,0)<>CASE WHEN mt.id=f.home_team_id THEN f.total_home ELSE f.total_away END;
-- CHECK player_stats_events
SELECT count(*) AS violations FROM apisports_match_player_stat s JOIN apisports_match_player p ON p.id=s.match_player_id
LEFT JOIN (SELECT player_id,count(*) FILTER(WHERE event_type='Goal') goals,count(*) FILTER(WHERE detail='Yellow Card') yellows,count(*) FILTER(WHERE detail='Red Card') reds FROM apisports_match_event GROUP BY player_id) e ON e.player_id=p.id
WHERE s.goals_total IS DISTINCT FROM coalesce(e.goals,0) OR s.yellow_cards IS DISTINCT FROM coalesce(e.yellows,0) OR s.red_cards IS DISTINCT FROM coalesce(e.reds,0) OR s.minutes_played<0 OR s.minutes_played>90;
-- CHECK team_stats_events
SELECT count(*) AS violations FROM apisports_match_team mt JOIN apisports_match_team_stat s ON s.id=mt.team_statistics_id
LEFT JOIN (SELECT match_team_id,count(*) FILTER(WHERE detail='Yellow Card') yellows,count(*) FILTER(WHERE detail='Red Card') reds FROM apisports_match_event GROUP BY match_team_id) e ON e.match_team_id=mt.id
WHERE s.yellow_cards IS DISTINCT FROM coalesce(e.yellows,0) OR s.red_cards IS DISTINCT FROM coalesce(e.reds,0);
-- CHECK substitution_semantics
SELECT count(*) AS violations FROM apisports_match_event e JOIN apisports_match_player p ON p.id=e.player_id JOIN apisports_match_player a ON a.id=e.assist_id
JOIN apisports_match_player_stat ps ON ps.match_player_id=p.id JOIN apisports_match_player_stat ast ON ast.match_player_id=a.id
WHERE e.event_type='Subst' AND (NOT p.substitute OR a.substitute OR ps.minutes_played<>90-e.elapsed_time OR ast.minutes_played<>e.elapsed_time);
-- CHECK event_after_red
SELECT count(*) AS violations FROM apisports_match_event red JOIN apisports_match_event e ON (e.player_id=red.player_id OR e.assist_id=red.player_id) AND e.fixture_api_id=red.fixture_api_id
WHERE red.detail='Red Card' AND e.elapsed_time>red.elapsed_time;
-- CHECK xg_order
SELECT count(*) AS violations FROM (SELECT expected_goals,lag(expected_goals) OVER(PARTITION BY match_team_statistics_id ORDER BY elapsed_time) previous FROM apisports_match_team_xg) x WHERE expected_goals<0 OR expected_goals<previous;
