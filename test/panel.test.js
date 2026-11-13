import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac } from 'node:crypto';

const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const { default: worker } = await import('../src/index.js');
const P = await import('../src/panel.js');

// A fake Grok (every photo passes, every drawing is a tiny JPEG) and a fake Telegram that keeps what the bot sends.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]).toString('base64'), sent = [];
globalThis.fetch = async (url, init) => {
  const u = String(url), body = init && init.body ? JSON.parse(init.body) : {};
  if (u.endsWith('/chat/completions')) return RealResponse.json({ choices: [{ message: { content: JSON.stringify({ subject: 'pet', adult: null, famous: false, unsafe: false }) } }] });
  if (u.endsWith('/images/edits')) return RealResponse.json({ data: [{ b64_json: JPEG }] });
  if (u.includes('api.telegram.org')) { sent.push({ method: u.split('/').pop(), ...body }); return RealResponse.json({ ok: true, result: {} }) }
  return RealResponse.json({}, { status: 404 });
};

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const LOBBY = { idFromName: n => n, get: () => ({ fetch: async () => Response.json({ online: [] }) }) };
  return { DB, sql, LOBBY, SESSION_SECRET: 'test-secret', SIGNIN_DOMAIN: 'example.test', XAI_API_KEY: 'x', BOT_TOKEN: 'bot', PUBLIC_URL: 'https://api.test' };
}
const call = async (env, path, body, token) => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { status: r.status, ...(await r.json()) };
};
const guest = async (env, src) => { const s = await call(env, '/auth/guest', src ? { src } : {}); return { token: s.token, id: s.player.id } };

const admin = async env => { const a = await guest(env); env.ADMIN_PLAYERS = String(a.id); env.sql.prepare('UPDATE players SET tg_id = 777 WHERE id = ?').run(a.id); return a };
const DAY = 864e5;

test('panel: only the accounts in ADMIN_PLAYERS get an answer', async () => {
  const env = makeEnv(), a = await admin(env), b = await guest(env);
  assert.equal((await call(env, '/panel/data')).status, 401);
  assert.equal((await call(env, '/panel/data', undefined, b.token)).status, 403);
  assert.equal((await call(env, '/panel/act', { a: 'gift', player: b.id, amount: 100 }, b.token)).status, 403);
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM rewards').get().n, 0);
  const d = await call(env, '/panel/data', undefined, a.token);
  assert.equal(d.status, 200); assert.equal(d.totals.players, 2); assert.equal(d.joined.today, 2); assert.equal(d.days.length, 14);
});

test('panel: the numbers count real players, never the load-test bots', async () => {
  const env = makeEnv(), a = await admin(env), b = await guest(env, 's_x'), bot = await guest(env), now = Date.now();
  env.sql.prepare('INSERT INTO sim_players (player, created) VALUES (?, 0)').run(bot.id);
  env.sql.prepare('UPDATE player_meta SET last_seen = ?, played = 4 WHERE player IN (?, ?)').run(now - 1000, b.id, bot.id);
  env.sql.prepare('INSERT INTO play_days (player, day) VALUES (?, ?), (?, ?)').run(b.id, Math.floor(now / DAY), bot.id, Math.floor(now / DAY));
  env.sql.prepare('INSERT INTO run_log (player, at, secs, credit) VALUES (?, ?, 60, 10), (?, ?, 60, 10)').run(b.id, now - 5000, bot.id, now - 5000);
  const d = await call(env, '/panel/data', undefined, a.token);
  assert.equal(d.totals.players, 2); assert.equal(d.active.m5, d.here.length); assert.equal(d.matches.today, 1); assert.equal(d.days[13].active, 1);
  assert.ok(d.here.some(r => r.id === b.id)); assert.ok(!d.here.some(r => r.id === bot.id)); assert.ok(!d.joins.some(r => r.id === bot.id));
  assert.equal(d.sources.reduce((n, s) => n + s.n, 0), 2);                                                   // the bot is in no source row
});

