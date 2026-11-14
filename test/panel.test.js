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
  assert.equal(d.status, 200); assert.equal(d.totals.players, 2); assert.equal(d.joined.today, 0); assert.equal(d.joined.gone, 2); assert.equal(d.days.length, 14);   // nobody stayed yet
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
  assert.equal(d.sources.reduce((n, s) => n + s.n + s.gone, 0), 2);                                          // the bot is in no source row
  assert.equal(d.joined.today, 1); assert.equal(d.joined.gone, 1);                                            // b played; the admin's fresh account left at once
});

test('panel: a new account counts as a player once it started a match or stayed 30 seconds', async () => {
  const env = makeEnv(), a = await admin(env), b = await guest(env), c = await guest(env), e = await guest(env), now = Date.now();
  env.sql.prepare('UPDATE player_meta SET started = 1 WHERE player = ?').run(b.id);
  env.sql.prepare('UPDATE player_meta SET last_seen = ? WHERE player = ?').run(now + 31000, c.id);
  env.sql.prepare('UPDATE player_meta SET last_seen = ? WHERE player = ?').run(now + 5000, e.id);
  const d = await call(env, '/panel/data', undefined, a.token);
  assert.equal(d.joined.today, 2); assert.equal(d.joined.gone, 2); assert.equal(d.days[13].joined, 2);
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

test('panel: the user and password open it without a game account; wrong tries are limited', async () => {
  const env = makeEnv(), b = await guest(env);
  assert.equal((await call(env, '/panel/login', { user: 'Boss', pass: 'x' })).status, 503);                       // not set up: nobody gets in
  env.PANEL_USER = 'Boss'; env.PANEL_PASS = await P.makePass('correct horse battery', 1000);
  assert.doesNotMatch(env.PANEL_PASS, /correct horse/);
  assert.equal((await call(env, '/panel/login', { user: 'Boss', pass: 'wrong' })).status, 401);
  assert.equal((await call(env, '/panel/login', { user: 'Other', pass: 'correct horse battery' })).status, 401);
  const ok = await call(env, '/panel/login', { user: ' boss ', pass: 'correct horse battery' });
  assert.equal(ok.status, 200); assert.match(ok.token, /^panel\.\d+\./);
  const d = await call(env, '/panel/data', undefined, ok.token);
  assert.equal(d.status, 200); assert.equal(d.totals.players, 1);
  assert.ok((await call(env, '/panel/act', { a: 'gift', player: b.id, amount: 100 }, ok.token)).ok);              // actions work with no admin account at all
  assert.equal((await call(env, '/me', undefined, ok.token)).status, 401);                                         // the panel token is no game sign-in
  const [k, exp, sig] = ok.token.split('.');
  assert.equal((await call(env, '/panel/data', undefined, `${k}.${Number(exp) + 999}.${sig}`)).status, 401);       // a changed token
  assert.equal((await call(env, '/panel/data', undefined, await P.panelToken(env, Date.now() - 2 * 864e5))).status, 401);   // an old one
  assert.equal((await call(env, '/panel/data', undefined, b.token)).status, 403);                                  // a player's own sign-in
  for (let i = 0; i < 3; i++) await call(env, '/panel/login', { user: 'Boss', pass: 'guess' + i });
  const shut = await call(env, '/panel/login', { user: 'Boss', pass: 'correct horse battery' });
  assert.equal(shut.status, 429); assert.match(shut.error, /Too many/);                                            // five wrong tries: even the right one waits
});

test('panel: the pulse has 48 hours, platforms, depth, comebacks and Worm Road progress', async () => {
  const env = makeEnv(), a = await admin(env), b = await guest(env), c = await guest(env), now = Date.now(), dn = Math.floor(now / DAY);
  for (const [p, ago, secs] of [[b.id, 5 * 60e3, 200], [b.id, 30 * 60e3, 40], [c.id, 26 * 3600e3, 300]]) env.sql.prepare('INSERT INTO run_log (player, at, secs, credit) VALUES (?, ?, ?, 10)').run(p, now - ago, secs);
  env.sql.prepare('INSERT INTO play_days (player, day) VALUES (?, ?), (?, ?), (?, ?)').run(b.id, dn - 1, b.id, dn, c.id, dn - 1);
  env.sql.prepare('INSERT INTO saves (player, data, at) VALUES (?, ?, ?), (?, ?, ?)').run(b.id, JSON.stringify({ d: { 'cww-road': 40, 'cww-streak': { d: 'x', n: 3 } } }), now, c.id, JSON.stringify({ d: {} }), now);
  const d = await call(env, '/panel/data', undefined, a.token), z = d.pulse;
  assert.equal(z.hours.length, 48);
  assert.equal(z.hours.reduce((s, h) => s + h.matches, 0), 3);
  assert.deepEqual(z.depth.find(x => x.b === '2-4'), { b: '2-4', n: 1 });
  assert.equal(z.match.short, 1);
  assert.deepEqual(z.back, { yesterday: 2, today: 1 });
  assert.equal(P.roadStop(0), 0); assert.equal(P.roadStop(15), 5); assert.equal(P.roadStop(20), 6); assert.equal(P.roadStop(40), 10);
  assert.equal(z.road.find(w => w.name === 'Underground').n, 1); assert.equal(z.road.find(w => w.name === 'Not started').n, 1);
  assert.equal(z.streak.find(s => s.b === '2-3').n, 1);
});
