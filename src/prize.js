// Weekly prize (Damian 2026-10-15, monetization/weekly-prize-analysis.md): 1 SOL worth of real $CWORM a week for the top 10
// of a prize chart (Damian 2026-10-15: a SOL value is steadier than a fixed token amount; it was 1,000,000 $CWORM). Players qualify with five steps: they are in the Telegram group (the bot asks Telegram), gave their X username
// (Damian checks the top 10's follows by hand), linked a wallet with the Holder tier (100K, read by holders.js), held it all
// week (streak from Monday or earlier, no reading under 100K since), and finished matches on 3 different UTC days this week.
// Prize points are the week's play-money $CWORM gained, at most 1,500 a UTC day, from a log of every score report that also
// serves Monday's fair-play review. Accounts must be 14 days old by the Monday payout. The server pays nothing: /prize in
// the bot gives the admins the list, the payout lines and the logs, and Damian sends the tokens from the treasury.
// Against scripts (Damian 2026-10-16): the phone reports the score, so a day's prize points also can't pass what the matches
// the server saw start and finish that day can carry (see runEnd), ties go to online wins against real players (the server
// sees those matches), an X username belongs to one player, and an admin can take a player out (/prize skip).
//
//   GET  /prize                -> {on, start, week, steps, done, ticket, points, rank, entrants, ...}   the player's card
//   POST /prize/check          -> same, after asking Telegram whether the player is in the group (at most every 30 s)
//   POST /prize/x {handle}     -> same, with the X username saved ('' clears it)

import { tg } from './bot.js';
import { balances, MINT } from './holders.js';

// Each place's share of the pool in SOL (25%, 17%, 12%, 7%, then 6.5% each), paid as $CWORM at the price on payout Monday
export const PRIZES = [0.25, 0.17, 0.12, 0.07, 0.065, 0.065, 0.065, 0.065, 0.065, 0.065];   // 1 SOL
export const DAY_CAP = 1500, PLAY_DAYS = 3, HOLD_MIN = 100000, MIN_AGE_DAYS = 14;
export const FIRST_WEEK = Date.UTC(2026, 9, 19), SHOW_FROM = Date.UTC(2026, 9, 18);   // first prize week Mon 19 Oct; the card shows from Sun 18 Oct
export const GROUP_LINK = 'https://t.me/CryptoWorm_Group', X_LINK = 'https://x.com/CryptoWorm72';
const DAY = 864e5, WEEK = 7 * DAY, CHECK_MS = 30e3, RECHECK_MS = 10 * 60e3, LOG_KEEP = 35 * DAY;
const day = t => Math.floor(t / DAY);
// The match check: the game tells the server when a match starts (/started) and ends (/played). A finished match of at least
// RUN_MIN_S seconds lets RUN_RATE prize points a second count (at most RUN_MAX a match), and each UTC day has FREE_PTS more
// for mini games. Real players stay far under this (about 0.3 points a second); a script has to take match time like them.
export const RUN_MIN_S = 20, RUN_RATE = 1.5, RUN_MAX = 400, FREE_PTS = 150;
const NO_RUN = new Set(['tutorial', 'mini']);
export const runStart = (env, player, mode, now = Date.now()) => env.DB.prepare('INSERT INTO prize_run (player, mode, at) VALUES (?, ?, ?) ON CONFLICT(player) DO UPDATE SET mode = excluded.mode, at = excluded.at')
  .bind(player, String(mode || '').slice(0, 12), now).run().catch(() => { });
