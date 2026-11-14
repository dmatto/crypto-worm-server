import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Simulated players for load tests: who they are, and what they may not do.
class FakeWS { constructor() { this.out = []; this.closed = false } send(m) { this.out.push(JSON.parse(m)) } close() { this.closed = true } serializeAttachment(v) { this.att = structuredClone(v) } deserializeAttachment() { return this.att } }
globalThis.WebSocketPair = class { constructor() { this[0] = new FakeWS(); this[1] = new FakeWS() } };
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { constructor(b, i = {}) { super(b, i.status === 101 ? { status: 200 } : i) } static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
globalThis.fetch = async () => Response.json({ ok: true, result: {} });
const { default: worker } = await import('../src/index.js');
const { Match } = await import('../src/match.js');
const { Lobby } = await import('../src/lobby.js');
const { neighbours } = await import('../src/map.js');
const { simCommand } = await import('../src/bot.js');

const KEY = 'k'.repeat(40);
function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const lobbyUrls = [];
  const LOBBY = { idFromName: n => n, get: () => ({ fetch: async u => { lobbyUrls.push(String(u.url || u)); return Response.json({ online: [], ids: [] }) } }) };
  return { DB, sql, LOBBY, lobbyUrls, SESSION_SECRET: 'test-secret', SIM_KEY: KEY, BOT_TOKEN: '123:BOT', ADMIN_PLAYERS: '99' };
}
const call = async (env, path, body, token, headers = {}) => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers, ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
function tgInit(id, name) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: name }) };
  const check = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n'), secret = createHmac('sha256', 'WebAppData').update('123:BOT').digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
}
const sims = env => env.sql.prepare('SELECT player FROM sim_players').all().map(r => r.player);

test('sim: only the right key makes a simulated player; they never get the weekly prize card', async () => {
  const env = makeEnv();
  const real = await call(env, '/auth/guest', {});
  const wrong = await call(env, '/auth/guest', {}, null, { 'x-sim-key': 'k'.repeat(39) + 'x' });
  const bot = await call(env, '/auth/guest', { src: 'loadtest' }, null, { 'x-sim-key': KEY });
  assert.deepEqual(sims(env), [bot.player.id]);
  assert.ok(!sims(env).includes(real.player.id) && !sims(env).includes(wrong.player.id));
  assert.equal(env.sql.prepare('SELECT source FROM player_meta WHERE player = ?').get(bot.player.id).source, 'loadtest');
  const noKey = { ...makeEnv(), SIM_KEY: undefined }, g = await call(noKey, '/auth/guest', {}, null, { 'x-sim-key': '' });
  assert.deepEqual(sims(noKey), []); assert.equal(g.status, 200);
  assert.deepEqual(await call(env, '/prize', undefined, bot.token), { status: 200, on: false });
  // the lobby always gets a simulated player as hidden: counted online, never offered to real players
  await call(env, '/lobby/ws', undefined, bot.token); await call(env, '/lobby/ws', undefined, real.token);
  assert.equal(new URL(env.lobbyUrls.at(-2)).searchParams.get('hidden'), '1');
  assert.equal(new URL(env.lobbyUrls.at(-1)).searchParams.get('hidden'), null);
});

test('sim: simulated players fight CPU land and each other, never a real player; real players can attack them', async () => {
  const env = makeEnv();
  const real = await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami') });
  const bot = await call(env, '/auth/guest', {}, null, { 'x-sim-key': KEY }), bot2 = await call(env, '/auth/guest', {}, null, { 'x-sim-key': KEY });
  const mr = await call(env, '/map/join', { cc: 'UY' }, real.token), mb = await call(env, '/map/join', { cc: 'UY' }, bot.token);
  await call(env, '/map/join', { cc: 'UY' }, bot2.token);
  env.sql.prepare('UPDATE landlords SET shield = 0').run();
  // move one real tile and one bot tile right next to the bot's land
  const free = mb.plot.flatMap(neighbours).filter((t, i, a) => a.indexOf(t) === i && !env.sql.prepare('SELECT 1 FROM land WHERE tile = ?').get(t));
  env.sql.prepare('UPDATE land SET tile = ? WHERE tile = ?').run(free[0], mr.plot[0]);
  const b2 = env.sql.prepare('SELECT tile FROM land WHERE owner = ? LIMIT 1').get(bot2.player.id).tile;
  env.sql.prepare('UPDATE land SET tile = ? WHERE tile = ?').run(free[1], b2);
  const hit = await call(env, '/map/attack', { tile: free[0] }, bot.token);
  assert.equal(hit.status, 403); assert.match(hit.error, /simulated/);
  const ok = await call(env, '/map/attack', { tile: free[1] }, bot.token);
  assert.equal(ok.status, 200); assert.equal(ok.owner.id, bot2.player.id);
  const cpu = await call(env, '/map/attack', { tile: free[2] }, bot.token);
  assert.equal(cpu.status, 200); assert.equal(cpu.owner, null);
  // a real player next to bot land can attack it like anyone's
  env.sql.prepare('UPDATE land SET tile = ? WHERE tile = ?').run(free[3], mr.plot[1]);
  const back = await call(env, '/map/attack', { tile: mb.plot.find(t => neighbours(t).includes(free[3])) }, real.token);
  assert.equal(back.status, 200, JSON.stringify(back)); assert.equal(back.owner.id, bot.player.id);
});

