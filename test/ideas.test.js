import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const I = await import('../src/ideas.js');
const { webhook, updatesCheck } = await import('../src/bot.js');

let sent = [], hook = { url: 'https://api.test/telegram/webhook', allowed_updates: ['message'] }, msgId = 100;
globalThis.fetch = async (url, init) => {
  const u = String(url), body = init && init.body ? JSON.parse(init.body) : {}, method = u.split('/').pop();
  if (u.includes('api.telegram.org')) {
    sent.push({ method, ...body });
    if (method === 'getWebhookInfo') return RealResponse.json({ ok: true, result: hook });
    return RealResponse.json({ ok: true, result: { message_id: ++msgId } });
  }
  return RealResponse.json({}, { status: 404 });
};
const DAY = 864e5, T0 = Date.UTC(2026, 10, 6, 10);
function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  sql.prepare("INSERT INTO players (id, tg_id, name, created) VALUES (1, 501, 'Ana', 0), (2, 900, 'Damian', 0), (3, 503, 'Bo', 0), (4, NULL, 'Cy', 0), (5, 505, 'Bot', 0)").run();
  for (const [id, n] of [[1, 5], [2, 50], [3, 1], [5, 9]]) sql.prepare('INSERT INTO player_meta (player, played) VALUES (?, ?)').run(id, n);
  sql.prepare('INSERT INTO sim_players (player, created) VALUES (5, 0)').run();
  return { DB, sql, SESSION_SECRET: 'test-secret', BOT_TOKEN: 'bot', PUBLIC_URL: 'https://api.test', ADMIN_PLAYERS: '2', GAME_LINK: 'https://t.me/Bot/play' };
}
const propose = (env, id, b, now = T0, sim = false) => I.handle('/ideas/propose', env, { id }, b, { post: true, sim }, now);
const vote = (env, id, idea, choice, now = T0 + 1000, sim = false) => I.handle('/ideas/vote', env, { id }, { id: idea, choice }, { post: true, sim }, now);
const idea = { kind: 'weapon', title: 'Banana bomb', text: 'A bomb that splits into five bananas.' };

