import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const sent = [];
globalThis.fetch = async (url, init) => { sent.push([String(url).split('/').pop(), JSON.parse(init.body)]); return Response.json({ ok: true, result: {} }) };
const { default: worker } = await import('../src/index.js');
const { teamClash, teamTopText, CLASH, CLASH_DAY, MAX_MEMBERS, REJOIN_MS } = await import('../src/teams.js');
const { weekly, weekStart } = await import('../src/growth.js');

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const LOBBY = { idFromName: n => n, get: () => ({ fetch: async req => Response.json({ online: String(req.url || req).includes('ids=') ? [Number(new URL(String(req.url || req)).searchParams.get('ids').split(',')[0])] : [] }) }) };
  return { DB, sql, LOBBY, SESSION_SECRET: 'test-secret', BOT_TOKEN: '123:BOT', SIGNIN_DOMAIN: 'example.test' };
}
const call = async (env, path, body, token) => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { status: r.status, ...(await r.json()) };
};
function tgInit(id, name) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: name }) };
  const check = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n'), secret = createHmac('sha256', 'WebAppData').update('123:BOT').digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
}
const played = (env, id, n = 3) => env.sql.prepare('INSERT INTO player_meta (player, played) VALUES (?, ?) ON CONFLICT(player) DO UPDATE SET played = excluded.played').run(id, n);
async function guest(env, n = 3) { const g = await call(env, '/auth/guest', {}); if (n) played(env, g.player.id, n); return g }

test('teams: start one after 3 matches, invite by code, the leader removes members, full teams and the wait after leaving', async () => {
  const env = makeEnv(), a = await guest(env), b = await guest(env), c = await guest(env, 0);
  assert.equal((await call(env, '/teams', undefined, c.token)).can, false);
  assert.equal((await call(env, '/teams/create', { name: 'Worm Gang', tag: 'wg', emoji: '🪱' }, c.token)).status, 403);   // not 3 matches yet
  assert.equal((await call(env, '/teams/create', { name: 'x', tag: 'WG', emoji: '🪱' }, a.token)).status, 400);
  assert.equal((await call(env, '/teams/create', { name: 'Worm Gang', tag: 'W', emoji: '🪱' }, a.token)).status, 400);
  assert.equal((await call(env, '/teams/create', { name: 'Official Worms', tag: 'OW', emoji: '🪱' }, a.token)).status, 400);
  assert.equal((await call(env, '/teams/create', { name: 'Worm Gang', tag: 'WG', emoji: '💩' }, a.token)).status, 400);
  assert.equal((await call(env, '/teams/create', { name: 'Worm Gang', tag: 'WG', emoji: '🪱', tg: 'not a link' }, a.token)).status, 400);
  const t = await call(env, '/teams/create', { name: 'Worm  Gang', tag: 'wg', emoji: '🪱', tg: '@wormgang' }, a.token);
  assert.equal(t.status, 200); assert.equal(t.team.name, 'Worm Gang'); assert.equal(t.team.tag, 'WG'); assert.equal(t.team.tg, 'https://t.me/wormgang');
  assert.match(t.team.link, /startapp=t_[A-Z0-9]{6}$/); assert.equal(t.members[0].role, 'lead'); assert.equal(t.members[0].online, true);
  assert.equal((await call(env, '/teams/create', { name: 'Other', tag: 'OT', emoji: '🐸' }, a.token)).status, 400);   // already in a team
  assert.equal((await call(env, '/teams/create', { name: 'worm gang', tag: 'ZZ', emoji: '🐸' }, b.token)).status, 409);   // name taken (any case)
  assert.equal((await call(env, '/me', undefined, a.token)).player.team.tag, 'WG');
  assert.equal((await call(env, '/me', undefined, a.token)).player.team.lead, true);

  assert.equal((await call(env, '/teams/code/' + t.team.code.toLowerCase(), undefined, b.token)).team.id, t.team.id);   // an invite link
  assert.equal((await call(env, '/teams/code/ZZZZZZ', undefined, b.token)).status, 404);
  const seen = await call(env, '/teams/' + t.team.id, undefined, b.token);           // not a member: no invite code
  assert.equal(seen.team.code, undefined); assert.equal(seen.mine, false); assert.equal(seen.members[0].online, undefined);
  const j = await call(env, '/teams/join', { code: t.team.code.toLowerCase() }, b.token);
  assert.equal(j.status, 200); assert.equal(j.team.members, 2); assert.equal(j.mine, true);
  assert.equal((await call(env, '/teams/join', { id: t.team.id }, b.token)).status, 400);   // already in it
  assert.equal((await call(env, '/teams/kick', { id: a.player.id }, b.token)).status, 403);   // only the leader
  assert.equal((await call(env, '/teams/edit', { emoji: '🐸', tg: '' }, b.token)).status, 403);
  const e = await call(env, '/teams/edit', { emoji: '🐸', tg: '' }, a.token); assert.equal(e.team.emoji, '🐸'); assert.equal(e.team.tg, '');
  const k = await call(env, '/teams/kick', { id: b.player.id }, a.token); assert.equal(k.team.members, 1);
  assert.equal((await call(env, '/teams/join', { id: t.team.id }, b.token)).status, 429);   // a short wait after leaving
  env.sql.prepare('UPDATE team_leave SET left_at = ?').run(Date.now() - REJOIN_MS - 1);
  assert.equal((await call(env, '/teams/join', { id: t.team.id }, b.token)).status, 200);

  for (let i = 2; i < MAX_MEMBERS; i++) env.sql.prepare("INSERT INTO team_members (player, team, role, joined) VALUES (?, ?, 'member', ?)").run(1000 + i, t.team.id, Date.now());
  assert.equal((await call(env, '/teams/join', { id: t.team.id }, c.token)).status, 409);   // 50 worms: full
  assert.equal((await call(env, '/teams/join', { id: 99 }, c.token)).status, 404);
});

