import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Stand-ins: node:sqlite for D1 and a lobby that answers nothing; a clock the test moves.
const RealResponse = globalThis.Response, realNow = Date.now;
globalThis.Response = class extends RealResponse { constructor(b, i = {}) { super(b, i.status === 101 ? { status: 200 } : i); this.ws = i.webSocket } static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
globalThis.fetch = async () => Response.json({ ok: true, result: {} });
const { default: worker } = await import('../src/index.js');
const F = await import('../src/feed.js');
let clock = realNow(); Date.now = () => clock;
test.after(() => { Date.now = realNow });

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const env = { DB, sql, SESSION_SECRET: 'test-secret', SITE_URL: 'https://play.test' };
  env.LOBBY = { idFromName: n => n, get: () => ({ fetch: async () => Response.json({ online: [] }) }) };
  return env;
}
const call = async (env, path, body, token, headers = {}) => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers, ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { status: r.status, headers: r.headers, ...(await r.json()) };
};
const rows = env => env.sql.prepare('SELECT * FROM feed ORDER BY id').all();
const guest = async (env, name) => { const g = await call(env, '/auth/guest', {}); if (name) env.sql.prepare('UPDATE players SET name = ? WHERE id = ?').run(name, g.player.id); return g };

test('feed: /played keeps up to 3 sensible moments, with the name and country from the server', async () => {
  const env = makeEnv(), me = await guest(env, 'Dami');
  await call(env, '/played', { mode: 'cpu', feed: [
    { k: 'solo', m: 'cpu', a: 'Somebody else' },                                      // the name is never the phone's
    { k: 'win', a: 'x', b: 'y' },                                                      // online wins only come from the match server
    { k: 'kill', w: 'Paper\u0000 Hands<script>', wp: 'grenade', how: 'drown' },
    { k: 'big', n: 12, wp: 'rocket' },                                                 // not big enough
    { k: 'multi', n: 3, wp: 'Bad Id!' },
    { k: 'oops', w: 'Moon Girl', wp: 'fart' },                                          // a 4th one: over the 3 a match may send
  ] }, me.token);
  const r = rows(env);
  assert.deepEqual(r.map(x => x.k), ['solo', 'kill', 'multi']);
  assert.ok(r.every(x => x.p === me.player.id && x.a === 'Dami'));
  assert.equal(r[0].m, 'cpu'); assert.equal(r[0].wp, null);
  assert.equal(r[1].w, 'Paper Handsscript'); assert.equal(r[1].wp, 'grenade'); assert.equal(r[1].how, 'drown');
  assert.equal(r[2].n, 3); assert.equal(r[2].wp, null);
  // the same match reported again (inside the 20 s gap) adds nothing
  await call(env, '/played', { mode: 'cpu', feed: [{ k: 'big', n: 80, wp: 'rocket' }] }, me.token);
  assert.equal(rows(env).length, 3);
});

test('feed: online and World Map matches send no result lines of their own; one player fills at most 8 lines in 10 minutes', async () => {
  const env = makeEnv(), me = await guest(env, 'Dami');
  const play = async (mode, feed) => { clock += 30e3; await call(env, '/played', { mode, feed }, me.token) };
  await play('online', [{ k: 'solo', m: 'online' }, { k: 'died', w: 'Moon Boy' }, { k: 'kill', w: 'Rekt', wp: 'rocket' }]);
  await play('map', [{ k: 'solo', m: 'map' }, { k: 'big', n: 66, wp: 'whale' }]);
  await play('camp', [{ k: 'solo', m: 'camp', n: 12, b: 'Bear King' }, { k: 'died', w: 'Moon Boy', wp: 'mine' }]);
  assert.deepEqual(rows(env).map(x => [x.k, x.m, x.n, x.b, x.wp]), [['kill', null, null, null, 'rocket'], ['big', null, 66, null, 'whale'], ['solo', 'camp', 12, 'Bear King', null], ['died', null, null, null, 'mine']]);
  for (let i = 0; i < 3; i++) await play('cpu', [{ k: 'lost', m: 'cpu' }, { k: 'big', n: 50 }, { k: 'big', n: 70 }]);
  assert.equal(rows(env).length, 8);
  clock += 11 * 60e3; await play('cpu', [{ k: 'lost', m: 'cpu' }]);
  assert.equal(rows(env).length, 9);
});

test('feed: online wins and land taken come with both names; GET /feed lists the newest first for anyone; old lines are cleaned up', async () => {
  const env = makeEnv(), a = await guest(env, 'Alpha'), b = await guest(env, 'Beta');
  for (const [p, cc] of [[a, 'AR'], [b, 'BR']]) env.sql.prepare('INSERT INTO player_meta (player, cc) VALUES (?, ?) ON CONFLICT(player) DO UPDATE SET cc = excluded.cc').run(p.player.id, cc);
  await F.winRow(env, a.player.id, b.player.id, 'left').run();
  await F.landRow(env, b.player.id, a.player.id, 'UY').run();
  await F.landRow(env, a.player.id, null, 'ZZZ').run();                                // CPU land; not a country code
  const got = await call(env, '/feed');
  assert.equal(got.status, 200); assert.ok(got.now > 0);
  assert.deepEqual(got.feed.map(e => [e.k, e.a, e.ac, e.b, e.bc, e.m]), [['land', 'Alpha', 'AR', undefined, undefined, undefined], ['land', 'Beta', 'BR', 'Alpha', 'AR', 'UY'], ['win', 'Alpha', 'AR', 'Beta', 'BR', 'left']]);
  assert.ok(got.feed.every(e => e.id && e.at && e.p));
  clock += F.FEED_KEEP + 1000; await F.cleanup(env);
  assert.equal(rows(env).length, 0);
});
