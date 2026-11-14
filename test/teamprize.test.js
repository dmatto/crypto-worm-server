import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const sent = [];
globalThis.fetch = async (url, init) => { sent.push([String(url).split('/').pop(), JSON.parse(init.body)]); return Response.json({ ok: true, result: {} }) };
const TP = await import('../src/teamprize.js');
const { weekly } = await import('../src/growth.js');
const { webhook } = await import('../src/bot.js');
const { createHash } = await import('node:crypto');

const DAY = 864e5, W = TP.TP_FROM, WD = Math.floor(W / DAY);   // the first Team Prize week, Monday 9 November
function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  return { DB, sql, SESSION_SECRET: 'test-secret', BOT_TOKEN: '123:BOT', GAME_LINK: 'https://t.me/CryptoWormWarsBot/play' };
}
let n = 0;
// a team member: `pts` team points this week, finished matches on `days` days, an account `age` days old at the payout
function member(env, team, { pts = 1000, days = 3, age = 30, wallet = true, sim = false, tg } = {}) {
  const id = env.sql.prepare('INSERT INTO players (name, wallet, tg_id, created) VALUES (?, ?, ?, ?) RETURNING id').get('P' + ++n, wallet ? 'Wa11et' + n : null, tg ?? null, W + 7 * DAY - age * DAY).id;
  env.sql.prepare('INSERT INTO team_members (player, team, joined) VALUES (?, ?, ?)').run(id, team, W - 30 * DAY);
  if (pts) env.sql.prepare('INSERT INTO team_points (team, week_start, player, pts) VALUES (?, ?, ?, ?)').run(team, W, id, pts);
  for (let d = 0; d < days; d++) env.sql.prepare('INSERT INTO play_days (player, day) VALUES (?, ?)').run(id, WD + d);
  if (sim) env.sql.prepare('INSERT INTO sim_players (player, created) VALUES (?, 0)').run(id);
  return id;
}
const team = (env, name, tag, created = 0) => env.sql.prepare("INSERT INTO teams (name, tag, emoji, owner, code, created) VALUES (?, ?, '🐸', 0, ?, ?) RETURNING id").get(name, tag, tag + 'CODE', created).id;

