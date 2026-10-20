// Crypto Worm Wars match server (Cloudflare Worker).
//
// One account per player across Telegram, the web and apps. A player can sign in with any of these, and each one
// signed in while already signed in is linked to the same account (two accounts get merged when they don't clash):
//   POST /auth/telegram      {initData}                         -> session   from the Telegram Mini App
//   POST /auth/telegram/web  {id, first_name, ..., hash}        -> session   Telegram Login Widget on the web
//   POST /auth/solana/nonce  {address}                          -> {message} the text the wallet signs
//   POST /auth/solana        {address, message, signature}      -> session
//   POST /auth/guest                                            -> session
//   POST /auth/code                                             -> {code, expires}   a login code for another device
//   POST /auth/code/redeem   {code}                             -> session   signs this device into that account
//   GET  /me                                                    -> session without the token
// A session is {token, player, friendCode}.
//
//   GET  /friends                                               -> {friends: [{id, name, wins, losses, online}]}
//   POST /friends/add        {code} | {id}                      -> {friend}  a friend code adds both ways, an id one way
//   POST /friends/remove     {id}
//   GET  /lobby/ws?token=...[&hidden=1]                         websocket into the lobby (see lobby.js)
//   GET  /online                                                -> {online, playing}  players with the game open now (no sign-in)
//   POST /match/new                                             -> {code}      challenge a friend by link
//   POST /match/quick                                           -> {code, side} quick match
//   GET  /match/<code>/ws?token=...                             websocket into the match
//   GET  /match/<code>/watch                                    websocket to watch a match live (no sign-in, see match.js)
//   GET  /live                                                  -> {live: [{code, names, cc, viewers, at}]}  matches being played now
//   POST /royale/join                                           -> {code, left}  the open Worm Royale room (see lobby.js, royale.js)
//   GET  /royale/<code>/ws?token=...                            websocket into a Worm Royale room
//   GET  /royale/ping, POST /royale/ping {on}                   -> {on}  a bot message when the daily Royale hour starts
//   GET  /stats                                                 -> {players}  everyone who has started a game (no sign-in)
//   GET  /feed                                                  -> {feed, now}  the live feed on Home: wins, kills, great shots (no sign-in, see feed.js)
// Load tests (see sim/): /auth/guest with the header x-sim-key: SIM_KEY makes a simulated player (sim_players). They count and
// rank like everyone else, but stay hidden in the lobby, out of Live now and the weekly prize, and only fight CPU or bot land.
//   POST /me/name            {name}                             -> session   pick a nickname (3-16 letters, digits, spaces, _ - .)
//   POST /me/avatar          {av}                               -> session   pick an avatar (an id from the game's list); it shows in the
//                                                               ranking and the battle's corners, online too (session player.av)
//   POST /me/wallet/unlink                                       -> session   disconnect the wallet (accounts that also have Telegram)
//   GET  /ranking?period=week|all&holders=1                    -> {period, since, holders?, top: [{rank, id, name, cworm, tier?, ticket?}], me, players}   holders=1: holders only
//   GET  /prize, POST /prize/check, /prize/x                     the weekly prize card (see prize.js)
//   POST /score              {amount} | {import: total}          -> {added, week, total}  play-money $CWORM a match banked
//   POST /feedback           {text, rating?, wallet?, info?, kind?}  -> {ok, reward, rated, rewards}   beta feedback (kind 'bug': a bug report); the bot passes it on to the admins; stars + a comment pay +500 once
//   GET  /map, POST /map/join, /map/buy, /map/attack, /map/result, /map/defend, /map/upgrade   the World Map (see map.js)
//   POST /started, /played, /rewards, /share/prepare, /share/done, /me/remind, GET /invites   matches, invite rewards and bonuses, share cards, reminders (see growth.js)
//   GET  /holder, POST /holder/refresh, /holder/chest, /holder/toast   $CWORM holder rewards (see holders.js); the session carries `holder` too
//   GET  /teams, /teams/<id>, POST /teams/create, /teams/join, /teams/leave, /teams/kick, /teams/edit, /teams/logo, GET /teams/logo/<id>.jpg   community teams (see teams.js)
//   GET  /worm, POST /worm/make, /worm/pick, /worm/remove, /worm/report, GET /worm/img/<id>.jpg   custom photo worms for holders (see
//                                                               worms.js); the session's player.cw, ranking rows and match flags carry the portrait's id
// The sign-in calls also take {src}: where a brand-new player came from (a link's source tag), kept on the new account.
//   POST /telegram/webhook, /telegram/setup                     the bot's welcome message and settings (see bot.js)
//
// Signing in with a wallet never asks for a transaction. Scores are for fun: the server never sends tokens or anything
// of value.

import { verifyTelegram, verifyTelegramLogin, makeNonce, signInMessage, verifySolana, makeToken, readToken, friendCode, readFriendCode } from './auth.js';
import { Match, newCode } from './match.js';
import { Lobby } from './lobby.js';
import { Royale } from './royale.js';
import { webhook, setup, cron, tellAdmins, tellAdminsPhoto } from './bot.js';
import { handle as mapHandle } from './map.js';
import { weekStart, newPlayer, seen, noteInvite, started, played, claim, prepareShare, setRemind, invites, shareDone, rateReward } from './growth.js';
import { handle as holderHandle, get as holderGet, badge } from './holders.js';
import { handle as prizeHandle, logScore, tickets, runStart, runEnd } from './prize.js';
import { feedResponse } from './feed.js';
import { handle as teamHandle, teamScore, teamOf, mergeTeams, teamLogo } from './teams.js';
import { handle as wormHandle, image as wormImage, mine as wormMine, admins as wormAdmins } from './worms.js';
export { Match, Lobby, Royale };

