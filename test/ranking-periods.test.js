import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const { default: worker } = await import('../src/index.js');
const { monthStart, weekStart } = await import('../src/growth.js');
globalThis.fetch = async () => RealResponse.json({}, { status: 404 });

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const LOBBY = { idFromName: n => n, get: () => ({ fetch: async () => Response.json({ online: [] }) }) };
  return { DB, sql, LOBBY, SESSION_SECRET: 'test-secret', SIGNIN_DOMAIN: 'example.test', PUBLIC_URL: 'https://api.test' };
}
const call = async (env, path, body, token) => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { status: r.status, ...(await r.json()) };
};
const guest = async env => { const s = await call(env, '/auth/guest', {}); return { token: s.token, id: s.player.id } };

test('ranking: players, holders, teams and clubs each have this week, this month and all time', async () => {
  const env = makeEnv(), now = Date.now(), M = monthStart(now), W = weekStart(now);
  const [a, b, c] = [await guest(env), await guest(env), await guest(env)];
  // history: b had a big earlier month and an earlier week, so only all time puts b first
  env.sql.prepare('INSERT INTO cworm_scores (player, total, week_start, week) VALUES (?, 5000, ?, 0)').run(b.id, W - 7 * 864e5);
  env.sql.prepare('INSERT INTO month_scores (month_start, player, cworm, last) VALUES (?, ?, 4000, 0)').run(M - 31 * 864e5, b.id);
  env.sql.prepare("INSERT INTO teams (id, name, tag, emoji, owner, code, created) VALUES (1, 'Diggers', 'DIG', '🪱', ?, 'c1', 0), (2, 'Moles', 'MOL', '🐀', ?, 'c2', 1)").run(a.id, b.id);
  env.sql.prepare("INSERT INTO team_members (player, team, role, joined) VALUES (?, 1, 'lead', 0), (?, 2, 'lead', 0)").run(a.id, b.id);
  env.sql.prepare('INSERT INTO team_points (team, week_start, player, pts) VALUES (2, ?, ?, 900)').run(W - 7 * 864e5, b.id);
  env.sql.prepare("INSERT INTO player_club (player, club, at) VALUES (?, 'uy-ca-penarol', 0), (?, 'uy-nacional-de-montevideo', 0)").run(a.id, b.id);
  env.sql.prepare("INSERT INTO club_points (club, week_start, player, pts) VALUES ('uy-nacional-de-montevideo', ?, ?, 700)").run(W - 7 * 864e5, b.id);
  env.sql.prepare("INSERT INTO holders (player, wallet, tier) VALUES (?, 'WA', 1)").run(a.id); env.sql.prepare("UPDATE players SET wallet = 'WA' WHERE id = ?").run(a.id);

  assert.equal((await call(env, '/score', { amount: 300 }, a.token)).added, 300);
  assert.equal((await call(env, '/score', { amount: 100 }, b.token)).added, 100);
  assert.equal((await call(env, '/score', { amount: 50 }, c.token)).added, 50);
  assert.deepEqual(env.sql.prepare('SELECT player, cworm FROM month_scores WHERE month_start = ? ORDER BY player').all(M).map(r => [r.player, r.cworm]), [[a.id, 300], [b.id, 100], [c.id, 50]]);

  const ids = r => r.top.map(x => [x.id, x.cworm]);
  const month = await call(env, '/ranking?period=month', undefined, c.token);
  assert.equal(month.period, 'month'); assert.equal(month.since, M); assert.deepEqual(ids(month), [[a.id, 300], [b.id, 100], [c.id, 50]]);
  assert.equal(month.me.rank, 3);
  assert.deepEqual(ids(await call(env, '/ranking?period=week', undefined, c.token)), [[a.id, 300], [b.id, 100], [c.id, 50]]);
  assert.deepEqual(ids(await call(env, '/ranking?period=all', undefined, c.token)), [[b.id, 5100], [a.id, 300], [c.id, 50]]);
  const hm = await call(env, '/ranking?period=month&holders=1', undefined, c.token);
  assert.equal(hm.holders, true); assert.deepEqual(ids(hm), [[a.id, 300]]);

  // teams: the month counts this month's points only, all time everything
  const tp = r => r.top.map(x => [x.id, x.pts]);
  const tm = await call(env, '/teams?period=month', undefined, a.token);
  assert.equal(tm.period, 'month'); assert.equal(tm.since, M); assert.deepEqual(tp(tm), [[1, 300], [2, 100]]);
  assert.deepEqual(tp(await call(env, '/teams?period=week', undefined, a.token)), [[1, 300], [2, 100]]);
  assert.deepEqual(tp(await call(env, '/teams?period=all', undefined, a.token)), [[2, 1000], [1, 300]]);

  // clubs: the same three periods, with the player's own share
  const cl = r => r.top.map(x => [x.id, x.pts]);
  const cm = await call(env, '/clubs?period=month', undefined, b.token);
  assert.equal(cm.period, 'month'); assert.deepEqual(cl(cm), [['uy-ca-penarol', 300], ['uy-nacional-de-montevideo', 100]]);
  assert.equal(cm.mine.pts, 100); assert.equal(cm.mine.myPts, 100); assert.equal(cm.mine.rank, 2);
  const ca = await call(env, '/clubs?period=all', undefined, b.token);
  assert.deepEqual(cl(ca), [['uy-nacional-de-montevideo', 800], ['uy-ca-penarol', 300]]); assert.equal(ca.mine.myPts, 800); assert.equal(ca.since, null);
  const cw = await call(env, '/clubs', undefined, b.token);                                    // no period: this week, as before
  assert.equal(cw.period, 'week'); assert.equal(cw.since, W); assert.equal(cw.mine.myPts, 100);
});