test('team prize: the #1 team by real players\' points, split between active members; bot teams and teams with nobody active pass it on', async () => {
  const env = makeEnv();
  const bots = team(env, 'Bot Squad', 'BOT'), quiet = team(env, 'Quiet Ones', 'QT'), frogs = team(env, 'Frog Army', 'FROG'), late = team(env, 'Late Team', 'LATE');
  for (let i = 0; i < 5; i++) member(env, bots, { pts: 50000, sim: true });       // load-test bots: never count
  member(env, quiet, { pts: 30000, days: 2 }); member(env, quiet, { pts: 1000, wallet: false });   // nobody active: passed over
  const a = member(env, frogs, { pts: 9000 }), b = member(env, frogs, { pts: 5000 }), c = member(env, frogs, { pts: 4000, days: 3 });
  const young = member(env, frogs, { pts: 3000, age: 5 }), nowal = member(env, frogs, { pts: 2000, wallet: false }), idle = member(env, frogs, { pts: 0 });
  member(env, late, { pts: 100 });
  let r = await TP.teamPrize(env, W);
  assert.equal(r.on, true); assert.equal(r.winner.name, 'Frog Army'); assert.equal(r.winner.pts, 23000);
  assert.deepEqual(r.passed.map(t => t.name), ['Quiet Ones']);
  assert.deepEqual(r.active.map(m => m.id), [a, b, c]); assert.equal(r.share, 16.66); assert.equal(r.left, 0.02);
  assert.deepEqual(Object.fromEntries(r.others.map(m => [m.id, m.why])), { [young]: ['account 5 days old at payout, needs 8'], [nowal]: ['no wallet linked'], [idle]: ['no points for the team this week'] });
  // an admin takes a member out: the others share more
  env.sql.prepare('INSERT INTO prize_skip (player, at) VALUES (?, 0)').run(c);
  r = await TP.teamPrize(env, W); assert.equal(r.share, 25); assert.equal(r.left, 0);
  // the admin text: the wallets and the shares, why the others get nothing, the payout lines
  const text = await TP.teamPrizeText(env, W, W + 8 * DAY);
  assert.match(text, /Team Prize 2026-11-09 to 2026-11-15\n50 USDC for the #1 team/); assert.match(text, /Frog Army<\/b> \[FROG\] \(id \d+\) · 23,000 points/);
  assert.match(text, /2 active members: 25 USDC each/); assert.match(text, /Passed over \(no active member\): 🐸 Quiet Ones \[QT\] 31,000 pts/);
  const wa = id => env.sql.prepare('SELECT wallet FROM players WHERE id = ?').get(id).wallet;
  assert.match(text, /taken out by an admin/); assert.ok(text.includes(`${wa(a)},25\n${wa(b)},25</code>`));
  // weeks outside the 4-week test say so; the Monday group post names the winner without amounts or token names
  assert.match(await TP.teamPrizeText(env, W - 7 * DAY, W), /this week has no Team Prize/);
  assert.equal(TP.tpOn(W - 7 * DAY), false); assert.equal(TP.tpOn(W + 21 * DAY), true); assert.equal(TP.tpOn(W + 28 * DAY), false);
  const post = await TP.teamPrizePost(env, W);
  assert.match(post, /Team prize of last week<\/b>: 🐸 <b>Frog Army<\/b> \[FROG\] wins! It goes to its 2 active players/); assert.doesNotMatch(post, /USDC|\$|SOL|CWORM|\d+ USD/);
  assert.equal(await TP.teamPrizePost(env, W - 7 * DAY), '');
  env.sql.prepare("INSERT INTO bot_kv (k, v) VALUES ('group', '-100123')").run(); sent.length = 0;
  await weekly(env, W + 7 * DAY + 10 * 60e3);
  assert.match(sent.find(([m]) => m === 'sendMessage')[1].text, /Team prize of last week/);
  // a member's own status for the game
  const me = await TP.myTeamPrize(env, { id: young }, frogs, W + 2 * DAY);
  assert.deepEqual(me, { on: true, from: W, until: W + 28 * DAY, days: 3, need: 3, wallet: true, pts: true, age: false, minAge: 8, active: false });
  assert.equal((await TP.myTeamPrize(env, { id: a }, frogs, W + 2 * DAY)).active, true);
  assert.equal(await TP.myTeamPrize(env, { id: a }, bots, W + 2 * DAY), null);
});

test('team prize: /prize teams for admins only, and an empty week', async () => {
  const env = makeEnv();
  const secret = createHash('sha256').update('webhook:test-secret').digest('hex').slice(0, 48);
  const say = async (text, from = 7) => { sent.length = 0; await webhook(new Request('https://w/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ message: { chat: { id: from, type: 'private' }, from: { id: from, first_name: 'D' }, text } }) }), env); return sent.filter(([m]) => m === 'sendMessage').map(([, b]) => b.text) };
  const admin = env.sql.prepare("INSERT INTO players (name, tg_id, created) VALUES ('Damian', 7, 0) RETURNING id").get().id; env.ADMIN_PLAYERS = String(admin);
  const realNow = Date.now; Date.now = () => W + 2 * DAY;
  try {
    assert.match((await say('/prize teams'))[0], /Team Prize 2026-11-09 to 2026-11-15 \(still running\)[^]*No team has scored yet/);
    assert.match((await say('/prize teams last'))[0], /Team Prize 2026-11-02 to 2026-11-08\n⚠️ The test runs 4 weeks from 2026-11-09/);
    assert.ok(!(await say('/prize teams', 55)).some(t => /Team Prize 2026/.test(t)));            // a player gets the usual pointer, not the list
  } finally { Date.now = realNow }
});

test('team prize: a member\'s own team page carries what they still need; others don\'t see it', async () => {
  const env = makeEnv(), { default: worker } = await import('../src/index.js');
  env.LOBBY = { idFromName: x => x, get: () => ({ fetch: async () => Response.json({ online: [] }) }) };
  const call = async (path, body, token) => { const r = await worker.fetch(new Request('https://api.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env); return { status: r.status, ...(await r.json()) } };
  const g = await call('/auth/guest', {}), o = await call('/auth/guest', {});
  env.sql.prepare('INSERT INTO player_meta (player, played) VALUES (?, 3) ON CONFLICT(player) DO UPDATE SET played = 3').run(g.player.id);
  const t = await call('/teams/create', { name: 'Frog Army', tag: 'FROG', emoji: '🐸' }, g.token);
  assert.equal(t.status, 200); assert.equal(t.prize.need, 3); assert.equal(t.prize.wallet, false); assert.equal(t.prize.active, false);
  assert.equal((await call('/teams/' + t.team.id, undefined, o.token)).prize, undefined);
});