export async function runEnd(env, player, now = Date.now()) {
  const r = await env.DB.prepare('DELETE FROM prize_run WHERE player = ? RETURNING mode, at').bind(player).first().catch(() => null);
  const secs = r ? Math.floor((now - r.at) / 1000) : 0;
  if (!r || NO_RUN.has(r.mode) || secs < RUN_MIN_S) return 0;
  const credit = Math.min(RUN_MAX, Math.round(secs * RUN_RATE));
  await env.DB.prepare('INSERT INTO run_log (player, at, secs, credit) VALUES (?, ?, ?, ?)').bind(player, now, secs, credit).run().catch(() => { });
  return credit;
}
export function weekOf(now = Date.now()) { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.getTime() }
// The prize week the card is about: this week once prizes have started, the first week before that.
export const prizeWeek = (now = Date.now()) => Math.max(FIRST_WEEK, weekOf(now));
const isAdmin = (env, id) => String(env.ADMIN_PLAYERS || '').split(',').map(Number).includes(id);
export const prizeOn = (env, me, now = Date.now()) => now >= SHOW_FROM || env.PRIZE_PREVIEW === '1' || (!!me && isAdmin(env, me.id));
export const cleanX = s => { s = String(s || '').trim().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, ''); return /^[A-Za-z0-9_]{1,15}$/.test(s) ? s : null };

// Every score report, for the prize chart and the fair-play review (kept 5 weeks).
export const logScore = (env, player, amount, now = Date.now()) =>
  amount > 0 ? env.DB.prepare('INSERT INTO score_log (player, at, amount) VALUES (?, ?, ?)').bind(player, now, amount).run().catch(() => { }) : null;
export const logPlayDay = (env, player, now = Date.now()) => env.DB.prepare('INSERT OR IGNORE INTO play_days (player, day) VALUES (?, ?)').bind(player, day(now)).run().catch(() => { });
export const cleanup = (env, now = Date.now()) => env.DB.batch([env.DB.prepare('DELETE FROM score_log WHERE at < ?').bind(now - LOG_KEEP),
  env.DB.prepare('DELETE FROM play_days WHERE day < ?').bind(day(now - LOG_KEEP)), env.DB.prepare('DELETE FROM hold_dips WHERE day < ?').bind(day(now - LOG_KEEP)),
  env.DB.prepare('DELETE FROM run_log WHERE at < ?').bind(now - LOG_KEEP), env.DB.prepare('DELETE FROM prize_run WHERE at < ?').bind(now - DAY)]);

// Prize points of week `w` for every player who scored, highest first: each UTC day counts at most DAY_CAP, and no more than
// that day's checked matches carry plus FREE_PTS. `ok` is what the checks let through before the cap; `raw` everything reported.
export async function points(env, w) {
  const { results } = await env.DB.prepare(`SELECT player, SUM(MIN(?, d, ? + COALESCE(c, 0))) AS pts, SUM(d) AS raw, SUM(MIN(d, ? + COALESCE(c, 0))) AS ok, MAX(last) AS last FROM
      (SELECT player, at / ${DAY} AS dd, SUM(amount) AS d, MAX(at) AS last FROM score_log WHERE at >= ? AND at < ? AND player NOT IN (SELECT player FROM sim_players)
      GROUP BY player, dd) s
      LEFT JOIN (SELECT player AS rp, at / ${DAY} AS rd, SUM(credit) AS c FROM run_log WHERE at >= ? AND at < ? GROUP BY rp, rd) r ON r.rp = s.player AND r.rd = s.dd
      GROUP BY player ORDER BY pts DESC, last ASC`)
    .bind(DAY_CAP, FREE_PTS, FREE_PTS, w, w + WEEK, w, w + WEEK).all();
  return results;
}

