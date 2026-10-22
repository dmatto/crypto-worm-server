import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Stand-ins: node:sqlite for D1, Grok's message check (anything with "BANNED" in it is turned down) and Telegram in `sent`.
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const sent = []; let grokDown = false;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.x.ai/')) {
    const b = JSON.parse(init.body), text = b.messages[1].content; sent.push(['xai', text]);
    if (grokDown) return Response.json({ error: 'down' }, { status: 503 });
    return Response.json({ choices: [{ message: { content: JSON.stringify(/BANNED/.test(text) ? { ok: false, why: 'insult' } : { ok: true }) } }] });
  }
  sent.push([String(url).split('/').pop(), JSON.parse(init.body)]); return Response.json({ ok: true, result: {} });
};
const { default: worker } = await import('../src/index.js');
const { precheck, clean, chatAdmin, chatCleanup, CHAT_PLAYED, MAX_LEN, PER_10MIN, KEEP_WORLD } = await import('../src/chat.js');
const { webhook } = await import('../src/bot.js');

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const LOBBY = { idFromName: n => n, get: () => ({ fetch: async req => Response.json({ online: [], ids: [] }) }) };
  return { DB, sql, LOBBY, SESSION_SECRET: 'test-secret', BOT_TOKEN: '123:BOT', XAI_API_KEY: 'x', SIGNIN_DOMAIN: 'example.test', GAME_LINK: 'https://t.me/CryptoWormWarsBot/play' };
}
const call = async (env, path, body, token) => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, {});
  return { status: r.status, ...(await r.json()) };
};
function tgInit(id, name) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: name }) };
  const check = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n'), secret = createHmac('sha256', 'WebAppData').update('123:BOT').digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
}
const played = (env, id, n) => env.sql.prepare('INSERT INTO player_meta (player, played) VALUES (?, ?) ON CONFLICT(player) DO UPDATE SET played = excluded.played').run(id, n);
async function player(env, n = CHAT_PLAYED, tgId) {
  const g = tgId ? await call(env, '/auth/telegram', { initData: tgInit(tgId, 'P' + tgId) }) : await call(env, '/auth/guest', {});
  played(env, g.player.id, n); return g;
}
// each message a little later than the one before, so the pace check doesn't get in the way
const later = (env, ms = 60e3) => env.sql.prepare('UPDATE chat SET at = at - ?').run(ms);

test('the quick checks stop links, wallets, contact details and slurs, and let normal trash talk through', () => {
  for (const t of ['join t.me/pumpgroup', 'check www.scam.xyz', 'go to moonshot.finance', 'https://x.com/a', 'follow @cryptoguy99',
    'send to 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', '0x52908400098527886E0F7030069857D2E4169EE7', 'my seed phrase is', 'dm me for the airdrop',
    'call +1 415 555 0134', 'mail me a@b.co']) assert.equal(precheck(t), 'link', t);
  for (const t of ['n i g g a', 'you f4ggot', 'kys']) assert.equal(precheck(t), 'rude', t);
  for (const t of ['gg wp, rekt 😂', 'ngmi lol', 'buy $CWORM and hodl', 'won 3-2 at 10 pm', 'skill issue', 'qué buena partida', 'Crypto Worm to the moon 🚀'])
    assert.equal(precheck(t), '', t);
  assert.equal(clean('  hi​\nthere \u0007 '), 'hi there');
});