const json = (body, status = 200, cors = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } });
const MAX_FRIENDS = 200, LOGIN_CODE_MS = 10 * 60 * 1000, MAX_FEEDBACK = 1500, FEEDBACK_PER_DAY = 10;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SCORE_MAX = 600, SCORE_DAY = 6000, SCORE_GAP_MS = 8000, SCORE_IMPORT_MAX = 3000;
async function addScore(env, me, amount, imported) {
  const now = Date.now(), week = weekStart(now), day = Math.floor(now / 864e5) * 864e5;
  const s = await env.DB.prepare('SELECT * FROM cworm_scores WHERE player = ?').bind(me.id).first() || { total: 0, week_start: week, week: 0, day_start: day, day: 0, last: 0, imported: 0 };
  if (imported) { if (s.imported) return { added: 0, s }; s.imported = 1; amount = Math.min(SCORE_IMPORT_MAX, amount); s.total += amount }
  else {
    if (now - s.last < SCORE_GAP_MS) return { error: 'too soon', status: 429 };
    if (s.day_start !== day) { s.day_start = day; s.day = 0 }
    if (s.week_start !== week) {                                   // keep the week that ended, for the Monday top 10
      if (s.week > 0) await env.DB.prepare('INSERT OR IGNORE INTO week_scores (week_start, player, cworm) VALUES (?, ?, ?)').bind(s.week_start, me.id, s.week).run();
      s.week_start = week; s.week = 0 }
    amount = Math.min(amount, SCORE_MAX, Math.max(0, SCORE_DAY - s.day));
    s.total += amount; s.week += amount; s.day += amount; s.last = now;
    await logScore(env, me.id, amount, now);                      // the weekly prize chart and its fair-play log
    await teamScore(env, me.id, amount, now).catch(() => { });    // the same amount scores for the player's community team
  }
  await env.DB.prepare(`INSERT INTO cworm_scores (player, total, week_start, week, day_start, day, last, imported) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player) DO UPDATE SET total = excluded.total, week_start = excluded.week_start, week = excluded.week, day_start = excluded.day_start, day = excluded.day, last = excluded.last, imported = excluded.imported`)
    .bind(me.id, s.total, s.week_start, s.week, s.day_start, s.day, s.last, s.imported).run();
  return { added: amount, s };
}
const NICK = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{1,14}[\p{L}\p{N}]$/u, RANK_TOP = 50, NICK_GAP_MS = 60 * 1000;
// A short list of words a nickname can't contain, and names that would pass for the team or the game.
const NICK_BLOCK = /(fuck|shit|bitch|cunt|nigg|fag|rape|nazi|hitler|porn|whore|slut|dick|pussy|admin|moderator|official|cryptoworm|crypto worm|whale|cwormteam|support)/i;   // whale: holder titles are shown by badge, not by name

// The ranking is play-money $CWORM gained: this week (from Monday 00:00 UTC) or all time. The game reports what each
// match banked; the server caps each report and each day so a tampered phone can't run away with it.
// holders (Damian 2026-10-19: "an option to see only the holders"): only players with a holder tier, ranked among themselves.
async function ranking(env, period, me, holders) {
  const since = weekStart();
  let rows = period === 'week'
    ? (await env.DB.prepare(`SELECT p.id, p.name, s.week AS cworm, ${TIER_COL} FROM cworm_scores s JOIN players p ON p.id = s.player ${TIER_JOIN} WHERE s.week_start = ? AND s.week > 0 ORDER BY s.week DESC, s.last ASC`).bind(since).all()).results
    : (await env.DB.prepare(`SELECT p.id, p.name, s.total AS cworm, ${TIER_COL} FROM cworm_scores s JOIN players p ON p.id = s.player ${TIER_JOIN} WHERE s.total > 0 ORDER BY s.total DESC, s.last ASC`).all()).results;
  if (holders) rows = rows.filter(r => r.tier > 0);
  const out = { period: period === 'week' ? 'week' : 'all', since: period === 'week' ? since : null, ...(holders ? { holders: true } : {}), ...place(rows, me, wormAdmins(env)) };
  if (period === 'week') {                                        // 🎟️ next to players who did every weekly prize step
    const t = await tickets(env, [...out.top.map(r => r.id), ...(out.me ? [out.me.id] : [])]).catch(() => new Set());
    for (const r of [...out.top, ...(out.me ? [out.me] : [])]) if (t.has(r.id)) r.ticket = true;
  }
  return out;
}
const TIER_COL = 'COALESCE(h.tier, 0) AS tier, c.id AS cw, a.av AS av, tt.tag AS team', TIER_JOIN = "LEFT JOIN holders h ON h.player = p.id AND h.wallet = p.wallet LEFT JOIN custom_worms c ON c.player = p.id AND c.state = 'on' LEFT JOIN player_avatar a ON a.player = p.id LEFT JOIN team_members tm ON tm.player = p.id LEFT JOIN teams tt ON tt.id = tm.team";   // holder badge, avatar, custom worm and team tag next to the name
function place(rows, me, admins = new Set()) {           // a custom worm shows while its owner holds (admins always)
  const out = rows.map((r, i) => ({ rank: i + 1, id: r.id, name: r.name, cworm: r.cworm | 0, ...(r.tier ? { tier: r.tier } : {}), ...(r.av ? { av: r.av } : {}), ...(r.team ? { team: r.team } : {}), ...(r.cw && (r.tier || admins.has(r.id)) ? { cw: r.cw } : {}) }));
  return { top: out.slice(0, RANK_TOP), me: me ? out.find(r => r.id === me.id) || null : null, players: out.length };
}

