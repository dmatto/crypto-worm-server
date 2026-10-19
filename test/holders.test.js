import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

class FakeWS { constructor() { this.out = [] } send(m) { this.out.push(JSON.parse(m)) } close() { this.closed = true } serializeAttachment(v) { this.att = structuredClone(v) } deserializeAttachment() { return this.att } }
globalThis.WebSocketPair = class { constructor() { this[0] = new FakeWS(); this[1] = new FakeWS() } };
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { constructor(b, i = {}) { super(b, i.status === 101 ? { status: 200 } : i); this.ws = i.webSocket } static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const { default: worker } = await import('../src/index.js');
const H = await import('../src/holders.js');
const { Lobby } = await import('../src/lobby.js');

// A fake Solana RPC: balances by wallet, and the biggest token accounts (owner -> amount, program-owned owners marked).
const chain = { bal: {}, big: [], program: new Set(), fail: false, calls: 0, ata: new Map() }, TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM = '11111111111111111111111111111111';
globalThis.fetch = async (url, init) => {
  chain.calls++; if (chain.fail) return new RealResponse('down', { status: 503 });
  const body = JSON.parse(init.body), one = r => {
    if (r.method === 'getAccountInfo') return { id: r.id, result: { value: { owner: TOKEN } } };
    if (r.method === 'getMultipleAccounts' && r.params[0].some(a => chain.ata.has(a))) return { id: r.id, result: { value: r.params[0].map(a => { const n = chain.bal[chain.ata.get(a)];
      return n == null ? null : { owner: TOKEN, data: { parsed: { info: { tokenAmount: { uiAmountString: String(n) } } } } } }) } };
    if (r.method === 'getTokenLargestAccounts') return { id: r.id, result: { value: chain.big.map(([o, n]) => ({ address: 'ta_' + o, uiAmountString: String(n) })) } };
    if (r.method === 'getMultipleAccounts' && r.params[1].encoding === 'jsonParsed') return { id: r.id, result: { value: r.params[0].map(a => ({ data: { parsed: { info: { owner: a.slice(3) } } } })) } };
    if (r.method === 'getMultipleAccounts') return { id: r.id, result: { value: r.params[0].map(o => ({ owner: chain.program.has(o) ? 'Program1111' : SYSTEM, executable: false })) } };
    return { id: r.id, error: { message: 'no' } };
  };
  return RealResponse.json(Array.isArray(body) ? body.map(one) : one(body));
};

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const LOBBY = { idFromName: n => n, get: () => ({ fetch: async () => Response.json({ online: [] }) }) };
  return { DB, sql, LOBBY, SESSION_SECRET: 'test-secret', SIGNIN_DOMAIN: 'example.test' };
}
const call = async (env, path, body, token, method = body === undefined ? 'GET' : 'POST') => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}) }), env);
  return { status: r.status, ...(await r.json()) };
};
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n } for (const b of bytes) { if (b) break; s = '1' + s } return s }
async function walletPlayer(env) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'), address = b58(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const { message } = await call(env, '/auth/solana/nonce', { address });
  const s = await call(env, '/auth/solana', { address, message, signature: b58(sign(null, Buffer.from(message), privateKey)) });
  chain.ata.set(await H.ata(address, TOKEN), address);
  return { ...s, address };
}
const DAY = 864e5;

test('holders: tiers by whole tokens, top-10 holders are Big Whales, stars at 7/30/90/180 days', () => {
  assert.deepEqual([0, 99999, 100e3, 999999, 1e6, 5e6, 10e6, 20e6, 9e9].map(b => H.tierOf(b, false)), [0, 0, 1, 1, 2, 3, 4, 5, 5]);
  assert.equal(H.tierOf(150e3, true), 5); assert.equal(H.tierOf(50e3, true), 0);   // a top-10 spot still needs the Holder amount
  assert.deepEqual([0, 6, 7, 29, 30, 90, 179, 180, 999].map(H.starsFor), [0, 0, 1, 1, 2, 3, 3, 4, 4]);
});

