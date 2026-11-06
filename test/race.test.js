import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const RealResponse = globalThis.Response;
const R = await import('../src/race.js');
const { RACE } = R;
const DAY = 864e5, T = RACE.start + 2 * DAY;   // a Wednesday in the race

// Solana stand-in: each wallet's signature count and first payer
let chainData = {};
globalThis.fetch = async (url, init) => {
  const b = JSON.parse(init.body);
  if (b.method === 'getSignaturesForAddress') { const c = chainData[b.params[0]] || { n: 0 }; return RealResponse.json({ result: Array.from({ length: c.n }, (_, i) => ({ signature: b.params[0] + ':' + i, blockTime: Math.floor((c.first || T) / 1000) })) }) }
  if (b.method === 'getTransaction') { const w = b.params[0].split(':')[0], c = chainData[w] || {}; return RealResponse.json({ result: { transaction: { message: { accountKeys: [c.payer || w, w] } } } }) }
  return RealResponse.json({ error: 'no' });
};

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { const r = []; for (const s of l) r.push(await s.run()); return r } };
  const add = (id, name, { created = RACE.start + DAY, wallet = null, by = null, tg = id + 500, matches = 0 } = {}) => {
    sql.prepare('INSERT INTO players (id, tg_id, wallet, name, created) VALUES (?, ?, ?, ?, ?)').run(id, tg, wallet, name, created);
    sql.prepare('INSERT INTO player_meta (player, invited_by, played) VALUES (?, ?, ?)').run(id, by, matches);
    for (let i = 0; i < matches; i++) sql.prepare('INSERT INTO run_log (player, at, secs, credit) VALUES (?, ?, 60, 90)').run(id, created + (i + 1) * 60e3);
  };
  return { DB, sql, add, SOLANA_RPC: 'https://rpc.test', ADMIN_PLAYERS: '2' };
}

test('a friend counts with a new account, a wallet and 3 matches, during the race only', async () => {
  const env = makeEnv();
  env.add(10, 'Ana', { created: RACE.start - 30 * DAY, wallet: 'WANA' });
  env.add(11, 'Bo', { by: 10, wallet: 'WBO', matches: 3 });
  env.add(12, 'Cy', { by: 10, matches: 3 });                                       // no wallet
  env.add(13, 'Di', { by: 10, wallet: 'WDI', matches: 2 });                        // 2 matches
  env.add(14, 'Ed', { by: 10, wallet: 'WED', matches: 3, created: RACE.start - DAY });   // joined before the race
  env.add(15, 'Fi', { by: 10, wallet: 'WFI', matches: 3 }); env.sql.prepare('INSERT INTO sim_players (player, created) VALUES (15, 0)').run();   // load-test bot
  assert.equal(await R.check(env, 11, RACE.start - 1), false);                     // not started
  assert.equal(await R.check(env, 11, RACE.end), false);                           // over
  for (const id of [11, 12, 13, 14, 15]) await R.check(env, id, T);
  assert.deepEqual(env.sql.prepare('SELECT friend FROM race_friends').all().map(r => r.friend), [11]);
  assert.equal(await R.check(env, 11, T + 1), false);                              // once
  env.sql.prepare('UPDATE players SET wallet = ? WHERE id = 12').run('WCY');
  assert.equal(await R.sweep(env, T + 2), 1);                                      // the sweep catches a wallet linked later
  const b = await R.board(env, T + 3);
  assert.deepEqual(b.map(r => [r.rank, r.id, r.n]), [[1, 10, 2]]);
});

