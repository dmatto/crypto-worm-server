import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Stand-ins: node:sqlite for D1, a lobby that reports who is online, and Telegram's Bot API recorded in `calls`.
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { constructor(b, i = {}) { super(b, i.status === 101 ? { status: 200 } : i); this.ws = i.webSocket } static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const calls = [];
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop(), body = JSON.parse(init.body);
  calls.push([method, body]);
  if (method === 'savePreparedInlineMessage') return Response.json({ ok: true, result: { id: 'PREP1', expiration_date: 0 } });
  if (method === 'sendMessage' && body.chat_id === 666) return Response.json({ ok: false, error_code: 403 });
  return Response.json({ ok: true, result: {} });
};
const { default: worker } = await import('../src/index.js');
const { webhook, cron } = await import('../src/bot.js');
const { weekStart } = await import('../src/growth.js');

function makeEnv(online = []) {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const LOBBY = { idFromName: n => n, get: () => ({ fetch: async u => Response.json(String(u).endsWith('/ids') ? { ids: online } : { online: [] }) }) };
  return { DB, sql, LOBBY, SESSION_SECRET: 'test-secret', BOT_TOKEN: '123:BOT', GAME_LINK: 'https://t.me/CryptoWormWarsBot/play', SITE_URL: 'https://play.test', ADMIN_PLAYERS: '1' };
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
const secret = createHash('sha256').update('webhook:test-secret').digest('hex').slice(0, 48);
const hook = (env, update) => webhook(new Request('https://w/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update) }), env);
const msg = (text, from, chat = { id: from, type: 'private' }) => ({ message: { chat, from: { id: from, first_name: 'Dami' }, text } });

test('growth: a source tag sticks to a new account; a friend link pays both players once the new one finishes a match', async () => {
  const env = makeEnv(); calls.length = 0;
  const host = await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami'), src: 'telegram' });
  const kid = await call(env, '/auth/guest', { src: 'Promo_Oct' });
  assert.equal(env.sql.prepare('SELECT source FROM player_meta WHERE player = ?').get(kid.player.id).source, 'promo_oct');
  const add = await call(env, '/friends/add', { code: host.friendCode }, kid.token);
  assert.equal(add.invited, true);
  assert.equal(env.sql.prepare('SELECT source FROM player_meta WHERE player = ?').get(kid.player.id).source, 'promo_oct');   // first touch wins
  const first = await call(env, '/played', { mode: 'cpu' }, kid.token);
  assert.equal(first.played, 1); assert.deepEqual(first.rewards.map(r => [r.amount, r.reason]), [[200, 'invited']]);
  assert.ok(calls.some(([m, b]) => m === 'sendMessage' && b.chat_id === 42 && /\+200 \$CWORM/.test(b.text) && /Play money/.test(b.text)));
  assert.equal((await call(env, '/played', { mode: 'cpu' }, kid.token)).played, 1);        // 20 s gap between counted matches
  const got = await call(env, '/rewards', {}, host.token);
  assert.deepEqual(got.rewards.map(r => [r.amount, r.reason, r.note]), [[200, 'invite', kid.player.name]]);
  assert.deepEqual((await call(env, '/rewards', {}, host.token)).rewards, []);           // claimed once
  // an old account (or one that already played) can't be counted as an invite
  env.sql.prepare('UPDATE player_meta SET last_played = 0').run();
  const again = await call(env, '/friends/add', { code: host.friendCode }, kid.token); assert.equal(again.invited, false);
  // the ranking doesn't move: invite rewards aren't $CWORM gained
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM cworm_scores').get().n, 0);
});

test('growth: at most 10 rewarded invites per inviter a day', async () => {
  const env = makeEnv();
  const host = await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami') });
  for (let i = 0; i < 11; i++) { const k = await call(env, '/auth/guest', {}); await call(env, '/friends/add', { code: host.friendCode }, k.token); await call(env, '/played', { mode: 'cpu' }, k.token) }
  assert.equal(env.sql.prepare("SELECT COUNT(*) AS n FROM rewards WHERE reason = 'invite'").get().n, 10);
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM player_meta WHERE invite_paid = 0').get().n, 1);
});

test('growth: challenge cards, inline mode and group duels carry Play links', async () => {
  const env = makeEnv(); calls.length = 0;
  const me = await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami') });
  const guest = await call(env, '/auth/guest', {});
  assert.equal((await call(env, '/share/prepare', { kind: 'win' }, guest.token)).status, 400);        // needs Telegram
  const r = await call(env, '/share/prepare', { kind: 'win', hp: 140 }, me.token);
  assert.equal(r.id, 'PREP1');
  const [, p] = calls.find(c => c[0] === 'savePreparedInlineMessage');
  assert.equal(p.user_id, 42); assert.equal(p.result.photo_url, 'https://play.test/cards/win.jpg'); assert.match(p.result.caption, /140 HP left/);
  assert.equal(p.result.reply_markup.inline_keyboard[0][0].url, 'https://t.me/CryptoWormWarsBot/play?startapp=f_' + me.friendCode);
  calls.length = 0; await hook(env, { inline_query: { id: 'Q', from: { id: 42 }, query: '' } });
  const [m, a] = calls[0]; assert.equal(m, 'answerInlineQuery'); assert.equal(a.results[0].type, 'photo');
  assert.match(a.results[0].reply_markup.inline_keyboard[0][0].url, /startapp=f_/);
  calls.length = 0; await hook(env, msg('/duel@CryptoWormWarsBot', 42, { id: -100, type: 'supergroup' }));
  assert.equal(calls[0][0], 'sendPhoto'); assert.equal(calls[0][1].chat_id, -100); assert.match(calls[0][1].reply_markup.inline_keyboard[0][0].url, /startapp=m_[A-Z2-9]{6}$/);
  calls.length = 0; await hook(env, msg('/duel@OtherBot', 42, { id: -100, type: 'supergroup' })); assert.equal(calls.length, 0);
  calls.length = 0; await hook(env, msg('/start s_ads1', 77));
  assert.equal(calls[0][1].reply_markup.inline_keyboard[0][0].url, 'https://t.me/CryptoWormWarsBot/play?startapp=s_ads1');
});

test('growth: the Monday top 10 goes to the group once, /sources is for admins, /stop and reminders', async () => {
  const env = makeEnv(); calls.length = 0;
  const admin = await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami') });          // player 1 = admin
  const a = await call(env, '/auth/telegram', { initData: tgInit(55, 'Ana') });
  await call(env, '/played', { mode: 'cpu' }, a.token);
  const lastWeek = weekStart() - 7 * 864e5;
  env.sql.prepare('INSERT INTO cworm_scores (player, total, week_start, week) VALUES (?, 500, ?, 500), (?, 90, ?, 90)').run(a.player.id, lastWeek, admin.player.id, lastWeek);
  env.sql.prepare("UPDATE player_meta SET cc = 'BR' WHERE player = ?").run(a.player.id);
  await hook(env, msg('/setgroup', 55, { id: -100, type: 'supergroup' })); assert.equal(calls.length, 0);   // not an admin
  await hook(env, msg('/setgroup', 42, { id: -100, type: 'supergroup' }));
  calls.length = 0; const monday = weekStart() + 10 * 60e3;
  await cron(env, monday); await cron(env, monday + 15 * 60e3);
  const posts = calls.filter(c => c[0] === 'sendMessage' && c[1].chat_id === -100);
  assert.equal(posts.length, 1); assert.match(posts[0][1].text, /🥇 🇧🇷 Ana: 500 \$CWORM\n🥈 Dami: 90/); assert.match(posts[0][1].text, /not real tokens/);
  calls.length = 0; await hook(env, msg('/sources', 55)); assert.equal(calls.length, 0);
  await hook(env, msg('/sources', 42)); assert.match(calls[0][1].text, /untagged/);
  // friend-online reminder: Ana is a friend of Dami, Dami is online, Ana was last here 3 hours ago
  env.sql.prepare('INSERT INTO friends (player, friend, created) VALUES (?, ?, 0)').run(a.player.id, admin.player.id);
  env.sql.prepare('UPDATE player_meta SET last_seen = ? WHERE player = ?').run(Date.now() - 3 * 3600e3, a.player.id);
  const env2 = { ...env, LOBBY: makeEnv([admin.player.id]).LOBBY };
  calls.length = 0; await cron(env2, Date.now()); await cron(env2, Date.now());
  const pings = calls.filter(c => c[0] === 'sendMessage' && c[1].chat_id === 55);
  assert.equal(pings.length, 1); assert.match(pings[0][1].text, /Dami is online/); assert.match(pings[0][1].text, /\/stop/);
  await hook(env, msg('/stop', 55));
  assert.equal(env.sql.prepare('SELECT remind FROM player_meta WHERE player = ?').get(a.player.id).remind, 0);
  assert.equal((await call(env, '/me', undefined, a.token)).player.remind, false);
  assert.equal((await call(env, '/me/remind', { on: true }, a.token)).remind, true);
});

test('growth: a week that rolls over is kept for the top 10', async () => {
  const env = makeEnv();
  const a = await call(env, '/auth/telegram', { initData: tgInit(55, 'Ana') });
  const lastWeek = weekStart() - 7 * 864e5;
  env.sql.prepare('INSERT INTO cworm_scores (player, total, week_start, week, day_start, day, last) VALUES (?, 300, ?, 300, 0, 0, 0)').run(a.player.id, lastWeek);
  await call(env, '/score', { amount: 50 }, a.token);
  assert.equal(env.sql.prepare('SELECT cworm FROM week_scores WHERE week_start = ?').get(lastWeek).cworm, 300);
});

test('growth: an announcement goes to the group once and to every Telegram player in batches, skipping /stop', async () => {
  const env = makeEnv(); calls.length = 0;
  const a = await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami') });
  await call(env, '/auth/telegram', { initData: tgInit(55, 'Ana') });
  await call(env, '/auth/telegram', { initData: tgInit(666, 'Blocked') });
  await call(env, '/auth/guest', {});
  await hook(env, msg('/stop', 55));
  await hook(env, msg('/setgroup', 42, { id: -100, type: 'supergroup' }));
  calls.length = 0; await hook(env, msg('/announce 🆕 Update: easier jumps', 55)); assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM announcements').get().n, 0);   // admins only
  await hook(env, msg('/announce 🆕 Update: easier jumps', 42));
  calls.length = 0; await cron(env, Date.now()); await cron(env, Date.now());
  const to = calls.filter(c => c[0] === 'sendMessage' && /easier jumps/.test(c[1].text)).map(c => c[1].chat_id);
  assert.deepEqual(to, [-100, 42, 666]);
  assert.equal(env.sql.prepare('SELECT no_dm FROM player_meta p JOIN players x ON x.id = p.player WHERE x.tg_id = 666').get().no_dm, 1);
  const row = env.sql.prepare('SELECT * FROM announcements').get(); assert.equal(row.done, 1); assert.equal(row.sent, 1);
  assert.ok(a);
});