test('holders: token accounts are program addresses, off the ed25519 curve; wallet keys are on it', async () => {
  for (let i = 0; i < 20; i++) { const { publicKey } = generateKeyPairSync('ed25519'); assert.equal(H.onCurve(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)), true) }
  const { publicKey } = generateKeyPairSync('ed25519'), w = b58(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)), a = await H.ata(w, TOKEN);
  assert.match(a, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/); assert.equal(a, await H.ata(w, TOKEN)); assert.notEqual(a, await H.ata(w, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'));
});

test('holders: buying more keeps the streak, falling below keeps the tier for 3 days, then it drops and the stars restart', () => {
  let h = H.step(null, 2, 100);
  assert.deepEqual([h.tier, h.streak_day], [2, 100]);
  h = H.step(h, 4, 110); assert.deepEqual([h.tier, h.tier_day, h.streak_day], [4, 110, 100]);   // upgrade: stars keep counting
  h = H.step(h, 2, 120); assert.deepEqual([h.tier, h.below_day], [4, 120]);                   // below, after 10 days at Whale: grace
  h = H.step(h, 2, 122); assert.equal(h.tier, 4);
  h = H.step(h, 4, 122); assert.deepEqual([h.tier, h.below_day, h.streak_day], [4, null, 100]); // bought back in time: nothing lost
  h = H.step(h, 2, 130); h = H.step(h, 2, 133); assert.deepEqual([h.tier, h.streak_day, h.below_day], [2, 133, null]);   // 3 days later: down, stars restart
  h = H.step(h, 5, 134); h = H.step(h, 2, 135); assert.deepEqual([h.tier, h.streak_day], [2, 135]);   // a tier held under 3 days drops at once (lent tokens)
  h = H.step(h, 0, 136); h = H.step(h, 0, 139); assert.deepEqual([h.tier, h.streak_day], [0, null]);
  const s = H.status({ tier: 3, streak_day: 0, below_day: null, chest_day: 0 }, 'w', 31 * DAY);
  assert.deepEqual([s.title, s.stars, s.days, s.chest, s.next], ['Shark', 2, 31, 80 + 20, 10e6]);
});

test('holders: linking a wallet, refreshing, the daily chest, whale toasts and the badge in sessions and the ranking', async () => {
  const env = makeEnv(), p = await walletPlayer(env), t = p.token;
  assert.equal(p.player.holder.tier, 0); assert.equal(p.player.holder.wallet, true);
  chain.bal[p.address] = 12e6;
  const r = await call(env, '/holder/refresh', {}, t);
  assert.deepEqual([r.status, r.tier, r.title, r.balance, r.chest], [200, 4, 'Whale', 12e6, 120]);
  assert.equal(r.toast, false);                                                    // Whales opt in, Big Whales opt out
  chain.bal[p.address] = 30e6; const again = await call(env, '/holder/refresh', {}, t);
  assert.equal(again.tier, 4);                                                     // at most every 5 minutes
  const c = await call(env, '/holder/chest', {}, t); assert.equal(c.amount, 120);
  assert.equal((await call(env, '/holder/chest', {}, t)).status, 400);              // once a day
  assert.deepEqual((await call(env, '/rewards', {}, t)).rewards, [{ amount: 120, reason: 'holder', note: 'Whale' }]);
  assert.equal((await call(env, '/holder/toast', { on: true }, t)).toast, true);
  assert.equal((await call(env, '/me', undefined, t)).player.holder.title, 'Whale');
  await call(env, '/score', { amount: 50 }, t);
  assert.equal((await call(env, '/ranking', undefined, t)).top[0].tier, 4);
  // holders only: a guest who scored more is left out, and ranks are counted among holders
  const g = await call(env, '/auth/guest', {}); await call(env, '/score', { amount: 300 }, g.token);
  const all = await call(env, '/ranking', undefined, t), only = await call(env, '/ranking?holders=1', undefined, t);
  assert.deepEqual([all.players, all.top[0].id, all.me.rank], [2, g.player.id, 2]);
  assert.deepEqual([only.holders, only.players, only.top.length, only.top[0].id, only.me.rank], [true, 1, 1, p.player.id, 1]);
  assert.equal((await call(env, '/ranking?period=week&holders=1', undefined, g.token)).me, null);
  const plain = makeEnv(), q = await walletPlayer(plain);
  assert.equal((await call(plain, '/holder/chest', {}, q.token)).error, 'holders only');
  const guest = await call(plain, '/auth/guest', {});
  assert.equal((await call(plain, '/holder/refresh', {}, guest.token)).error, 'link a wallet first');
  assert.equal((await call(env, '/me/name', { name: 'Big Whale' }, t)).status, 400);   // titles come from the badge only
});