function corsFor(req, env) {
  const origin = req.headers.get('Origin') || '', allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(origin) || allowed.includes('*') ? { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Vary': 'Origin' } : {};
}

// Wallet sign-in messages name the site the player is on (the game can live on more than one domain), falling back to SIGNIN_DOMAIN.
function signDomain(req, env) {
  const origin = req.headers.get('Origin') || '', allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  if (origin && allowed.includes(origin)) try { return new URL(origin).host } catch (e) { }
  return env.SIGNIN_DOMAIN;
}

// Everyone who has been in the game: signed in with Telegram or a wallet, or started at least one match or mini game as a
// guest, finished or not (so a web visitor who never played, or a page preview, doesn't count). Kept for 5 minutes per Worker instance.
let counted = { at: 0, n: 0 };
async function playerCount(env, now = Date.now()) {
  if (now - counted.at < 300000) return counted.n;
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM players p LEFT JOIN player_meta m ON m.player = p.id
    WHERE p.tg_id IS NOT NULL OR p.wallet IS NOT NULL OR p.wins + p.losses > 0 OR m.played > 0 OR m.started > 0`).first();
  counted = { at: now, n: r ? r.n : 0 }; return counted.n;
}

// A simulated player from the load test (see sim/)? The key is compared in constant time.
const sameKey = (a, b) => { a = String(a || ''); b = String(b || ''); if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0 };
// a simulated player's own country (they all run inside Cloudflare, so the connection says nothing)
const simCountry = (req, env) => { const cc = req.headers.get('x-sim-cc'); return cc && /^[A-Z]{2}$/.test(cc) && env.SIM_KEY && sameKey(req.headers.get('x-sim-key'), env.SIM_KEY) ? cc : null };
const isSim = (env, id) => env.DB.prepare('SELECT 1 AS y FROM sim_players WHERE player = ?').bind(id).first().then(r => !!r).catch(() => false);

// The load test's minute (see sim/): this Worker's cron also starts it, and keeps its answer in bot_kv for a look from outside.
async function simTick(env) {
  let note;
  try { const r = await env.SIM.fetch('https://sim/tick', { method: 'POST', headers: { 'x-sim-key': env.SIM_KEY } }); note = r.status + ' ' + (await r.text()).slice(0, 1500) } catch (e) { note = 'error ' + String(e && e.message || e).slice(0, 300) }
  await env.DB.prepare("INSERT INTO bot_kv (k, v) VALUES ('sim_tick', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(new Date().toISOString() + ' ' + note).run().catch(() => { });
}

const publicPlayer = p => p && { id: p.id, name: p.name, tg: p.tg_id != null, wallet: p.wallet || null, wins: p.wins, losses: p.losses };

async function playerById(env, id) { return env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(id).first() }
const AVATAR = /^[a-z0-9]{2,16}$/;
const avatarOf = (env, id) => env.DB.prepare('SELECT av FROM player_avatar WHERE player = ?').bind(id).first().then(r => r ? r.av : null).catch(() => null);

async function signedIn(req, env) {
  const auth = req.headers.get('Authorization') || '', token = auth.startsWith('Bearer ') ? auth.slice(7) : new URL(req.url).searchParams.get('token');
  const id = await readToken(token, env.SESSION_SECRET);
  return id ? playerById(env, id) : null;
}

async function session(env, p, cors, withToken = true) {
  const nick = await env.DB.prepare('SELECT 1 AS y FROM nicknames WHERE player = ?').bind(p.id).first();
  await seen(env, p.id); const m = await env.DB.prepare('SELECT remind FROM player_meta WHERE player = ?').bind(p.id).first();
  const holder = await holderGet(env, p).catch(() => null), cw = await wormMine(env, p.id, holder && holder.tier || 0), av = await avatarOf(env, p.id), tm = await teamOf(env, p.id);
  const team = tm ? { id: tm.id, name: tm.name, tag: tm.tag, emoji: tm.emoji, ...(tm.logo ? { logo: tm.logo } : {}), ...(tm.role === 'lead' ? { lead: true } : {}) } : null;
  return json({ ...(withToken ? { token: await makeToken(p.id, env.SESSION_SECRET) } : {}), player: { ...publicPlayer(p), nick: !!nick, remind: !m || !!m.remind, holder, cw, av, team }, friendCode: await friendCode(p.id, env.SESSION_SECRET) }, 200, cors);
}

// Sign `me` (whoever this device was signed in as) into `target`. When the two are different accounts that don't both
// have a Telegram account or both have a wallet, `me` is folded into `target`: wins, losses, friends and match history
// move over and `me` is deleted. Otherwise the device simply switches to `target`.
async function link(env, me, target) {
  if (!me || me.id === target.id) return target;
  if ((me.tg_id != null && target.tg_id != null) || (me.wallet && target.wallet)) return target;
  const a = me.id, b = target.id, q = (s, ...v) => env.DB.prepare(s).bind(...v);
  await mergeTeams(env, a, b);                                                         // community team: the target's own team wins
  await env.DB.batch([
    q('UPDATE players SET tg_id = NULL, wallet = NULL WHERE id = ?', a),
    q('UPDATE players SET tg_id = COALESCE(tg_id, ?), wallet = COALESCE(wallet, ?), wins = wins + ?, losses = losses + ?, name = CASE WHEN tg_id IS NULL AND ? IS NOT NULL THEN ? ELSE name END WHERE id = ?',
      me.tg_id, me.wallet, me.wins, me.losses, me.tg_id, me.name, b),
    q('INSERT OR IGNORE INTO friends (player, friend, created) SELECT ?, friend, created FROM friends WHERE player = ? AND friend != ?', b, a, b),
    q('INSERT OR IGNORE INTO friends (player, friend, created) SELECT player, ?, created FROM friends WHERE friend = ? AND player != ?', b, a, b),
    q('DELETE FROM friends WHERE player = ? OR friend = ?', a, a),
    q('UPDATE matches SET p0 = ? WHERE p0 = ?', b, a), q('UPDATE matches SET p1 = ? WHERE p1 = ?', b, a), q('UPDATE matches SET winner = ? WHERE winner = ?', b, a),
    q('UPDATE login_codes SET player = ? WHERE player = ?', b, a),
    q('UPDATE feedback SET player = ? WHERE player = ?', b, a),                          // feedback follows the merged account, for the airdrop list
    q('UPDATE OR IGNORE nicknames SET player = ? WHERE player = ?', b, a),             // a nickname picked as a guest comes along, unless the account has one
    q('DELETE FROM nicknames WHERE player = ?', a),
    q(`INSERT INTO cworm_scores (player, total, week_start, week, day_start, day, last, imported) SELECT ?, total, week_start, week, day_start, day, last, imported FROM cworm_scores WHERE player = ?
       ON CONFLICT(player) DO UPDATE SET total = total + excluded.total,
       week = CASE WHEN week_start = excluded.week_start THEN week + excluded.week WHEN excluded.week_start > week_start THEN excluded.week ELSE week END,
       week_start = MAX(week_start, excluded.week_start), imported = MAX(imported, excluded.imported), last = MAX(last, excluded.last)`, b, a),
    q('DELETE FROM cworm_scores WHERE player = ?', a),
    q('UPDATE rewards SET player = ? WHERE player = ?', b, a),                          // unclaimed play money follows the account
    q('UPDATE OR IGNORE reward_once SET player = ? WHERE player = ?', b, a), q('DELETE FROM reward_once WHERE player = ?', a),   // invite bonuses already paid
    q('UPDATE score_log SET player = ? WHERE player = ?', b, a),                        // weekly prize: points, play days, steps
    q('UPDATE OR IGNORE play_days SET player = ? WHERE player = ?', b, a), q('DELETE FROM play_days WHERE player = ?', a),
    q('UPDATE OR IGNORE prize_entry SET player = ? WHERE player = ?', b, a), q('DELETE FROM prize_entry WHERE player = ?', a),
    q('UPDATE OR IGNORE player_meta SET player = ? WHERE player = ?', b, a), q('DELETE FROM player_meta WHERE player = ?', a),
    q('UPDATE player_meta SET invited_by = ? WHERE invited_by = ?', b, a),
    q('UPDATE land SET owner = ? WHERE owner = ?', b, a),                                // World Map land and upgrades follow the account
    q('UPDATE OR IGNORE landlords SET player = ? WHERE player = ?', b, a), q('DELETE FROM landlords WHERE player = ?', a),
    q('UPDATE attacks SET attacker = ? WHERE attacker = ?', b, a),
    q('UPDATE OR IGNORE holders SET player = ? WHERE player = ?', b, a), q('DELETE FROM holders WHERE player = ?', a),   // holder status follows the wallet
    q('UPDATE OR IGNORE hold_dips SET player = ? WHERE player = ?', b, a), q('DELETE FROM hold_dips WHERE player = ?', a),
    q("DELETE FROM custom_worms WHERE player = ? AND EXISTS (SELECT 1 FROM custom_worms WHERE player = ? AND state = 'on')", a, b),   // custom worms: the target's own portrait wins
    q('UPDATE custom_worms SET player = ? WHERE player = ?', b, a), q('UPDATE worm_makes SET player = ? WHERE player = ?', b, a),
    q('UPDATE OR IGNORE player_avatar SET player = ? WHERE player = ?', b, a), q('DELETE FROM player_avatar WHERE player = ?', a),   // the account's own avatar wins
    q('UPDATE players SET name = (SELECT nick FROM nicknames WHERE player = ?) WHERE id = ? AND id IN (SELECT player FROM nicknames)', b, b),
    q('DELETE FROM players WHERE id = ?', a),
  ]);
  return playerById(env, b);
}

async function telegramUser(env, req, u, cors, src) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 40) || u.username || 'Worm';
  const me = await signedIn(req, env);
  let p = await env.DB.prepare('SELECT * FROM players WHERE tg_id = ?').bind(u.id).first();
  if (p) { if (p.name !== name) await env.DB.prepare('UPDATE players SET name = ? WHERE id = ? AND id NOT IN (SELECT player FROM nicknames)').bind(name, p.id).run(); p = await playerById(env, p.id) }
  else if (me && me.tg_id == null) { await env.DB.prepare('UPDATE players SET tg_id = ?, name = CASE WHEN id IN (SELECT player FROM nicknames) THEN name ELSE ? END WHERE id = ?').bind(u.id, name, me.id).run(); p = await playerById(env, me.id) }
  else { p = await env.DB.prepare('INSERT INTO players (tg_id, name, created) VALUES (?, ?, ?) RETURNING *').bind(u.id, name, Date.now()).first(); await newPlayer(env, p.id, src) }
  return session(env, await link(env, me, p), cors);
}

const lobbyOf = env => env.LOBBY.get(env.LOBBY.idFromName('lobby'));

const app = {
  async scheduled(event, env, ctx) { ctx.waitUntil(cron(env, event && event.scheduledTime || Date.now())); if (env.SIM && env.SIM_KEY) ctx.waitUntil(simTick(env)) },
  async fetch(req, env, ctx) {                                                    // a simulated player also gets the server's own time (x-took)
    if (!req.headers.has('x-sim-key')) return app.handle(req, env, ctx);
    const t0 = Date.now(), r = await app.handle(req, env, ctx);
    try { if (r.status !== 101) r.headers.set('x-took', String(Date.now() - t0)) } catch (e) { }
    return r;
  },
  async handle(req, env, ctx) {
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, ''), cors = corsFor(req, env);
    const geo = simCountry(req, env) || (req.cf && req.cf.country) || '';        // the player's country, for flags
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST' } });
    if (path === '/telegram/webhook' && req.method === 'POST') return webhook(req, env);
    if (path === '/telegram/setup') return setup(req, env, url.origin);
    if (path === '/online' && req.method === 'GET') return json(await (await lobbyOf(env).fetch('https://lobby/count')).json(), 200, cors);
    if (path === '/live' && req.method === 'GET') return json(await (await lobbyOf(env).fetch('https://lobby/live')).json(), 200, cors);
    if (path === '/stats' && req.method === 'GET') return json({ players: await playerCount(env) }, 200, cors);
    if (path === '/feed' && req.method === 'GET') return feedResponse(env, ctx, cors);
    const pic = path.match(/^\/worm\/img\/([a-z0-9]{12,24})(?:\.jpg)?$/);
    if (pic && req.method === 'GET') return wormImage(env, pic[1]);              // a custom worm's portrait, for anyone
    const tpic = path.match(/^\/teams\/logo\/([a-z0-9]{12,24})(?:\.jpg)?$/);
    if (tpic && req.method === 'GET') return teamLogo(env, tpic[1]);             // a team's picture, for anyone
    const watch = path.match(/^\/match\/([A-Z2-9]{6})\/watch$/);
    if (watch) return env.MATCH.get(env.MATCH.idFromName(watch[1])).fetch(new Request(req.url, { headers: req.headers }));
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

    if (path === '/auth/telegram' && req.method === 'POST') {
      const u = await verifyTelegram(body.initData, env.BOT_TOKEN);
      return u ? telegramUser(env, req, u, cors, body.src) : json({ error: 'telegram sign-in failed' }, 401, cors);
    }
    if (path === '/auth/telegram/web' && req.method === 'POST') {
      const u = await verifyTelegramLogin(body, env.BOT_TOKEN);
      return u ? telegramUser(env, req, u, cors, body.src) : json({ error: 'telegram sign-in failed' }, 401, cors);
    }

    if (path === '/auth/solana/nonce' && req.method === 'POST') {
      if (typeof body.address !== 'string' || body.address.length > 50) return json({ error: 'bad address' }, 400, cors);
      return json({ message: signInMessage(signDomain(req, env), body.address, await makeNonce(body.address, env.SESSION_SECRET)) }, 200, cors);
    }

    if (path === '/auth/solana' && req.method === 'POST') {
      if (!(await verifySolana(body, signDomain(req, env), env.SESSION_SECRET))) return json({ error: 'wallet sign-in failed' }, 401, cors);
      const me = await signedIn(req, env);
      let p = await env.DB.prepare('SELECT * FROM players WHERE wallet = ?').bind(body.address).first();
      // A new wallet joins the signed-in account, or takes the place of its old one (still one wallet per account, one account
      // per wallet; holder status starts over with the new wallet). A wallet that has its own account switches the device to it.
      if (!p && me) { await env.DB.prepare("UPDATE players SET wallet = ?, name = CASE WHEN name LIKE 'Guest %' OR name = ? THEN ? ELSE name END WHERE id = ?").bind(body.address, me.wallet ? me.wallet.slice(0, 4) + '…' + me.wallet.slice(-4) : '', body.address.slice(0, 4) + '…' + body.address.slice(-4), me.id).run(); p = await playerById(env, me.id) }
      else if (!p) { p = await env.DB.prepare('INSERT INTO players (wallet, name, created) VALUES (?, ?, ?) RETURNING *').bind(body.address, body.address.slice(0, 4) + '…' + body.address.slice(-4), Date.now()).first(); await newPlayer(env, p.id, body.src) }
      return session(env, await link(env, me, p), cors);
    }

    if (path === '/auth/guest' && req.method === 'POST') {
      const r = await env.DB.prepare('INSERT INTO players (name, created) VALUES (?, ?) RETURNING *').bind('Guest ' + Math.floor(1000 + Math.random() * 9000), Date.now()).first();
      if (env.SIM_KEY && sameKey(req.headers.get('x-sim-key'), env.SIM_KEY)) await env.DB.prepare('INSERT OR IGNORE INTO sim_players (player, created) VALUES (?, ?)').bind(r.id, Date.now()).run();
      await newPlayer(env, r.id, body.src);
      return session(env, r, cors);
    }

    if (path === '/auth/code/redeem' && req.method === 'POST') {
      const code = String(body.code || '').trim().toUpperCase().slice(0, 12);
      const row = await env.DB.prepare('DELETE FROM login_codes WHERE code = ? RETURNING player, expires').bind(code).first();
      const p = row && row.expires > Date.now() && await playerById(env, row.player);
      if (!p) return json({ error: 'that code is wrong or has expired' }, 404, cors);
      return session(env, await link(env, await signedIn(req, env), p), cors);
    }

    const me = await signedIn(req, env);
    if (path === '/me') return me ? session(env, me, cors, false) : json({ error: 'sign in first' }, 401, cors);
    if (!me) return json({ error: 'sign in first' }, 401, cors);

    if (path === '/auth/code' && req.method === 'POST') {
      const code = newCode() + newCode().slice(0, 2), expires = Date.now() + LOGIN_CODE_MS;
      await env.DB.batch([
        env.DB.prepare('DELETE FROM login_codes WHERE expires < ? OR player = ?').bind(Date.now(), me.id),
        env.DB.prepare('INSERT INTO login_codes (code, player, expires) VALUES (?, ?, ?)').bind(code, me.id, expires),
      ]);
      return json({ code, expires }, 200, cors);
    }

    if (path === '/friends' && req.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT p.id, p.name, p.wins, p.losses FROM friends f JOIN players p ON p.id = f.friend WHERE f.player = ? ORDER BY p.name LIMIT ?').bind(me.id, MAX_FRIENDS).all();
      let online = new Set();
      if (results.length) { const r = await (await lobbyOf(env).fetch('https://lobby/online?ids=' + results.map(f => f.id).join(','))).json(); online = new Set(r.online) }
      return json({ friends: results.map(f => ({ ...f, online: online.has(f.id) })) }, 200, cors);
    }
    if (path === '/friends/add' && req.method === 'POST') {
      const byCode = body.code != null, id = byCode ? await readFriendCode(body.code, env.SESSION_SECRET) : Number(body.id);
      const f = id && id !== me.id && await playerById(env, id);
      if (!f) return json({ error: byCode ? 'that friend code is wrong' : 'no such player' }, 404, cors);
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM friends WHERE player = ?').bind(me.id).first();
      if (n.n >= MAX_FRIENDS) return json({ error: 'friend list is full' }, 400, cors);
      const add = (a, b) => env.DB.prepare('INSERT OR IGNORE INTO friends (player, friend, created) VALUES (?, ?, ?)').bind(a, b, Date.now());
      await env.DB.batch(byCode ? [add(me.id, f.id), add(f.id, me.id)] : [add(me.id, f.id)]);
      const invited = byCode && await noteInvite(env, me, f.id);                            // a brand-new player who came through a friend link
      return json({ friend: { id: f.id, name: f.name, wins: f.wins, losses: f.losses }, invited }, 200, cors);
    }
    if (path === '/friends/remove' && req.method === 'POST') {
      await env.DB.prepare('DELETE FROM friends WHERE player = ? AND friend = ?').bind(me.id, Number(body.id)).run();
      return json({ ok: true }, 200, cors);
    }

    if (path === '/lobby/ws') {
      const h = new Headers(req.headers);
      h.set('x-player', String(me.id)); h.set('x-name', encodeURIComponent(me.name)); h.set('x-wins', String(me.wins)); h.set('x-losses', String(me.losses));
      h.set('x-country', geo);
      const hb = await badge(env, me.id); h.set('x-tier', String(hb.tier)); h.set('x-stars', String(hb.stars)); h.set('x-toast', hb.toast ? '1' : '0');   // holder badge, vouched for by the server
      const u = new URL(req.url); if (await isSim(env, me.id)) u.searchParams.set('hidden', '1');   // simulated players count as online but can't be challenged
      return lobbyOf(env).fetch(new Request(u.toString(), { headers: h }));
    }
    if (path === '/me/name' && req.method === 'POST') {
      const nick = String(body.name || '').normalize('NFC').replace(/\s+/g, ' ').trim();
      if (!NICK.test(nick)) return json({ error: 'use 3 to 16 letters or numbers (spaces, _ - . in between are fine)' }, 400, cors);
      if (NICK_BLOCK.test(nick.replace(/[\s_.\-]/g, '')) || NICK_BLOCK.test(nick) || /^guest\b/i.test(nick)) return json({ error: 'pick a different nickname' }, 400, cors);
      const mine = await env.DB.prepare('SELECT nick, changed FROM nicknames WHERE player = ?').bind(me.id).first();
      if (mine && mine.nick === nick) return session(env, me, cors, false);
      if (mine && Date.now() - mine.changed < NICK_GAP_MS && mine.nick.toLowerCase() !== nick.toLowerCase()) return json({ error: 'wait a minute before changing it again' }, 429, cors);
      const taken = await env.DB.prepare('SELECT player FROM nicknames WHERE nick = ? AND player != ?').bind(nick, me.id).first();
      if (taken) return json({ error: 'that nickname is taken' }, 409, cors);
      await env.DB.batch([
        env.DB.prepare('INSERT INTO nicknames (player, nick, changed) VALUES (?, ?, ?) ON CONFLICT(player) DO UPDATE SET nick = excluded.nick, changed = excluded.changed').bind(me.id, nick, Date.now()),
        env.DB.prepare('UPDATE players SET name = ? WHERE id = ?').bind(nick, me.id),
      ]);
      return session(env, await playerById(env, me.id), cors, false);
    }
    if (path === '/me/avatar' && req.method === 'POST') {
      const av = String(body.av || '');
      if (!AVATAR.test(av)) return json({ error: 'pick one of the avatars' }, 400, cors);
      await env.DB.prepare('INSERT INTO player_avatar (player, av) VALUES (?, ?) ON CONFLICT(player) DO UPDATE SET av = excluded.av').bind(me.id, av).run();
      return session(env, me, cors, false);
    }
    // Disconnect the wallet. Only for accounts that also sign in with Telegram: for a wallet-only account the wallet is the
    // way back in, so the game logs that device out instead.
    if (path === '/me/wallet/unlink' && req.method === 'POST') {
      if (!me.wallet) return session(env, me, cors, false);
      if (me.tg_id == null) return json({ error: 'this wallet is how you sign in: log out of this device instead' }, 400, cors);
      const short = me.wallet.slice(0, 4) + '…' + me.wallet.slice(-4);
      await env.DB.prepare('UPDATE players SET wallet = NULL, name = CASE WHEN name = ? THEN ? ELSE name END WHERE id = ?').bind(short, 'Guest ' + Math.floor(1000 + Math.random() * 9000), me.id).run();
      return session(env, await playerById(env, me.id), cors, false);
    }
    if (path === '/score' && req.method === 'POST') {
      const imp = body.import != null, amount = Math.floor(Number(imp ? body.import : body.amount));
      if (!(amount > 0) || amount > 1e9) return json({ error: 'bad amount' }, 400, cors);
      const r = await addScore(env, me, amount, imp);
      if (r.error) return json({ error: r.error }, r.status, cors);
      return json({ added: r.added, week: r.s.week_start === weekStart() ? r.s.week : 0, total: r.s.total }, 200, cors);
    }
    if (path === '/ranking' && req.method === 'GET') return json(await ranking(env, url.searchParams.get('period') === 'week' ? 'week' : 'all', me, url.searchParams.get('holders') === '1'), 200, cors);
    if (path === '/feedback' && req.method === 'POST') {
      const text = String(body.text || '').trim().slice(0, MAX_FEEDBACK), typed = String(body.wallet || '').trim();
      if (!text) return json({ error: 'write something first' }, 400, cors);
      if (typed && !SOLANA.test(typed)) return json({ error: 'that does not look like a Solana address' }, 400, cors);
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE player = ? AND created > ?').bind(me.id, Date.now() - 864e5).first();
      if (n.n >= FEEDBACK_PER_DAY) return json({ error: 'thanks! that is plenty for today' }, 429, cors);
      const bug = body.kind === 'bug', wallet = typed || me.wallet || null, rating = Math.round(Number(body.rating));
      const info = (bug ? 'BUG · ' : '') + String(body.info || '').slice(0, bug ? 600 : 120);   // a bug report carries the phone and game details
      const row = { player: me.id, name: me.name, tg_id: me.tg_id ?? null, wallet, wallet_ok: wallet && wallet === me.wallet ? 1 : 0, rating: rating >= 1 && rating <= 5 ? rating : null, text, info, created: Date.now() };
      await env.DB.prepare('INSERT INTO feedback (player, name, tg_id, wallet, wallet_ok, rating, text, info, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(row.player, row.name, row.tg_id, row.wallet, row.wallet_ok, row.rating, row.text, row.info, row.created).run();
      const note = tellAdmins(env, row).catch(() => { });
      if (ctx && ctx.waitUntil) ctx.waitUntil(note); else await note;
      return json({ ok: true, ...(bug ? {} : await rateReward(env, me.id, row.rating, text)) }, 200, cors);   // stars and a comment: +500 once
    }
    // every match start and end also feeds the weekly prize's match check (not for simulated players, who never take part)
    if (path === '/started' && req.method === 'POST') { if (!req.headers.has('x-sim-key')) await runStart(env, me.id, body.mode); return json(await started(env, me), 200, cors) }
    if (path === '/played' && req.method === 'POST') { if (!req.headers.has('x-sim-key')) await runEnd(env, me.id); return json(await played(env, me, String(body.mode || '').slice(0, 12), geo, body.feed), 200, cors) }
    if (path === '/rewards' && req.method === 'POST') return json({ rewards: await claim(env, me.id) }, 200, cors);
    if (path === '/invites' && req.method === 'GET') return json(await invites(env, me), 200, cors);
    if (path === '/prize' || path.startsWith('/prize/')) {                                  // the weekly prize card (see prize.js)
      if (await isSim(env, me.id)) return json({ on: false }, 200, cors);                  // never for simulated players
      const r = await prizeHandle(path, env, me, body); if (!r) return json({ error: 'not found' }, 404, cors);
      return json(r.error ? { error: r.error } : r, r.status || 200, cors);
    }
    if (path === '/share/done' && req.method === 'POST') return json(await shareDone(env, me), 200, cors);
    if (path === '/me/remind' && req.method === 'POST') return json(await setRemind(env, me, !!body.on), 200, cors);
    if (path === '/share/prepare' && req.method === 'POST') { const r = await prepareShare(env, me, body); return json(r.error ? { error: r.error } : r, r.status || 200, cors) }
    if (path === '/holder' || path.startsWith('/holder/')) {
      try { const r = await holderHandle(path, req, env, me, body); if (r) return json(r, r.error ? 400 : 200, cors) } catch (e) { return json({ error: e && e.message || 'try again later' }, 502, cors) }
    }
    if (path === '/worm' || path.startsWith('/worm/')) {                                   // custom photo worms (see worms.js)
      if (await isSim(env, me.id)) return json({ on: false }, 200, cors);
      const tell = (photo, caption) => { const t = tellAdminsPhoto(env, photo, caption).catch(() => { }); if (!ctx || !ctx.waitUntil) return t; ctx.waitUntil(t); return Promise.resolve() };
      const r = await wormHandle(path, req, env, me, body, { tier: (await badge(env, me.id)).tier, tell, origin: env.PUBLIC_URL || url.origin });
      if (r) { const { status, ...out } = r; return json(out, status || 200, cors) }
    }
    if (path === '/teams' || path.startsWith('/teams/')) {                                 // community teams (see teams.js)
      if (await isSim(env, me.id)) return json({ error: 'not for test players' }, 403, cors);
      if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'not found' }, 404, cors);
      const tell = (photo, caption) => { const t = tellAdminsPhoto(env, photo, caption).catch(() => { }); if (!ctx || !ctx.waitUntil) return t; ctx.waitUntil(t); return Promise.resolve() };
      const r = await teamHandle(path, env, me, body, { lobby: lobbyOf(env), period: url.searchParams.get('period'), post: req.method === 'POST', tell, origin: env.PUBLIC_URL || url.origin });
      if (r) { const { status, ...out } = r; return json(out, status || 200, cors) }
    }
    if (path === '/map' || path.startsWith('/map/')) { const r = await mapHandle(path, req, env, me, body, cors, ctx); if (r) return r }
    if (path === '/royale/join' && req.method === 'POST') {
      if (await isSim(env, me.id)) return json({ error: 'not for test players' }, 403, cors);
      return json(await (await lobbyOf(env).fetch('https://lobby/royale/join')).json(), 200, cors);
    }
    const rws = path.match(/^\/royale\/([A-Z2-9]{6})\/ws$/);
    if (rws) {
      const h = new Headers(req.headers); h.set('x-player', String(me.id)); h.set('x-name', encodeURIComponent(me.name)); h.set('x-country', geo);
      const hb = await badge(env, me.id); h.set('x-tier', String(hb.tier));
      h.set('x-cw', (await wormMine(env, me.id, hb.tier)) || ''); h.set('x-av', (await avatarOf(env, me.id)) || ''); h.set('x-sim', (await isSim(env, me.id)) ? '1' : '0');
      return env.ROYALE.get(env.ROYALE.idFromName(rws[1])).fetch(new Request(req.url, { headers: h }));
    }
    if (path === '/royale/ping') {                                                     // the Royale hour message from the bot (see royaleHour in growth.js)
      if (req.method === 'POST') await env.DB.prepare(body.on ? 'INSERT OR IGNORE INTO royale_ping (player, at) VALUES (?, ?)' : 'DELETE FROM royale_ping WHERE player = ? AND ? > 0').bind(me.id, Date.now()).run();
      return json({ on: !!(await env.DB.prepare('SELECT 1 AS y FROM royale_ping WHERE player = ?').bind(me.id).first()), tg: me.tg_id != null }, 200, cors);
    }
    if (path === '/match/new' && req.method === 'POST') return json({ code: newCode() }, 200, cors);
    if (path === '/match/quick' && req.method === 'POST') return json(await (await lobbyOf(env).fetch(`https://lobby/?player=${me.id}`)).json(), 200, cors);
    const ws = path.match(/^\/match\/([A-Z2-9]{6})\/ws$/);
    if (ws) {
      const h = new Headers(req.headers); h.set('x-player', String(me.id)); h.set('x-country', geo);   // country only, from Cloudflare, for the opponent's flag
      const hb = await badge(env, me.id); h.set('x-tier', String(hb.tier));                   // holder tier, for the opponent's badge
      h.set('x-cw', (await wormMine(env, me.id, hb.tier)) || '');                            // and their custom worm, while they hold
      h.set('x-av', (await avatarOf(env, me.id)) || '');                                     // the avatar they picked, for the battle's corners
      h.set('x-sim', (await isSim(env, me.id)) ? '1' : '0');                                  // a simulated player's match stays out of Live now
      return env.MATCH.get(env.MATCH.idFromName(ws[1])).fetch(new Request(req.url, { headers: h }));
    }
    return json({ error: 'not found' }, 404, cors);
  },
};
export default app;