test('World chat: read by anyone, written after 3 matches, every message checked; pace, repeats and Grok', async () => {
  const env = makeEnv(), a = await player(env), b = await player(env), newbie = await player(env, 1);
  const r0 = await call(env, '/chat?room=w', undefined, newbie.token);
  assert.equal(r0.status, 200); assert.deepEqual(r0.msgs, []); assert.equal(r0.can, false); assert.equal(r0.why, 'played'); assert.equal(r0.left, 2);
  assert.equal((await call(env, '/chat/send', { room: 'w', text: 'hi' }, newbie.token)).code, 'played');
  const s = await call(env, '/chat/send', { room: 'w', text: '  gm   worms! ' }, a.token);
  assert.equal(s.status, 200); assert.equal(s.msg.text, 'gm worms!'); assert.equal(s.msg.p.id, a.player.id);
  assert.equal((await call(env, '/chat/send', { room: 'w', text: 'again' }, a.token)).code, 'slow');
  later(env);
  assert.equal((await call(env, '/chat/send', { room: 'w', text: 'GM WORMS!' }, a.token)).code, 'repeat');
  assert.equal((await call(env, '/chat/send', { room: 'w', text: 'x'.repeat(MAX_LEN + 1) }, a.token)).code, 'long');
  assert.equal((await call(env, '/chat/send', { room: 'w', text: '   ' }, a.token)).code, 'empty');
  assert.equal((await call(env, '/chat/send', { room: 'w', text: 'free SOL at t.me/x' }, a.token)).code, 'link');
  const n = sent.filter(x => x[0] === 'xai').length;
  assert.equal((await call(env, '/chat/send', { room: 'w', text: 'you are BANNED word' }, a.token)).code, 'rude');
  assert.equal(sent.filter(x => x[0] === 'xai').length, n + 1, 'Grok saw only the message that passed the quick checks');
  grokDown = true; later(env);
  assert.equal((await call(env, '/chat/send', { room: 'w', text: 'grok is asleep' }, b.token)).status, 200, 'Grok down: the message goes through');
  grokDown = false;
  const r = await call(env, '/chat?room=w', undefined, newbie.token);
  assert.deepEqual(r.msgs.map(m => m.text), ['gm worms!', 'grok is asleep']);
  assert.equal((await call(env, '/chat?room=w&after=' + r.msgs[0].id, undefined, a.token)).msgs.length, 1);
  for (let i = 0; i < PER_10MIN; i++) env.sql.prepare("INSERT INTO chat (room, player, text, at) VALUES ('w', ?, ?, ?)").run(b.player.id, 'm' + i, Date.now() - 300e3);
  assert.equal((await call(env, '/chat/send', { room: 'w', text: 'one more' }, b.token)).code, 'slow');
});

test('Team chat: members only, unread dot in the session, bot note to members who are away', async () => {
  const env = makeEnv(), a = await player(env, 3, 7001), b = await player(env, 3, 7002), c = await player(env, 3, 7003), out = await player(env, 3, 7004);
  assert.equal((await call(env, '/chat?room=t', undefined, a.token)).none, true);
  assert.equal((await call(env, '/chat/send', { room: 't', text: 'hi team' }, a.token)).code, 'team');
  const t = await call(env, '/teams/create', { name: 'Worm Gang', tag: 'WG', emoji: '🪱' }, a.token);
  await call(env, '/teams/join', { id: t.team.id }, b.token); await call(env, '/teams/join', { id: t.team.id }, c.token);
  await call(env, '/chat?room=t', undefined, c.token);                                // c has Team chat open right now
  sent.length = 0;
  const s = await call(env, '/chat/send', { room: 't', text: 'raid at 8?' }, a.token);
  assert.equal(s.status, 200); assert.deepEqual(s.msg.p.team, { tag: 'WG', emoji: '🪱' });
  const dms = sent.filter(x => x[0] === 'sendMessage').map(x => x[1]);
  assert.deepEqual(dms.map(d => d.chat_id), [7002], 'b is told; c is looking at it, a wrote it');
  assert.equal(dms[0].text, '💬 P7001 in 🪱 Worm Gang: raid at 8?');
  assert.match(dms[0].reply_markup.inline_keyboard[0][0].url, /startapp=chat_t$/);
  later(env);
  sent.length = 0; await call(env, '/chat/send', { room: 't', text: 'anyone?' }, a.token);
  assert.equal(sent.filter(x => x[0] === 'sendMessage').length, 0, 'one bot note per member every 12 hours');
  assert.equal((await call(env, '/me', undefined, b.token)).player.tchat, 2);
  assert.equal((await call(env, '/me', undefined, a.token)).player.tchat, undefined, 'your own messages are read');
  const r = await call(env, '/chat?room=t', undefined, b.token);
  assert.deepEqual(r.msgs.map(m => m.text), ['raid at 8?', 'anyone?']); assert.equal(r.team.name, 'Worm Gang');
  assert.equal((await call(env, '/me', undefined, b.token)).player.tchat, undefined);
  assert.deepEqual((await call(env, '/chat?room=t', undefined, out.token)).msgs, [], 'not a member: no team room');
  assert.deepEqual((await call(env, '/chat?room=w', undefined, out.token)).msgs, [], 'team messages never show in World chat');
});