test('teams: the leader leaving passes the team on, the last one out closes it, and a GET never changes anything', async () => {
  const env = makeEnv(), a = await guest(env), b = await guest(env);
  const t = await call(env, '/teams/create', { name: 'Moon Squad', tag: 'MOON', emoji: '🌙' }, a.token);
  await call(env, '/teams/join', { id: t.team.id }, b.token);
  assert.equal((await call(env, '/teams/leave', undefined, a.token)).team, undefined);   // GET /teams/leave: not a route
  assert.equal((await call(env, '/me', undefined, a.token)).player.team.tag, 'MOON');
  assert.equal((await call(env, '/teams/leave', {}, a.token)).ok, true);
  const now = await call(env, '/teams/' + t.team.id, undefined, b.token);
  assert.equal(now.team.owner, b.player.id); assert.equal(now.members[0].role, 'lead'); assert.equal((await call(env, '/me', undefined, b.token)).player.team.lead, true);
  await call(env, '/teams/leave', {}, b.token);
  assert.equal((await call(env, '/teams/' + t.team.id, undefined, b.token)).status, 404);
  assert.equal((await call(env, '/me', undefined, b.token)).player.team, null);
  assert.equal((await call(env, '/teams/create', { name: 'Moon Squad', tag: 'MOON', emoji: '🌙' }, b.token)).status, 429);   // the wait after leaving
});

test('teams: members\' play money scores for the team, rival wins add clash points (capped), and the weekly table', async () => {
  const env = makeEnv(), a = await guest(env), b = await guest(env), c = await guest(env), d = await guest(env);
  const t1 = await call(env, '/teams/create', { name: 'Bulls', tag: 'BULL', emoji: '🦁' }, a.token);
  const t2 = await call(env, '/teams/create', { name: 'Bears', tag: 'BEAR', emoji: '🐻' }, c.token);
  await call(env, '/teams/join', { id: t1.team.id }, b.token);
  assert.equal((await call(env, '/score', { amount: 250 }, a.token)).added, 250);
  assert.equal((await call(env, '/score', { amount: 900 }, b.token)).added, 600);   // the ranking's cap counts for the team too
  await call(env, '/score', { amount: 100 }, c.token);
  await call(env, '/score', { amount: 400 }, d.token);                                 // no team: nothing
  let list = await call(env, '/teams', undefined, d.token);
  assert.deepEqual(list.top.map(r => [r.tag, r.pts, r.members]), [['BULL', 850, 2], ['BEAR', 100, 1]]);
  assert.equal(list.mine, null); assert.equal(list.can, true);
  assert.equal((await call(env, '/teams', undefined, b.token)).mine.rank, 1);
  const rk = (await call(env, '/ranking?period=week', undefined, a.token)).top;
  assert.equal(rk.find(r => r.id === b.player.id).team, 'BULL'); assert.equal(rk.find(r => r.id === d.player.id).team, undefined);

  assert.equal(await teamClash(env, c.player.id, a.player.id), CLASH);              // Bears beat a Bull online
  assert.equal(await teamClash(env, c.player.id, a.player.id), 0);                  // the same rival again today: no more
  assert.equal(await teamClash(env, a.player.id, b.player.id), 0);                  // teammates
  assert.equal(await teamClash(env, a.player.id, d.player.id), 0);                  // no team
  assert.equal(await teamClash(env, c.player.id, b.player.id), CLASH);
  for (let i = 0; i < CLASH_DAY; i++) env.sql.prepare("INSERT INTO team_members (player, team, role, joined) VALUES (?, ?, 'member', 0)").run(2000 + i, t1.team.id);
  let got = 0; for (let i = 0; i < CLASH_DAY; i++) got += await teamClash(env, c.player.id, 2000 + i);
  assert.equal(got, CLASH * (CLASH_DAY - 2));                                       // at most CLASH_DAY clashes a day
  list = await call(env, '/teams', undefined, d.token);
  assert.equal(list.top.find(r => r.tag === 'BEAR').pts, 100 + CLASH * CLASH_DAY);
  const page = await call(env, '/teams/' + t2.team.id, undefined, c.token);
  assert.equal(page.members[0].pts, 100 + CLASH * CLASH_DAY); assert.equal(page.team.ptsAll, 100 + CLASH * CLASH_DAY);

  const last = weekStart() - 7 * 864e5;                                             // last week, for the Monday post
  env.sql.prepare('INSERT INTO team_points (team, week_start, player, pts) VALUES (?, ?, ?, 300), (?, ?, ?, 900)').run(t1.team.id, last, a.player.id, t2.team.id, last, c.player.id);
  const text = await teamTopText(env, last);
  assert.match(text, /🥇 🐻 <b>Bears<\/b> \[BEAR\]: 900 points\n🥈 🦁 <b>Bulls<\/b> \[BULL\]: 300 points/);
  env.sql.prepare("INSERT INTO bot_kv (k, v) VALUES ('group', '-100')").run();
  sent.length = 0; await weekly(env, weekStart() + 10 * 60e3);
  assert.match(sent[0][1].text, /Top teams of last week/);
});

