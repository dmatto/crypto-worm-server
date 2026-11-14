import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Stand-ins: node:sqlite for D1 and Telegram's Bot API recorded in `calls`.
const calls = [];
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop(), body = init && init.body ? JSON.parse(init.body) : {};
  calls.push([method, body]);
  if (method === 'sendMessage' && body.chat_id === 666) return Response.json({ ok: false, error_code: 403 });
  return Response.json({ ok: true, result: {} });
};
const { default: worker } = await import('../src/index.js');
const M = await import('../src/medals.js');
const { weekly, weekStart } = await import('../src/growth.js');
const R = await import('../src/race.js');
const DAY = 864e5;

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const env = { DB, sql, SESSION_SECRET: 'test-secret', BOT_TOKEN: '123:BOT', GAME_LINK: 'https://t.me/CryptoWormWarsBot/play', SITE_URL: 'https://play.test', ADMIN_PLAYERS: '1' };
  env.LOBBY = { idFromName: n => n, get: () => ({ fetch: async u => Response.json(String(u).endsWith('/ids') ? { ids: [] } : { online: [] }) }) };
  // a player with a Telegram chat (tg_id = id + 500) who has finished `played` matches
  env.add = (id, name, played = 0, extra = {}) => { sql.prepare('INSERT INTO players (id, tg_id, name, created) VALUES (?, ?, ?, ?)').run(id, extra.tg === null ? null : id + 500, name, 0);
    sql.prepare('INSERT INTO player_meta (player, played, source) VALUES (?, ?, ?)').run(id, played, extra.source || null) };
  return env;
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
const medalsOf = (env, id) => env.sql.prepare('SELECT kind, ref, label, tier, value, sold FROM medals WHERE player = ? ORDER BY id').all(id).map(r => ({ ...r }));
const gap = env => env.sql.prepare('UPDATE player_meta SET last_played = 0').run();   // past the 20 s gap between counted matches

test('medals: the first 10 players to win with a new weapon are its Pioneers; a loss, an old weapon or a load-test bot gets nothing', async () => {
  const env = makeEnv();
  for (let i = 1; i <= 12; i++) env.add(100 + i, 'P' + i);
  env.add(200, 'Bot'); env.sql.prepare('INSERT INTO sim_players (player, created) VALUES (200, 0)').run();
  assert.deepEqual(await M.pioneer(env, { id: 200 }, 'cpu', ['saber'], true), []);                 // a load-test bot
  assert.deepEqual(await M.pioneer(env, { id: 101 }, 'cpu', ['saber'], false), []);                // a loss
  assert.deepEqual(await M.pioneer(env, { id: 101 }, '2p', ['saber'], true), []);                  // two players on one phone
  assert.deepEqual(await M.pioneer(env, { id: 101 }, 'cpu', ['rocket', 'grenade'], true), []);     // weapons that aren't new
  const first = await M.pioneer(env, { id: 101 }, 'online', ['rocket', 'saber', 'saber', 'football'], true);
  assert.deepEqual(first.map(m => [m.kind, m.label, m.tier, m.value]), [['pioneer', 'Laser Saber', 'rare', 1500], ['pioneer', 'Golazo', 'rare', 1500]]);
  assert.deepEqual(await M.pioneer(env, { id: 101 }, 'cpu', ['saber'], true), []);                 // once per weapon
  for (let i = 2; i <= 12; i++) await M.pioneer(env, { id: 100 + i }, 'cpu', ['saber'], true);
  assert.equal(env.sql.prepare("SELECT COUNT(*) AS n FROM medals WHERE kind = 'pioneer' AND ref = 'saber'").get().n, 10);
  assert.equal(medalsOf(env, 111).length, 0); assert.equal(medalsOf(env, 112).length, 0);          // the 11th and 12th came too late
  assert.match(calls.findLast(([m, b]) => m === 'sendMessage' && b.chat_id === 610)[1].text, /🧪 New medal: Pioneer · Laser Saber!\n\n.*sell it any time for 1,500 BP/s);
  assert.equal(calls.findLast(([m, b]) => b.chat_id === 610)[1].reply_markup.inline_keyboard[0][0].url, 'https://t.me/CryptoWormWarsBot/play?startapp=medals');
});

