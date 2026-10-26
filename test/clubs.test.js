import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const sent = [];
let grok = { real: true, name: 'Worm City FC', cc: 'UY', city: 'Salto', colors: ['#112233', '#ffffff'], same: null };   // what the Grok club check answers
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.x.ai/')) { sent.push(['xai', JSON.parse(init.body)]); return grok === 'down' ? new Response('no', { status: 500 }) : Response.json({ choices: [{ message: { content: JSON.stringify(grok) } }] }) }
  sent.push([String(url).split('/').pop(), JSON.parse(init.body)]); return Response.json({ ok: true, result: {} }) };
const { default: worker } = await import('../src/index.js');
const C = await import('../src/clubs.js');
const { weekly, weekStart } = await import('../src/growth.js');
const { webhook } = await import('../src/bot.js');

const PENAROL = 'uy-ca-penarol', NACIONAL = 'uy-nacional-de-montevideo', BOCA = 'ar-boca-juniors', RIVER = 'ar-river-plate', LIVERPOOL = 'eng-liverpool';
function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  return { DB, sql, SESSION_SECRET: 'test-secret', BOT_TOKEN: '123:BOT', SIGNIN_DOMAIN: 'example.test', XAI_API_KEY: 'k', ADMIN_PLAYERS: '1', TELEGRAM_WEBHOOK_SECRET: 'hook' };
}
const call = async (env, path, body, token) => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { status: r.status, ...(await r.json()) };
};
const guest = env => call(env, '/auth/guest', {});
const pts = (env, club) => env.sql.prepare('SELECT COALESCE(SUM(pts), 0) AS n FROM club_points WHERE club = ?').get(club).n;
const ago = (env, player, ms) => env.sql.prepare('UPDATE player_club SET at = ? WHERE player = ?').run(Date.now() - ms, player);

test('clubs: the list has the big clubs with their derbies, and search finds them by name', () => {
  assert.equal(C.lite(PENAROL).n, 'CA Peñarol'); assert.equal(C.lite(PENAROL).cc, 'UY'); assert.equal(C.lite('xx-nope'), null);
  assert.ok(C.derbyName(PENAROL, NACIONAL)); assert.equal(C.derbyName(PENAROL, NACIONAL), C.derbyName(NACIONAL, PENAROL));
  assert.ok(C.derbyName(BOCA, RIVER)); assert.equal(C.derbyName(PENAROL, LIVERPOOL), null); assert.equal(C.derbyName(PENAROL, PENAROL), null);
  assert.ok(C.rivalsOf(PENAROL).some(r => r.id === NACIONAL && r.d));
  assert.equal(C.search('penarol')[0].id, PENAROL); assert.equal(C.search('Boca Juniors')[0].id, BOCA);   // accents don't matter; the exact name first
  assert.deepEqual(C.search(''), []);
});

test('clubs: pick a club, it rides along in the session with its rivals, and it changes once a week (a wrong tap is free)', async () => {
  const env = makeEnv(), a = await guest(env);
  assert.equal(a.player.club, null);
  assert.equal((await call(env, '/me/club', { id: 'xx-not-a-club' }, a.token)).status, 400);
  const s = await call(env, '/me/club', { id: PENAROL }, a.token);
  assert.equal(s.status, 200); assert.equal(s.player.club.id, PENAROL); assert.equal(s.player.club.n, 'CA Peñarol'); assert.equal(s.player.club.c.length, 2);
  assert.ok(s.player.club.rivals.some(r => r.id === NACIONAL)); assert.equal(s.player.club.change, 0);
  assert.equal((await call(env, '/me/club', { id: NACIONAL }, a.token)).player.club.id, NACIONAL);         // right after picking: free to fix
  ago(env, a.player.id, C.UNDO_MS + 1000);
  const no = await call(env, '/me/club', { id: BOCA }, a.token); assert.equal(no.status, 429); assert.ok(no.wait > Date.now());
  assert.equal((await call(env, '/me/club', { id: NACIONAL }, a.token)).status, 200);                       // the same club again: nothing to change
  assert.ok((await call(env, '/me', undefined, a.token)).player.club.change > 0);
  ago(env, a.player.id, C.CHANGE_MS + 1000);
  assert.equal((await call(env, '/me/club', { id: BOCA }, a.token)).player.club.id, BOCA);
  assert.equal((await call(env, '/me/club', { id: null }, a.token)).player.club, null);                     // leave it
});

