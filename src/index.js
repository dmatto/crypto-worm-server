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
//   POST /me/name            {name}                             -> session   pick a nickname (3-16 letters, digits, spaces, _ - .)
//   GET  /ranking?period=week|all                               -> {period, since, top: [{rank, id, name, cworm}], me, players}
//   POST /score              {amount} | {import: total}          -> {added, week, total}  play-money $CWORM a match banked
//   POST /feedback           {text, rating?, wallet?, info?}    -> {ok}   beta feedback; the bot passes it on to the admins
//   GET  /map, POST /map/join, /map/buy, /map/attack, /map/result, /map/defend, /map/upgrade   the World Map (see map.js)
//   POST /played, /rewards, /share/prepare, /me/remind           finished matches, invite rewards, share cards, reminders (see growth.js)
// The sign-in calls also take {src}: where a brand-new player came from (a link's source tag), kept on the new account.
//   POST /telegram/webhook, /telegram/setup                     the bot's welcome message and settings (see bot.js)
//
// Signing in with a wallet never asks for a transaction. Scores are for fun: the server never sends tokens or anything
// of value.

import { verifyTelegram, verifyTelegramLogin, makeNonce, signInMessage, verifySolana, makeToken, readToken, friendCode, readFriendCode } from './auth.js';
import { Match, newCode } from './match.js';
import { Lobby } from './lobby.js';
import { webhook, setup, cron, tellAdmins } from './bot.js';
import { handle as mapHandle } from './map.js';
import { weekStart, newPlayer, seen, noteInvite, played, claim, prepareShare, setRemind } from './growth.js';
export { Match, Lobby };

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
  }
  await env.DB.prepare(`INSERT INTO cworm_scores (player, total, week_start, week, day_start, day, last, imported) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player) DO UPDATE SET total = excluded.total, week_start = excluded.week_start, week = excluded.week, day_start = excluded.day_start, day = excluded.day, last = excluded.last, imported = excluded.imported`)
    .bind(me.id, s.total, s.week_start, s.week, s.day_start, s.day, s.last, s.imported).run();
  return { added: amount, s };
}
const NICK = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{1,14}[\p{L}\p{N}]$/u, RANK_TOP = 50, NICK_GAP_MS = 60 * 1000;
// A short list of words a nickname can't contain, and names that would pass for the team or the game.
const NICK_BLOCK = /(fuck|shit|bitch|cunt|nigg|fag|rape|nazi|hitler|porn|whore|slut|dick|pussy|admin|moderator|official|cryptoworm|crypto worm)/i;

