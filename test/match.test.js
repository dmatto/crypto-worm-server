import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal stand-ins for the Workers runtime pieces the Match object uses.
class FakeWS { constructor() { this.out = []; this.closed = false } send(m) { this.out.push(JSON.parse(m)) } close() { this.closed = true } }
globalThis.WebSocketPair = class { constructor() { const a = new FakeWS(), b = new FakeWS(); this[0] = a; this[1] = b } };
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { constructor(body, init = {}) { const s = init.status; super(body, s === 101 ? { status: 200 } : init); this.ws = init.webSocket; this.code = s } };
const { Match } = await import('../src/match.js');

function ctx() {
  const socks = new Map(), store = new Map();
  return {
    socks, acceptWebSocket(ws, tags) { ws.tags = tags; socks.set(tags[0], ws) },
    getWebSockets(tag) { const w = socks.get(tag); return w ? [w] : [] }, getTags(ws) { return ws.tags },
    storage: { async get(k) { return store.get(k) }, async put(k, v) { store.set(k, structuredClone(v)) }, async setAlarm() { }, async delete(k) { store.delete(k) } },
  };
}
const open = (m, player) => m.fetch(new Request('https://x/match/ABCDEF/ws', { headers: { Upgrade: 'websocket', 'x-player': String(player) } }));

test('match: seats two players, relays, enforces whose turn it is, hands over', async () => {
  const c = ctx(), m = new Match(c, {});
  await open(m, 11); await open(m, 22);
  const s0 = c.socks.get('0'), s1 = c.socks.get('1');
  assert.deepEqual(s0.out[0], { t: 'seat', side: 0 }); assert.deepEqual(s1.out[0], { t: 'seat', side: 1 });
  assert.equal((await open(m, 33)).code, 409);                                   // a third player is turned away
  await m.webSocketMessage(s1, JSON.stringify({ t: 'join', hat: 'crown' }));
  assert.equal(s0.out.at(-1).t, 'join');
  await m.webSocketMessage(s1, JSON.stringify({ t: 'start', seed: 5 }));          // only the host starts
  assert.equal(s0.out.at(-1).t, 'join');
  await m.webSocketMessage(s0, JSON.stringify({ t: 'start', seed: 5, theme: 'moon', count: 2, hats: ['team', 'crown'] }));
  assert.equal(s1.out.at(-1).t, 'start'); assert.equal(s1.out.at(-1).seed, 5);
  await m.webSocketMessage(s1, JSON.stringify({ t: 'f', e: [], s: {} }));        // not side 1's turn: dropped
  const before = s0.out.length;
  await m.webSocketMessage(s1, JSON.stringify({ t: 'f', e: [], s: {} }));
  assert.equal(s0.out.length, before);
  await m.webSocketMessage(s0, JSON.stringify({ t: 'f', e: [['carve', [1, 2, 3]]], s: { a: 1 } }));
  assert.equal(s1.out.at(-1).t, 'f');
  await m.webSocketMessage(s0, JSON.stringify({ t: 'auth', e: [], s: { turn: 2 } }));
  assert.equal(s1.out.at(-1).t, 'auth'); assert.equal(m.mem.holder, 1);
  await m.webSocketMessage(s1, JSON.stringify({ t: 'f', e: [], s: {} }));
  assert.equal(s0.out.at(-1).t, 'f');
});

test('match: a dropped phone resumes with the last handed-over state', async () => {
  const c = ctx(), m = new Match(c, {});
  await open(m, 1); await open(m, 2);
  await m.webSocketMessage(c.socks.get('0'), JSON.stringify({ t: 'start', seed: 9, theme: 'ice', count: 1, hats: [] }));
  await m.webSocketMessage(c.socks.get('0'), JSON.stringify({ t: 'f', e: [['carve', [100, 200, 30]], ['floatText', [1, 2, 'x', '#fff']]], s: {} }));
  await m.webSocketMessage(c.socks.get('0'), JSON.stringify({ t: 'auth', e: [['carve', [5, 6, 7]]], s: { turn: 1 } }));
  const old = c.socks.get('1'); await open(m, 2);
  assert.equal(old.closed, true);
  const r = c.socks.get('1').out[0];
  assert.equal(r.t, 'resume'); assert.equal(r.side, 1); assert.equal(r.auth, true); assert.deepEqual(r.s, { turn: 1 }); assert.equal(r.start.seed, 9);
  assert.deepEqual(r.carves, [[100, 200, 30], [5, 6, 7]]);
});

test('match: game over and leaving are recorded once', async () => {
  const c = ctx(), m = new Match(c, {});
  await open(m, 1); await open(m, 2);
  await m.webSocketMessage(c.socks.get('0'), JSON.stringify({ t: 'start', seed: 1, theme: 'island', count: 1, hats: [] }));
  await m.webSocketMessage(c.socks.get('0'), JSON.stringify({ t: 'f', e: [['gameOver', [0]]], s: {} }));
  assert.deepEqual([m.mem.done.winner, m.mem.done.reason], [0, 'played']);
  assert.equal(c.socks.get('1').out.at(-1).t, 'over');
  await m.webSocketMessage(c.socks.get('1'), JSON.stringify({ t: 'bye' }));
  assert.equal(m.mem.done.reason, 'played');
  assert.equal((await open(m, 1)).code, 410);
});

test('match: quick chat relays only a line number, from either side, at most every 1.5 s', async () => {
  const c = ctx(), m = new Match(c, {});
  await open(m, 11); await open(m, 22);
  const s0 = c.socks.get('0'), s1 = c.socks.get('1');
  await m.webSocketMessage(s1, JSON.stringify({ t: 'chat', id: 1 }));               // nothing before the match starts
  assert.notEqual(s0.out.at(-1).t, 'chat');
  await m.webSocketMessage(s0, JSON.stringify({ t: 'start', seed: 5 }));
  await m.webSocketMessage(s1, JSON.stringify({ t: 'chat', id: 3, text: 'anything' }));   // the other side can talk on any turn
  assert.deepEqual(s0.out.at(-1), { t: 'chat', id: 3 });
  const n = s0.out.length;
  await m.webSocketMessage(s1, JSON.stringify({ t: 'chat', id: 4 }));               // too soon
  await m.webSocketMessage(s0, JSON.stringify({ t: 'chat', id: 'x' }));             // not a number
  await m.webSocketMessage(s0, JSON.stringify({ t: 'chat', id: 99 }));              // not on the list
  assert.equal(s0.out.length, n); assert.notEqual(s1.out.at(-1).t, 'chat');
  await m.webSocketMessage(s0, JSON.stringify({ t: 'chat', id: 0 }));
  assert.deepEqual(s1.out.at(-1), { t: 'chat', id: 0 });
});

test('match: both phones get each player\'s country for the flag, unknown ones as null', async () => {
  const c = ctx(), m = new Match(c, {});
  const at = (player, cc) => m.fetch(new Request('https://x/match/ABCDEF/ws', { headers: { Upgrade: 'websocket', 'x-player': String(player), 'x-country': cc } }));
  await at(11, 'br'); await at(22, 'XX');
  const s0 = c.socks.get('0'), s1 = c.socks.get('1');
  assert.deepEqual(s0.out.at(-1), { t: 'flags', cc: ['BR', null] }); assert.deepEqual(s1.out.at(-1), { t: 'flags', cc: ['BR', null] });
  await at(22, 'UY');                                                              // rejoining from somewhere else updates it
  assert.deepEqual(s0.out.at(-1), { t: 'flags', cc: ['BR', 'UY'] });
});
