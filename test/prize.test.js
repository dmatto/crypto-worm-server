import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Stand-ins: node:sqlite for D1, a clock the test moves, and Telegram's Bot API recorded in `calls` (group members in `members`).
const RealResponse = globalThis.Response, realNow = Date.now;
globalThis.Response = class extends RealResponse { constructor(b, i = {}) { super(b, i.status === 101 ? { status: 200 } : i); this.ws = i.webSocket } static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const calls = [], members = new Map(), bal = new Map(), ataOf = new Map(), TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const price = { dex: '0.000001', jup: null };                                       // $CWORM price answers: DexScreener (in SOL), Jupiter (USD)
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.dexscreener.com/')) { if (!price.dex) throw new Error('down'); const M = '65V31DT6xGVXY8axRu2QzNf1U7u6ZuQ77sRoBGYYpump';
    return Response.json({ pairs: [{ chainId: 'solana', baseToken: { address: M }, quoteToken: { symbol: 'USDC' }, priceNative: '0.0002' },
      { chainId: 'solana', baseToken: { address: M }, quoteToken: { symbol: 'SOL' }, priceNative: '0.000002', liquidity: { usd: 10 } },
      { chainId: 'solana', baseToken: { address: M }, quoteToken: { symbol: 'SOL' }, priceNative: price.dex, liquidity: { usd: 5000 } }] }) }
  if (String(url).startsWith('https://lite-api.jup.ag/')) { if (!price.jup) throw new Error('down'); return Response.json(price.jup) }
  if (String(url).startsWith('https://rpc.test')) {                                  // Solana: the $CWORM in each wallet (`bal`)
    const body = JSON.parse(init.body), one = r => r.method === 'getAccountInfo' ? { id: r.id, result: { value: { owner: TOKEN } } }
      : r.method === 'getMultipleAccounts' && r.params[1].encoding === 'jsonParsed' && r.params[0].every(a => ataOf.has(a)) ? { id: r.id, result: { value: r.params[0].map(a => { const n = bal.get(ataOf.get(a));
          return n == null ? null : { owner: TOKEN, data: { parsed: { info: { tokenAmount: { uiAmountString: String(n) } } } } } }) } } : { id: r.id, error: { message: 'no' } };
    return Response.json(Array.isArray(body) ? body.map(one) : one(body));
  }
  const method = String(url).split('/').pop();
  if (init.body instanceof FormData) { const doc = init.body.get('document'), bytes = Buffer.from(await doc.arrayBuffer()); calls.push([method, { chat_id: init.body.get('chat_id'), file: doc.name, bytes, csv: bytes.toString('utf8') }]); return Response.json({ ok: true, result: {} }) }
  const body = JSON.parse(init.body); calls.push([method, body]);
  if (method === 'getChatMember') { const st = members.get(body.user_id); return Response.json(st ? { ok: true, result: { status: st } } : { ok: false, error_code: 400, description: 'Bad Request: user not found' }) }
  return Response.json({ ok: true, result: {} });
};
const { default: worker } = await import('../src/index.js');
const { webhook, cron } = await import('../src/bot.js');
const P = await import('../src/prize.js');
const H = await import('../src/holders.js');

const DAY = 864e5, MON = P.FIRST_WEEK, at = (d, h = 10) => MON + d * DAY + h * 3600e3;   // d days after Monday 19 Oct, at h:00 UTC
let clock = realNow(); Date.now = () => clock;
test.after(() => { Date.now = realNow });