test('the board: most friends first, a tie goes to whoever got there first; admins and skipped players are out', async () => {
  const env = makeEnv();
  for (const [id, name] of [[1, 'Ana'], [2, 'Damian'], [3, 'Bo'], [4, 'Cy']]) env.add(id, name, { created: 0, wallet: 'W' + id });
  let f = 100; const give = (inv, n, at) => { for (let i = 0; i < n; i++) { env.add(f, 'F' + f, { by: inv, wallet: 'WF' + f, matches: 3 }); env.sql.prepare('INSERT INTO race_friends (race, friend, inviter, at) VALUES (?, ?, ?, ?)').run(RACE.id, f++, inv, at + i) } };
  give(1, 3, T + 50); give(2, 5, T); give(3, 3, T + 10); give(4, 1, T);
  let b = await R.board(env, T + DAY);
  assert.deepEqual(b.map(r => r.id), [3, 1, 4]);                                   // Damian (admin) is out; Bo reached 3 before Ana
  assert.deepEqual(R.winners(b).map(w => [w.id, w.prize]), [[3, 0.5], [1, 0.3]]);  // Cy has 1 friend: under the minimum of 3
  assert.match(await R.command(env, 'skip 3 shared phones', {}, T), /out of the Invite Race/);
  b = await R.board(env, T + DAY); assert.deepEqual(b.map(r => r.id), [1, 4]);
  await R.command(env, 'unskip 3', {}, T); assert.equal((await R.board(env, T + DAY))[0].id, 3);
  await R.command(env, 'skip 100', {}, T);                                          // a friend taken out no longer counts
  assert.equal((await R.board(env, T + DAY)).find(r => r.id === 1).n, 2);
  // the end: friends counted after it don't count, and the admin gets /pay lines for the winners with a wallet
  env.sql.prepare('INSERT INTO race_friends (race, friend, inviter, at) VALUES (?, 999, 4, ?)').run(RACE.id, RACE.end + 5);
  const txt = await R.command(env, '', {}, RACE.end + DAY);
  assert.match(txt, /is over/); assert.match(txt, /<code>\/pay new Invite Race\nW3 0\.5 SOL Invite Race #1 Bo/); assert.doesNotMatch(txt, /W4 /);
});

test('GET /race: the card shows the top 10 and what each of my friends still needs', async () => {
  const env = makeEnv();
  env.add(10, 'Ana', { created: 0, wallet: 'WANA' });
  env.add(11, 'Bo', { by: 10, wallet: 'WBO', matches: 3 }); env.add(12, 'Cy', { by: 10, matches: 1, created: RACE.start + DAY + 60e3 }); env.add(13, 'Old', { by: 10, created: 0, wallet: 'WOLD', matches: 9 });
  assert.deepEqual(await R.handle('/race', env, { id: 10 }, RACE.show - 1), { on: false });
  const soon = await R.handle('/race', env, { id: 10 }, RACE.start - DAY);
  assert.equal(soon.state, 'soon'); assert.deepEqual(soon.prizes, [0.5, 0.3, 0.2]); assert.equal(soon.min, 3);
  const d = await R.handle('/race', env, { id: 10 }, T);                            // Bo is caught up on the spot
  assert.equal(d.state, 'on'); assert.deepEqual(d.top, [{ rank: 1, id: 10, name: 'Ana', n: 1 }]);
  assert.deepEqual(d.me, { rank: 1, n: 1, friends: [{ name: 'Cy', wallet: false, matches: 1, counted: false }, { name: 'Bo', wallet: true, matches: 3, counted: true }] });
  assert.equal((await R.handle('/race', env, { id: 2 }, RACE.show - 1)).on, true);   // admins see it early
  assert.equal((await R.handle('/race', env, { id: 10 }, RACE.until)).on, false);
});

test('/race check flags wallets the inviter funded, shared funders, empty wallets and batches', async () => {
  const env = makeEnv();
  env.add(10, 'Ana', { created: 0, wallet: 'WANA' });
  env.add(11, 'Bo', { by: 10, wallet: 'WBO', matches: 3 });
  env.add(12, 'Cy', { by: 10, wallet: 'WCY', matches: 3, created: RACE.start + DAY + 3 * 60e3 });
  env.add(13, 'Di <x>', { by: 10, wallet: 'WDI', matches: 1, created: RACE.start + 3 * DAY, tg: null });
  chainData = { WANA: { n: 40, payer: 'EXCH', first: 0 }, WBO: { n: 2, payer: 'WANA', first: T }, WCY: { n: 5, payer: 'MULE', first: RACE.start - 100 * DAY }, WDI: { n: 0 } };
  env.sql.prepare('INSERT INTO race_friends (race, friend, inviter, at) VALUES (?, 11, 10, ?), (?, 12, 10, ?)').run(RACE.id, T, RACE.id, T);
  const t = await R.command(env, 'check 10', {}, T + DAY);
  assert.match(t, /2 count of 3/);
  assert.match(t, /11 Bo .*\n {4}⚠️ funded by the inviter, wallet made today, joined within 10 min of 1/);
  assert.match(t, /12 Cy .*\n {4}⚠️ joined within 10 min of 1/);
  assert.match(t, /⏳ 13 Di &lt;x&gt; .*1\/3 matches.*\n {4}⚠️ empty wallet, never used, no Telegram/);
  assert.match(await R.command(env, 'check 77', {}, T), /No player with ID 77/);
});

test('/race post puts the standings, then the winners, in the community group', async () => {
  const env = makeEnv(), sent = [], tg = async (e, m, b) => { sent.push(b); return { ok: true } };
  env.add(10, 'Ana', { created: 0, wallet: 'WANA' });
  for (let i = 0; i < 3; i++) { env.add(20 + i, 'F' + i, { by: 10, wallet: 'WF' + i, matches: 3 }); await R.check(env, 20 + i, T) }
  assert.match(await R.command(env, 'post', { tg }, T), /Posted/);
  assert.match(sent[0].text, /standings\n\n🥇 Ana · 3 friends/); assert.doesNotMatch(sent[0].text, /SOL/);
  await R.command(env, 'post', { tg }, RACE.end + DAY);
  assert.match(sent[1].text, /winners!\n\n🥇 Ana · 3 friends/);
});

test('an inviter folded into another account keeps their friends', async () => {
  const env = makeEnv();
  env.add(10, 'Ana', { created: 0 }); env.add(30, 'Ana TG', { created: 0, wallet: 'WA' });
  env.sql.prepare('INSERT INTO race_friends (race, friend, inviter, at) VALUES (?, 11, 10, ?)').run(RACE.id, T);
  await R.mergeRace(env, 10, 30);
  assert.equal(env.sql.prepare('SELECT inviter FROM race_friends').get().inviter, 30);
});