test('ranking: the one-off November backfill fills the monthly tables once', () => {
  const env = makeEnv(), sql = env.sql, NOV1 = Date.UTC(2026, 10, 1), MON = Date.UTC(2026, 10, 2), H = 3600e3;
  sql.prepare('INSERT INTO sim_players (player, created) VALUES (9, 0)').run();
  const log = (p, at, n) => sql.prepare('INSERT INTO score_log (player, at, amount) VALUES (?, ?, ?)').run(p, at, n);
  log(1, NOV1 - H, 999); log(1, NOV1 + H, 100); log(1, MON + H, 40); log(2, MON + 2 * H, 60); log(9, NOV1 + H, 50);   // October doesn't count
  sql.prepare("INSERT INTO team_members (player, team, role, joined) VALUES (1, 7, 'lead', 0), (9, 7, 'member', 0)").run();
  sql.prepare('INSERT INTO team_points (team, week_start, player, pts) VALUES (7, ?, 1, 40), (7, ?, 1, 999)').run(MON, MON - 7 * 864e5);
  sql.prepare('INSERT INTO team_clash (at, winner, loser, wteam, lteam) VALUES (?, 1, 2, 7, 8)').run(NOV1 + 2 * H);
  sql.prepare("INSERT INTO player_club (player, club, at) VALUES (1, 'uy-ca-penarol', 0), (2, 'ar-boca-juniors', 0)").run();
  sql.prepare("INSERT INTO club_points (club, week_start, player, pts) VALUES ('uy-ca-penarol', ?, 1, 40), ('ar-boca-juniors', ?, 2, 60)").run(MON, MON);
  sql.prepare("INSERT INTO club_wins (at, winner, loser, wclub, lclub, derby) VALUES (?, 1, 2, 'uy-ca-penarol', 'ar-boca-juniors', 0)").run(NOV1 + 3 * H);
  const fill = readFileSync(new URL('../tools/month_backfill.sql', import.meta.url), 'utf8');
  const state = () => ({ m: sql.prepare('SELECT player, cworm FROM month_scores WHERE month_start = ? ORDER BY player').all(NOV1).map(r => [r.player, r.cworm]),
    t: sql.prepare('SELECT player, pts FROM team_month WHERE team = 7 AND month_start = ? ORDER BY player').all(NOV1).map(r => [r.player, r.pts]),
    c: sql.prepare('SELECT club, pts FROM club_month WHERE month_start = ? ORDER BY club').all(NOV1).map(r => [r.club, r.pts]) });
  sql.exec(fill);
  const s = state();
  assert.deepEqual(s.m, [[1, 140], [2, 60], [9, 50]]);
  assert.deepEqual(s.t, [[1, 40 + 100 + 100], [9, 10]]);                                         // this week + Sunday's play money + a clash; the bot at 0.2
  assert.deepEqual(s.c, [['ar-boca-juniors', 60], ['uy-ca-penarol', 40 + 100 + 50]]);              // this week + Sunday + a win
  sql.exec(fill); assert.deepEqual(state(), s);                                                  // a second run changes nothing
});