test('medals: a won match reported with its weapons gives the Pioneer medal; the game gets it back once as a new medal', async () => {
  const env = makeEnv(); calls.length = 0;
  const me = await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami') });
  const lost = await call(env, '/played', { mode: 'cpu', w: ['saber'], win: false }, me.token);
  assert.deepEqual(lost.medals, []);
  gap(env);
  const won = await call(env, '/played', { mode: 'cpu', w: ['saber', 'rocket'], win: true }, me.token);
  assert.deepEqual(won.medals.map(m => [m.kind, m.label, m.emo, m.name, m.value]), [['pioneer', 'Laser Saber', '🧪', 'Pioneer', 1500]]);
  assert.deepEqual((await call(env, '/rewards', {}, me.token)).medals, []);                        // shown once
  gap(env);
  assert.deepEqual((await call(env, '/played', { mode: 'cpu', w: 'saber', win: 'yes' }, me.token)).medals, []);   // junk is ignored
});

test('medals: the player whose first match makes it 2,000 real players gets the one-of-a-kind Milestone medal', async () => {
  const env = makeEnv();
  const ins = env.sql.prepare('INSERT INTO player_meta (player, played, source) VALUES (?, ?, ?)');
  for (let i = 0; i < 1998; i++) ins.run(10000 + i, 1, null);
  for (let i = 0; i < 30; i++) ins.run(20000 + i, 4, 'loadtest');                                   // load-test bots don't count
  const a = await call(env, '/auth/guest', {}), b = await call(env, '/auth/guest', {}), c = await call(env, '/auth/guest', {});
  assert.deepEqual((await call(env, '/played', { mode: 'cpu' }, a.token)).medals, []);              // #1,999
  const two = await call(env, '/played', { mode: 'cpu' }, b.token);                                  // #2,000
  assert.deepEqual(two.medals.map(m => [m.kind, m.label, m.tier, m.value]), [['milestone', 'Player #2,000', 'unique', 5000]]);
  assert.deepEqual((await call(env, '/played', { mode: 'cpu' }, c.token)).medals, []);              // #2,001
  gap(env);
  assert.deepEqual((await call(env, '/played', { mode: 'cpu' }, b.token)).medals, []);              // only on a first match
  assert.equal(env.sql.prepare("SELECT COUNT(*) AS n FROM medals WHERE kind = 'milestone'").get().n, 1);
  for (let i = 0; i < 2010; i++) ins.run(30000 + i, 1, null);                                      // then 4,012 players: long past 4,000
  const d = await call(env, '/auth/guest', {});
  assert.deepEqual((await call(env, '/played', { mode: 'cpu' }, d.token)).medals, []);
});

test('medals: the inviter gets the Recruiter medal when the first friend finishes a match, and only then', async () => {
  const env = makeEnv(); calls.length = 0;
  const host = await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami') });
  for (const n of [1, 2]) {
    const kid = await call(env, '/auth/guest', {}); await call(env, '/friends/add', { code: host.friendCode }, kid.token);
    if (n === 1) assert.deepEqual(medalsOf(env, host.player.id), []);
    await call(env, '/played', { mode: 'cpu' }, kid.token);
  }
  const got = medalsOf(env, host.player.id);
  assert.equal(got.length, 1); assert.equal(got[0].kind, 'recruiter'); assert.match(got[0].label, /^First friend: /); assert.equal(got[0].value, 300);
  const dms = calls.filter(([m, b]) => m === 'sendMessage' && b.chat_id === 42).map(c => c[1].text);
  assert.equal(dms.filter(t => /New medal: Recruiter/.test(t)).length, 1);                        // told once, in the first friend's DM
  assert.match(dms[0], /joined Crypto Worm Wars through your invite[^]*🤝 New medal: Recruiter, for your first friend! It shows on your player card\./);
  assert.deepEqual((await call(env, '/rewards', {}, host.token)).medals.map(m => m.kind), ['recruiter']);
});

