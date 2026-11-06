import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const RealResponse = globalThis.Response;
const P = await import('../src/players.js');
const { webhook, commandsCheck, COMMANDS } = await import('../src/bot.js');

let sent = [];
globalThis.fetch = async (url, init) => {
  const u = String(url), body = init && init.body ? JSON.parse(init.body) : {};
  if (u.includes('api.telegram.org')) { sent.push({ method: u.split('/').pop(), ...body }); return RealResponse.json({ ok: true, result: { message_id: 1 } }) }
  return RealResponse.json({}, { status: 404 });
};
const T0 = Date.UTC(2026, 10, 6, 10);
function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  sql.prepare("INSERT INTO players (id, tg_id, wallet, name, wins, losses, created) VALUES (1203, 501, 'W1', 'Alex <b>', 7, 4, ?), (1388, NULL, NULL, 'Alex', 0, 0, ?), (2, 900, NULL, 'Damian', 0, 0, 0), (1500, NULL, NULL, 'Al_x%', 0, 0, 0)").run(T0 - 9 * 864e5, T0);
  sql.prepare("INSERT INTO player_meta (player, played, last_seen, source) VALUES (1203, 25, ?, 'tg')").run(T0);
  sql.prepare("INSERT INTO holders (player, wallet, balance, tier) VALUES (1203, 'W1', 1234567.8, 2)").run();
  sql.prepare("INSERT INTO teams (id, name, tag, emoji, owner, code, created) VALUES (1, 'Bulls & Co', 'BUL', '🐂', 1203, 'c1', 0)").run();
  sql.prepare("INSERT INTO team_members (player, team, role, joined) VALUES (1203, 1, 'lead', 0)").run();
  sql.prepare('INSERT INTO prize_skip (player, at) VALUES (1203, ?)').run(T0);
  sql.prepare('INSERT INTO chat_mutes (player, until) VALUES (1203, ?)').run(T0 + 3600e3);
  sql.prepare('INSERT INTO sim_players (player, created) VALUES (1388, 0)').run();
  return { DB: { prepare: q => stmt(q) }, SESSION_SECRET: 'test-secret', BOT_TOKEN: 'bot', PUBLIC_URL: 'https://api.test', ADMIN_PLAYERS: '2', GAME_LINK: 'https://t.me/Bot/play' };
}

test('/id tells a player their number, or how to get one', async () => {
  const env = makeEnv();
  const a = await P.idMessage(env, { id: 501 });
  assert.equal(a.parse_mode, 'HTML'); assert.match(a.text, /Your player ID: <b>1203<\/b> \(Alex &lt;b&gt;\)/);
  const b = await P.idMessage(env, { id: 777 });
  assert.match(b.text, /first time/); assert.equal(b.reply_markup.inline_keyboard[0][0].url, 'https://t.me/Bot/play');
});

test('/player shows who a number is, and finds numbers by name', async () => {
  const env = makeEnv();
  const one = await P.lookup(env, '#1203', T0);
  for (const s of ['Player <b>1203</b>: <b>Alex &lt;b&gt;</b>', 'tg://user?id=501', '<code>W1</code> · Dolphin tier, 1,234,567 $CWORM', 'from tg · 25 matches · online 7 W / 4 L',
    'Team: 🐂 Bulls &amp; Co [BUL] (leader)', 'out of the weekly prize', 'chat muted until']) assert.ok(one.includes(s), s + '\n' + one);
  assert.match(await P.lookup(env, '1388', T0), /load-test bot/);
  assert.match(await P.lookup(env, '42', T0), /No player with ID 42/);
  const byName = await P.lookup(env, 'alex', T0);
  assert.match(byName, /1388 · Alex \(load-test bot\)/); assert.match(byName, /1203 · Alex &lt;b&gt;/); assert.doesNotMatch(byName, /Al_x%/);
  assert.match(await P.lookup(env, '_x%', T0), /1500 · Al_x%/);   // LIKE wildcards in the search are plain characters
  assert.match(await P.lookup(env, '', T0), /Send \/player 1234/);
});

test('the bot answers /id for anyone and /player only for admins', async () => {
  const env = makeEnv(), secret = createHash('sha256').update('webhook:' + env.SESSION_SECRET).digest('hex').slice(0, 48);
  const say = (from, text) => webhook(new Request('https://api.test/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ update_id: 1, message: { chat: { id: from, type: 'private' }, from: { id: from, first_name: 'X' }, text } }) }), env);
  sent = []; await say(501, '/id');
  assert.match(sent.find(x => x.method === 'sendMessage').text, /<b>1203<\/b>/);
  sent = []; await say(900, '/player 1203');
  assert.match(sent.find(x => x.method === 'sendMessage').text, /Player <b>1203<\/b>/);
  sent = []; await say(501, '/player 2');
  assert.ok(!sent.some(x => x.method === 'sendMessage' && /Player <b>2<\/b>/.test(x.text || '')), 'not for players');
});

test('the command menu with /id is set once after a deploy', async () => {
  const env = makeEnv();
  sent = []; await commandsCheck(env);
  const set = sent.filter(x => x.method === 'setMyCommands'); assert.equal(set.length, 1); assert.ok(set[0].commands.some(c => c.command === 'id'));
  assert.deepEqual(set[0].commands, COMMANDS);
  sent = []; await commandsCheck(env); assert.deepEqual(sent, []);
});
