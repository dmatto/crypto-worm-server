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
const { weekStart, announce, PROMO } = await import('../src/growth.js');
const PROMO_UNTIL = PROMO.until; PROMO.until = 0;   // the invite week is off for the tests that don't test it

function makeEnv(online = []) {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const env = { DB, sql, SESSION_SECRET: 'test-secret', BOT_TOKEN: '123:BOT', GAME_LINK: 'https://t.me/CryptoWormWarsBot/play', SITE_URL: 'https://play.test', ADMIN_PLAYERS: '1' };
  env.LOBBY = { idFromName: n => n, get: () => ({ fetch: async u => {
    if (String(u).endsWith('/announce')) { while (await announce(env, env.now || Date.now())); return Response.json({ ok: true }) }   // the lobby's alarm loop, run straight through
    return Response.json(String(u).endsWith('/ids') ? { ids: online } : { online: [] }) } }) };
  return env;
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

test('growth: invite week: the inviter gets +1,500 per friend, the friend +200; the Invite page and /invite say so; off after it ends', async () => {
  const env = makeEnv(); calls.length = 0; PROMO.until = PROMO_UNTIL;
  try {
    assert.ok(PROMO.until === Date.UTC(2026, 9, 26) && PROMO.amount === 1500);
    PROMO.until = Date.now() + 864e5;
    const host = await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami') });
    const kid = await call(env, '/auth/guest', {}); await call(env, '/friends/add', { code: host.friendCode }, kid.token);
    assert.deepEqual((await call(env, '/played', { mode: 'cpu' }, kid.token)).rewards.map(r => [r.amount, r.reason]), [[200, 'invited']]);
    const dm = calls.find(([m, b]) => m === 'sendMessage' && b.chat_id === 42)[1];
    assert.match(dm.text, /Invite week: \+1,500 \$CWORM for you, and \+200 for /); assert.match(dm.text, /Play money/);
    const page = await call(env, '/invites', undefined, host.token);
    assert.deepEqual(page.rewards.map(r => [r.amount, r.reason]), [[1500, 'invite']]);
    assert.equal(page.inviterReward, 1500); assert.equal(page.promoUntil, PROMO.until); assert.equal(page.earned, 1500); assert.equal(page.friends[0].paid, 1500);
    calls.length = 0; await hook(env, msg('/invite', 42));
    assert.match(calls[0][1].text, /\+1,500 \$CWORM for you \(invite week, until Sunday 25 October\)\n• \+200 \$CWORM for your friend/);
    calls.length = 0; await hook(env, msg('/start', 42));
    assert.equal(calls[0][1].reply_markup.inline_keyboard[1][0].text, '👥 Invite friends: +1,500 play $CWORM per friend');   // the welcome's invite button
    // after the week: +200 again, and friends paid during it still show +1,500
    PROMO.until = Date.now() - 1;
    const kid2 = await call(env, '/auth/guest', {}); await call(env, '/friends/add', { code: host.friendCode }, kid2.token); await call(env, '/played', { mode: 'cpu' }, kid2.token);
    const after = await call(env, '/invites', undefined, host.token);
    assert.equal(after.inviterReward, 200); assert.equal(after.promoUntil, 0); assert.deepEqual(after.rewards.map(r => r.amount), [200]);
    assert.deepEqual(after.friends.map(f => f.paid).sort((a, b) => a - b), [200, 1500]);
  } finally { PROMO.until = 0 }
});

test('growth: at most 10 rewarded invites per inviter a day', async () => {
  const env = makeEnv();
  const host = await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami') });
  for (let i = 0; i < 11; i++) { const k = await call(env, '/auth/guest', {}); await call(env, '/friends/add', { code: host.friendCode }, k.token); await call(env, '/played', { mode: 'cpu' }, k.token) }
  assert.equal(env.sql.prepare("SELECT COUNT(*) AS n FROM rewards WHERE reason = 'invite'").get().n, 10);
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM player_meta WHERE invite_paid = 0').get().n, 1);
});

test('growth: invite & earn: +300 when a friend plays 5 matches, friend-count bonuses once, the Invite page, the daily share bonus, /invite', async () => {
  const env = makeEnv(); calls.length = 0;
  const host = await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami') });
  const kids = [];
  for (let i = 0; i < 3; i++) { const k = await call(env, '/auth/guest', {}); await call(env, '/friends/add', { code: host.friendCode }, k.token); await call(env, '/played', { mode: 'cpu' }, k.token); kids.push(k) }
  const late = await call(env, '/auth/guest', {}); await call(env, '/friends/add', { code: host.friendCode }, late.token);   // joined, no match yet
  const rew = () => env.sql.prepare('SELECT amount, reason, note FROM rewards WHERE player = ? ORDER BY id').all(host.player.id).map(r => [r.amount, r.reason, r.note]);
  assert.deepEqual(rew().map(r => r[1]), ['invite', 'invite', 'invite', 'milestone']);
  assert.deepEqual(rew()[3], [500, 'milestone', '3']);
  const dm3 = calls.filter(([m, b]) => m === 'sendMessage' && b.chat_id === 42).pop()[1];
  assert.match(dm3.text, /3 friends! Bonus \+500 \$CWORM and the invite-only Coral crew skin/); assert.match(dm3.text, /Next bonus: \+1,000 \$CWORM at 5 friends \(2 to go\)/); assert.match(dm3.text, /Play money/);
  assert.equal(dm3.reply_markup.inline_keyboard[0][1].url, 'https://t.me/CryptoWormWarsBot/play?startapp=invite');
  // the first friend keeps playing: +300 at the 5th counted match, once
  const k0 = kids[0], play = () => { env.sql.prepare('UPDATE player_meta SET last_played = 0 WHERE player = ?').run(k0.player.id); return call(env, '/played', { mode: 'cpu' }, k0.token) };
  for (let i = 0; i < 6; i++) await play();
  assert.deepEqual(rew().filter(r => r[1] === 'loyal'), [[300, 'loyal', k0.player.name]]);
  assert.ok(calls.some(([m, b]) => m === 'sendMessage' && b.chat_id === 42 && /has played 5 matches/.test(b.text)));
  // the Invite page: counts, friends, earnings, and it hands back what's waiting
  const page = await call(env, '/invites', undefined, host.token);
  assert.equal(page.joined, 4); assert.equal(page.counted, 3); assert.equal(page.loyal, 1); assert.equal(page.earned, 3 * 200 + 500 + 300);
  assert.deepEqual(page.next, { n: 5, amount: 1000 }); assert.deepEqual(page.milestones.map(x => x.got), [true, false, false, false, false]);
  assert.deepEqual(page.friends.map(f => f.state).sort(), ['loyal', 'played', 'played', 'waiting']);
  assert.equal(page.rewards.reduce((s, r) => s + r.amount, 0), 3 * 200 + 500 + 300); assert.equal(page.shared, false);
  assert.deepEqual((await call(env, '/invites', undefined, host.token)).rewards, []);
  // a friend from before the bonuses (5+ matches, no loyal bonus yet) is paid when the page opens
  env.sql.prepare('UPDATE player_meta SET played = 7 WHERE player = ?').run(kids[1].player.id);
  assert.deepEqual((await call(env, '/invites', undefined, host.token)).rewards.map(r => [r.amount, r.reason]), [[300, 'loyal']]);
  assert.deepEqual((await call(env, '/invites', undefined, host.token)).rewards, []);
  // the share bonus: once a UTC day
  const s1 = await call(env, '/share/done', { via: 'tg' }, host.token); assert.equal(s1.bonus, true); assert.deepEqual(s1.rewards.map(r => [r.amount, r.reason]), [[30, 'share']]);
  const s2 = await call(env, '/share/done', { via: 'tg' }, host.token); assert.equal(s2.bonus, false); assert.deepEqual(s2.rewards, []);
  assert.equal((await call(env, '/invites', undefined, host.token)).shared, true);
  // the ranking doesn't move
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM cworm_scores WHERE player = ?').get(host.player.id).n, 0);
  // /invite in the bot: the link, the ladder and the friends so far
  calls.length = 0; await hook(env, msg('/invite', 42));
  const [m, b] = calls[0]; assert.equal(m, 'sendMessage');
  assert.match(b.text, /\+200 \$CWORM for you/); assert.match(b.text, /3 played, 1 still to finish a first match/); assert.match(b.text, /startapp=f_/); assert.match(b.text, /not real tokens/);
  assert.match(b.reply_markup.inline_keyboard[0][0].url, /^https:\/\/t\.me\/share\/url\?url=/);
  calls.length = 0; await hook(env, msg('/invite', 999)); assert.match(calls[0][1].text, /Open the game once/);
  // an invite card for Telegram's share dialog
  calls.length = 0; await call(env, '/share/prepare', { kind: 'invite' }, host.token);
  const [, p] = calls.find(c => c[0] === 'savePreparedInlineMessage');
  assert.equal(p.result.photo_url, 'https://play.test/cards/invite.jpg'); assert.match(p.result.caption, /we both get \+200 \$CWORM in the game \(play money\)/);
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
  calls.length = 0; const monday = weekStart() + 15 * 60e3;
  await cron(env, monday); await cron(env, monday + 15 * 60e3);
  const posts = calls.filter(c => c[0] === 'sendMessage' && c[1].chat_id === -100);
  assert.equal(posts.length, 1); assert.match(posts[0][1].text, /🥇 🇧🇷 Ana: 500 \$CWORM\n🥈 Dami: 90/); assert.match(posts[0][1].text, /not real tokens/);
  calls.length = 0; await hook(env, msg('/sources', 55)); assert.equal(calls.length, 0);
  await hook(env, msg('/sources', 42)); assert.match(calls[0][1].text, /untagged/);
  // friend-online reminder: Ana is a friend of Dami, Dami is online, Ana was last here 3 hours ago
  env.sql.prepare('INSERT INTO friends (player, friend, created) VALUES (?, ?, 0), (?, ?, 0)').run(a.player.id, admin.player.id, admin.player.id, a.player.id);   // friends both ways
  env.sql.prepare('UPDATE player_meta SET last_seen = ? WHERE player = ?').run(Date.now() - 3 * 3600e3, a.player.id);
  const env2 = { ...env, LOBBY: makeEnv([admin.player.id]).LOBBY };
  const q = Math.floor(Date.now() / 9e5) * 9e5; calls.length = 0; await cron(env2, q); await cron(env2, q);
  const pings = calls.filter(c => c[0] === 'sendMessage' && c[1].chat_id === 55);
  assert.equal(pings.length, 1); assert.match(pings[0][1].text, /Dami is online/); assert.match(pings[0][1].text, /\/stop/);
  await hook(env, msg('/stop', 55));
  assert.equal(env.sql.prepare('SELECT remind FROM player_meta WHERE player = ?').get(a.player.id).remind, 0);
  assert.equal((await call(env, '/me', undefined, a.token)).player.remind, false);
  assert.equal((await call(env, '/me/remind', { on: true }, a.token)).remind, true);
});

test('growth: every START is logged; one reminder an hour later, in their language, only if they never opened the game', async () => {
  const env = makeEnv(); await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami') }); calls.length = 0;   // player 1 = admin
  const start = (id, lang, arg = '') => hook(env, { message: { chat: { id, type: 'private' }, from: { id, first_name: 'Ana', language_code: lang }, text: '/start' + arg } });
  await start(71, 'es-ES', ' s_promo'); await start(72, 'en'); await start(73, 'pt-br'); await start(71, 'es');
  assert.match(calls[0][1].text, /^🪱 ¡Bienvenido, Ana!/); assert.equal(calls[0][1].reply_markup.inline_keyboard[0][0].text, '🎮 Jugar ahora');
  assert.match(calls[0][1].reply_markup.inline_keyboard[0][0].url, /startapp=s_promo$/);
  assert.deepEqual(env.sql.prepare('SELECT tg_id, n, src, lang, nudged FROM bot_starts ORDER BY tg_id').all().map(r => ({ ...r })),
    [{ tg_id: 71, n: 2, src: 'promo', lang: 'es', nudged: 0 }, { tg_id: 72, n: 1, src: null, lang: 'en', nudged: 0 }, { tg_id: 73, n: 1, src: null, lang: 'pt', nudged: 0 }]);
  await call(env, '/auth/telegram', { initData: tgInit(72, 'Bo') });                  // 72 opened the game
  await hook(env, msg('/stop', 73));                                                   // 73 asked for no messages
  const later = Date.now() + 61 * 60e3, q = Math.floor(later / 9e5) * 9e5 + 9e5;
  calls.length = 0; await cron(env, Date.now()); assert.equal(calls.filter(c => c[0] === 'sendMessage').length, 0);   // not an hour yet
  calls.length = 0; await cron(env, q); await cron(env, q + 9e5);
  const sent = calls.filter(c => c[0] === 'sendMessage');
  assert.equal(sent.length, 1); assert.equal(sent[0][1].chat_id, 71); assert.match(sent[0][1].text, /primera batalla/);
  assert.match(sent[0][1].reply_markup.inline_keyboard[0][0].url, /startapp=s_promo$/);
  calls.length = 0; await hook(env, msg('/sources', 42));
  assert.match(calls[0][1].text, /Bot START, last 7 days<\/b>: 3 people · 1 opened the game · 1 got the reminder, 0 of them came/);
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
  calls.length = 0; await hook(env, msg('/announce 🆕 Update: easier jumps', 42)); await cron(env, Date.now()); await cron(env, Date.now());   // sent at once; the cron sends nothing twice
  const to = calls.filter(c => c[0] === 'sendMessage' && /easier jumps/.test(c[1].text)).map(c => c[1].chat_id);
  assert.deepEqual(to, [-100, 42, 666]);
  assert.equal(env.sql.prepare('SELECT no_dm FROM player_meta p JOIN players x ON x.id = p.player WHERE x.tg_id = 666').get().no_dm, 1);
  const row = env.sql.prepare('SELECT * FROM announcements').get(); assert.equal(row.done, 1); assert.equal(row.sent, 1);
  assert.ok(env.sql.prepare('SELECT reminded FROM player_meta p JOIN players x ON x.id = p.player WHERE x.tg_id = 42').get().reminded > 0);   // no reminder on top today
  // one note a day: a second note waits for the next UTC day
  calls.length = 0; await hook(env, msg('/announce Second note', 42)); await cron(env, Date.now());
  assert.equal(calls.filter(c => c[0] === 'sendMessage' && /Second note/.test(c[1].text)).length, 0);
  env.now = Date.now() + 86400000; await cron(env, env.now);
  assert.deepEqual(calls.filter(c => c[0] === 'sendMessage' && /Second note/.test(c[1].text)).map(c => c[1].chat_id), [-100, 42]);   // 666 blocked the bot last time
  // a note queued with a later time waits for it
  env.sql.prepare('INSERT INTO announcements (text, created) VALUES (?, ?)').run('Timed note', env.now + 2 * 86400000);
  calls.length = 0; env.now += 86400000; await cron(env, env.now); assert.equal(calls.filter(c => /Timed note/.test(c[1].text || '')).length, 0);
  env.now += 86400000 + 60e3; await cron(env, env.now); assert.equal(calls.filter(c => /Timed note/.test(c[1].text || '')).length, 2);
  assert.ok(a);
});
