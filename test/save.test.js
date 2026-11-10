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
const { mergeSave } = await import('../src/save.js');

test('save: merges only ever add, the newer day wins, choices go to the latest pick', () => {
  const a = { d: { 'cww-bank': 900, 'cww-spent': 100, 'cww-owned': ['tophat'], 'cww-wins': { Bulls: 4, Bears: 1 }, 'cww-camp': { 0: 3, 1: 1 },
    'cww-missions': { date: '2026-11-10', ids: ['win', 'crate', 'dmg'], prog: { crate: 2 }, done: ['win'] }, 'cww-streak': { d: '2026-11-10', n: 3, g: 0, w: 0 },
    'cww-look': { hat: 'crown' }, 'cww-camplvl': 5, 'cww-seen': ['news-a'], 'cww-starter': true,
    'cww-rescue': { lv: 3, st: [3, 2, 1], gm: [1, 0, 4], bp: 300, snd: true, mus: true } }, t: { 'cww-look': 1000, 'cww-camplvl': 1000 } };
  const b = { d: { 'cww-bank': 700, 'cww-spent': 250, 'cww-owned': ['cowboy', 'tophat'], 'cww-wins': { Bulls: 2, Bears: 6 }, 'cww-camp': { 1: 3, 2: 2 },
    'cww-missions': { date: '2026-11-10', ids: ['win', 'crate', 'dmg'], prog: { crate: 1, dmg: 120 }, done: [] }, 'cww-streak': { d: '2026-11-09', n: 2, g: 0, w: 0 },
    'cww-look': { hat: 'viking' }, 'cww-camplvl': 2, 'cww-seen': ['news-b'], 'cww-gfx': 'high',
    'cww-rescue': { lv: 2, st: [1, 3], gm: [2, 1], bp: 100, snd: false, mus: true } }, t: { 'cww-look': 2000, 'cww-camplvl': 500 } };
  const m = mergeSave(a, b).d, t = mergeSave(a, b).t;
  assert.equal(m['cww-bank'], 900); assert.equal(m['cww-spent'], 250);
  assert.deepEqual(m['cww-owned'].sort(), ['cowboy', 'tophat']); assert.deepEqual(m['cww-wins'], { Bulls: 4, Bears: 6 }); assert.deepEqual(m['cww-camp'], { 0: 3, 1: 3, 2: 2 });
  assert.deepEqual(m['cww-missions'], { date: '2026-11-10', ids: ['win', 'crate', 'dmg'], prog: { crate: 2, dmg: 120 }, done: ['win'] });
  assert.equal(m['cww-streak'].n, 3);                                              // today's claim beats yesterday's
  assert.equal(m['cww-look'].hat, 'viking'); assert.equal(t['cww-look'], 2000);     // picked later on the other device
  assert.equal(m['cww-camplvl'], 5);                                               // picked later here: a lower level can be the choice
  assert.deepEqual(m['cww-seen'].sort(), ['news-a', 'news-b']); assert.equal(m['cww-starter'], true);
  assert.equal(m['cww-gfx'], undefined);                                           // device settings never travel
  assert.deepEqual(m['cww-rescue'], { lv: 3, st: [3, 3, 1, 0, 0, 0, 0, 0, 0, 0], gm: [3, 1, 4, 0, 0, 0, 0, 0, 0, 0], bp: 300, snd: false, mus: true });
  const next = mergeSave(a, { d: { 'cww-missions': { date: '2026-11-11', ids: ['boots', 'win', 'coins'], prog: {}, done: [] } } }).d;
  assert.equal(next['cww-missions'].date, '2026-11-11');                           // a new day starts fresh missions everywhere
  assert.equal(mergeSave(null, { d: { 'cww-bank': 'lots', 'cww-stars': -5, 'cww-played': 1e99 } }).d['cww-bank'], 0);
  assert.equal(mergeSave(null, { d: { 'cww-played': 1e99 } }).d['cww-played'], 1e9);
});

test('save: phone, desktop and web on one account share one copy; joined accounts fold theirs together', async () => {
  const env = makeEnv();
  const phone = await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami') });
  const r1 = await call(env, '/me/save', { data: { 'cww-bank': 1200, 'cww-missions': { date: '2026-11-10', ids: ['win', 'crate', 'dmg'], prog: { crate: 3 }, done: ['crate'] } } }, phone.token);
  assert.equal(r1.status, 200); assert.equal(r1.data['cww-bank'], 1200);
  const desk = await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami') });          // Telegram Desktop: same account, empty phone storage
  const r2 = await call(env, '/me/save', { data: { 'cww-gfx': 'low' } }, desk.token);
  assert.equal(r2.data['cww-bank'], 1200); assert.deepEqual(r2.data['cww-missions'].done, ['crate']); assert.equal(r2.data['cww-gfx'], undefined);
  const web = await call(env, '/auth/guest', {});                                            // the web game as a guest with its own progress
  await call(env, '/me/save', { data: { 'cww-bank': 300, 'cww-owned': ['cowboy'], 'cww-stars': 9 } }, web.token);
  const joined = await call(env, '/auth/telegram/web', tgWidget(42, 'Dami'), web.token);     // Telegram login on the web
  assert.equal(joined.player.id, phone.player.id);
  const g = await call(env, '/me/save', undefined, joined.token);
  assert.equal(g.data['cww-bank'], 1200); assert.equal(g.data['cww-stars'], 9); assert.deepEqual(g.data['cww-owned'], ['cowboy']);
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM saves').get().n, 1);
  const big = await call(env, '/me/save', { data: { 'cww-owned': Array.from({ length: 1500 }, (_, i) => 'item-number-' + i + '-'.repeat(40)) } }, phone.token);
  assert.equal(big.status, 413); assert.equal((await call(env, '/me/save', undefined, phone.token)).data['cww-bank'], 1200);   // a copy too big is refused, the old one stays
});
