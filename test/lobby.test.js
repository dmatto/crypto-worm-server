import test from 'node:test';
import assert from 'node:assert/strict';

class FakeWS { constructor() { this.out = [] } send(m) { this.out.push(JSON.parse(m)) } close() { this.closed = true } serializeAttachment(v) { this.att = structuredClone(v) } deserializeAttachment() { return this.att } }
globalThis.WebSocketPair = class { constructor() { this[0] = new FakeWS(); this[1] = new FakeWS() } };
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { constructor(b, i = {}) { super(b, i.status === 101 ? { status: 200 } : i) } static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const { Lobby } = await import('../src/lobby.js');

function ctx() {
  const socks = [];
  return { socks, acceptWebSocket(ws, tags) { ws.tags = tags; socks.push(ws) }, getWebSockets: tag => socks.filter(w => !w.closed && (tag == null || w.tags.includes(tag))), storage: { get: async () => null, put: async () => { }, delete: async () => { } } };
}
async function enter(l, c, id, name, hidden) {
  await l.fetch(new Request('https://lobby/ws' + (hidden ? '?hidden=1' : ''), { headers: { Upgrade: 'websocket', 'x-player': String(id), 'x-name': encodeURIComponent(name), 'x-wins': '2', 'x-losses': '1' } }));
  return c.socks.at(-1);
}
const say = (l, ws, m) => l.webSocketMessage(ws, JSON.stringify(m));
const last = (ws, t) => ws.out.filter(m => m.t === t).at(-1);

test('lobby: lists who is around, carries challenges, declines and cancels', async () => {
  const c = ctx(), l = new Lobby(c, {});
  const a = await enter(l, c, 1, 'Ana'), b = await enter(l, c, 2, 'Bo'), h = await enter(l, c, 3, 'Hid', true);
  assert.deepEqual(last(a, 'list').players.map(p => p.name), ['Ana', 'Bo']);         // hidden players aren't listed
  await say(l, a, { t: 'challenge', to: 2 });
  const sent = last(a, 'sent'), got = last(b, 'challenged');
  assert.equal(sent.to.name, 'Bo'); assert.equal(got.code, sent.code); assert.equal(got.from.name, 'Ana'); assert.equal(got.from.wins, 2);
  await say(l, b, { t: 'decline', code: got.code, from: 1 });
  assert.equal(last(a, 'declined').by.name, 'Bo');
  l.recent.clear(); await say(l, a, { t: 'challenge', to: 3 });                       // hidden and not a friend: nothing
  assert.equal(last(a, 'none').t, 'none'); assert.equal(last(h, 'challenged'), undefined);
  await say(l, b, { t: 'busy', on: true });
  assert.equal(last(a, 'list').players.find(p => p.id === 2).busy, true);
  l.recent.clear(); await say(l, a, { t: 'challenge', to: 'random' });                // the only other player is busy
  assert.equal(a.out.at(-1).t, 'none');
  await say(l, b, { t: 'busy', on: false }); l.recent.clear(); await say(l, a, { t: 'challenge', to: 'random' });
  assert.equal(a.out.at(-1).t, 'sent'); assert.equal(a.out.at(-1).to.id, 2);
  await say(l, a, { t: 'cancel', code: a.out.at(-1).code, to: 2 });
  assert.equal(last(b, 'cancelled').code, a.out.at(-1).code);
  b.closed = true; await l.webSocketClose(b);
  assert.deepEqual(last(a, 'list').players.map(p => p.name), ['Ana']);
  const r = await (await l.fetch(new Request('https://lobby/online?ids=1,2,3'))).json();
  assert.deepEqual(r.online, [1]);
});

test('lobby: a second tab for the same player replaces the first', async () => {
  const c = ctx(), l = new Lobby(c, {});
  const a1 = await enter(l, c, 1, 'Ana'); await enter(l, c, 1, 'Ana');
  assert.equal(a1.closed, true);
});

test('lobby: quick match pairs two players on one code', async () => {
  const store = new Map(), c = { ...ctx(), storage: { get: async k => store.get(k), put: async (k, v) => void store.set(k, v), delete: async k => void store.delete(k) } }, l = new Lobby(c, {});
  const one = await (await l.fetch(new Request('https://lobby/?player=1'))).json(), two = await (await l.fetch(new Request('https://lobby/?player=2'))).json();
  assert.equal(one.side, 0); assert.equal(two.side, 1); assert.equal(one.code, two.code);
});
