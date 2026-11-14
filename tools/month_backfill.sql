-- One-off (2026-11-03, the monthly rankings): November 2026 into month_scores, team_month and club_month, from what the weekly
-- tables and the score log already hold. Run once against D1 right before the Worker that writes the monthly tables goes live.
--   Players: every score report since 1 November (score_log keeps 5 weeks), exactly what the weekly ranking counted.
--   Teams and clubs: this week's points (from Monday 2 November) plus Sunday 1 November rebuilt from the score log (members'
--   and fans' play money, load-test bots at 0.2 as teams.js and clubs.js count them) and that day's team clashes and club wins.
-- Each insert only runs while its table is still empty, so a second run changes nothing.
-- 1793491200000 = 2026-11-01 00:00 UTC, 1793577600000 = Monday 2026-11-02, 1796083200000 = 2026-12-01.
INSERT INTO month_scores (month_start, player, cworm, last)
  SELECT 1793491200000, player, SUM(amount), MAX(at) FROM score_log
  WHERE at >= 1793491200000 AND at < 1796083200000 AND NOT EXISTS (SELECT 1 FROM month_scores) GROUP BY player HAVING SUM(amount) > 0;
INSERT INTO team_month (team, month_start, player, pts)
  SELECT team, 1793491200000, player, SUM(pts) FROM (
    SELECT team, player, pts FROM team_points WHERE week_start = 1793577600000
    UNION ALL
    SELECT m.team, l.player, CASE WHEN l.player IN (SELECT player FROM sim_players) THEN CAST(ROUND(l.amount * 0.2) AS INTEGER) ELSE l.amount END
      FROM score_log l JOIN team_members m ON m.player = l.player WHERE l.at >= 1793491200000 AND l.at < 1793577600000
    UNION ALL
    SELECT wteam, winner, 100 FROM team_clash WHERE at >= 1793491200000 AND at < 1793577600000)
  WHERE NOT EXISTS (SELECT 1 FROM team_month) GROUP BY team, player HAVING SUM(pts) > 0;
INSERT INTO club_month (club, month_start, player, pts)
  SELECT club, 1793491200000, player, SUM(pts) FROM (
    SELECT club, player, pts FROM club_points WHERE week_start = 1793577600000
    UNION ALL
    SELECT c.club, l.player, CASE WHEN l.player IN (SELECT player FROM sim_players) THEN CAST(ROUND(l.amount * 0.2) AS INTEGER) ELSE l.amount END
      FROM score_log l JOIN player_club c ON c.player = l.player WHERE l.at >= 1793491200000 AND l.at < 1793577600000
    UNION ALL
    SELECT wclub, winner, CASE WHEN derby = 1 THEN 200 ELSE 50 END FROM club_wins WHERE at >= 1793491200000 AND at < 1793577600000)
  WHERE NOT EXISTS (SELECT 1 FROM club_month) GROUP BY club, player HAVING SUM(pts) > 0;
