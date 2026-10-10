import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Stand-ins: node:sqlite for D1 and Telegram's Bot API recorded in `calls`.
const calls = [];
globalThis.fetch = async (url, init) => { calls.push([String(url).split('/').pop(), JSON.parse(init.body)]); return Response.json({ ok: true, result: {} }) };
const { default: worker } = await import('../src/index.js');
const { TILES, COUNTRIES } = await import('../src/world.js');
const { neighbours, reachable, ATTACKS_PER_DAY, DEF_PRICES } = await import('../src/map.js');

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  return { DB, sql, SESSION_SECRET: 'test-secret', BOT_TOKEN: '123:BOT', GAME_LINK: 'https://t.me/CryptoWormWarsBot/play' };
}
const call = async (env, path, body, token) => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { status: r.status, ...(await r.json()) };
};
function tgInit(id, name) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: name }) };
  const check = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n'), secret = createHmac('sha256', 'WebAppData').update('123:BOT').digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
}
const age = (env, ms) => env.sql.prepare('UPDATE attacks SET started = started - ?').run(ms);

test('world: about 5,000 tiles, every country has land, and Uruguay has a few', () => {
  assert.ok(TILES.length > 4800 && TILES.length < 5300);
  const uy = TILES.filter(t => COUNTRIES[t[2]] === 'UY').length;
  assert.ok(uy >= 4, 'Uruguay ' + uy);
  for (const c of ['US', 'BR', 'AR', 'ES', 'FR', 'DE', 'RU', 'CN', 'IN', 'JP', 'GB', 'NG', 'AU', 'SG', 'LU']) assert.ok(TILES.some(t => COUNTRIES[t[2]] === c), c);
});

test('map: a free home plot in your country, attacks on land next to it, a win takes the tile and tells the owner', async () => {
  const env = makeEnv(); calls.length = 0;
  const a = await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami') });
  const b = await call(env, '/auth/telegram', { initData: tgInit(43, 'Bob') });
  let m = await call(env, '/map', undefined, a.token);
  assert.equal(m.me.joined, false); assert.deepEqual(m.tiles, []);
  assert.equal((await call(env, '/map/attack', { tile: 0 }, a.token)).status, 409);          // home plot first
  m = await call(env, '/map/join', { cc: 'UY' }, a.token);
  assert.equal(m.plot.length, 3); assert.equal(m.me.tiles, 3); assert.ok(m.me.shield > Date.now());
  assert.ok(m.plot.every(t => COUNTRIES[TILES[t][2]] === 'UY' || m.plot.some(o => neighbours(o).includes(t))));
  assert.equal((await call(env, '/map/join', { cc: 'UY' }, a.token)).status, 400);           // once
  const mb = await call(env, '/map/join', { cc: 'UY' }, b.token);
  assert.equal(mb.plot.filter(t => m.plot.includes(t)).length, 0);                           // nobody gets someone else's land

  // a's neutral neighbour
  const mine = m.plot, target = mine.flatMap(neighbours).find(t => !mine.includes(t) && !mb.plot.includes(t));
  assert.equal((await call(env, '/map/attack', { tile: mine[0] }, a.token)).status, 400);    // your own land
  const far = TILES.findIndex((t, i) => !reachable(i, mine));
  assert.equal((await call(env, '/map/attack', { tile: far }, a.token)).status, 400);
  let at = await call(env, '/map/attack', { tile: target }, a.token);
  assert.equal(at.status, 200); assert.equal(at.owner, null); assert.equal(at.me.attacksLeft, ATTACKS_PER_DAY - 1);
  assert.equal((await call(env, '/map/result', { ticket: at.ticket, win: true }, a.token)).status, 400);   // too quick
  age(env, 60e3);
  let r = await call(env, '/map/result', { ticket: at.ticket, win: true }, a.token);
  assert.equal(r.won, true); assert.equal(r.me.tiles, 4);
  assert.equal((await call(env, '/map/result', { ticket: at.ticket, win: true }, a.token)).status, 400);  // once

  // b's land is shielded while b is new; when the shield is gone a can take it and b hears about it
  const bt = mb.plot.find(t => reachable(t, [...mine, target]));
  if (bt != null) {
    assert.equal((await call(env, '/map/attack', { tile: bt }, a.token)).status, 400);
    env.sql.prepare('UPDATE landlords SET shield = 0 WHERE player = ?').run(b.player.id);
    at = await call(env, '/map/attack', { tile: bt }, a.token);
    assert.equal(at.owner.name, 'Bob');
    age(env, 60e3); r = await call(env, '/map/result', { ticket: at.ticket, win: true }, a.token);
    assert.equal(r.won, true);
    assert.ok(calls.some(([meth, body]) => meth === 'sendMessage' && body.chat_id === 43 && /took your land/.test(body.text) && /play money/.test(body.text)));
    assert.equal((await call(env, '/map/attack', { tile: bt }, b.token)).status, 400);       // truce on a tile just taken
  }
  // a loss changes nothing but the count
  const next = r.tiles.filter(x => x[1] === a.player.id).map(x => x[0]).flatMap(neighbours).find(t => !r.tiles.some(x => x[0] === t));
  at = await call(env, '/map/attack', { tile: next }, a.token);
  r = await call(env, '/map/result', { ticket: at.ticket, win: false }, a.token);
  assert.equal(r.won, false); assert.ok(!r.tiles.some(x => x[0] === next));
});