// What a player has done for week `w`, from what the server knows (the group answer is the last one Telegram gave).
// D1 takes at most 100 bound values a query, so long lists go in parts.
const PART = 90;
const parts = fn => async function go(env, ids, w) {
  if (ids.length > PART) { const out = new Map(); for (let i = 0; i < ids.length; i += PART) for (const [k, v] of await go(env, ids.slice(i, i + PART), w)) out.set(k, v); return out }
  return ids.length ? fn(env, ids, w) : new Map();
};
const rows = parts(async (env, ids, w) => {
  const q = ids.map(() => '?').join(','), W = day(w);
  const [p, d, dips] = await Promise.all([
    env.DB.prepare(`SELECT p.id, p.name, p.tg_id, p.wallet, p.created, e.x, e.group_ok, e.group_at, h.wallet AS hw, h.tier, h.streak_day, h.balance, h.checked,
        (SELECT 1 FROM prize_skip k WHERE k.player = p.id) AS skipped
        FROM players p LEFT JOIN prize_entry e ON e.player = p.id LEFT JOIN holders h ON h.player = p.id
        WHERE p.id IN (${q}) AND p.id NOT IN (SELECT player FROM sim_players)`).bind(...ids).all(),   // simulated players from load tests never take part
    env.DB.prepare(`SELECT player, COUNT(*) AS n FROM play_days WHERE player IN (${q}) AND day >= ? AND day < ? GROUP BY player`).bind(...ids, W, W + 7).all(),
    env.DB.prepare(`SELECT DISTINCT player FROM hold_dips WHERE player IN (${q}) AND day >= ? AND day < ?`).bind(...ids, W, W + 7).all()]);
  const days = new Map(d.results.map(r => [r.player, r.n])), dipped = new Set(dips.results.map(r => r.player));
  return new Map(p.results.map(r => [r.id, { ...r, days: days.get(r.id) || 0, dipped: dipped.has(r.id) }]));
});
// Online wins in week `w` against real players (Telegram accounts, not load-test bots), each opponent once a UTC day, and
// how many different players those were: the prize chart's tie-break, since the server sees these matches itself.
export const wins = parts(async (env, ids, w) => {
  const { results } = await env.DB.prepare(`SELECT winner AS player, COUNT(DISTINCT opp || ':' || (ended / ${DAY})) AS n, COUNT(DISTINCT opp) AS opps FROM
      (SELECT winner, ended, CASE WHEN winner = p0 THEN p1 ELSE p0 END AS opp FROM matches WHERE ended >= ? AND ended < ? AND winner IN (${ids.map(() => '?').join(',')}))
      WHERE opp != winner AND opp IN (SELECT id FROM players WHERE tg_id IS NOT NULL) AND opp NOT IN (SELECT player FROM sim_players) GROUP BY winner`).bind(w, w + WEEK, ...ids).all();
  return new Map(results.map(r => [r.player, { n: r.n, opps: r.opps }]));
});
// Without SOLANA_RPC the daily wallet reading mostly fails on the free public hosts. Then (loose) a linked wallet that was
// never read counts for now, holding is "no reading under 100K this week", and /prize reads the top wallets live on Monday.
export const loose = env => !env.SOLANA_RPC;
// The five steps (and the account age) for one player row; `now` decides how far into the week the hold counter is.
export function steps(r, w, now = Date.now(), lax = false) {
  const W = day(w), wallet = !!(r.wallet && r.hw === r.wallet), read = wallet && r.checked > 0, holder = wallet && r.tier >= 1, started = now >= w;
  const pending = lax && !!r.wallet && !holder && !read;
  const onTrack = (holder || pending) && !r.dipped && (lax || r.streak_day != null && r.streak_day <= W);
  const held = onTrack ? Math.max(0, Math.min(7, day(now) - W + 1)) : 0;
  return {
    group: { done: !!r.group_ok, tg: r.tg_id != null },
    x: { done: !!r.x, handle: r.x ? '@' + r.x : null },
    wallet: { done: holder || pending, linked: !!r.wallet, checking: !!r.wallet && !holder && !read && !pending, low: read && !holder, pending },
    hold: { done: onTrack, days: started ? held : 0, nextWeek: (holder || pending) && !onTrack },
    days: { done: (r.days || 0) >= PLAY_DAYS, n: Math.min(PLAY_DAYS, r.days || 0) },
    age: { ok: r.created <= w + WEEK - MIN_AGE_DAYS * DAY, days: Math.floor((now - r.created) / DAY), from: firstWeek(r.created) },
  };
}
// The first prize week an account is old enough for: 14 days old by that week's Monday payout.
const firstWeek = created => { const t = created + MIN_AGE_DAYS * DAY - WEEK, m = weekOf(t); return Math.max(FIRST_WEEK, m < t ? m + WEEK : m) };
const doneOf = s => s.group.done && s.x.done && s.wallet.done && s.hold.done && s.days.done;

