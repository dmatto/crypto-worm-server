import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Stand-ins: node:sqlite for D1, Workers' websockets for the Match object, a lobby that records what it was told, and
// Telegram's Bot API recorded in `calls`.
class FakeWS { constructor() { this.out = []; this.closed = false } send(m) { this.out.push(JSON.parse(m)) } close() { this.closed = true } }
globalThis.WebSocketPair = class { constructor() { const a = new FakeWS(), b = new FakeWS(); this[0] = a; this[1] = b } };
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { constructor(b, i = {}) { super(b, i.status === 101 ? { status: 200 } : i); this.ws = i.webSocket; this.code = i.status } static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const calls = [];
globalThis.fetch = async (url, init) => { calls.push([String(url).split('/').pop(), JSON.parse(init.body)]); return Response.json({ ok: true, result: {} }) };
const { default: worker } = await import('../src/index.js');
const { Match } = await import('../src/match.js');
const { sweep, NEXT_MS, FIRST_MS, OPEN_MS } = await import('../src/wager.js');

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const env = { DB, sql, SESSION_SECRET: 'test-secret', BOT_TOKEN: '123:BOT', GAME_LINK: 'https://t.me/CryptoWormWarsBot/play', told: [], here: new Set(), wagers: null, rooms: new Map() };
  env.LOBBY = { idFromName: n => n, get: () => ({ fetch: async (u, init) => {
    const path = new URL(u).pathname, b = init && init.body ? JSON.parse(init.body) : {};
    if (path === '/tell') { env.told.push([b.id, b.msg]); return Response.json({ ok: env.here.has(b.id) }) }
    if (path === '/wagers') { env.wagers = b.n; return Response.json({ ok: true }) }
    if (path === '/online') return Response.json({ online: [...env.here] });
    return Response.json({ ok: true }) } }) };
  env.MATCH = { idFromName: n => n, get: code => { if (!env.rooms.has(code)) env.rooms.set(code, room(env)); return env.rooms.get(code).m } };
  return env;
}
function room(env) {
  const socks = new Map(), store = new Map();
  const ctx = { socks, acceptWebSocket(ws, tags) { ws.tags = tags; socks.set(tags[0], ws) }, getWebSockets(tag) { const w = socks.get(tag); return w ? [w] : [] }, getTags(ws) { return ws.tags },
    storage: { async get(k) { return store.get(k) }, async put(k, v) { store.set(k, structuredClone(v)) }, async setAlarm() { }, async delete(k) { store.delete(k) } } };
  return { m: new Match(ctx, env), ctx };
}
const call = async (env, path, body, token) => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, {});
  return { status: r.status, ...(await r.json()) };
};
// a player who has played `n` matches and earned `cworm` ranked play money
async function player(env, name, n = 3, cworm = 5000) {
  const g = await call(env, '/auth/guest', {});
  env.sql.prepare('UPDATE players SET name = ? WHERE id = ?').run(name, g.player.id);
  env.sql.prepare('INSERT INTO player_meta (player, played) VALUES (?, ?) ON CONFLICT(player) DO UPDATE SET played = excluded.played').run(g.player.id, n);
  env.sql.prepare('INSERT INTO cworm_scores (player, total) VALUES (?, ?)').run(g.player.id, cworm);
  return { id: g.player.id, token: g.token, name };
}
// open a series game's match as index.js does (the route checks the player), then play it: the host phone starts, the
// game ends with `win` (0 or 1: the seat that won, -1: a draw)
const enter = async (env, code, p) => (await worker.fetch(new Request(`https://api.test/match/${code}/ws?token=x`, { headers: { Upgrade: 'websocket', authorization: 'Bearer ' + p.token } }), env, {}));
async function game(env, code, a, b, win) {
  await enter(env, code, a); await enter(env, code, b);
  const { m, ctx } = env.rooms.get(code), s0 = ctx.socks.get('0'), s1 = ctx.socks.get('1');
  await m.webSocketMessage(s1, JSON.stringify({ t: 'join', hat: 'team' }));
  await m.webSocketMessage(s0, JSON.stringify({ t: 'start', seed: 1, theme: 'island', count: 1, hats: [] }));
  const started = [s0.out.at(-1), s1.out.at(-1)];
  await m.webSocketMessage(s0, JSON.stringify({ t: 'f', e: [['gameOver', [win]]], s: {} }));
  return { started, ended: [s0.out.at(-1), s1.out.at(-1)], m, s0, s1 };
}
const rewards = (env, id) => env.sql.prepare('SELECT amount, reason, note FROM rewards WHERE player = ? ORDER BY id').all(id).map(r => [r.amount, r.reason, r.note]);

