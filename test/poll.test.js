import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const { default: worker } = await import('../src/index.js');
const P = await import('../src/poll.js');

const sent = [];
globalThis.fetch = async (url, init) => {
  const u = String(url), body = init && init.body ? JSON.parse(init.body) : {};
  if (u.includes('api.telegram.org')) { sent.push({ method: u.split('/').pop(), ...body }); return RealResponse.json({ ok: true, result: { status: 'left' } }) }
  return RealResponse.json({}, { status: 404 });
};
function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const LOBBY = { idFromName: n => n, get: () => ({ fetch: async () => Response.json({ online: [] }) }) };
  return { DB, sql, LOBBY, SESSION_SECRET: 'test-secret', SIGNIN_DOMAIN: 'example.test', BOT_TOKEN: 'bot', PUBLIC_URL: 'https://api.test' };
}
const call = async (env, path, body, token) => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { status: r.status, ...(await r.json()) };
};
const guest = async env => { const s = await call(env, '/auth/guest', {}); return { token: s.token, id: s.player.id } };
const played = (env, id, n) => env.sql.prepare('INSERT INTO player_meta (player, played) VALUES (?, ?) ON CONFLICT(player) DO UPDATE SET played = excluded.played').run(id, n);
const POLL = P.POLLS[0], MID = POLL.from + 864e5, vote = (env, id, choice, now = MID, sim = false) => P.handle('/poll/vote', env, { id }, { id: POLL.id, choice }, { post: true, sim }, now);

test('poll: real players with 3 matches vote once each, can change it, and see the results after voting', async () => {
  const env = makeEnv();
  for (const id of [1, 2, 3, 4]) env.sql.prepare("INSERT INTO players (id, name, created) VALUES (?, 'p', 0)").run(id);
  played(env, 1, 3); played(env, 2, 9); played(env, 3, 2);
  assert.equal(P.current(POLL.from - 1), null); assert.equal(P.current(MID).id, POLL.id); assert.equal(P.current(POLL.ends + 8 * 864e5), null);

  let c = await P.card(env, { id: 1 }, MID);
  assert.deepEqual(c, { id: POLL.id, n: 3, ends: POLL.ends, starts: POLL.starts, open: true, need: 3, played: 3, can: true, mine: null });   // no counts before voting
  c = await P.card(env, { id: 3 }, MID); assert.equal(c.can, false); assert.equal(c.played, 2);
  const no = await vote(env, 3, 1); assert.equal(no.status, 403); assert.match(no.error, /finish 3 matches/);
  assert.equal((await vote(env, 4, 1)).status, 403);                                             // never played
  assert.equal((await vote(env, 1, 3)).status, 400); assert.equal((await vote(env, 1, 1.5)).status, 400);
  assert.equal((await P.handle('/poll/vote', env, { id: 1 }, { id: 'old', choice: 1 }, { post: true }, MID)).status, 404);
  assert.equal((await vote(env, 2, 1, MID, true)).status, 403);                                   // load-test bots never vote

  let r = await vote(env, 1, 1);
  assert.equal(r.poll.mine, 1); assert.deepEqual(r.poll.counts, [0, 1, 0]); assert.equal(r.poll.total, 1);
  r = await vote(env, 2, 2); assert.deepEqual(r.poll.counts, [0, 1, 1]);
  r = await vote(env, 1, 0); assert.equal(r.poll.mine, 0); assert.deepEqual(r.poll.counts, [1, 0, 1]);   // changed, still one vote
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM poll_votes').get().n, 2);

  const late = await vote(env, 2, 0, POLL.ends); assert.equal(late.status, 409);                  // closed: no more votes
  c = await P.card(env, { id: 3 }, POLL.ends + 1000);                                              // after the end everyone sees the results
  assert.equal(c.open, false); assert.equal(c.can, false); assert.deepEqual(c.counts, [1, 0, 1]);
});

test('poll: /poll shows admins the votes, holders and others apart; merged accounts keep one vote', async () => {
  const env = makeEnv();
  for (const [id, w] of [[1, 'W1'], [2, 'W2'], [3, null], [4, null], [5, null]]) env.sql.prepare("INSERT INTO players (id, name, wallet, created) VALUES (?, 'p', ?, 0)").run(id, w);
  for (const id of [1, 2, 3, 4, 5]) env.sql.prepare('INSERT INTO player_meta (player, played, last_seen) VALUES (?, 5, ?)').run(id, MID);
  env.sql.prepare("INSERT INTO holders (player, wallet, tier) VALUES (1, 'W1', 1), (2, 'OLD', 2)").run();   // 2's tier is for an old wallet: not a holder now
  await vote(env, 1, 1); await vote(env, 2, 1); await vote(env, 3, 2); await vote(env, 4, 1);
  const t = await P.resultsText(env, MID);
  assert.match(t, /Votes: 4 \(holders 1, others 3\)/);
  assert.match(t, /Could vote \(3\+ matches, seen in the last 7 days\): 5/);
  assert.match(t, /2\. Holder bonus[^\n]*\n\s+<b>3<\/b> \(75%\) · holders 1, others 2/);
  assert.match(t, /Leading: 2\. Holder bonus$/);
  assert.match(await P.resultsText(env, POLL.ends + 1), /Closed Fri 6 Nov/);

  await P.mergePoll(env, 4, 3);                                                                     // 3 keeps its own vote
  await P.mergePoll(env, 5, 1);                                                                     // nothing to move
  assert.deepEqual(env.sql.prepare('SELECT player, choice FROM poll_votes ORDER BY player').all().map(r => [r.player, r.choice]), [[1, 1], [2, 1], [3, 2]]);
});

test('poll: the routes and the prize card carry it; the bot answers /poll for admins only', async () => {
  const env = makeEnv(), a = await guest(env);
  const g = await call(env, '/poll', undefined, a.token);
  assert.equal(g.status, 200); assert.ok('poll' in g);
  const live = P.current();
  const pz = await call(env, '/prize', undefined, a.token);
  if (pz.on && live) { assert.equal(pz.poll.id, live.id); assert.equal(pz.poll.can, false) } else assert.equal(pz.poll, undefined);
  const v = await call(env, '/poll/vote', { id: POLL.id, choice: 1 }, a.token);
  assert.ok([403, 404, 409].includes(v.status));                                                     // no matches yet (or no poll now)

  env.ADMIN_PLAYERS = '999'; env.sql.prepare("INSERT INTO players (id, tg_id, name, created) VALUES (999, 777, 'Damian', 0)").run();
  const tgMsg = async (text, from) => { sent.length = 0;
    await worker.fetch(new Request('https://api.test/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': createHash('sha256').update('webhook:' + env.SESSION_SECRET).digest('hex').slice(0, 48) },
      body: JSON.stringify({ message: { chat: { id: from, type: 'private' }, from: { id: from }, text } }) }), env);
    return sent.map(x => x.text).join('\n') };
  assert.match(await tgMsg('/poll', 777), /🗳️ <b>Poll: Weekly prize rules[\s\S]*Votes: 0/);
  assert.doesNotMatch(await tgMsg('/poll', 555), /Votes:/);
});