// The prize chart of week `w`: players who did all five steps (and are old enough, and weren't taken out), by prize points,
// then online wins against real players, then who got there first.
// Only players who joined the group and gave their X username can have done all five, so only they are looked up.
export async function chart(env, w, now = Date.now()) {
  const ready = new Set((await env.DB.prepare('SELECT player FROM prize_entry WHERE group_ok = 1 AND x IS NOT NULL AND player NOT IN (SELECT player FROM prize_skip)').all()).results.map(r => r.player));
  const pts = (await points(env, w)).filter(p => ready.has(p.player)), info = await rows(env, pts.map(p => p.player), w), out = [];
  for (const p of pts) { const r = info.get(p.player); if (!r) continue; const s = steps(r, w, now, loose(env)); if (doneOf(s) && s.age.ok) out.push({ ...r, steps: s, pts: p.pts, raw: p.raw, ok: p.ok, last: p.last }) }
  const won = await wins(env, out.map(r => r.id), w);
  for (const r of out) { const x = won.get(r.id); r.wins = x ? x.n : 0; r.opps = x ? x.opps : 0 }
  return out.sort((a, b) => b.pts - a.pts || b.wins - a.wins || a.last - b.last);
}
export async function tickets(env, ids, now = Date.now()) {
  const w = prizeWeek(now); if (now < w) return new Set();
  const info = await rows(env, ids, w), out = new Set();
  for (const [id, r] of info) { const s = steps(r, w, now, loose(env)); if (doneOf(s) && s.age.ok && !r.skipped) out.add(id) }
  return out;
}
// An admin takes a player out of the weekly prize (on = true) or lets them back in. null when there's no such player.
export async function skip(env, player, on, by, now = Date.now()) {
  const p = await env.DB.prepare('SELECT id, name FROM players WHERE id = ?').bind(player).first(); if (!p) return null;
  await (on ? env.DB.prepare('INSERT OR IGNORE INTO prize_skip (player, at, by) VALUES (?, ?, ?)').bind(player, now, by ?? null) : env.DB.prepare('DELETE FROM prize_skip WHERE player = ?').bind(player)).run();
  return p;
}

// Telegram's answer about a player in the community group (the bot must be an admin there to see members).
export async function member(env, tgId) {
  const group = env.PRIZE_GROUP || await env.DB.prepare("SELECT v FROM bot_kv WHERE k = 'group'").first().then(r => r && r.v).catch(() => null) || '@CryptoWorm_Group';
  return tg(env, 'getChatMember', { chat_id: /^-?\d+$/.test(group) ? Number(group) : group, user_id: tgId }).catch(() => null);
}
// Is this player in the community group? null when Telegram didn't answer.
export async function inGroup(env, tgId) {
  const r = await member(env, tgId);
  if (!r || !r.ok || !r.result) return r && r.error_code === 400 ? false : null;            // 400: not a member Telegram knows of
  const st = r.result.status;
  return st === 'creator' || st === 'administrator' || st === 'member' || (st === 'restricted' && !!r.result.is_member);
}
async function checkGroup(env, me, force, now = Date.now()) {
  if (me.tg_id == null || !env.BOT_TOKEN) return;
  const e = await env.DB.prepare('SELECT group_at FROM prize_entry WHERE player = ?').bind(me.id).first();
  if (e && now - e.group_at < (force ? CHECK_MS : RECHECK_MS)) return;
  const ok = await inGroup(env, me.tg_id); if (ok == null) return;
  await env.DB.prepare('INSERT INTO prize_entry (player, group_ok, group_at) VALUES (?, ?, ?) ON CONFLICT(player) DO UPDATE SET group_ok = excluded.group_ok, group_at = excluded.group_at')
    .bind(me.id, ok ? 1 : 0, now).run();
}

