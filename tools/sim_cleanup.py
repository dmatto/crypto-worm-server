#!/usr/bin/env python3
"""Remove the load test's simulated players from the live database: python3 tools/sim_cleanup.py [--yes]

First it orders the bots off (sim_cmd) and shows what it would delete. With --yes (run it a couple of minutes later,
once they have logged off) it deletes every simulated account and everything it made: land goes back to the CPU,
their matches, scores, ranking rows, nicknames and bot teams go. Real players are never touched: only ids in sim_players.
Reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment.
"""
import json, os, sys, time, urllib.request

T, A = os.environ['CLOUDFLARE_API_TOKEN'], os.environ['CLOUDFLARE_ACCOUNT_ID']
B = f'https://api.cloudflare.com/client/v4/accounts/{A}'
def call(m, p, b=None):
    r = urllib.request.Request(B + p, data=json.dumps(b).encode() if b else None, method=m, headers={'Authorization': 'Bearer ' + T, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))
db = next(d for d in call('GET', '/d1/database?name=crypto-worm')['result'] if d['name'] == 'crypto-worm')
def sql(q): return call('POST', f'/d1/database/{db["uuid"]}/query', {'sql': q})['result'][-1]['results']

S = '(SELECT player FROM sim_players)'
STEPS = [
    f'DELETE FROM live_fights WHERE attack IN (SELECT id FROM attacks WHERE attacker IN {S} OR defender IN {S})',
    f'DELETE FROM attacks WHERE attacker IN {S} OR defender IN {S}',
    f'DELETE FROM land WHERE owner IN {S}', f'DELETE FROM landlords WHERE player IN {S}', f'DELETE FROM map_alerts WHERE player IN {S}',
    f'DELETE FROM matches WHERE p0 IN {S} OR p1 IN {S}', f'DELETE FROM friends WHERE player IN {S} OR friend IN {S}',
    f'DELETE FROM login_codes WHERE player IN {S}', f'DELETE FROM nicknames WHERE player IN {S}',
    f'DELETE FROM cworm_scores WHERE player IN {S}', f'DELETE FROM week_scores WHERE player IN {S}', f'DELETE FROM score_log WHERE player IN {S}',
    f'DELETE FROM play_days WHERE player IN {S}', f'DELETE FROM rewards WHERE player IN {S}', f'DELETE FROM reward_once WHERE player IN {S}',
    f'DELETE FROM prize_entry WHERE player IN {S}', f'DELETE FROM holders WHERE player IN {S}', f'DELETE FROM hold_dips WHERE player IN {S}',
    f'DELETE FROM team_clash WHERE winner IN {S} OR loser IN {S}', f'DELETE FROM team_leave WHERE player IN {S}',
    f'DELETE FROM team_points WHERE player IN {S}', f'DELETE FROM team_members WHERE player IN {S}',
    # bot teams: a team real players joined stays, led by its earliest real member; a team with nobody left goes
    f'UPDATE teams SET owner = (SELECT player FROM team_members m WHERE m.team = teams.id ORDER BY joined LIMIT 1) WHERE owner IN {S} AND id IN (SELECT team FROM team_members)',
    "UPDATE team_members SET role = 'lead' WHERE player IN (SELECT owner FROM teams)",
    'DELETE FROM team_points WHERE team NOT IN (SELECT team FROM team_members)', 'DELETE FROM team_logos WHERE team NOT IN (SELECT team FROM team_members)',
    'DELETE FROM team_logo_log WHERE team NOT IN (SELECT team FROM team_members)', 'DELETE FROM teams WHERE id NOT IN (SELECT team FROM team_members)',
    f'DELETE FROM feedback WHERE player IN {S}', f'UPDATE player_meta SET invited_by = NULL WHERE invited_by IN {S}',
    f'DELETE FROM player_meta WHERE player IN {S}', f'DELETE FROM players WHERE id IN {S}', 'DELETE FROM sim_players',
]
n = sql(f'''SELECT (SELECT COUNT(*) FROM sim_players) AS accounts, (SELECT COUNT(*) FROM land WHERE owner IN {S}) AS tiles,
  (SELECT COUNT(*) FROM matches WHERE p0 IN {S} OR p1 IN {S}) AS matches, (SELECT COUNT(*) FROM cworm_scores WHERE player IN {S}) AS ranked,
  (SELECT COUNT(DISTINCT team) FROM team_members WHERE player IN {S}) AS teams''')[0]
print('simulated players:', json.dumps(n))
if '--yes' not in sys.argv:
    sql(f"INSERT INTO sim_cmd (cmd, arg, at) VALUES ('off', NULL, {int(time.time() * 1000)})")
    print('Ordered the bots off. Run again with --yes in a couple of minutes to delete them.')
    sys.exit(0)
for q in STEPS: sql(q)
print('deleted. left:', json.dumps(sql('SELECT COUNT(*) AS n FROM sim_players')[0]))
