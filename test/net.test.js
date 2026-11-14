import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const N = await import('../src/net.js');
const R = await import('../src/race.js');
const P = await import('../src/players.js');
const DAY = 864e5, T = R.RACE.start + 2 * DAY;
globalThis.fetch = async () => Response.json({ error: 'no' });   // no Solana RPC in these tests

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const add = (id, name, by = null, created = R.RACE.start + DAY) => { sql.prepare('INSERT INTO players (id, tg_id, name, created) VALUES (?, ?, ?, ?)').run(id, id + 500, name, created); sql.prepare('INSERT INTO player_meta (player, invited_by, played) VALUES (?, ?, 3)').run(id, by) };
  return { DB: { prepare: q => stmt(q) }, sql, add, SESSION_SECRET: 'test-secret', ADMIN_PLAYERS: '2' };
}
const from = (ip, sim) => new Request('https://api.test/played', { method: 'POST', headers: { ...(ip ? { 'CF-Connecting-IP': ip } : {}), ...(sim ? { 'x-sim-key': 'k' } : {}) } });

test('the network part of an address: IPv4 whole, IPv6 cut to its first 64 bits, nonsense ignored', () => {
  assert.equal(N.netAddr('203.0.113.7'), '203.0.113.7');
  assert.equal(N.netAddr('2001:db8:85a3:12::8a2e:370:7334'), '2001:db8:85a3:12::/64');
  assert.equal(N.netAddr('2001:0DB8:85a3:0012:aaaa:bbbb:cccc:dddd'), '2001:db8:85a3:12::/64');
  assert.equal(N.netAddr('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(N.netAddr('::ffff:198.51.100.4'), '198.51.100.4');
  for (const bad of ['', null, 'localhost', '1.2.3', '2001::db8::1', '12345::1', '<script>']) assert.equal(N.netAddr(bad), '');
});

test('the stored code never shows the address, is the same for one network and differs per server secret', async () => {
  const a = await N.netCode('203.0.113.7', 's1');
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(!a.includes('203'));
  assert.equal(await N.netCode('203.0.113.7', 's1'), a);
  assert.notEqual(await N.netCode('203.0.113.8', 's1'), a);
  assert.notEqual(await N.netCode('203.0.113.7', 's2'), a);
  assert.equal(await N.netCode('2a02:1:2:3:aaaa::1', 's1'), await N.netCode('2a02:1:2:3:bbbb::9', 's1'));   // a phone's changing IPv6 address
  assert.equal(await N.netCode('junk', 's1'), null);
});

test('a counted match records the network once a day, never for load-test bots; old rows are deleted after 30 days', async () => {
  const env = makeEnv(), now = T;
  assert.equal(await N.netSeen(env, from('203.0.113.7'), 10, now), true);
  await N.netSeen(env, from('203.0.113.7'), 10, now + 60e3);                         // same day: one row
  assert.equal(await N.netSeen(env, from('203.0.113.7', true), 11, now), false);     // a load-test bot
  assert.equal(await N.netSeen(env, from(null), 12, now), false);                    // no address
  const rows = env.sql.prepare('SELECT player, h, day FROM net_seen').all();
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes('203.0'));
  await N.netSeen(env, from('203.0.113.7'), 10, now - 31 * DAY);
  await N.netCleanup(env, now);
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM net_seen').get().n, 1);
});

test('/race check flags friends on the inviter\'s network or on each other\'s', async () => {
  const env = makeEnv();
  env.add(10, 'Ana', null, 0); env.add(11, 'Bo', 10); env.add(12, 'Cy', 10, R.RACE.start + 3 * DAY); env.add(13, 'Di', 10, R.RACE.start + 4 * DAY); env.add(14, 'Ed', 10, R.RACE.start + 5 * DAY);
  await N.netSeen(env, from('198.51.100.1'), 10, T); await N.netSeen(env, from('198.51.100.1'), 11, T);   // Bo plays from Ana's home
  await N.netSeen(env, from('2a02:9:9:9::1'), 12, T); await N.netSeen(env, from('2a02:9:9:9::77'), 13, T);   // Cy and Di share a phone network
  await N.netSeen(env, from('192.0.2.50'), 14, T);
  const t = await R.command(env, 'check 10', {}, T + DAY);
  assert.match(t, /11 Bo .*\n {4}⚠️ .*same network as the inviter/);
  assert.match(t, /12 Cy .*\n {4}⚠️ .*same network as 1 other friend\(s\)/);
  assert.match(t, /13 Di .*\n {4}⚠️ .*same network as 1 other friend\(s\)/);
  assert.doesNotMatch(t, /14 Ed [^\n]*\n {4}⚠️[^\n]*same network/);
});

test('/player shows the networks of the last 30 days and the other accounts seen on them', async () => {
  const env = makeEnv(), now = T;
  env.add(10, 'Ana', null, 0); env.add(11, 'Bo <i>'); env.add(12, 'Cy'); env.add(13, 'Bot');
  env.sql.prepare('INSERT INTO sim_players (player, created) VALUES (13, 0)').run();
  for (const id of [10, 11, 13]) await N.netSeen(env, from('198.51.100.1'), id, now);
  await N.netSeen(env, from('192.0.2.9'), 10, now);
  await N.netSeen(env, from('192.0.2.200'), 12, now - 40 * DAY);                     // too long ago
  assert.match(await P.lookup(env, '10', now), /🌐 2 networks in 30 days · same network as 11 Bo &lt;i&gt; \(a hint/);
  assert.doesNotMatch(await P.lookup(env, '10', now), /Bot/);                        // load-test bots are left out
  assert.match(await P.lookup(env, '11', now), /🌐 1 network in 30 days · same network as 10 Ana/);
  assert.doesNotMatch(await P.lookup(env, '12', now), /🌐/);
});