export async function card(env, me, now = Date.now()) {
  if (!prizeOn(env, me, now)) return { on: false };
  const w = prizeWeek(now), r = (await rows(env, [me.id], w)).get(me.id), s = steps(r, w, now, loose(env)), done = doneOf(s);
  const pts = now >= w ? await points(env, w) : [], mine = pts.find(p => p.player === me.id);
  let rank = null, entrants = 0;
  if (done && s.age.ok && !r.skipped) { const c = await chart(env, w, now); entrants = c.length; const i = c.findIndex(x => x.id === me.id); rank = i >= 0 ? i + 1 : null }
  return { on: true, start: FIRST_WEEK, week: w, started: now >= w, ends: w + WEEK, steps: s, done, ticket: done && s.age.ok && !r.skipped, ...(r.skipped ? { skipped: true } : {}), points: mine ? mine.pts : 0,
    rank, entrants, prizes: PRIZES, prizeUnit: 'SOL', dayCap: DAY_CAP, playDays: PLAY_DAYS, hold: HOLD_MIN, minAge: MIN_AGE_DAYS, group: GROUP_LINK, xLink: X_LINK };
}
export async function handle(path, env, me, body, now = Date.now()) {
  if (!prizeOn(env, me, now)) return path === '/prize' || path === '/prize/check' || path === '/prize/x' ? { on: false } : null;
  if (path === '/prize') { await checkGroup(env, me, false, now).catch(() => { }); return card(env, me, now) }
  if (path === '/prize/check') { await checkGroup(env, me, true, now).catch(() => { }); return card(env, me, now) }
  if (path === '/prize/x') {
    const raw = String(body.handle || '').trim(), x = cleanX(raw);
    if (raw && !x) return { error: 'type your X username, like @yourname', status: 400 };
    if (x && await env.DB.prepare('SELECT 1 AS y FROM prize_entry WHERE x = ? COLLATE NOCASE AND player != ?').bind(x, me.id).first())
      return { error: 'that X username is already used by another player', status: 409 };
    await env.DB.prepare('INSERT INTO prize_entry (player, x, x_at) VALUES (?, ?, ?) ON CONFLICT(player) DO UPDATE SET x = excluded.x, x_at = excluded.x_at').bind(me.id, x, now).run();
    return card(env, me, now);
  }
  return null;
}