test('clubs: fans\' banked play money scores for the club, double on its derby day; load-test bots score a fifth', async () => {
  const env = makeEnv(), a = await guest(env), b = await guest(env), s = await guest(env), none = await guest(env);
  await call(env, '/me/club', { id: PENAROL }, a.token); await call(env, '/me/club', { id: NACIONAL }, b.token); await call(env, '/me/club', { id: PENAROL }, s.token);
  env.sql.prepare('INSERT INTO sim_players (player, created) VALUES (?, ?)').run(s.player.id, Date.now());
  await call(env, '/score', { amount: 100 }, a.token); await call(env, '/score', { amount: 100 }, s.token); await call(env, '/score', { amount: 100 }, none.token);
  assert.equal(pts(env, PENAROL), 120);
  const r = await C.derbyCommand(env, 'Nacional de Montevideo vs CA Peñarol', 1);
  assert.match(r.text, /Derby day today/); assert.ok(r.post); assert.match(r.post.text, /DERBY DAY/); assert.match(r.post.text, /Play money/);
  await call(env, '/score', { amount: 100 }, b.token);
  assert.equal(pts(env, NACIONAL), 200);
  const day = await call(env, '/clubs', undefined, a.token);
  assert.equal(day.day.a.id, NACIONAL); assert.equal(day.day.b.id, PENAROL); assert.ok(day.day.name);
  assert.deepEqual(day.top.map(t => [t.id, t.pts, t.fans]), [[NACIONAL, 200, 1], [PENAROL, 120, 2]]);
  assert.equal(day.mine.id, PENAROL); assert.equal(day.mine.rank, 2); assert.equal(day.mine.myPts, 100); assert.equal(day.mine.fans, 2);
  assert.equal((await C.derbyCommand(env, 'off', 1)).text.includes('off'), true);
  assert.equal((await call(env, '/clubs', undefined, a.token)).day, null);
});

test('clubs: an online win over another club\'s fan scores, more in a derby, with daily limits', async () => {
  const env = makeEnv(), [a, b, c, d] = [await guest(env), await guest(env), await guest(env), await guest(env)];
  await call(env, '/me/club', { id: PENAROL }, a.token); await call(env, '/me/club', { id: NACIONAL }, b.token); await call(env, '/me/club', { id: LIVERPOOL }, c.token);
  const [A, B, Cc, D] = [a, b, c, d].map(x => x.player.id);
  assert.deepEqual(await C.clubWin(env, A, D), { pts: 0 });                         // no club: nothing
  const derby = await C.clubWin(env, A, B); assert.equal(derby.pts, C.DERBY); assert.ok(derby.derby);
  assert.equal((await C.clubWin(env, A, B)).pts, 0);                                 // the same opponent again today
  assert.deepEqual(await C.clubWin(env, A, Cc), { pts: C.WIN, derby: null });
  assert.equal(pts(env, PENAROL), C.DERBY + C.WIN);
  for (let i = 0; i < 6; i++) { const g = await guest(env); await call(env, '/me/club', { id: BOCA }, g.token); await C.clubWin(env, A, g.player.id) }
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM club_wins WHERE winner = ?').get(A).n, C.WIN_DAY);   // 5 a day
  await call(env, '/me/club', { id: PENAROL }, d.token);
  assert.deepEqual(await C.clubWin(env, D, A), { pts: 0 });                         // same club: no club war
  await C.derbyCommand(env, `${NACIONAL} vs ${PENAROL}`, 1);
  assert.equal((await C.clubWin(env, B, A)).pts, 2 * C.DERBY);                       // derby day: double
});

test('clubs: a club not in the list is checked by Grok, added for everyone and picked; made-up names are turned down', async () => {
  const env = makeEnv(), a = await guest(env), b = await guest(env); sent.length = 0;
  env.sql.prepare('UPDATE players SET tg_id = 777 WHERE id = 1').run();                // player 1 is the admin
  const ok = await call(env, '/clubs/suggest', { name: 'worm city', country: 'Uruguay' }, a.token);
  assert.equal(ok.status, 200); assert.equal(ok.club.n, 'Worm City FC'); assert.equal(ok.club.cc, 'UY'); assert.deepEqual(ok.club.c, ['#112233', '#ffffff']);
  assert.equal((await call(env, '/me', undefined, a.token)).player.club.id, ok.club.id);
  assert.match(sent.find(s => s[0] === 'sendMessage' && /New club added/.test(s[1].text))[1].text, /\/clubs off x/);
  const list = await call(env, '/clubs', undefined, b.token);
  assert.ok(list.extra.some(e => e[0] === ok.club.id && e[1] === 'Worm City FC'));
  assert.equal((await call(env, '/me/club', { id: ok.club.id }, b.token)).player.club.id, ok.club.id);    // anyone can pick it now
  grok = { real: false }; assert.equal((await call(env, '/clubs/suggest', { name: 'Rug Pullers United' }, b.token)).status, 422);
  grok = { real: true, name: 'Peñarol', cc: 'UY', same: PENAROL };
  const same = await call(env, '/clubs/suggest', { name: 'penarol montevideo' }, b.token);
  assert.equal(same.found, true); assert.equal(same.club.id, PENAROL);
  assert.equal((await call(env, '/clubs/suggest', { name: 'one more' }, b.token)).status, 200);
  assert.equal((await call(env, '/clubs/suggest', { name: 'and another' }, b.token)).status, 429);       // 3 a day
  grok = 'down'; assert.equal((await call(env, '/clubs/suggest', { name: 'anything' }, a.token)).status, 502);
  // an admin takes the added club off: its fans are free to pick another
  assert.match(await C.adminClubs(env, 'off ' + ok.club.id), /Took Worm City FC off/);
  assert.equal((await call(env, '/me', undefined, a.token)).player.club, null);
  assert.equal((await call(env, '/me', undefined, b.token)).player.club.id, PENAROL);                       // b had moved on to Peñarol
  assert.equal((await call(env, '/me/club', { id: ok.club.id }, a.token)).status, 400);
  grok = { real: true, name: 'Worm City FC', cc: 'UY', city: 'Salto', colors: ['#112233', '#ffffff'], same: null };
});