test('wager: post, take, best of 3 with a draw replayed, the winner gets both stakes', async () => {
  const env = makeEnv(); calls.length = 0;
  const ana = await player(env, 'Ana'), bo = await player(env, 'Bo'), cy = await player(env, 'Cy');
  env.sql.prepare('UPDATE players SET tg_id = 77 WHERE id = ?').run(ana.id);
  assert.equal((await call(env, '/wager/new', { stake: 50 }, ana.token)).status, 400);           // below the smallest stake
  assert.equal((await call(env, '/wager/new', { stake: 6000 }, ana.token)).code, 'max');          // more than the server has seen her earn
  const posted = await call(env, '/wager/new', { stake: 1000 }, ana.token);
  assert.equal(posted.status, 200); assert.equal(posted.mine.state, 'open'); assert.equal(posted.mine.pot, 2000); assert.equal(env.wagers, 1);
  assert.equal((await call(env, '/wager/new', { stake: 500 }, ana.token)).code, 'busy');           // one at a time
  const id = posted.mine.id;
  const seen = await call(env, '/wagers', undefined, bo.token);
  assert.deepEqual(seen.open.map(o => [o.id, o.stake, o.by.name]), [[id, 1000, 'Ana']]); assert.equal(seen.max, 5000);
  assert.equal((await call(env, '/wager/take', { id }, ana.token)).status, 400);                // not her own
  const took = await call(env, '/wager/take', { id }, bo.token);
  assert.equal(took.mine.state, 'taken'); assert.equal(took.mine.opp.name, 'Ana'); assert.match(took.mine.code, /^[A-Z2-9]{6}$/);
  assert.equal(env.wagers, 0);
  assert.equal((await call(env, '/wager/take', { id }, cy.token)).code, 'gone');
  assert.deepEqual(env.told.at(-1), [ana.id, { t: 'wager', ev: 'taken', id, by: 'Bo', stake: 1000 }]);   // Ana wasn't in the game: the bot tells her
  const dm = calls.find(([m, b]) => m === 'sendMessage' && b.chat_id === 77);
  assert.match(dm[1].text, /Bo took your 1,000 \$CWORM challenge/); assert.match(dm[1].text, /play money/);
  assert.equal(dm[1].reply_markup.inline_keyboard[0][0].url, 'https://t.me/CryptoWormWarsBot/play?startapp=b_' + id);

  // only the two players get into the series' matches
  const code1 = took.mine.code;
  assert.equal((await enter(env, code1, cy)).status, 403);
  // game 1: Bo opens it first (seat 0) and wins
  let g = await game(env, code1, bo, ana, 0);
  assert.deepEqual(g.started.map(s => [s.t, s.at, s.game, s.owe]), [['series', 'start', 1, true], ['series', 'start', 1, true]]);
  assert.deepEqual(g.ended.map(s => [s.at, s.score, s.done]), [['end', [1, 0], false], ['end', [0, 1], false]]);
  const code2 = g.ended[0].next; assert.match(code2, /^[A-Z2-9]{6}$/); assert.notEqual(code2, code1);
  assert.equal((await call(env, '/wager/paid', { id }, bo.token)).ok, true);
  assert.equal((await call(env, '/wagers', undefined, bo.token)).mine.owe, false);
  assert.equal((await call(env, '/wagers', undefined, ana.token)).mine.owe, true);
  assert.equal((await call(env, '/wagers', undefined, ana.token)).max, 4000);                  // her stake is in
  // a bot start is never allowed in a series room
  await enter(env, code2, ana); const r2 = env.rooms.get(code2);
  await r2.m.webSocketMessage(r2.ctx.socks.get('0'), JSON.stringify({ t: 'start', seed: 1, bot: { name: 'Robo', team: 1 } }));
  assert.equal(r2.m.mem.start, null);
  // game 2: a draw is played again; game 3 Ana wins; game 4 Ana wins the series 2-1
  g = await game(env, code2, ana, bo, -1);
  assert.deepEqual(g.ended[0].score, [0, 1]); assert.equal(g.ended[0].done, false);
  g = await game(env, g.ended[0].next, ana, bo, 0);
  assert.deepEqual(g.ended[0].score, [1, 1]);
  assert.deepEqual(rewards(env, ana.id), []);
  g = await game(env, g.ended[0].next, bo, ana, 1);
  assert.deepEqual(g.ended.map(s => [s.score, s.done, s.won, s.next]), [[[1, 2], true, false, null], [[2, 1], true, true, null]]);
  assert.deepEqual(rewards(env, ana.id), [[2000, 'wager', 'Bo']]);
  assert.deepEqual(rewards(env, bo.id), []);
  const w = env.sql.prepare('SELECT * FROM wagers WHERE id = ?').get(id);
  assert.deepEqual([w.state, w.winner, w.why, w.games, w.w0, w.w1], ['done', ana.id, 'won', 4, 2, 1]);
  const last = (await call(env, '/wagers', undefined, bo.token)).last;
  assert.deepEqual([last.won, last.draw, last.score, last.why], [false, false, [1, 2], 'won']);
  assert.equal((await call(env, '/wagers', undefined, bo.token)).mine, null);
  // the finished series' old codes are ordinary rooms again, already over
  assert.equal((await enter(env, code1, cy)).code, 410);
});