test('medals: selling pays the value in BP once, outside the ranking; a sold medal leaves the card and is never given again', async () => {
  const env = makeEnv();
  const me = await call(env, '/auth/telegram', { initData: tgInit(42, 'Dami') }), other = await call(env, '/auth/guest', {});
  await M.pioneer(env, me.player, 'cpu', ['saber'], true); await M.recruiter(env, me.player.id, 'Kid');
  const page = await call(env, '/medals', undefined, me.token);
  assert.deepEqual(page.medals.map(m => [m.kind, m.value]), [['recruiter', 300], ['pioneer', 1500]]);
  assert.deepEqual(page.tiers, { common: 300, rare: 1500, unique: 5000 }); assert.deepEqual(page.sold, { n: 0, bp: 0 });
  assert.deepEqual(page.pioneer, { weapons: ['Laser Saber', 'Golazo'], n: 10 });
  assert.deepEqual((await call(env, '/rewards', {}, me.token)).medals, []);                        // opening the page counts as shown
  const card = await call(env, '/chat/player?id=' + me.player.id, undefined, other.token);
  assert.deepEqual(card.medals.map(m => [m.emo, m.name, m.label, m.tier, m.ref]), [['🤝', 'Recruiter', 'First friend: Kid', 'common', ''], ['🧪', 'Pioneer', 'Laser Saber', 'rare', 'saber']]);
  const pid = page.medals[1].id;
  assert.equal((await call(env, '/medals/sell', { id: pid }, other.token)).status, 404);           // not theirs
  const sold = await call(env, '/medals/sell', { id: pid }, me.token);
  assert.equal(sold.sold.kind, 'pioneer'); assert.deepEqual(sold.rewards.map(r => [r.amount, r.reason, r.note]), [[1500, 'medal', 'Pioneer · Laser Saber']]);
  assert.equal((await call(env, '/medals/sell', { id: pid }, me.token)).status, 404);              // once
  assert.equal((await call(env, '/medals/sell', { id: 'x' }, me.token)).status, 400);
  const after = await call(env, '/medals', undefined, me.token);
  assert.deepEqual(after.medals.map(m => m.kind), ['recruiter']); assert.deepEqual(after.sold, { n: 1, bp: 1500 });
  assert.deepEqual((await call(env, '/chat/player?id=' + me.player.id, undefined, other.token)).medals.map(m => m.kind), ['recruiter']);
  assert.deepEqual(await M.pioneer(env, me.player, 'cpu', ['saber'], true), []);                  // never again
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM cworm_scores').get().n, 0);              // nothing went into the ranking
  assert.equal((await call(env, '/chat/player?id=' + other.player.id, undefined, me.token)).medals, undefined);
});

test('medals: Monday gives last week\'s top 10 real players a medal (#1 one of a kind), skipping load-test bots and admins', async () => {
  const env = makeEnv(); calls.length = 0;
  const now = weekStart(Date.UTC(2026, 10, 16, 12)) + 10 * 60e3, last = weekStart(now) - 7 * DAY;
  env.sql.prepare("INSERT INTO bot_kv (k, v) VALUES ('group', '-100123')").run();
  const score = env.sql.prepare('INSERT INTO cworm_scores (player, week_start, week, total) VALUES (?, ?, ?, ?)');
  env.add(1, 'Admin'); score.run(1, last, 99999, 99999);
  for (let i = 0; i < 3; i++) { env.add(300 + i, 'Sim' + i, 5, { source: 'loadtest' }); score.run(300 + i, last, 90000 - i, 90000) }
  for (let i = 0; i < 12; i++) { env.add(400 + i, 'Real' + i, 5); score.run(400 + i, last, 5000 - i * 100, 5000) }
  await weekly(env, now);
  const got = env.sql.prepare("SELECT player, label, tier, value FROM medals WHERE kind = 'weektop' ORDER BY value DESC, player").all().map(r => ({ ...r }));
  assert.equal(got.length, 10);
  assert.deepEqual(got[0], { player: 400, label: '#1 · week of 2026-11-09', tier: 'unique', value: 5000 });
  assert.deepEqual(got.slice(1).map(r => [r.player, r.tier]), [401, 402, 403, 404, 405, 406, 407, 408, 409].map(p => [p, 'rare']));
  await weekly(env, now + 3600e3);                                                                   // once a week
  assert.equal(env.sql.prepare("SELECT COUNT(*) AS n FROM medals WHERE kind = 'weektop'").get().n, 10);
});