test('clubs: the ranking shows each player\'s club, and merged accounts keep the target\'s club and the points', async () => {
  const env = makeEnv(), a = await guest(env), b = await guest(env);
  await call(env, '/me/club', { id: BOCA }, a.token); await call(env, '/score', { amount: 50 }, a.token); await call(env, '/score', { amount: 70 }, b.token);
  const r = await call(env, '/ranking?period=week', undefined, b.token);
  assert.deepEqual(r.top.find(x => x.id === a.player.id).club, { id: BOCA, n: 'Boca Juniors', c: C.lite(BOCA).c });
  assert.equal(r.top.find(x => x.id === b.player.id).club, undefined);
  await C.mergeClubs(env, a.player.id, b.player.id);
  assert.equal((await C.clubOf(env, b.player.id)).id, BOCA); assert.equal(await C.clubOf(env, a.player.id), null);
  assert.equal(env.sql.prepare('SELECT SUM(pts) AS n FROM club_points WHERE player = ?').get(b.player.id).n, 50);
});

test('clubs: /derby asks which club when a name fits several, takes ids, and the Monday post names the top 3 clubs', async () => {
  const env = makeEnv(), a = await guest(env);
  assert.match((await C.derbyCommand(env, 'Boca vs River Plate', 1)).text, /Which club is "Boca"\?[\s\S]*ar-boca-juniors/);
  assert.match((await C.derbyCommand(env, 'Zzzzqx vs River Plate', 1)).text, /No club found/);
  assert.match((await C.derbyCommand(env, 'just one club', 1)).text, /vs/);
  const t = await C.derbyCommand(env, `${BOCA} vs ${RIVER} tomorrow`, 1);
  assert.match(t.text, /tomorrow/); assert.equal(t.day, Math.floor(Date.now() / 864e5) + 1);
  assert.match((await C.derbyCommand(env, '', 1)).text, /Boca Juniors vs River Plate/);
  // last week's club war in the Monday group post
  const start = weekStart(), last = start - 7 * 864e5;
  env.sql.prepare("INSERT INTO bot_kv (k, v) VALUES ('group', '-100')").run();
  env.sql.prepare('INSERT INTO club_points (club, week_start, player, pts) VALUES (?, ?, ?, ?), (?, ?, ?, ?)').run(BOCA, last, a.player.id, 900, RIVER, last, 99, 300);
  env.sql.prepare('INSERT INTO week_scores (week_start, player, cworm) VALUES (?, ?, ?)').run(last, a.player.id, 900);
  sent.length = 0; await weekly(env, start + 10 * 60e3);
  const post = sent.find(s => s[0] === 'sendMessage')[1].text;
  assert.match(post, /Club war: top clubs of last week[\s\S]*🥇 <b>Boca Juniors<\/b>: 900 points[\s\S]*🥈 <b>River Plate<\/b>: 300/);
});

test('clubs: the bot shows the club war, and admins call a derby day that goes to the group', async () => {
  const env = makeEnv(), a = await guest(env);
  env.sql.prepare('UPDATE players SET tg_id = 777 WHERE id = ?').run(a.player.id);
  env.sql.prepare("INSERT INTO bot_kv (k, v) VALUES ('group', '-100')").run();
  const secret = createHash('sha256').update('webhook:' + env.SESSION_SECRET).digest('hex').slice(0, 48);
  const say = (text, from = 777) => webhook(new Request('https://x/telegram/webhook', { method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify({ message: { text, chat: { id: from, type: 'private' }, from: { id: from } } }) }), env);
  sent.length = 0; await say('/derby CA Peñarol vs Nacional de Montevideo');
  const msgs = sent.filter(s => s[0] === 'sendMessage').map(s => s[1]);
  assert.ok(msgs.some(m => m.chat_id === -100 && /DERBY DAY/.test(m.text)), 'posted to the group');
  assert.ok(msgs.some(m => m.chat_id === 777 && /Posted in the community group/.test(m.text)));
  sent.length = 0; await say('/derby Boca vs River', 555);                             // not an admin: nothing
  assert.equal(sent.filter(s => s[0] === 'sendMessage').length, 0);
  sent.length = 0; await say('/clubs', 555);
  assert.match(sent.find(s => s[0] === 'sendMessage')[1].text, /Club war this week/);
});
