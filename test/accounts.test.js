import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Stand-ins: node:sqlite for D1, a lobby with nobody in it.
class FakeWS { constructor() { this.out = [] } send(m) { this.out.push(JSON.parse(m)) } close() { this.closed = true } serializeAttachment(v) { this.att = structuredClone(v) } deserializeAttachment() { return this.att } }
globalThis.WebSocketPair = class { constructor() { this[0] = new FakeWS(); this[1] = new FakeWS() } };
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { constructor(b, i = {}) { super(b, i.status === 101 ? { status: 200 } : i); this.ws = i.webSocket } static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const { default: worker } = await import('../src/index.js');

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const LOBBY = { idFromName: n => n, get: () => ({ fetch: async () => Response.json({ online: [] }) }) };
  return { DB, sql, LOBBY, SESSION_SECRET: 'test-secret', BOT_TOKEN: '123:BOT', SIGNIN_DOMAIN: 'example.test' };
}
const call = async (env, path, body, token, method = body === undefined ? 'GET' : 'POST') => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}) }), env);
  return { status: r.status, ...(await r.json()) };
};
function tgInit(id, name) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: name }) };
  const check = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n'), secret = createHmac('sha256', 'WebAppData').update('123:BOT').digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
}
function tgWidget(id, name) {
  const d = { id: String(id), first_name: name, auth_date: String(Math.floor(Date.now() / 1000)) };
  const check = Object.keys(d).sort().map(k => `${k}=${d[k]}`).join('\n');
  return { ...d, hash: createHmac('sha256', createHash('sha256').update('123:BOT').digest()).update(check).digest('hex') };
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n } for (const b of bytes) { if (b) break; s = '1' + s } return s }
async function walletSignIn(env, token) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'), address = b58(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const { message } = await call(env, '/auth/solana/nonce', { address });
  return call(env, '/auth/solana', { address, message, signature: b58(sign(null, Buffer.from(message), privateKey)) }, token);
}

test('accounts: a login code moves a device onto the same account, and a guest on it is folded in', async () => {
  const env = makeEnv();
  const tg = await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami') });
  assert.equal(tg.player.name, 'Dami'); assert.equal(tg.player.tg, true);
  const guest = await call(env, '/auth/guest', {});
  env.sql.prepare('UPDATE players SET wins = 3 WHERE id = ?').run(guest.player.id);
  const { code } = await call(env, '/auth/code', {}, tg.token);
  const web = await call(env, '/auth/code/redeem', { code }, guest.token);
  assert.equal(web.player.id, tg.player.id); assert.equal(web.player.wins, 3);
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM players').get().n, 1);
  assert.equal((await call(env, '/auth/code/redeem', { code })).status, 404);    // codes work once
});

test('accounts: telegram on the web and a wallet end up on one account', async () => {
  const env = makeEnv();
  const mini = await call(env, '/auth/telegram', { initData: tgInit(7, 'Ana') });
  const w = await walletSignIn(env);                                               // wallet first, on its own account
  assert.notEqual(w.player.id, mini.player.id);
  const both = await call(env, '/auth/telegram/web', tgWidget(7, 'Ana'), w.token);  // then Telegram on the same page
  assert.equal(both.player.id, mini.player.id); assert.equal(both.player.wallet, w.player.wallet); assert.equal(both.player.tg, true);
  assert.equal((await call(env, '/auth/telegram/web', { ...tgWidget(7, 'Ana'), first_name: 'Eve' })).status, 401);
  const again = await walletSignIn(env, mini.token);                               // a second wallet can't join an account that has one
  assert.notEqual(again.player.id, mini.player.id);
});

test('friends: a friend code adds both ways, an id one way, and remove works', async () => {
  const env = makeEnv();
  const a = await call(env, '/auth/guest', {}), b = await call(env, '/auth/guest', {}), c = await call(env, '/auth/guest', {});
  assert.equal((await call(env, '/friends/add', { code: 'NOPE1234' }, a.token)).status, 404);
  assert.equal((await call(env, '/friends/add', { code: b.friendCode.toLowerCase() }, a.token)).friend.id, b.player.id);
  assert.deepEqual((await call(env, '/friends', undefined, b.token)).friends.map(f => f.id), [a.player.id]);
  await call(env, '/friends/add', { id: c.player.id }, a.token);
  assert.equal((await call(env, '/friends', undefined, a.token)).friends.length, 2);
  assert.equal((await call(env, '/friends', undefined, c.token)).friends.length, 0);
  await call(env, '/friends/remove', { id: b.player.id }, a.token);
  assert.deepEqual((await call(env, '/friends', undefined, a.token)).friends.map(f => f.id), [c.player.id]);
});