test('reports, blocks, admin mutes and deletes, player cards, cleanup; load-test bots stay out', async () => {
  const env = makeEnv(), admin = await player(env, 3, 9001), a = await player(env), b = await player(env), c = await player(env);
  env.ADMIN_PLAYERS = String(admin.player.id);
  const m = (await call(env, '/chat/send', { room: 'w', text: 'mean thing' }, a.token)).msg;
  sent.length = 0;
  assert.deepEqual(await call(env, '/chat/report', { id: m.id }, b.token), { status: 200, ok: true, hidden: false });
  const alert = sent.find(x => x[0] === 'sendMessage');
  assert.equal(alert[1].chat_id, 9001); assert.match(alert[1].text, /mean thing/); assert.match(alert[1].text, new RegExp(`/chatmute ${a.player.id} 24`));
  sent.length = 0; await call(env, '/chat/report', { id: m.id }, b.token);
  assert.equal(sent.length, 0, 'the same player reporting again changes nothing');
  assert.equal((await call(env, '/chat/report', { id: m.id }, c.token)).hidden, true, 'two players: hidden');
  assert.deepEqual((await call(env, '/chat?room=w', undefined, b.token)).msgs, []);
  later(env);
  const m2 = (await call(env, '/chat/send', { room: 'w', text: 'hello all' }, a.token)).msg;
  assert.equal((await call(env, '/chat/block', { id: a.player.id }, b.token)).blocked[0], a.player.id);
  assert.deepEqual((await call(env, '/chat?room=w', undefined, b.token)).msgs, [], 'blocked: gone for b');
  assert.equal((await call(env, '/chat?room=w', undefined, c.token)).msgs.length, 1, 'still there for c');
  assert.deepEqual((await call(env, '/chat/blocks', undefined, b.token)).blocked, [{ id: a.player.id, name: a.player.name }]);
  await call(env, '/chat/block', { id: a.player.id, on: false }, b.token);
  assert.equal((await call(env, '/chat?room=w', undefined, b.token)).msgs.length, 1);
  const card = await call(env, '/chat/player?id=' + a.player.id, undefined, b.token);
  assert.equal(card.name, a.player.name); assert.equal(card.played, 3); assert.equal(card.friend, false); assert.equal(card.blocked, false); assert.equal(card.invite, false);
  assert.equal((await call(env, '/chat/player?id=99999', undefined, b.token)).status, 404);
  assert.match(await chatAdmin(env, '/chatmute', `${a.player.id} 2`), /can't chat for 2 hours/);
  assert.equal((await call(env, '/chat/send', { room: 'w', text: 'let me talk' }, a.token)).code, 'muted');
  assert.equal((await call(env, '/chat?room=w', undefined, c.token)).msgs.length, 0, 'a mute hides their last day');
  assert.match(await chatAdmin(env, '/chatmute', `${a.player.id} 0`), /can chat again/);
  later(env); assert.equal((await call(env, '/chat/send', { room: 'w', text: 'thanks' }, a.token)).status, 200);
  const m3 = (await call(env, '/chat?room=w', undefined, c.token)).msgs.at(-1);
  assert.match(await chatAdmin(env, '/chatdel', String(m3.id)), /hidden/);
  assert.equal((await call(env, '/chat?room=w', undefined, c.token)).msgs.length, 0);
  assert.equal((await call(env, '/chat/report', { id: m2.id }, admin.token)).hidden, true, 'one report from an admin hides it');
  env.sql.prepare('UPDATE chat SET at = ?').run(Date.now() - KEEP_WORLD - 1); await chatCleanup(env);
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM chat').get().n, 0);
  env.sql.prepare('INSERT INTO sim_players (player, created) VALUES (?, 0)').run(c.player.id);
  assert.equal((await call(env, '/chat?room=w', undefined, c.token)).status, 403);
});

test('the bot: /chatmute and /chatdel for admins only', async () => {
  const env = makeEnv(), admin = await player(env, 3, 9101), a = await player(env, 3, 9102);
  env.ADMIN_PLAYERS = String(admin.player.id);
  const say = async (from, text) => { sent.length = 0;
    await webhook(new Request('https://api.test/telegram/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': await secret(env) },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: from, type: 'private' }, from: { id: from, first_name: 'X' }, text } }) }), env);
    return sent.filter(x => x[0] === 'sendMessage').map(x => x[1].text).join('\n') };
  assert.match(await say(9101, `/chatmute ${a.player.id} 5`), /can't chat for 5 hours/);
  assert.doesNotMatch(await say(9102, `/chatmute ${admin.player.id} 5`), /can't chat/);
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM chat_mutes').get().n, 1);
});
async function secret(env) { const { createHash } = await import('node:crypto'); return createHash('sha256').update('webhook:' + env.SESSION_SECRET).digest('hex').slice(0, 48) }