test('medals: an online Royale win (one a week), a team war win and the Invite Race winners', async () => {
  const env = makeEnv(), now = Date.UTC(2026, 10, 11, 12);
  env.add(10, 'Ana'); env.add(11, 'Bo'); env.add(12, 'Cy');
  assert.equal((await M.royaleWin(env, 10, now)).label, 'Week of 2026-11-09');
  assert.equal(await M.royaleWin(env, 10, now + DAY), null);                                         // same week
  assert.equal((await M.royaleWin(env, 10, now + 7 * DAY)).label, 'Week of 2026-11-16');
  const pts = env.sql.prepare('INSERT INTO team_war_pts (war, team, player, day, reported, credit, clash) VALUES (?, ?, ?, ?, ?, ?, ?)');
  pts.run(5, 1, 10, 1, 300, 0, 0); pts.run(5, 1, 11, 1, 0, 0, 0); pts.run(5, 2, 12, 1, 900, 0, 0);
  assert.deepEqual((await M.teamWar(env, 5, 1, 'Moon Diggers', now)).map(m => [m.kind, m.label]), [['teamwar', 'With Moon Diggers']]);   // Bo scored nothing
  const won = await M.raceWinners(env, 'r1', [{ id: 11, n: 7 }, { id: 12, n: 3 }], now);
  assert.deepEqual(won.map(m => [m.label, m.tier, m.value]), [['1st place · 7 friends', 'unique', 5000], ['2nd place · 3 friends', 'unique', 5000]]);
  assert.deepEqual(await M.raceWinners(env, 'r1', [{ id: 11, n: 7 }], now), []);
});

test('medals: /medal lets admins give a special medal, take one back, and see what was given', async () => {
  const env = makeEnv(); env.add(10, 'Ana <b>');
  assert.match(await M.command(env, 'give 10 epic For fun'), /^Use: \/medal give/);
  assert.match(await M.command(env, 'give 99 rare For fun'), /No player 99/);
  assert.match(await M.command(env, 'give #10 unique First to find the secret island', 1000), /Medal given to Ana &lt;b&gt; \(10\): First to find the secret island · unique, sells for 5,000 BP/);
  assert.deepEqual(medalsOf(env, 10).map(m => [m.kind, m.label, m.tier, m.value]), [['special', 'First to find the secret island', 'unique', 5000]]);
  const list = await M.command(env, '');
  assert.match(list, /1 given, 0 sold for 0 BP/); assert.match(list, /Pioneers: Laser Saber 0\/10 · Golazo 0\/10/); assert.match(list, /🎖️ #1 · Ana &lt;b&gt; \(10\) · Special honour · First to find the secret island · unique 5,000 BP/);
  assert.match(await M.command(env, 'take 1'), /Removed medal #1/);
  assert.deepEqual(medalsOf(env, 10), []);
  assert.match(await M.command(env, 'take 1'), /No unsold medal/);
});

test('medals: a Royale week starts on Monday, 00:00 UTC', async () => {
  assert.equal(new Date(M.weekOf(Date.UTC(2026, 10, 15, 23))).toISOString(), '2026-11-09T00:00:00.000Z');
  assert.equal(new Date(M.weekOf(Date.UTC(2026, 10, 16, 0))).toISOString(), '2026-11-16T00:00:00.000Z');
});
