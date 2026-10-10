import test from 'node:test';
import assert from 'node:assert/strict';

class FakeWS { constructor() { this.out = []; this.closed = false } send(m) { this.out.push(JSON.parse(m)) } close() { this.closed = true } }
globalThis.WebSocketPair = class { constructor() { this[0] = new FakeWS(); this[1] = new FakeWS() } };
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { constructor(body, init = {}) { const s = init.status; super(body, s === 101 ? { status: 200 } : init); this.ws = init.webSocket; this.code = s } static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const { Match } = await import('../src/match.js');
const { Lobby } = await import('../src/lobby.js');

// Several sockets per tag (viewers share the tag 'v'), and a real Lobby object behind env.LOBBY.
function ctx() {
  const socks = [], store = new Map();
  return {
    socks, acceptWebSocket(ws, tags) { ws.tags = tags; socks.push(ws) },
    getWebSockets(tag) { return socks.filter(w => !w.closed && (tag == null || w.tags[0] === tag)) }, getTags(ws) { return ws.tags },
    storage: { async get(k) { return store.get(k) }, async put(k, v) { store.set(k, structuredClone(v)) }, async setAlarm() { }, async delete(k) { store.delete(k) } },
  };
}
function env() {
  const lobby = new Lobby(ctx(), {});
  const DB = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ id: 11, name: 'Alice' }, { id: 22, name: 'Bob' }] }), run: async () => ({}) }) }), batch: async () => [] };
  return { lobby, DB, LOBBY: { idFromName: n => n, get: () => ({ fetch: (u, i) => lobby.fetch(new Request(u, i)) }) } };
}
const open = (m, player) => m.fetch(new Request('https://x/match/ABCDEF/ws', { headers: { Upgrade: 'websocket', 'x-player': String(player) } }));
const watch = m => m.fetch(new Request('https://x/match/ABCDEF/watch', { headers: { Upgrade: 'websocket' } }));
const sock = (c, tag, i = 0) => c.socks.filter(w => w.tags[0] === tag)[i];

test('watch: a viewer waits, then follows the match, cheers, and the match shows in Live now until it ends', async () => {
  const c = ctx(), e = env(), m = new Match(c, e);
  await open(m, 11); await open(m, 22);
  await watch(m); const v1 = sock(c, 'v');
  assert.deepEqual(v1.out[0], { t: 'wait' });
  assert.deepEqual(sock(c, '0').out.at(-1), { t: 'viewers', n: 1 });          // players see they have an audience
  await m.webSocketMessage(sock(c, '0'), JSON.stringify({ t: 'start', seed: 5, theme: 'moon', count: 2, hats: ['team', 'team'] }));
  const w = v1.out.find(x => x.t === 'watch');
  assert.equal(w.start.seed, 5); assert.deepEqual(w.names, ['Alice', 'Bob']);
  let live = await (await e.lobby.fetch(new Request('https://lobby/live'))).json();
  assert.equal(live.live.length, 1); assert.equal(live.live[0].code, 'ABCDEF'); assert.deepEqual(live.live[0].names, ['Alice', 'Bob']); assert.deepEqual(live.live[0].ids, [11, 22]);

  await m.webSocketMessage(sock(c, '0'), JSON.stringify({ t: 'f', n: 3, e: [['carve', [1, 2, 3]]], s: { a: 1 } }));
  assert.equal(v1.out.at(-1).t, 'f');
  await m.webSocketMessage(sock(c, '0'), JSON.stringify({ t: 'auth', n: 6, e: [], s: { a: 2 } }));
  assert.equal(v1.out.at(-1).t, 'auth');
  await m.webSocketMessage(sock(c, '1'), JSON.stringify({ t: 'chat', id: 3 }));
  assert.deepEqual(v1.out.at(-1), { t: 'chat', id: 3, side: 1 });

  await watch(m); const v2 = sock(c, 'v', 1);                                    // a late viewer catches up from the saved state
  const w2 = v2.out[0]; assert.equal(w2.t, 'watch'); assert.deepEqual(w2.s, { a: 2 }); assert.deepEqual(w2.carves, [[1, 2, 3]]); assert.equal(w2.viewers, 2);

  await m.webSocketMessage(v1, JSON.stringify({ t: 'cheer', id: 2 }));
  assert.deepEqual(sock(c, '1').out.at(-1), { t: 'cheer', id: 2 }); assert.deepEqual(v2.out.at(-1), { t: 'cheer', id: 2 });
  const n = v2.out.length;
  await m.webSocketMessage(v1, JSON.stringify({ t: 'cheer', id: 2 }));            // too soon
  await m.webSocketMessage(v1, JSON.stringify({ t: 'cheer', id: 9 }));            // not a cheer
  await m.webSocketMessage(v1, JSON.stringify({ t: 'f', e: [], s: {} }));         // viewers can't play
  await m.webSocketMessage(v1, JSON.stringify({ t: 'bye' }));
  assert.equal(v2.out.length, n); assert.equal(m.mem.done, null);

  v2.closed = true; await m.webSocketClose(v2);
  assert.deepEqual(sock(c, '0').out.at(-1), { t: 'viewers', n: 1 });
  await m.webSocketMessage(sock(c, '1'), JSON.stringify({ t: 'bye' }));
  assert.deepEqual(v1.out.at(-1), { t: 'over', winner: 0, reason: 'left' });
  live = await (await e.lobby.fetch(new Request('https://lobby/live'))).json();
  assert.equal(live.live.length, 0);
  assert.equal((await watch(m)).code, 410);                                      // nothing to watch after the end
});
