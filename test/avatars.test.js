import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const { default: worker } = await import('../src/index.js');

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const LOBBY = { idFromName: n => n, get: () => ({ fetch: async () => Response.json({ online: [] }) }) };
  return { DB, sql, LOBBY, SESSION_SECRET: 'test-secret', SIGNIN_DOMAIN: 'example.test' };
}
const call = async (env, path, body, token) => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { status: r.status, ...(await r.json()) };
};

test('avatars: a player picks one; it rides in the session, the ranking and the match', async () => {
  const env = makeEnv(), a = await call(env, '/auth/guest', {}), b = await call(env, '/auth/guest', {});
  assert.equal(a.player.av, null);
  assert.equal((await call(env, '/me/avatar', { av: '../x' }, a.token)).status, 400);
  assert.equal((await call(env, '/me/avatar', { av: 'pirate' }, a.token)).player.av, 'pirate');
  assert.equal((await call(env, '/me/avatar', { av: 'queen' }, a.token)).player.av, 'queen');   // changing it
  assert.equal((await call(env, '/me', undefined, a.token)).player.av, 'queen');
  env.sql.prepare('INSERT INTO cworm_scores (player, total, week_start, week, day_start, day, last) VALUES (?, 500, 0, 0, 0, 0, 0), (?, 400, 0, 0, 0, 0, 0)').run(a.player.id, b.player.id);
  const top = (await call(env, '/ranking?period=all', undefined, b.token)).top;
  assert.equal(top[0].av, 'queen'); assert.equal(top[1].av, undefined);
  let seen = null; env.MATCH = { idFromName: n => n, get: () => ({ fetch: async req => { seen = req.headers.get('x-av'); return new RealResponse('ok') } }) };
  await worker.fetch(new Request('https://api.test/match/ABCDEF/ws?token=' + a.token), env); assert.equal(seen, 'queen');
  await worker.fetch(new Request('https://api.test/match/ABCDEF/ws?token=' + b.token), env); assert.equal(seen, '');
});