test('holders: the daily reading starts at a hidden time, reads every linked wallet in batches and survives a dead RPC', async () => {
  const env = makeEnv(), a = await walletPlayer(env), b = await walletPlayer(env), day = 20500, at = await H.snapshotAt(env, day);
  assert.ok(at >= day * DAY && at < day * DAY + 22 * 3600e3);
  chain.bal[a.address] = 2e6; chain.bal[b.address] = 50; chain.big = [];
  assert.equal(await H.snapshot(env, at - 1000), 0);                               // not yet
  assert.equal(await H.snapshot(env, at), 2);
  assert.equal(await H.snapshot(env, at + 60000), 0);                              // done for the day
  const row = id => env.sql.prepare('SELECT * FROM holders WHERE player = ?').get(id);
  assert.deepEqual([row(a.player.id).tier, row(a.player.id).streak_day, row(b.player.id).tier], [2, day, 0]);
  chain.fail = true; const next = await H.snapshotAt(env, day + 1);
  await assert.rejects(H.snapshot(env, next));                                     // nothing changes when the RPC is down
  assert.equal(row(a.player.id).tier, 2); chain.fail = false;
  assert.equal(await H.snapshot(env, next), 2); assert.equal(row(a.player.id).snap_day, day + 1);
});

test('holders: top-10 holders skip pools, the burn address and team wallets', async () => {
  const env = makeEnv(), p = await walletPlayer(env);
  env.HOLDER_EXCLUDE = 'TeamWallet1';
  chain.big = [['PoolPda', 500e6], ['1nc1nerator11111111111111111111111111111111', 90e6], ['TeamWallet1', 80e6], ...Array.from({ length: 9 }, (_, i) => ['Someone' + i, 50e6 - i]), [p.address, 300e3], ['Late', 100e3]];
  chain.program.add('PoolPda');
  const top = await H.topHolders(env, Date.now(), true);
  assert.equal(top.size, 10); assert.ok(top.has(p.address) && !top.has('PoolPda') && !top.has('TeamWallet1') && !top.has('Late'));
  chain.bal[p.address] = 300e3;
  assert.equal((await call(env, '/holder/refresh', {}, p.token)).title, 'Big Whale');
  chain.big = []; chain.program.clear();
});

test('holders: the lobby shows badges and announces a whale once a day, never two whales within minutes', async () => {
  const mem = new Map(), socks = [];
  const c = { acceptWebSocket(ws, tags) { ws.tags = tags; socks.push(ws) }, getWebSockets: tag => socks.filter(w => !w.closed && (tag == null || w.tags.includes(tag))),
    storage: { get: async k => mem.get(k), put: async (k, v) => mem.set(k, structuredClone(v)), delete: async k => mem.delete(k), getAlarm: async () => null } };
  const l = new Lobby(c, {}), enter = async (id, name, tier, toast) => { await l.fetch(new Request('https://lobby/ws', { headers: { Upgrade: 'websocket', 'x-player': String(id), 'x-name': name, 'x-tier': String(tier), 'x-stars': '2', 'x-toast': toast ? '1' : '0' } })); return socks.at(-1) };
  const fan = await enter(1, 'Fan', 0, false), whale = await enter(2, 'Moby', 5, true);
  assert.deepEqual(fan.out.filter(m => m.t === 'whale'), [{ t: 'whale', name: 'Moby', tier: 5 }]);
  assert.equal(whale.out.filter(m => m.t === 'whale').length, 0);
  assert.deepEqual(fan.out.filter(m => m.t === 'list').at(-1).players.find(p => p.id === 2), { id: 2, name: 'Moby', wins: 0, losses: 0, busy: false, cc: null, tier: 5, st: 2 });
  await enter(2, 'Moby', 5, true); await enter(3, 'Orca', 4, true); await enter(4, 'Quiet', 5, false);
  assert.equal(fan.out.filter(m => m.t === 'whale').length, 1);                    // once a day; the next whale waits a few minutes; opted out never
});