test('teams: a guest folded into a Telegram account brings its team and its points along', async () => {
  const env = makeEnv(), first = await call(env, '/auth/telegram', { initData: tgInit(77, 'Dee') }), g = await guest(env);
  const t = await call(env, '/teams/create', { name: 'Diamond Hands', tag: 'DIAM', emoji: '💎' }, g.token);
  await call(env, '/score', { amount: 200 }, g.token);
  const tgUser = await call(env, '/auth/telegram', { initData: tgInit(77, 'Dee') }, g.token);   // the guest's phone signs in to that Telegram account
  assert.equal(tgUser.player.id, first.player.id);
  const me = await call(env, '/me', undefined, tgUser.token);
  assert.equal(me.player.team.tag, 'DIAM'); assert.equal(me.player.team.lead, true);
  const page = await call(env, '/teams/' + t.team.id, undefined, tgUser.token);
  assert.equal(page.members.length, 1); assert.equal(page.members[0].id, me.player.id); assert.equal(page.team.pts, 200);
});

test('teams: the bot shows a player\'s team with its invite link, the week\'s top teams, and lets admins remove one', async () => {
  const env = makeEnv(), tgUser = await call(env, '/auth/telegram', { initData: tgInit(42, 'Tea') }), admin = await call(env, '/auth/telegram', { initData: tgInit(555, 'Boss') });
  env.ADMIN_PLAYERS = String(admin.player.id);
  played(env, tgUser.player.id);
  const t = await call(env, '/teams/create', { name: 'Pump Crew', tag: 'PUMP', emoji: '🚀' }, tgUser.token);
  await call(env, '/score', { amount: 120 }, tgUser.token);
  const hook = async (from, text, chat = { id: from, type: 'private' }) => {
    sent.length = 0;
    const r = await worker.fetch(new Request('https://api.test/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': await hookSecret(env) }, body: JSON.stringify({ message: { chat, from: { id: from }, text } }) }), env);
    assert.equal(r.status, 200); return sent.filter(s => s[0] === 'sendMessage').map(s => s[1]);
  };
  let out = await hook(42, '/team');
  assert.match(out[0].text, /🚀 Pump Crew \[PUMP\]\nThis week: #1 with 120 points · 1 worms/); assert.match(out[0].text, new RegExp('startapp=t_' + t.team.code));
  out = await hook(43, '/team'); assert.match(out[0].text, /join a team or start your own/);
  out = await hook(43, '/teams'); assert.match(out[0].text, /🥇 🚀 Pump Crew \[PUMP\]: 120 points/);
  out = await hook(43, '/teams', { id: -100, type: 'supergroup' }); assert.match(out[0].text, /Pump Crew/);
  out = await hook(555, '/teams'); assert.match(out[0].text, new RegExp('id ' + t.team.id));
  out = await hook(555, '/teams off ' + t.team.id); assert.match(out[0].text, /Removed the team Pump Crew/);
  assert.equal((await call(env, '/me', undefined, tgUser.token)).player.team, null);
});

async function hookSecret(env) {
  const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('webhook:' + env.SESSION_SECRET)))].map(x => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 48);
}