test('feedback: stored with the linked wallet, checked, limited per day, and sent to the admins', async () => {
  const env = { ...makeEnv(), ADMIN_PLAYERS: '1' }, sent = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push([String(url).split('/').pop(), init.body instanceof FormData ? init.body : JSON.parse(init.body)]); return Response.json({ ok: true, result: {} }) };
  try {
    const boss = await call(env, '/auth/telegram', { initData: tgInit(42, 'Damian') });   // player 1, the admin
    const w = await walletSignIn(env);
    assert.equal((await call(env, '/feedback', { text: 'hi' })).status, 401);
    assert.equal((await call(env, '/feedback', { text: '   ' }, w.token)).status, 400);
    assert.equal((await call(env, '/feedback', { text: 'hi', wallet: 'not a wallet' }, w.token)).status, 400);
    assert.equal((await call(env, '/feedback', { text: 'Love the <vulture>!', rating: 5, info: 'web en L3' }, w.token)).ok, true);
    const row = env.sql.prepare('SELECT * FROM feedback').get();
    assert.equal(row.wallet, w.player.wallet); assert.equal(row.wallet_ok, 1); assert.equal(row.rating, 5);
    assert.equal(sent.length, 1); assert.equal(sent[0][1].chat_id, 42); assert.match(sent[0][1].text, /Love the &lt;vulture&gt;!/); assert.match(sent[0][1].text, /★★★★★/);
    const g = await call(env, '/auth/guest', {}), typed = w.player.wallet;
    assert.equal((await call(env, '/feedback', { text: 'ok', rating: 9, wallet: typed }, g.token)).ok, true);
    const r2 = env.sql.prepare('SELECT * FROM feedback WHERE player = ?').get(g.player.id);
    assert.equal(r2.wallet_ok, 0); assert.equal(r2.rating, null);
    for (let i = 1; i < 10; i++) await call(env, '/feedback', { text: 'more ' + i }, g.token);
    assert.equal((await call(env, '/feedback', { text: 'too many' }, g.token)).status, 429);
    const { feedbackCsv } = await import('../src/bot.js');
    const csv = await feedbackCsv(env);
    assert.equal(csv.messages, 11); assert.equal(csv.testers, 2); assert.equal(csv.withWallet, 2);
    assert.match(csv.csv, /"Love the <vulture>!"|Love the <vulture>!/); assert.ok(boss.player.id === 1);
  } finally { globalThis.fetch = realFetch }
});

test('nicknames: checked, unique, kept through Telegram sign-in and account linking', async () => {
  const env = makeEnv();
  const a = await call(env, '/auth/telegram', { initData: tgInit(5, 'Ana') }), b = await call(env, '/auth/guest', {});
  assert.equal(a.player.nick, false);
  for (const bad of ['ab', 'x'.repeat(17), ' -ab', 'Guest 77', 'fuckworm', 'f.u.c.k', 'Crypto Worm']) assert.equal((await call(env, '/me/name', { name: bad }, a.token)).status, 400, bad);
  const ok = await call(env, '/me/name', { name: '  Moon   Boy ' }, a.token);
  assert.equal(ok.player.name, 'Moon Boy'); assert.equal(ok.player.nick, true);
  assert.equal((await call(env, '/me/name', { name: 'moon boy' }, b.token)).status, 409);          // taken, whatever the case
  assert.equal((await call(env, '/me/name', { name: 'Worm King' }, a.token)).status, 429);         // not again right away
  const again = await call(env, '/auth/telegram', { initData: tgInit(5, 'Ana') });                 // Telegram doesn't overwrite it
  assert.equal(again.player.name, 'Moon Boy');
  assert.equal((await call(env, '/me/name', { name: 'Señor_Gusano' }, b.token)).player.name, 'Señor_Gusano');
  const linked = await call(env, '/auth/telegram', { initData: tgInit(6, 'Bo') }, b.token);       // the guest's nickname comes along
  assert.equal(linked.player.name, 'Señor_Gusano'); assert.equal(linked.player.nick, true);
});

test('ranking: all time from the totals, the week from matches since Monday', async () => {
  const env = makeEnv();
  const p = [];
  for (const n of ['A', 'B', 'C']) p.push((await call(env, '/auth/guest', {})).player.id);
  const t = (await call(env, '/auth/guest', {})).token;
  const add = (w, l, ended) => { env.sql.prepare('INSERT INTO matches (p0, p1, winner, reason, ended) VALUES (?, ?, ?, ?, ?)').run(w, l, w, 'played', ended); env.sql.prepare('UPDATE players SET wins = wins + 1 WHERE id = ?').run(w); env.sql.prepare('UPDATE players SET losses = losses + 1 WHERE id = ?').run(l) };
  const old = Date.now() - 30 * 864e5;
  add(p[0], p[1], old); add(p[0], p[1], old); add(p[0], p[2], old);
  add(p[1], p[2], Date.now()); add(p[2], p[0], Date.now()); add(p[2], p[0], Date.now() - 1000);
  env.sql.prepare('INSERT INTO matches (p0, p1, winner, reason, ended) VALUES (?, ?, ?, ?, ?)').run(p[1], p[1], p[1], 'played', Date.now());   // same account both sides: ignored
  const all = await call(env, '/ranking?period=all', undefined, t);
  assert.deepEqual(all.top.map(r => [r.id, r.wins, r.losses]), [[p[0], 3, 2], [p[2], 2, 2], [p[1], 1, 2]]);
  assert.equal(all.me, null);
  const week = await call(env, '/ranking?period=week', undefined, t);
  assert.deepEqual(week.top.map(r => [r.rank, r.id, r.wins, r.losses]), [[1, p[2], 2, 1], [2, p[1], 1, 0], [3, p[0], 0, 2]]);
  assert.ok(week.since <= Date.now() && new Date(week.since).getUTCDay() === 1);
  assert.equal((await call(env, '/ranking?period=week')).status, 401);
});