function makeEnv(extra = {}) {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const LOBBY = { idFromName: n => n, get: () => ({ fetch: async u => Response.json(String(u).endsWith('/ids') ? { ids: [] } : { online: [] }) }) };
  return { DB, sql, LOBBY, SESSION_SECRET: 'test-secret', BOT_TOKEN: '123:BOT', GAME_LINK: 'https://t.me/CryptoWormWarsBot/play', ADMIN_PLAYERS: '99', ...extra };
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
const secret = createHash('sha256').update('webhook:test-secret').digest('hex').slice(0, 48);
const hook = (env, update) => webhook(new Request('https://w/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update) }), env);
// A Telegram player made `age` days before Monday 19 Oct, with a wallet that holds `bal` since `since` (a UTC day number).
async function player(env, tgId, name, { age = 30, wallet, bal = 150000, since } = {}) {
  const s = await call(env, '/auth/telegram', { initData: tgInit(tgId, name) }), id = s.player.id;
  env.sql.prepare('UPDATE players SET created = ? WHERE id = ?').run(MON - age * DAY, id);
  if (wallet) {
    env.sql.prepare('UPDATE players SET wallet = ? WHERE id = ?').run(wallet, id);
    env.sql.prepare('INSERT INTO holders (player, wallet, balance, tier, tier_day, streak_day, checked) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, wallet, bal, bal >= 1e5 ? 1 : 0, since ?? Math.floor(MON / DAY) - 3, bal >= 1e5 ? since ?? Math.floor(MON / DAY) - 3 : null, MON);
  }
  return { id, token: s.token };
}
const score = async (env, p, amount, t) => { clock = t; return call(env, '/score', { amount }, p.token) };
// A match the server sees start `secs` seconds before `t` and finish at `t` (the prize's match check)
const play = async (env, p, t, secs = 300, mode = 'cpu') => { clock = t - secs * 1e3; await call(env, '/started', { mode }, p.token); clock = t; return call(env, '/played', { mode: 'cpu' }, p.token) };

test('prize: hidden before Sunday 18 Oct except for admins and the preview switch', async () => {
  clock = Date.UTC(2026, 9, 15, 12);
  const env = makeEnv(), a = await player(env, 42, 'Dami');
  assert.deepEqual(await call(env, '/prize', undefined, a.token), { status: 200, on: false });
  env.ADMIN_PLAYERS = String(a.id);
  const c = await call(env, '/prize', undefined, a.token);
  assert.equal(c.on, true); assert.equal(c.week, MON); assert.equal(c.started, false); assert.equal(c.points, 0);
  assert.deepEqual(c.prizes, [0.25, 0.17, 0.12, 0.07, 0.065, 0.065, 0.065, 0.065, 0.065, 0.065]); assert.equal(c.prizeUnit, 'SOL');
  assert.ok(Math.abs(P.PRIZES.reduce((s, n) => s + n, 0) - 1) < 1e-9);   // 1 SOL a week
  env.ADMIN_PLAYERS = '99'; env.PRIZE_PREVIEW = '1';
  assert.equal((await call(env, '/prize', undefined, a.token)).on, true);
  clock = Date.UTC(2026, 9, 18, 0); delete env.PRIZE_PREVIEW;
  assert.equal((await call(env, '/prize', undefined, a.token)).on, true);                 // Sunday: shown to everyone, for next week
});

test('prize: five steps, prize points capped at 1,500 a day, a ticket in the ranking, and a dip below 100K loses the week', async () => {
  clock = at(0, 9); calls.length = 0;
  const env = makeEnv(), a = await player(env, 42, 'Dami', { wallet: 'WaLLetA111111111111111111111111111' });
  let c = await call(env, '/prize', undefined, a.token);
  assert.equal(c.on, true); assert.equal(c.started, true); assert.equal(c.done, false);
  assert.deepEqual(Object.fromEntries(Object.entries(c.steps).map(([k, v]) => [k, v.done ?? v.ok])), { group: false, x: false, wallet: true, hold: true, days: false, age: true });
  assert.equal(c.steps.group.tg, true);
  // 1. the group: Telegram is asked; at most every 30 s when the player taps Check
  members.set(42, 'member'); clock += 5e3;
  assert.equal((await call(env, '/prize/check', {}, a.token)).steps.group.done, false);     // the first look said "not a member" a moment ago
  clock += 31e3;
  assert.equal((await call(env, '/prize/check', {}, a.token)).steps.group.done, true);
  assert.equal(calls.filter(([m]) => m === 'getChatMember').length, 2);
  // 2. the X username: checked and kept without the @ or the link
  assert.equal((await call(env, '/prize/x', { handle: 'not a name!' }, a.token)).status, 400);
  c = await call(env, '/prize/x', { handle: 'https://x.com/Dami_W?s=20' }, a.token);
  assert.equal(c.steps.x.done, true); assert.equal(c.steps.x.handle, '@Dami_W');
  assert.equal(P.cleanX('@CryptoWorm72'), 'CryptoWorm72'); assert.equal(P.cleanX('this_name_is_too_long'), null);
  // 5. three play days, and prize points: Monday 3 x 600 counts 1,500, Tuesday 500, once the server saw the matches
  for (const t of [at(0, 10), at(0, 10) + 9e3, at(0, 10) + 18e3]) assert.equal((await score(env, a, 600, t)).added, 600);
  await score(env, a, 500, at(1));
  clock = at(1, 12); assert.equal((await call(env, '/prize', undefined, a.token)).points, 300);   // no checked match yet: 150 a day
  await play(env, a, at(0, 8));                                                     // a 5-minute match carries 400
  clock = at(1, 12); assert.equal((await call(env, '/prize', undefined, a.token)).points, 700);
  for (const h of [9, 11, 12]) await play(env, a, at(0, h)); await play(env, a, at(1));
  clock = at(1, 12); c = await call(env, '/prize', undefined, a.token);
  assert.equal(c.points, 2000); assert.equal(c.steps.days.n, 2); assert.equal(c.done, false); assert.equal(c.rank, null);
  await play(env, a, at(2)); await play(env, a, at(2) + 25e3);
  clock = at(2, 12); c = await call(env, '/prize', undefined, a.token);
  assert.equal(c.steps.days.n, 3); assert.equal(c.steps.hold.days, 3);
  assert.equal(c.done, true); assert.equal(c.ticket, true); assert.equal(c.rank, 1); assert.equal(c.entrants, 1);
  const rk = await call(env, '/ranking?period=week', undefined, a.token);
  assert.equal(rk.me.ticket, true); assert.equal(rk.top[0].ticket, true);
  // a reading under 100K this week loses the week, even while the holder tier is kept for 3 days
  env.sql.prepare('INSERT INTO hold_dips (player, day) VALUES (?, ?)').run(a.id, Math.floor(at(3) / DAY));
  clock = at(3, 12); c = await call(env, '/prize', undefined, a.token);
  assert.equal(c.steps.wallet.done, true); assert.equal(c.steps.hold.done, false); assert.equal(c.steps.hold.nextWeek, true); assert.equal(c.ticket, false);
  assert.equal((await call(env, '/ranking?period=week', undefined, a.token)).me.ticket, undefined);
  // the next week starts clean: the dip was last week, the streak goes on
  clock = at(7, 12); c = await call(env, '/prize', undefined, a.token);
  assert.equal(c.week, MON + 7 * DAY); assert.equal(c.steps.hold.done, true); assert.equal(c.steps.hold.days, 1); assert.equal(c.steps.days.n, 0); assert.equal(c.points, 0);
});

test('prize: who can\'t win yet: no wallet, a wallet under 100K, a holder from mid-week, a new account, someone who left the group', async () => {
  clock = at(0, 8);
  const env = makeEnv({ SOLANA_RPC: 'https://rpc.test/' });
  const none = await player(env, 50, 'NoWallet'), low = await player(env, 51, 'Low', { wallet: 'LowWa11et1111111111111111111111111', bal: 5000 });
  const late = await player(env, 52, 'Late', { wallet: 'LateWa11et111111111111111111111111', since: Math.floor(at(2) / DAY) });
  const young = await player(env, 53, 'Young', { age: 3, wallet: 'YoungWa11et11111111111111111111111' });
  clock = at(2, 12);
  let s = (await call(env, '/prize', undefined, none.token)).steps; assert.equal(s.wallet.done, false); assert.equal(s.wallet.linked, false);
  s = (await call(env, '/prize', undefined, low.token)).steps; assert.equal(s.wallet.done, false); assert.equal(s.wallet.low, true);
  s = (await call(env, '/prize', undefined, late.token)).steps; assert.equal(s.wallet.done, true); assert.equal(s.hold.done, false); assert.equal(s.hold.nextWeek, true);
  s = (await call(env, '/prize', undefined, young.token)).steps; assert.equal(s.age.ok, false); assert.equal(s.age.days, 5); assert.equal(s.age.from, MON + 7 * DAY);
  // without SOLANA_RPC the free hosts rarely answer: a linked wallet never read counts until Monday's live check, a holder
  // from mid-week counts too, and a wallet read under 100K still doesn't
  delete env.SOLANA_RPC;
  const unread = await player(env, 54, 'Unread'); env.sql.prepare('UPDATE players SET wallet = ? WHERE id = ?').run('UnreadWa11et111111111111111111111', unread.id);
  s = (await call(env, '/prize', undefined, unread.token)).steps; assert.equal(s.wallet.done, true); assert.equal(s.wallet.pending, true); assert.equal(s.hold.done, true); assert.equal(s.hold.days, 3);
  assert.equal((await call(env, '/prize', undefined, late.token)).steps.hold.done, true);
  assert.equal((await call(env, '/prize', undefined, low.token)).steps.wallet.done, false);
  // an account made Friday 16 Oct is 10 days old at the first payout (too young) and 17 at the next one
  assert.equal(P.steps({ created: MON - 3 * DAY }, MON, MON).age.ok, false);
  assert.equal(P.steps({ created: MON - 3 * DAY }, MON + 7 * DAY, MON + 7 * DAY).age.ok, true);
  // Telegram's answers: member, admin, restricted but in the group count; left, kicked and "user not found" don't
  for (const [st, ok] of [['member', true], ['administrator', true], ['creator', true], ['left', false], ['kicked', false], [null, false]]) {
    if (st) members.set(77, st); else members.delete(77);
    assert.equal(await P.inGroup(env, 77), ok, String(st));
  }
});

test('prize: /prize gives admins the eligible top 10 with the group asked again, the CSVs and the payout lines; logs are kept 5 weeks', async () => {
  clock = at(0, 8); calls.length = 0;
  const env = makeEnv({ PRIZE_GROUP: '-1002191131055', SOLANA_RPC: 'https://rpc.test/' }), ps = [], wal = [];
  for (let i = 0; i < 12; i++) {
    const w = H.b58(randomBytes(32)); wal.push(w); ataOf.set(await H.ata(w, TOKEN), w); bal.set(w, i === 9 ? 50000 : 150000);   // Worm9 sold
    const p = await player(env, 100 + i, 'Worm' + i, { wallet: w });
    members.set(100 + i, 'member'); env.sql.prepare('INSERT INTO prize_entry (player, x, group_ok, group_at) VALUES (?, ?, 1, ?)').run(p.id, 'worm' + i, clock);
    for (const d of [0, 1, 2]) { await play(env, p, at(d, 10) + i * 1e3); await score(env, p, 100 + i * 10, at(d, 11) + i * 1e3) }
    ps.push(p);
  }
  await score(env, ps[3], 50, at(4, 2));                                              // a night report
  const admin = await player(env, 7, 'Damian'); env.ADMIN_PLAYERS = String(admin.id);
  members.set(111, 'left');                                                         // the top player left the group: skipped
  clock = at(8, 9); calls.length = 0;
  await hook(env, { message: { chat: { id: 7, type: 'private' }, from: { id: 7, first_name: 'Damian' }, text: '/prize last' } });
  const text = calls.find(([m]) => m === 'sendMessage')[1].text;
  assert.match(text, /Weekly prize 2026-10-19 to 2026-10-25/); assert.match(text, /12 players did all 5 steps/);
  assert.match(text, /Price now: 1 SOL ≈ 1,000,000 \$CWORM \(DexScreener\)/); assert.match(text, /1\. Worm10 \(id \d+\) · 600 pts · 0\.25 SOL ≈ 250,000 \$CWORM/); assert.match(text, /holds 150,000/); assert.doesNotMatch(text, /Next in line/);
  assert.match(text, /Dropped just now: Worm11 \(left the group\), Worm9 \(holds 50,000\)/);
  assert.match(text, /X @worm3 · 4 reports, max 130\/hour, 1 at night/);
  const docs = calls.filter(([m]) => m === 'sendDocument').map(([, b]) => b);
  assert.deepEqual(docs.map(d => d.file), ['weekly-prize-2026-10-19.csv', 'weekly-prize-2026-10-19-score-log.csv']);
  for (const d of docs) { assert.equal(d.bytes.subarray(0, 3).toString('hex'), 'efbbbf'); assert.notEqual(d.bytes.subarray(3, 6).toString('hex'), 'efbbbf') }   // one BOM, so Excel reads the names
  const rows = docs[0].csv.slice(1).trim().split('\r\n');
  assert.equal(rows.length, 11); assert.match(rows[1], /^1,0\.25,250000,Worm10,/); assert.match(rows[2], /^2,0\.17,170000,Worm8,/); assert.match(rows[10], /^10,0\.065,65000,Worm0,/);
  assert.ok(rows[1].includes(',150000,150000,'));                                   // the balance now and the last daily reading
  const pay = calls.filter(([m]) => m === 'sendMessage').pop()[1].text;
  assert.ok(pay.includes(wal[10] + ',250000\n' + wal[8] + ',170000')); assert.equal((pay.match(/,65000/g) || []).length, 6); assert.equal((pay.match(/,70000/g) || []).length, 1);
  // everyone else gets nothing from /prize
  calls.length = 0;
  await hook(env, { message: { chat: { id: 100, type: 'private' }, from: { id: 100, first_name: 'Worm0' }, text: '/prize' } });
  assert.ok(!calls.some(([m]) => m === 'sendDocument'));
  const tip = calls.find(([m]) => m === 'sendMessage')[1].text;                      // a pointer to the game, with no token name or amounts
  assert.match(tip, /Weekly prizes/); assert.match(tip, /prize\.html/); assert.doesNotMatch(tip, /CWORM|000/);
  // this week has nothing yet; before the first week, /prize last says so
  clock = at(-3); calls.length = 0;
  await hook(env, { message: { chat: { id: 7, type: 'private' }, from: { id: 7, first_name: 'Damian' }, text: '/prize last' } });
  assert.match(calls.find(([m]) => m === 'sendMessage')[1].text, /No prize week has ended yet/);
  // once a day the cron asks Telegram about the first admin, so a bot that can't see members shows up in bot_kv
  members.set(7, 'administrator'); env.LOBBY = { idFromName: n => n, get: () => ({ fetch: async () => Response.json({}) }) };
  const q = Math.floor(at(9) / 9e5) * 9e5; calls.length = 0; await cron(env, q); await cron(env, q + 9e5);
  assert.equal(calls.filter(([m, b]) => m === 'getChatMember' && b.chat_id === -1002191131055 && b.user_id === 7).length, 1);
  assert.deepEqual(JSON.parse(env.sql.prepare("SELECT v FROM bot_kv WHERE k = 'prize_probe'").get().v), { day: Math.floor(q / DAY), at: q, ok: true, status: 'administrator', error: null });
  // cleanup keeps 35 days
  env.sql.prepare('INSERT INTO score_log (player, at, amount) VALUES (?, ?, ?)').run(ps[0].id, at(39), 10);
  await P.cleanup(env, at(40));
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM score_log').get().n, 1);
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM play_days').get().n, 0);
});

test('weekly prize: the SOL prizes turn into $CWORM at the price now, from DexScreener or else Jupiter', async () => {
  assert.equal(Math.round((await P.cwormPerSol()).perSol), 1e6);                     // the SOL pair with the most liquidity
  price.dex = null; price.jup = { '65V31DT6xGVXY8axRu2QzNf1U7u6ZuQ77sRoBGYYpump': { usdPrice: 0.0002 }, So11111111111111111111111111111111111111112: { usdPrice: 200 } };
  assert.deepEqual(await P.cwormPerSol(), { perSol: 1e6, from: 'Jupiter' });
  price.jup = null; assert.equal(await P.cwormPerSol(), null);                       // nothing answers: the admin works it out by hand
  price.dex = '0.000001';
});

test('prize vs scripts: points need matches the server saw, ties go to online wins against real players, one X username each, and /prize skip', async () => {
  clock = at(0, 8); calls.length = 0;
  const env = makeEnv({ SOLANA_RPC: 'https://rpc.test/' }), [a, b, c, d] = [];
  const mk = async (tgId, name) => { const w = H.b58(randomBytes(32)); ataOf.set(await H.ata(w, TOKEN), w); bal.set(w, 150000); members.set(tgId, 'member');
    const p = await player(env, tgId, name, { wallet: w }); env.sql.prepare('INSERT INTO prize_entry (player, x, group_ok, group_at) VALUES (?, ?, 1, ?)').run(p.id, name.toLowerCase(), clock); return p };
  const ann = await mk(300, 'Ann'), bob = await mk(301, 'Bob'), cat = await mk(302, 'Cat');
  const pts = async p => { const r = (await P.points(env, MON)).find(x => x.player === p.id); return r ? r.pts : 0 };
  // the match check: what each finished match carries, and what carries nothing
  clock = at(0, 9); assert.equal(await P.runEnd(env, ann.id), 0);                  // /played with no /started
  await P.runStart(env, ann.id, 'cpu', at(0, 9)); assert.equal(await P.runEnd(env, ann.id, at(0, 9) + 15e3), 0);     // under 20 s
  await P.runStart(env, ann.id, 'tutorial', at(0, 9)); assert.equal(await P.runEnd(env, ann.id, at(0, 9) + 300e3), 0);
  await P.runStart(env, ann.id, 'mini', at(0, 9)); assert.equal(await P.runEnd(env, ann.id, at(0, 9) + 300e3), 0);
  await P.runStart(env, ann.id, 'online', at(0, 9)); assert.equal(await P.runEnd(env, ann.id, at(0, 9) + 100e3), 150);   // 1.5 a second
  assert.equal(await P.runEnd(env, ann.id, at(0, 9) + 200e3), 0);                    // closed already
  await P.runStart(env, ann.id, 'cpu', at(0, 9)); assert.equal(await P.runEnd(env, ann.id, at(0, 12)), 400);           // at most 400
  // a script that only sends scores: 150 a day for mini games, the rest stays in the ranking but not in the prize
  for (let i = 0; i < 3; i++) await score(env, bob, 600, at(1, 10) + i * 9e3);
  assert.equal(await pts(bob), 150); assert.equal((await call(env, '/ranking?period=week', undefined, bob.token)).me.cworm, 1800);
  // load-test bots don't open matches
  const sim = await call(env, '/auth/guest', {}); clock = at(1, 11);
  await worker.fetch(new Request('https://api.test/started', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sim.token, 'x-sim-key': 'x' }, body: '{"mode":"cpu"}' }), env);
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM prize_run WHERE player = ?').get(sim.player.id).n, 0);
  // Ann and Cat both reach 1,500 on three days; Cat beat two real players online, Ann beat a bot, a guest and herself
  for (const p of [ann, cat]) for (const dd of [0, 1, 2]) { for (const h of [13, 14, 15, 16]) await play(env, p, at(dd, h) + p.id * 1e3); for (let i = 0; i < 3; i++) await score(env, p, 600, at(dd, 17) + p.id * 1e3 + i * 9e3) }
  const guest = await call(env, '/auth/guest', {}), sp = env.sql.prepare("INSERT INTO players (name, created) VALUES ('SimBot', 0) RETURNING id").get().id;
  env.sql.prepare('INSERT INTO sim_players (player, created) VALUES (?, 0)').run(sp);
  const m = (w, l, t) => env.sql.prepare("INSERT INTO matches (p0, p1, winner, reason, ended) VALUES (?, ?, ?, 'played', ?)").run(l, w, w, t);
  m(cat.id, bob.id, at(1, 18)); m(cat.id, bob.id, at(1, 19)); m(cat.id, ann.id, at(2, 18));       // Bob counts once that day
  for (const l of [sp, guest.player.id, ann.id]) m(ann.id, l, at(1, 18) + l);   // a bot and a guest don't count, Cat's win over Ann does
  m(ann.id, ann.id, at(1, 20));
  assert.equal(await pts(ann), 4500); assert.equal(await pts(cat), 4500);
  clock = at(3, 12); let ch = await P.chart(env, MON, clock);
  assert.deepEqual(ch.map(r => [r.name, r.wins, r.opps]), [['Cat', 2, 2], ['Ann', 0, 0]]);
  assert.equal((await call(env, '/prize', undefined, cat.token)).rank, 1);
  // one X username per player, whatever the case
  assert.equal((await call(env, '/prize/x', { handle: '@CAT' }, ann.token)).status, 409);
  assert.equal((await call(env, '/prize/x', { handle: '@cat' }, cat.token)).steps.x.handle, '@cat');
  // /prize skip takes Cat out; she still plays and ranks, her card says so; /prize unskip lets her back
  const admin = await player(env, 7, 'Damian'); env.ADMIN_PLAYERS = String(admin.id);
  const say = async text => { calls.length = 0; await hook(env, { message: { chat: { id: 7, type: 'private' }, from: { id: 7, first_name: 'Damian' }, text } }); return calls.filter(([x]) => x === 'sendMessage').map(([, y]) => y.text) };
  assert.match((await say('/prize skip ' + cat.id))[0], /Cat \(id \d+\) is out of the weekly prize/);
  assert.match((await say('/prize skip 99999'))[0], /No player with id 99999/);
  const card = await call(env, '/prize', undefined, cat.token); assert.equal(card.skipped, true); assert.equal(card.ticket, false); assert.equal(card.rank, null);
  assert.deepEqual((await P.chart(env, MON, clock)).map(r => r.name), ['Ann']);
  assert.equal((await call(env, '/ranking?period=week', undefined, cat.token)).me.ticket, undefined);
  let text = (await say('/prize'))[0];
  assert.match(text, /1\. Ann \(id \d+\) · 4,500 pts/); assert.match(text, /14 checked matches · 0 online wins vs 0 players · ⚠️ 100 pts without a checked match/); assert.match(text, /Taken out by an admin: Cat/);
  assert.match((await say('/prize unskip ' + cat.id))[0], /Cat \(id \d+\) can win the weekly prize again/);
  text = (await say('/prize'))[0]; assert.match(text, /1\. Cat/); assert.match(text, /2 online wins vs 2 players/);
  // the red flags: points the checks didn't let through, and a script's even gaps and same amounts
  for (let i = 0; i < 25; i++) await score(env, ann, 40, at(4, 1) + i * 9e3);
  text = (await say('/prize'))[0];
  assert.match(text, /Ann[^]*⚠️ 950 pts without a checked match \(not counted\) · ⚠️ reports at even gaps · ⚠️ same amount again and again/);
  const csv = calls.find(([x]) => x === 'sendDocument')[1].csv;
  assert.match(csv, /checked_matches,points_without_checked_match,online_wins,win_opponents,even_timing,same_amounts/);
});