test('map: defenses and upgrades have levels and prices; attacks per day are capped; a player with no land buys a plot', async () => {
  const env = makeEnv();
  const a = await call(env, '/auth/guest', {});
  const m = await call(env, '/map/join', { cc: 'ES' }, a.token);
  let d = await call(env, '/map/defend', { tile: m.plot[0], item: 'mines' }, a.token);
  assert.equal(d.price, DEF_PRICES.mines[0]); assert.equal(d.def, '1000');
  await call(env, '/map/defend', { tile: m.plot[0], item: 'mines' }, a.token); d = await call(env, '/map/defend', { tile: m.plot[0], item: 'mines' }, a.token);
  assert.equal(d.def, '3000'); assert.equal((await call(env, '/map/defend', { tile: m.plot[0], item: 'mines' }, a.token)).status, 400);
  assert.equal((await call(env, '/map/defend', { tile: m.plot[0], item: 'garrison' }, a.token)).def, '3001');
  assert.equal((await call(env, '/map/defend', { tile: 1, item: 'mines' }, a.token)).status, 400);  // not yours
  const u = await call(env, '/map/upgrade', { stat: 'acc' }, a.token);
  assert.equal(u.price, 300); assert.equal(u.me.acc, 1);
  const target = m.plot.flatMap(neighbours).find(t => !m.plot.includes(t));
  for (let k = 0; k < ATTACKS_PER_DAY; k++) assert.equal((await call(env, '/map/attack', { tile: target }, a.token)).status, 200);
  assert.equal((await call(env, '/map/attack', { tile: target }, a.token)).status, 429);
  assert.equal((await call(env, '/map/buy', {}, a.token)).status, 400);                      // still has land
  env.sql.prepare('DELETE FROM land').run();
  const b1 = await call(env, '/map/buy', {}, a.token);
  assert.equal(b1.price, 500); assert.equal(b1.me.tiles, 3); assert.equal(b1.me.buyPrice, 750);
});

test('map: land follows an account that is merged into another', async () => {
  const env = makeEnv();
  const g = await call(env, '/auth/guest', {});
  await call(env, '/map/join', { cc: 'FR' }, g.token);
  const t = await call(env, '/auth/telegram', { initData: tgInit(77, 'Zed') }, g.token);
  const m = await call(env, '/map', undefined, t.token);
  assert.equal(m.me.tiles, 3); assert.equal(m.me.cc, 'FR');
});