// The ranking is play-money $CWORM gained: this week (from Monday 00:00 UTC) or all time. The game reports what each
// match banked; the server caps each report and each day so a tampered phone can't run away with it.
async function ranking(env, period, me) {
  const since = weekStart();
  const rows = period === 'week'
    ? (await env.DB.prepare('SELECT p.id, p.name, s.week AS cworm FROM cworm_scores s JOIN players p ON p.id = s.player WHERE s.week_start = ? AND s.week > 0 ORDER BY s.week DESC, s.last ASC').bind(since).all()).results
    : (await env.DB.prepare('SELECT p.id, p.name, s.total AS cworm FROM cworm_scores s JOIN players p ON p.id = s.player WHERE s.total > 0 ORDER BY s.total DESC, s.last ASC').all()).results;
  return { period: period === 'week' ? 'week' : 'all', since: period === 'week' ? since : null, ...place(rows, me) };
}
function place(rows, me) {
  const out = rows.map((r, i) => ({ rank: i + 1, id: r.id, name: r.name, cworm: r.cworm | 0 }));
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

const publicPlayer = p => p && { id: p.id, name: p.name, tg: p.tg_id != null, wallet: p.wallet || null, wins: p.wins, losses: p.losses };

async function playerById(env, id) { return env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(id).first() }

async function signedIn(req, env) {
  const auth = req.headers.get('Authorization') || '', token = auth.startsWith('Bearer ') ? auth.slice(7) : new URL(req.url).searchParams.get('token');
  const id = await readToken(token, env.SESSION_SECRET);
  return id ? playerById(env, id) : null;
}

async function session(env, p, cors, withToken = true) {
  const nick = await env.DB.prepare('SELECT 1 AS y FROM nicknames WHERE player = ?').bind(p.id).first();
  await seen(env, p.id); const m = await env.DB.prepare('SELECT remind FROM player_meta WHERE player = ?').bind(p.id).first();
  return json({ ...(withToken ? { token: await makeToken(p.id, env.SESSION_SECRET) } : {}), player: { ...publicPlayer(p), nick: !!nick, remind: !m || !!m.remind }, friendCode: await friendCode(p.id, env.SESSION_SECRET) }, 200, cors);
}

// Sign `me` (whoever this device was signed in as) into `target`. When the two are different accounts that don't both
// have a Telegram account or both have a wallet, `me` is folded into `target`: wins, losses, friends and match history
// move over and `me` is deleted. Otherwise the device simply switches to `target`.
async function link(env, me, target) {
  if (!me || me.id === target.id) return target;
  if ((me.tg_id != null && target.tg_id != null) || (me.wallet && target.wallet)) return target;
  const a = me.id, b = target.id, q = (s, ...v) => env.DB.prepare(s).bind(...v);
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
    q('UPDATE OR IGNORE player_meta SET player = ? WHERE player = ?', b, a), q('DELETE FROM player_meta WHERE player = ?', a),
    q('UPDATE player_meta SET invited_by = ? WHERE invited_by = ?', b, a),
    q('UPDATE land SET owner = ? WHERE owner = ?', b, a),                                // World Map land and upgrades follow the account
    q('UPDATE OR IGNORE landlords SET player = ? WHERE player = ?', b, a), q('DELETE FROM landlords WHERE player = ?', a),
    q('UPDATE attacks SET attacker = ? WHERE attacker = ?', b, a),
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

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(cron(env, event && event.scheduledTime || Date.now())) },
  async fetch(req, env, ctx) {
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, ''), cors = corsFor(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST' } });
    if (path === '/telegram/webhook' && req.method === 'POST') return webhook(req, env);
    if (path === '/telegram/setup') return setup(req, env, url.origin);
    if (path === '/online' && req.method === 'GET') return json(await (await lobbyOf(env).fetch('https://lobby/count')).json(), 200, cors);
    if (path === '/live' && req.method === 'GET') return json(await (await lobbyOf(env).fetch('https://lobby/live')).json(), 200, cors);
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
      if (!p && me && !me.wallet) { await env.DB.prepare("UPDATE players SET wallet = ?, name = CASE WHEN name LIKE 'Guest %' THEN ? ELSE name END WHERE id = ?").bind(body.address, body.address.slice(0, 4) + '…' + body.address.slice(-4), me.id).run(); p = await playerById(env, me.id) }
      else if (!p) { p = await env.DB.prepare('INSERT INTO players (wallet, name, created) VALUES (?, ?, ?) RETURNING *').bind(body.address, body.address.slice(0, 4) + '…' + body.address.slice(-4), Date.now()).first(); await newPlayer(env, p.id, body.src) }
      return session(env, await link(env, me, p), cors);
    }

    if (path === '/auth/guest' && req.method === 'POST') {
      const r = await env.DB.prepare('INSERT INTO players (name, created) VALUES (?, ?) RETURNING *').bind('Guest ' + Math.floor(1000 + Math.random() * 9000), Date.now()).first();
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
      h.set('x-country', String((req.cf && req.cf.country) || ''));
      return lobbyOf(env).fetch(new Request(req.url, { headers: h }));
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
    if (path === '/score' && req.method === 'POST') {
      const imp = body.import != null, amount = Math.floor(Number(imp ? body.import : body.amount));
      if (!(amount > 0) || amount > 1e9) return json({ error: 'bad amount' }, 400, cors);
      const r = await addScore(env, me, amount, imp);
      if (r.error) return json({ error: r.error }, r.status, cors);
      return json({ added: r.added, week: r.s.week_start === weekStart() ? r.s.week : 0, total: r.s.total }, 200, cors);
    }
    if (path === '/ranking' && req.method === 'GET') return json(await ranking(env, url.searchParams.get('period') === 'week' ? 'week' : 'all', me), 200, cors);
    if (path === '/feedback' && req.method === 'POST') {
      const text = String(body.text || '').trim().slice(0, MAX_FEEDBACK), typed = String(body.wallet || '').trim();
      if (!text) return json({ error: 'write something first' }, 400, cors);
      if (typed && !SOLANA.test(typed)) return json({ error: 'that does not look like a Solana address' }, 400, cors);
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE player = ? AND created > ?').bind(me.id, Date.now() - 864e5).first();
      if (n.n >= FEEDBACK_PER_DAY) return json({ error: 'thanks! that is plenty for today' }, 429, cors);
      const wallet = typed || me.wallet || null, rating = Math.round(Number(body.rating)), info = String(body.info || '').slice(0, 120);
      const row = { player: me.id, name: me.name, tg_id: me.tg_id ?? null, wallet, wallet_ok: wallet && wallet === me.wallet ? 1 : 0, rating: rating >= 1 && rating <= 5 ? rating : null, text, info, created: Date.now() };
      await env.DB.prepare('INSERT INTO feedback (player, name, tg_id, wallet, wallet_ok, rating, text, info, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(row.player, row.name, row.tg_id, row.wallet, row.wallet_ok, row.rating, row.text, row.info, row.created).run();
      const note = tellAdmins(env, row).catch(() => { });
      if (ctx && ctx.waitUntil) ctx.waitUntil(note); else await note;
      return json({ ok: true }, 200, cors);
    }
    if (path === '/played' && req.method === 'POST') return json(await played(env, me, String(body.mode || '').slice(0, 12), req.cf && req.cf.country), 200, cors);
    if (path === '/rewards' && req.method === 'POST') return json({ rewards: await claim(env, me.id) }, 200, cors);
    if (path === '/me/remind' && req.method === 'POST') return json(await setRemind(env, me, !!body.on), 200, cors);
    if (path === '/share/prepare' && req.method === 'POST') { const r = await prepareShare(env, me, body); return json(r.error ? { error: r.error } : r, r.status || 200, cors) }
    if (path === '/map' || path.startsWith('/map/')) { const r = await mapHandle(path, req, env, me, body, cors, ctx); if (r) return r }
    if (path === '/match/new' && req.method === 'POST') return json({ code: newCode() }, 200, cors);
    if (path === '/match/quick' && req.method === 'POST') return json(await (await lobbyOf(env).fetch(`https://lobby/?player=${me.id}`)).json(), 200, cors);
    const ws = path.match(/^\/match\/([A-Z2-9]{6})\/ws$/);
    if (ws) {
      const h = new Headers(req.headers); h.set('x-player', String(me.id)); h.set('x-country', String((req.cf && req.cf.country) || ''));   // country only, from Cloudflare, for the opponent's flag
      return env.MATCH.get(env.MATCH.idFromName(ws[1])).fetch(new Request(req.url, { headers: h }));
    }
    return json({ error: 'not found' }, 404, cors);
  },
};