test('ideas: players with 3 matches propose one a day; admins get it with buttons; nobody sees it before approval', async () => {
  const env = makeEnv(); sent = [];
  assert.equal((await propose(env, 3, idea)).status, 403);                                          // 1 match
  assert.equal((await propose(env, 4, idea)).status, 403);                                          // never played
  assert.equal((await propose(env, 5, idea, T0, true)).status, 403);                                // load-test bot
  assert.equal((await propose(env, 1, { ...idea, kind: 'x' })).status, 400);
  assert.equal((await propose(env, 1, { ...idea, title: 'ab' })).status, 400);
  assert.equal((await propose(env, 1, { ...idea, text: 'short' })).status, 400);
  const r = await propose(env, 1, { ...idea, title: '  Banana\n‮bomb  ' });
  assert.equal(r.mine.length, 1); assert.equal(r.mine[0].state, 'wait'); assert.equal(r.mine[0].title, 'Banana bomb');
  assert.equal(r.me.canPropose, false); assert.equal(r.me.why, 'today');
  assert.equal((await propose(env, 1, idea, T0 + 3600e3)).status, 429);                            // one a day
  const msg = sent.find(s => s.method === 'sendMessage');
  assert.equal(msg.chat_id, 900); assert.match(msg.text, /New idea #1 from <a href="tg:\/\/user\?id=501">Ana<\/a> \(player 1, 5 matches\)/);
  assert.deepEqual(msg.reply_markup.inline_keyboard[0].map(b => b.callback_data), ['idea:ok:1', 'idea:no:1']);
  assert.deepEqual(JSON.parse(env.sql.prepare('SELECT msgs FROM ideas WHERE id = 1').get().msgs), [[900, msg.message_id ?? 101]]);
  const other = await I.list(env, { id: 3 }, T0);
  assert.deepEqual(other.open, []); assert.deepEqual(other.mine, []); assert.equal(other.me.why, 'matches'); assert.equal(other.me.canVote, true);
  await propose(env, 1, idea, T0 + DAY); await propose(env, 1, idea, T0 + 2 * DAY);
  const full = await propose(env, 1, idea, T0 + 3 * DAY); assert.equal(full.status, 429); assert.match(full.error, /3 ideas waiting/);
});

test('ideas: Approve (a button) opens a Yes/No poll for 7 days, pays +500 once and tells the author; Reject keeps it private', async () => {
  const env = makeEnv(); sent = [];
  await propose(env, 1, idea); await propose(env, 1, { ...idea, title: 'Moon jump' }, T0 + DAY);
  sent = [];
  const cq = (data, from = 900) => ({ id: 'cq' + from, data, from: { id: from, first_name: 'Dami' } });
  assert.equal(await I.callback(env, cq('idea:ok:1', 503), false), true);
  assert.match(sent.pop().text, /Only admins/); assert.equal(env.sql.prepare('SELECT state FROM ideas WHERE id = 1').get().state, 'wait');
  await I.callback(env, cq('idea:ok:1'), true, T0 + 2 * DAY);
  const row = env.sql.prepare('SELECT * FROM ideas WHERE id = 1').get();
  assert.equal(row.state, 'open'); assert.equal(row.ends, T0 + 2 * DAY + 7 * DAY);
  assert.deepEqual(env.sql.prepare('SELECT player, amount, reason, note FROM rewards').all().map(r => ({ ...r })), [{ player: 1, amount: 500, reason: 'idea', note: 'Banana bomb' }]);
  assert.ok(sent.some(s => s.method === 'sendMessage' && s.chat_id === 501 && /is now a poll/.test(s.text)));          // the author's note
  const edit = sent.find(s => s.method === 'editMessageText'); assert.equal(edit.chat_id, 900); assert.match(edit.text, /Approved by Dami/); assert.equal(edit.reply_markup, undefined);
  assert.match(sent.find(s => s.method === 'answerCallbackQuery').text, /is a poll now/);
  sent = []; await I.callback(env, cq('idea:ok:1'), true, T0 + 2 * DAY);                              // a second tap pays nothing
  assert.match(sent.pop().text, /already approved/); assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM rewards').get().n, 1);

  assert.match(await I.command(env, 'no 2 we have one like it', { by: 'Dami' }, T0 + 2 * DAY), /rejected/);
  const mine = (await I.list(env, { id: 1 }, T0 + 2 * DAY)).mine;
  assert.deepEqual(mine.map(m => [m.id, m.state, m.note]), [[2, 'no', 'we have one like it'], [1, 'live', null]]);
  const pub = await I.list(env, { id: 3 }, T0 + 2 * DAY);
  assert.deepEqual(pub.open.map(o => [o.id, o.by, o.title, o.options, o.counts]), [[1, 'Ana', 'Banana bomb', null, undefined]]);   // no counts before voting
});

test('ideas: one vote per real player with a match, changeable, results after voting or the end; load-test votes never count', async () => {
  const env = makeEnv();
  await propose(env, 1, idea); await I.decide(env, 1, true, 'Dami', null, T0);
  assert.equal((await vote(env, 4, 1, 0)).status, 403);                                             // no finished match
  assert.equal((await vote(env, 5, 1, 0, T0 + 1, true)).status, 403);                               // load-test bot
  assert.equal((await vote(env, 3, 1, 2)).status, 400); assert.equal((await vote(env, 3, 9, 0)).status, 404);
  let r = await vote(env, 3, 1, 1);
  assert.deepEqual([r.open[0].mine, r.open[0].counts, r.open[0].total], [1, [0, 1], 1]);
  env.sql.prepare('INSERT INTO idea_votes (idea, player, choice, at) VALUES (1, 5, 0, 0)').run();   // a bot's vote slipped in: not counted
  r = await vote(env, 1, 1, 0); assert.deepEqual(r.open[0].counts, [1, 1]);
  r = await vote(env, 3, 1, 0); assert.deepEqual(r.open[0].counts, [2, 0]);                          // changed, still one vote
  assert.equal((await vote(env, 3, 1, 1, T0 + 7 * DAY)).status, 409);                               // closed
  const after = await I.list(env, { id: 2 }, T0 + 7 * DAY);
  assert.deepEqual(after.open, []); assert.deepEqual(after.closed.map(c => [c.id, c.open, c.counts]), [[1, false, [2, 0]]]);
  assert.deepEqual((await I.list(env, { id: 2 }, T0 + 40 * DAY)).closed, []);                        // results stay a month
});

test('ideas: /newpoll posts team polls (2 to 4 options or Yes/No), /idea tag done pays +2,000 once, end and del, cron tells admins once', async () => {
  const env = makeEnv(); sent = [];
  assert.match(await I.newPoll(env, 'Which one? | only one', 2, T0), /Write it like this/);
  assert.match(await I.newPoll(env, 'Which one? | a | b | c | d | e', 2, T0), /Write it like this/);
  assert.match(await I.newPoll(env, 'Which weapon next? | Laser | Freeze ray | Mega mole', 2, T0), /Poll #1 is live in the game for 7 days/);
  assert.match(await I.newPoll(env, '3d More maps?', 2, T0), /Poll #2 is live in the game for 3 days/);
  let l = await I.list(env, { id: 3 }, T0 + 1);
  assert.deepEqual(l.open.map(o => [o.id, o.team, o.by, o.options]), [[2, true, null, null], [1, true, null, ['Laser', 'Freeze ray', 'Mega mole']]]);
  const r = await vote(env, 3, 1, 2); assert.deepEqual(r.open.find(o => o.id === 1).counts, [0, 0, 1]);

  await propose(env, 1, idea); await I.decide(env, 3, true, '', null, T0);
  assert.match(await I.command(env, 'tag 3 done', {}, T0 + 1), /Ana got \+2,000 play \$CWORM/);
  assert.match(await I.command(env, 'tag 3 done', {}, T0 + 2), /^✅ Done on #3/);
  assert.deepEqual(env.sql.prepare('SELECT amount, reason FROM rewards ORDER BY id').all().map(x => [x.amount, x.reason]), [[500, 'idea'], [2000, 'ideadone']]);
  assert.match(await I.command(env, 'tag 3 maybe', {}, T0), /planned, done, notnow or none/);
  assert.match(await I.command(env, 'end 2', {}, T0 + 5), /closed/);
  assert.match(await I.command(env, 'del 1', {}, T0 + 5), /out of the game/);
  l = await I.list(env, { id: 3 }, T0 + 6);
  assert.deepEqual(l.open.map(o => o.id), [3]); assert.deepEqual(l.closed.map(o => [o.id, o.counts]), [[2, [0, 0]]]);
  assert.equal(l.open[0].tag, 'done');
  assert.match(await I.command(env, '', {}, T0 + 6), /Open polls \(1\)/);

  sent = []; assert.equal(await I.cron(env, T0 + 6), 1); assert.equal(await I.cron(env, T0 + 7), 0);
  assert.match(sent.find(s => s.chat_id === 900).text, /Poll #2 closed/);
});

test('ideas: /idea edit fixes the wording (and resends the buttons), merged accounts keep ideas and one vote', async () => {
  const env = makeEnv(); sent = [];
  await propose(env, 1, idea); sent = [];
  assert.equal(await I.command(env, 'edit 1 Banana barrage | Five bananas rain down.', { chat: 900 }, T0), null);
  assert.match(sent[0].text, /<b>Banana barrage<\/b>\nFive bananas rain down\./); assert.equal(sent[0].reply_markup.inline_keyboard[0][0].callback_data, 'idea:ok:1');
  assert.equal(JSON.parse(env.sql.prepare('SELECT msgs FROM ideas').get().msgs).length, 2);
  await I.decide(env, 1, true, '', null, T0);
  await vote(env, 3, 1, 1); await vote(env, 1, 1, 0);
  await I.mergeIdeas(env, 3, 1);
  assert.deepEqual(env.sql.prepare('SELECT player, choice FROM idea_votes').all().map(x => [x.player, x.choice]), [[1, 0]]);
  await I.mergeIdeas(env, 1, 4);
  assert.equal(env.sql.prepare('SELECT player FROM ideas').get().player, 4);
});

test('ideas: the webhook routes button taps and admin commands; the cron adds callback_query to the webhook once', async () => {
  const env = makeEnv(); sent = [];
  const secret = createHash('sha256').update('webhook:test-secret').digest('hex').slice(0, 48);
  const post = u => webhook(new Request('https://api.test/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(u) }), env);
  await post({ update_id: 1, message: { chat: { id: 900, type: 'private' }, from: { id: 900, first_name: 'Dami' }, text: '/newpoll Bigger maps? | Yes please | No' } });
  assert.match(sent.pop().text, /Poll #1 is live/);
  await post({ update_id: 2, message: { chat: { id: 503, type: 'private' }, from: { id: 503, first_name: 'Bo' }, text: '/newpoll Hack? | a | b' } });
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM ideas').get().n, 1);                       // not an admin
  await propose(env, 1, idea); sent = [];
  await post({ update_id: 3, callback_query: { id: 'q1', data: 'idea:ok:2', from: { id: 900, first_name: 'Dami' } } });
  assert.equal(env.sql.prepare('SELECT state FROM ideas WHERE id = 2').get().state, 'open');
  await post({ update_id: 4, callback_query: { id: 'q2', data: 'other', from: { id: 900 } } });
  assert.deepEqual(sent.pop(), { method: 'answerCallbackQuery', callback_query_id: 'q2' });
  await post({ update_id: 5, message: { chat: { id: 900, type: 'private' }, from: { id: 900, first_name: 'Dami' }, text: '/ideas' } });
  assert.match(sent.pop().text, /Open polls \(2\)/);

  sent = []; await updatesCheck(env);
  const set = sent.find(s => s.method === 'setWebhook');
  assert.equal(set.url, 'https://api.test/telegram/webhook'); assert.ok(set.allowed_updates.includes('callback_query')); assert.ok(set.secret_token);
  sent = []; await updatesCheck(env); assert.deepEqual(sent, []);                                    // once
  const env2 = makeEnv(); hook = { url: 'https://elsewhere.test/hook' }; sent = [];
  await updatesCheck(env2); assert.equal(sent.some(s => s.method === 'setWebhook'), false);         // never moves a webhook that points elsewhere
});