function mctx() {
  const socks = [], store = new Map();
  return { socks, acceptWebSocket(ws, tags) { ws.tags = tags; socks.push(ws) }, getWebSockets(tag) { return socks.filter(w => !w.closed && (tag == null || w.tags[0] === tag)) }, getTags(ws) { return ws.tags },
    storage: { async get(k) { return store.get(k) }, async put(k, v) { store.set(k, structuredClone(v)) }, async setAlarm() { }, async delete(k) { store.delete(k) } } };
}
test('sim: a match with a simulated player never shows in Live now, and still counts when it ends', async () => {
  const posts = [], batches = [];
  const env = { LOBBY: { idFromName: n => n, get: () => ({ fetch: async (u, i) => { posts.push(JSON.parse(i.body)); return Response.json({ ok: true }) } }) },
    DB: { prepare: q => ({ bind: (...a) => ({ q, a, all: async () => ({ results: [] }), run: async () => ({}) }) }), batch: async l => { batches.push(l); return [] } } };
  for (const sim of [['1', '1'], ['0', '1']]) {
    posts.length = 0; batches.length = 0;
    const c = mctx(), m = new Match(c, env);
    for (const [i, p] of [11, 22].entries()) await m.fetch(new Request('https://x/match/ABCDEF/ws', { headers: { Upgrade: 'websocket', 'x-player': String(p), 'x-sim': sim[i] } }));
    await m.webSocketMessage(c.socks[0], JSON.stringify({ t: 'start', seed: 1, theme: 'moon', count: 2, hats: [] }));
    await m.webSocketMessage(c.socks[0], JSON.stringify({ t: 'f', e: [['gameOver', [1]]], s: {} }));
    assert.equal(posts.length, 0, 'no Live now entry');
    assert.equal(batches.length, 1); assert.match(batches[0][0].q, /INSERT INTO matches/);
  }
  const c = mctx(), m = new Match(c, env); posts.length = 0;                                  // two real players: listed as before
  for (const p of [11, 22]) await m.fetch(new Request('https://x/match/ABCDEF/ws', { headers: { Upgrade: 'websocket', 'x-player': String(p), 'x-sim': '0' } }));
  await m.webSocketMessage(c.socks[0], JSON.stringify({ t: 'start', seed: 1, theme: 'moon', count: 2, hats: [] }));
  assert.equal(posts.length, 1); assert.equal(posts[0].code, 'ABCDEF');
});

test('lobby: a busy lobby bundles list updates (one a second at most) and leaves closed sockets out', async () => {
  const socks = [], c = { socks, acceptWebSocket(ws, tags) { ws.tags = tags; socks.push(ws) }, getWebSockets: tag => socks.filter(w => !w.closed && (tag == null || w.tags.includes(tag))), storage: { get: async () => null, put: async () => { }, delete: async () => { } } };
  const l = new Lobby(c, {});
  const enter = (id, hidden) => l.fetch(new Request('https://lobby/ws' + (hidden ? '?hidden=1' : ''), { headers: { Upgrade: 'websocket', 'x-player': String(id), 'x-name': 'P' + id } }));
  for (let i = 1; i <= 60; i++) await enter(i, i > 2);
  const first = socks[0], lists = () => first.out.filter(m => m.t === 'list');
  const before = lists().length;
  assert.ok(before < 45, 'bundled after 40: ' + before);
  await new Promise(r => setTimeout(r, 1100));
  const after = lists().at(-1);
  assert.equal(after.online, 60); assert.deepEqual(after.players.map(p => p.id), [1, 2]);    // simulated (hidden) players count but aren't listed
  socks[5].readyState = 3; await l.webSocketClose(socks[5]);                                 // closing: no longer counted or sent to
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(lists().at(-1).online, 59); assert.equal(socks[5].out.filter(m => m.t === 'list').at(-1).online, 60);
});