// ---- Monday: the admins' list ----
const csvCell = v => v == null ? '' : /[",\n\r]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
const toCsv = rs => '\ufeff' + rs.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const iso = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
// How many $CWORM one SOL buys now: DexScreener's SOL pair with the most liquidity, else Jupiter's USD prices. null when
// neither answers (the admin then works the amounts out by hand).
export async function cwormPerSol() {
  try { const d = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + MINT)).json();
    const p = (d.pairs || []).filter(x => x.chainId === 'solana' && x.baseToken && x.baseToken.address === MINT && x.quoteToken && x.quoteToken.symbol === 'SOL' && +x.priceNative > 0)
      .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
    if (p) return { perSol: 1 / +p.priceNative, from: 'DexScreener' } } catch (e) { }
  try { const SOL = 'So11111111111111111111111111111111111111112', d = await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${MINT},${SOL}`)).json();
    const c = d[MINT] && +d[MINT].usdPrice, s = d[SOL] && +d[SOL].usdPrice; if (c > 0 && s > 0) return { perSol: s / c, from: 'Jupiter' } } catch (e) { }
  return null;
}
// The eligible top of week `w`, with Telegram asked again about the group and the wallets read now (a wallet under 100K
// drops out; one the RPC didn't answer for stays, for the admin to check by hand), and how each player's points came in.
export async function adminList(env, w, now = Date.now()) {
  const c = await chart(env, w, now), top = [], dropped = [];
  const live = await balances(env, c.slice(0, PRIZES.length + 20).map(r => r.wallet)).catch(() => new Map());
  for (const r of c) {
    if (top.length >= PRIZES.length + 5) break;
    r.now = live.has(r.wallet) ? live.get(r.wallet) : null;
    if (r.now != null && r.now < HOLD_MIN) { dropped.push({ ...r, why: 'balance' }); continue }
    if (r.tg_id != null && env.BOT_TOKEN) { const ok = await inGroup(env, r.tg_id); if (ok === false) { r.steps.group.done = false; dropped.push({ ...r, why: 'group' }); continue } }
    top.push(r);
  }
  const ids = top.map(r => r.id), logs = ids.length ? (await env.DB.prepare(`SELECT player, at, amount FROM score_log WHERE player IN (${ids.map(() => '?').join(',')}) AND at >= ? AND at < ? ORDER BY player, at`)
    .bind(...ids, w, w + WEEK).all()).results : [];
  const runs = ids.length ? new Map((await env.DB.prepare(`SELECT player, COUNT(*) AS n FROM run_log WHERE player IN (${ids.map(() => '?').join(',')}) AND at >= ? AND at < ? GROUP BY player`)
    .bind(...ids, w, w + WEEK).all()).results.map(r => [r.player, r.n])) : new Map();
  const fair = new Map(ids.map(id => [id, { reports: 0, maxHour: 0, night: 0, runs: runs.get(id) || 0, gaps: [], amounts: new Map() }])), hours = new Map(), prev = new Map();
  for (const l of logs) { const f = fair.get(l.player); f.reports++; const h = l.player + ':' + Math.floor(l.at / 3600e3); hours.set(h, (hours.get(h) || 0) + l.amount); f.maxHour = Math.max(f.maxHour, hours.get(h)); if (new Date(l.at).getUTCHours() < 6) f.night++
    if (prev.has(l.player) && l.at - prev.get(l.player) < 3600e3) f.gaps.push(l.at - prev.get(l.player)); prev.set(l.player, l.at); f.amounts.set(l.amount, (f.amounts.get(l.amount) || 0) + 1) }
  for (const f of fair.values()) {          // what a script tends to look like: reports at even gaps, or the same amount again and again
    const m = f.gaps.reduce((a, b) => a + b, 0) / (f.gaps.length || 1), sd = Math.sqrt(f.gaps.reduce((a, g) => a + (g - m) ** 2, 0) / (f.gaps.length || 1));
    f.even = f.gaps.length >= 20 && sd < m * 0.25; f.same = f.reports >= 20 && Math.max(0, ...f.amounts.values()) >= f.reports / 2; delete f.gaps; delete f.amounts }
  const px = await cwormPerSol(), cw = sol => px ? Math.round(sol * px.perSol) : null;
  const winners = top.slice(0, PRIZES.length).map((r, i) => ({ ...r, place: i + 1, prize: PRIZES[i], cworm: cw(PRIZES[i]), fair: { ...fair.get(r.id), unchecked: Math.max(0, r.raw - r.ok) } }));
  const head = ['place', 'prize_sol', 'prize_cworm_now', 'name', 'player', 'telegram_id', 'x_username', 'wallet', 'prize_points', 'week_points', 'play_days', 'hold_days', 'balance_now', 'balance_last_read', 'account_days', 'reports', 'max_per_hour', 'reports_00_06_utc',
    'checked_matches', 'points_without_checked_match', 'online_wins', 'win_opponents', 'even_timing', 'same_amounts'];
  const list = toCsv([head, ...winners.map(r => [r.place, r.prize, r.cworm ?? 'price not read', r.name, r.id, r.tg_id, r.x ? '@' + r.x : '', r.wallet, r.pts, r.raw, r.days, r.steps.hold.days, r.now == null ? 'check by hand' : r.now, r.balance, r.steps.age.days, r.fair.reports, r.fair.maxHour, r.fair.night,
    r.fair.runs, r.fair.unchecked, r.wins, r.opps, r.fair.even ? 'yes' : '', r.fair.same ? 'yes' : ''])]);
  const pay = winners.map(r => r.wallet + ',' + (r.cworm ?? r.prize + ' SOL')).join('\n');
  const log = toCsv([['player', 'name', 'time_utc', 'amount'], ...logs.map(l => [l.player, (top.find(r => r.id === l.player) || {}).name, iso(l.at), l.amount])]);
  const out = (await env.DB.prepare('SELECT p.id, p.name FROM prize_skip k JOIN players p ON p.id = k.player ORDER BY k.at DESC LIMIT 20').all()).results;
  return { week: w, winners, reserves: top.slice(PRIZES.length), dropped, list, pay, log, entrants: c.length, price: px, skipped: out };
}