test('panel: a gift to a player waits in their game; limits and unknown players are refused', async () => {
  const env = makeEnv(), a = await admin(env), b = await guest(env);
  assert.match((await call(env, '/panel/act', { a: 'gift', player: 99999, amount: 100 }, a.token)).error, /No player/);
  assert.match((await call(env, '/panel/act', { a: 'gift', player: b.id, amount: P.GIFT_MAX + 1 }, a.token)).error, /between 1 and/);
  assert.match((await call(env, '/panel/act', { a: 'gift', player: b.id, amount: -5 }, a.token)).error, /between 1 and/);
  const r = await call(env, '/panel/act', { a: 'gift', player: b.id, amount: 750, note: 'thanks <b>' }, a.token);
  assert.ok(r.ok);
  const got = await call(env, '/rewards', {}, b.token);
  assert.deepEqual(got.rewards.map(x => [x.amount, x.reason, x.note]), [[750, 'present', 'thanks b']]);
  assert.match(env.sql.prepare('SELECT note FROM bot_log ORDER BY at DESC, rowid DESC LIMIT 1').get().note, /panel \d+: gift 750 BP/);
});

test('panel: a gift code is made with the same words as /gift and shows on the panel', async () => {
  const env = makeEnv(), a = await admin(env);
  assert.match((await call(env, '/panel/act', { a: 'code', spec: 'banana' }, a.token)).error, /don't know/);
  const r = await call(env, '/panel/act', { a: 'code', spec: '1000 x5 7d PANELTEST' }, a.token);
  assert.equal(r.codes[0].code, 'PANELTEST'); assert.match(r.codes[0].web, /gift=PANELTEST/);
  const d = await call(env, '/panel/data', undefined, a.token);
  assert.deepEqual(d.gifts.map(g => [g.code, g.uses, g.max]), [['PANELTEST', 0, 5]]);
});

test('panel: the reward reminder reaches players with BP waiting who are away, once', async () => {
  const env = makeEnv(), a = await admin(env), b = await guest(env), c = await guest(env), e = await guest(env), now = Date.now();
  env.sql.prepare('UPDATE players SET tg_id = id + 5000 WHERE id IN (?, ?, ?)').run(b.id, c.id, e.id);
  env.sql.prepare('UPDATE player_meta SET last_seen = ? WHERE player IN (?, ?)').run(now - DAY, b.id, e.id);     // c is in the game now
  env.sql.prepare('UPDATE player_meta SET remind = 0 WHERE player = ?').run(e.id);                                   // e sent /stop
  for (const p of [b, c, e]) env.sql.prepare("INSERT INTO rewards (player, amount, reason, note, created) VALUES (?, 500, 'present', '', ?)").run(p.id, now - 2 * 3600e3);
  sent.length = 0;
  const r = await call(env, '/panel/act', { a: 'remind' }, a.token);
  assert.equal(r.sent, 1); assert.equal(sent.length, 1); assert.equal(sent[0].chat_id, b.id + 5000); assert.match(sent[0].text, /500 BP are waiting[\s\S]*play money/);
  assert.equal((await call(env, '/panel/act', { a: 'remind' }, a.token)).tried, 0);
});

test('panel: payouts due are listed with their bot commands; Monday noon the admins get one reminder', async () => {
  const env = makeEnv(), a = await admin(env), mon = Date.UTC(2026, 10, 23, 12, 3);
  const due = await P.todo(env, mon);
  assert.deepEqual(due.map(t => [t.name, t.week, t.pay, t.state]), [['Weekly prize', '2026-11-16', '/pay prize', null], ['New players prize', '2026-11-16', '/pay rookies', null],
    ['Weekly draw', '2026-11-16', '/pay draw', null], ['Team Prize', '2026-11-16', '/pay new Team Prize', null]]);
  env.sql.prepare("INSERT INTO pay_batch (label, created, code, status) VALUES ('Weekly prize, week of 2026-11-16', ?, 'X', 'done')").run(mon);
  assert.equal((await P.todo(env, mon + 1)).find(t => t.name === 'Weekly prize').state, 'done');
  sent.length = 0;
  assert.equal(await P.payReminder(env, [777], mon + 2), 1); assert.match(sent[0].text, /Payouts due[\s\S]*New players prize: \/prize new last, then \/pay rookies/); assert.doesNotMatch(sent[0].text, /Weekly prize:/);
  assert.equal(await P.payReminder(env, [777], mon + 60e3), 0);                                                  // once a week
  assert.equal(await P.payReminder(env, [777], Date.UTC(2026, 10, 24, 12, 3)), 0);                               // Mondays only
});

test('panel: an update note is queued like /announce', async () => {
  const env = makeEnv(), a = await admin(env);
  assert.match((await call(env, '/panel/act', { a: 'note', text: 'hi' }, a.token)).error, /Write the note/);
  assert.ok((await call(env, '/panel/act', { a: 'note', text: 'New worm jokes are in the game today.' }, a.token)).ok);
  assert.equal(env.sql.prepare('SELECT text FROM announcements').get().text, 'New worm jokes are in the game today.');
});