test('bot: /sim orders go to the load-test Worker, and /sim shows its latest numbers', async () => {
  const env = makeEnv(), now = Date.now();
  assert.match(await simCommand(env, 'rush 45', now), /45 minutes/);
  assert.match(await simCommand(env, 'rush 9999', now), /180 minutes/);
  await simCommand(env, 'off', now); await simCommand(env, 'life', now);
  assert.deepEqual(env.sql.prepare('SELECT cmd, arg FROM sim_cmd ORDER BY id').all().map(r => [r.cmd, r.arg]), [['rush', 45], ['rush', 180], ['off', null], ['life', null]]);
  assert.match(await simCommand(env, '', now), /no numbers yet/);
  env.sql.prepare('INSERT INTO sim_stats (at, data) VALUES (?, ?)').run(now - 60000, JSON.stringify({ mode: 'rush', bots: 500, online: 480, inMatch: 300, serverOnline: 492, players: 1290, rpm: 3100, p50: 41, p95: 180, errPct: 0.1 }));
  const s = await simCommand(env, '', now);
  assert.match(s, /rush/); assert.match(s, /480 online/); assert.match(s, /492 online/); assert.match(s, /180 ms/);
});

test('prize: a week with 150 scorers (bots among them) stays under D1\'s 100 bound values, and bots never chart', async () => {
  const env = makeEnv(), { chart, FIRST_WEEK } = await import('../src/prize.js'), w = FIRST_WEEK, now = w + 3 * 864e5, D = 864e5;
  const prep = env.DB.prepare; env.DB.prepare = q => { const s = prep(q), b = s.bind; s.bind = (...a) => { if (a.length > 100) throw new Error('too many SQL variables: ' + a.length); return b(...a) }; return s };
  const add = (i, sim) => {
    const id = env.sql.prepare("INSERT INTO players (name, created, wallet) VALUES (?, ?, ?) RETURNING id").get('P' + i, w - 30 * D, 'W' + i).id;
    if (sim) env.sql.prepare('INSERT INTO sim_players (player, created) VALUES (?, 0)').run(id);
    env.sql.prepare('INSERT INTO score_log (player, at, amount) VALUES (?, ?, ?)').run(id, w + D, 100 + i);
    env.sql.prepare('INSERT INTO run_log (player, at, secs, credit) VALUES (?, ?, 300, 400)').run(id, w + D);   // one checked match
    env.sql.prepare("INSERT INTO prize_entry (player, x, group_ok) VALUES (?, 'x' || ?, 1)").run(id, i);
    for (let d = 0; d < 3; d++) env.sql.prepare('INSERT INTO play_days (player, day) VALUES (?, ?)').run(id, Math.floor((w + d * D) / D));
    return id;
  };
  const ids = [...Array(150)].map((_, i) => add(i, i % 3 === 0));
  const c = await chart(env, w, now);
  assert.equal(c.length, 100);                                                                // every real one, no bot
  assert.ok(c.every(r => ids.indexOf(r.id) % 3 !== 0)); assert.equal(c[0].id, ids[149]);
});

test('sim: a simulated player may send its own country (for its flag), nobody else can', async () => {
  const env = makeEnv();
  const bot = await call(env, '/auth/guest', {}, null, { 'x-sim-key': KEY });
  await call(env, '/played', { mode: 'cpu' }, bot.token, { 'x-sim-key': KEY, 'x-sim-cc': 'KE' });
  const guest = await call(env, '/auth/guest', {});
  await call(env, '/played', { mode: 'cpu' }, guest.token, { 'x-sim-key': 'wrong'.repeat(8), 'x-sim-cc': 'KE' });
  const cc = id => env.sql.prepare('SELECT cc FROM player_meta WHERE player = ?').get(id).cc;
  assert.equal(cc(bot.player.id), 'KE'); assert.equal(cc(guest.player.id), null);
});