test('wager: who can post or take, cancelling, giving up, expiring and not turning up', async () => {
  const env = makeEnv(); const t0 = Date.now();
  const ana = await player(env, 'Ana'), bo = await player(env, 'Bo'), kid = await player(env, 'Kid', 1);
  assert.equal((await call(env, '/wager/new', { stake: 100 }, kid.token)).code, 'played');     // 3 matches first
  let p = await call(env, '/wager/new', { stake: 200 }, ana.token);
  assert.equal((await call(env, '/wager/take', { id: p.mine.id }, kid.token)).code, 'played');
  // cancel an open one
  let c = await call(env, '/wager/cancel', { id: p.mine.id }, ana.token);
  assert.equal(c.mine, null); assert.equal(c.last.state, 'off'); assert.equal(c.last.why, 'cancelled');
  assert.equal((await call(env, '/wagers', undefined, bo.token)).open.length, 0);
  // taken but game 1 never starts: called off, nothing moved
  p = await call(env, '/wager/new', { stake: 300 }, ana.token);
  await call(env, '/wager/take', { id: p.mine.id }, bo.token);
  assert.equal(await sweep(env, t0 + FIRST_MS / 2), 0);
  assert.equal(await sweep(env, t0 + FIRST_MS + 1000), 1);
  assert.deepEqual(({ ...env.sql.prepare('SELECT state, why FROM wagers WHERE id = ?').get(p.mine.id) }), { state: 'off', why: 'noshow' });
  assert.deepEqual([rewards(env, ana.id), rewards(env, bo.id)], [[], []]);
  // an open one expires
  p = await call(env, '/wager/new', { stake: 400 }, ana.token);
  await sweep(env, t0 + OPEN_MS + 1000);
  assert.equal(env.sql.prepare('SELECT state FROM wagers WHERE id = ?').get(p.mine.id).state, 'off');
  // between games, the player who turns up for the next one wins
  p = await call(env, '/wager/new', { stake: 500 }, ana.token);
  let took = await call(env, '/wager/take', { id: p.mine.id }, bo.token);
  let g = await game(env, took.mine.code, ana, bo, 0);
  await enter(env, g.ended[1].next, bo);                                                       // only Bo comes back
  await sweep(env, Date.now() + NEXT_MS + 1000);
  assert.deepEqual(({ ...env.sql.prepare('SELECT state, why, winner FROM wagers WHERE id = ?').get(p.mine.id) }), { state: 'done', why: 'noshow', winner: bo.id });
  assert.deepEqual(rewards(env, bo.id), [[1000, 'wager', 'Ana']]);
  // nobody comes back at 1-1: each stake goes back
  p = await call(env, '/wager/new', { stake: 600 }, ana.token);
  took = await call(env, '/wager/take', { id: p.mine.id }, bo.token);
  g = await game(env, took.mine.code, ana, bo, 0); g = await game(env, g.ended[0].next, ana, bo, 1);
  await sweep(env, Date.now() + NEXT_MS + 1000);
  assert.deepEqual(({ ...env.sql.prepare('SELECT state, why, winner FROM wagers WHERE id = ?').get(p.mine.id) }), { state: 'done', why: 'noshow', winner: null });
  assert.deepEqual(rewards(env, ana.id), [[600, 'wagerback', 'Bo']]); assert.deepEqual(rewards(env, bo.id).at(-1), [600, 'wagerback', 'Ana']);
  // giving up mid-series: the other player wins
  p = await call(env, '/wager/new', { stake: 700 }, bo.token);
  took = await call(env, '/wager/take', { id: p.mine.id }, ana.token);
  await game(env, took.mine.code, ana, bo, 0);
  c = await call(env, '/wager/cancel', { id: p.mine.id }, ana.token);
  assert.deepEqual([c.last.why, c.last.won], ['forfeit', false]);
  assert.deepEqual(rewards(env, bo.id).at(-1), [1400, 'wager', 'Ana']);
  assert.ok(env.told.some(([id, m]) => id === bo.id && m.ev === 'done' && m.won));
});