test('sim: /sim taper winds the bots down a step now and a step each UTC day, to none and off', async () => {
  const env = makeEnv(), now = Date.UTC(2026, 10, 10, 22, 40);
  assert.match(await simCommand(env, 'taper 50', now), /50 simulated players stop/);
  await simCommand(env, 'taper off', now); await simCommand(env, 'bots 300', now); assert.match(await simCommand(env, 'taper x', now), /Use \/sim taper/);
  assert.deepEqual(env.sql.prepare('SELECT cmd, arg FROM sim_cmd ORDER BY id').all().map(r => [r.cmd, r.arg]), [['taper', 50], ['taper', 0], ['bots', 300]]);
  env.sql.prepare('INSERT INTO sim_stats (at, data) VALUES (?, ?)').run(now - 60000, JSON.stringify({ mode: 'life', bots: 450, taper: 50, online: 40, inMatch: 10 }));
  assert.match(await simCommand(env, '', now), /450 \(40 online, 10 in online matches\), 50 fewer each UTC day/);
  const { Control } = await import('../sim/control.js'), store = new Map();
  const c = new Control({ storage: { get: async k => store.get(k), put: async (k, v) => { store.set(k, v) } } }, {}); await c.load();
  c.order('life'); assert.equal(c.cfg.bots, 500);
  c.order('taper', 120); assert.equal(c.cfg.bots, 380);
  assert.equal(c.taperDay(now + 3600e3), false); assert.equal(c.cfg.bots, 380);                // same UTC day: nothing more
  assert.equal(c.taperDay(now + 864e5), true); assert.equal(c.cfg.bots, 260);                  // next day: one more step
  c.taperDay(now + 2 * 864e5); c.taperDay(now + 3 * 864e5); c.taperDay(now + 4 * 864e5);
  assert.equal(c.cfg.bots, 0); assert.equal(c.cfg.mode, 'off'); assert.equal(c.cfg.taper, null);
  c.order('life'); assert.equal(c.cfg.bots, 500);                                              // /sim life after none: all of them again
  c.order('taper', 100); c.order('taper', 0); assert.equal(c.cfg.bots, 400); assert.equal(c.taperDay(now + 9 * 864e5), false);   // stopped where it was
});

test('sim: /sim active 90 keeps every bot and shortens each one\'s time online, today\'s plan too', async () => {
  const env = makeEnv(), now = Date.UTC(2026, 10, 10, 22, 40);
  assert.match(await simCommand(env, 'active 90', now), /90% of its usual time: about 1\.8 to 2\.7 hours/);
  assert.match(await simCommand(env, 'active 5', now), /Use \/sim active/);
  assert.deepEqual(env.sql.prepare('SELECT cmd, arg FROM sim_cmd ORDER BY id').all().map(r => [r.cmd, r.arg]), [['active', 90]]);
  env.sql.prepare('INSERT INTO sim_stats (at, data) VALUES (?, ?)').run(now - 60000, JSON.stringify({ mode: 'life', bots: 500, active: 90, online: 54, inMatch: 10 }));
  assert.match(await simCommand(env, '', now), /500 \(54 online, 10 in online matches\), online 90% of the usual time/);
  const { Control } = await import('../sim/control.js'), { Fleet } = await import('../sim/fleet.js'), store = new Map();
  const c = new Control({ storage: { get: async k => store.get(k), put: async (k, v) => { store.set(k, v) } } }, {}); await c.load();
  c.order('life'); c.order('active', 90); assert.equal(c.cfg.active, 90); assert.equal(c.cfg.bots, 500);
  const f = new Fleet({ storage: { get: async () => null, put: async () => { }, setAlarm: async () => { } } }, {}); f.speed = () => 1;
  f.cfg = { active: 100 }; const day = Math.floor(now / 864e5);
  let total = 0; for (let i = 0; i < 400; i++) total += f.planDay(day).slots.reduce((s, [a, e]) => s + e - a, 0);
  f.cfg = { active: 90 }; let less = 0; for (let i = 0; i < 400; i++) less += f.planDay(day).slots.reduce((s, [a, e]) => s + e - a, 0);
  assert.ok(Math.abs(less / total - .9) < .03, 'about 10% less time online: ' + (less / total).toFixed(3));
  f.cfg = { active: 100 }; const b = { plan: f.planDay(day) }, before = b.plan.slots.map(([a, e]) => e - a);
  f.cfg = { active: 90 }; f.slot(b, day * 864e5); const after = b.plan.slots.map(([a, e]) => e - a);    // a plan made before the change gets 10% shorter
  before.forEach((x, i) => assert.ok(Math.abs(after[i] - x * .9) <= 1));
});
