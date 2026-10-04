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
//   POST /telegram/webhook, /telegram/setup                     the bot's welcome message and settings (see bot.js)
//
// Signing in with a wallet never asks for a transaction. Scores are for fun: the server never sends tokens or anything
// of value.

import { verifyTelegram, verifyTelegramLogin, makeNonce, signInMessage, verifySolana, makeToken, readToken, friendCode, readFriendCode } from './auth.js';
import { Match, newCode } from './match.js';
import { Lobby } from './lobby.js';
import { webhook, setup, sync } from './bot.js';
export { Match, Lobby };

const json = (body, status = 200, cors = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } });
const MAX_FRIENDS = 200, LOGIN_CODE_MS = 10 * 60 * 1000;

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
  return json({ ...(withToken ? { token: await makeToken(p.id, env.SESSION_SECRET) } : {}), player: publicPlayer(p), friendCode: await friendCode(p.id, env.SESSION_SECRET) }, 200, cors);
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
    q('DELETE FROM players WHERE id = ?', a),
  ]);
  return playerById(env, b);
}

async function telegramUser(env, req, u, cors) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 40) || u.username || 'Worm';
  const me = await signedIn(req, env);
  let p = await env.DB.prepare('SELECT * FROM players WHERE tg_id = ?').bind(u.id).first();
  if (p) { if (p.name !== name) await env.DB.prepare('UPDATE players SET name = ? WHERE id = ?').bind(name, p.id).run(); p.name = name }
  else if (me && me.tg_id == null) { await env.DB.prepare('UPDATE players SET tg_id = ?, name = ? WHERE id = ?').bind(u.id, name, me.id).run(); p = await playerById(env, me.id) }
  else p = await env.DB.prepare('INSERT INTO players (tg_id, name, created) VALUES (?, ?, ?) RETURNING *').bind(u.id, name, Date.now()).first();
  return session(env, await link(env, me, p), cors);
}

const lobbyOf = env => env.LOBBY.get(env.LOBBY.idFromName('lobby'));

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(sync(env)) },
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, ''), cors = corsFor(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST' } });
    if (path === '/telegram/webhook' && req.method === 'POST') return webhook(req, env);
    if (path === '/telegram/setup') return setup(req, env, url.origin);
    if (path === '/online' && req.method === 'GET') return json(await (await lobbyOf(env).fetch('https://lobby/count')).json(), 200, cors);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

    if (path === '/auth/telegram' && req.method === 'POST') {
      const u = await verifyTelegram(body.initData, env.BOT_TOKEN);
      return u ? telegramUser(env, req, u, cors) : json({ error: 'telegram sign-in failed' }, 401, cors);
    }
    if (path === '/auth/telegram/web' && req.method === 'POST') {
      const u = await verifyTelegramLogin(body, env.BOT_TOKEN);
      return u ? telegramUser(env, req, u, cors) : json({ error: 'telegram sign-in failed' }, 401, cors);
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
      else if (!p) p = await env.DB.prepare('INSERT INTO players (wallet, name, created) VALUES (?, ?, ?) RETURNING *').bind(body.address, body.address.slice(0, 4) + '…' + body.address.slice(-4), Date.now()).first();
      return session(env, await link(env, me, p), cors);
    }

    if (path === '/auth/guest' && req.method === 'POST') {
      const r = await env.DB.prepare('INSERT INTO players (name, created) VALUES (?, ?) RETURNING *').bind('Guest ' + Math.floor(1000 + Math.random() * 9000), Date.now()).first();
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
      return json({ friend: { id: f.id, name: f.name, wins: f.wins, losses: f.losses } }, 200, cors);
    }
    if (path === '/friends/remove' && req.method === 'POST') {
      await env.DB.prepare('DELETE FROM friends WHERE player = ? AND friend = ?').bind(me.id, Number(body.id)).run();
      return json({ ok: true }, 200, cors);
    }

    if (path === '/lobby/ws') {
      const h = new Headers(req.headers);
      h.set('x-player', String(me.id)); h.set('x-name', encodeURIComponent(me.name)); h.set('x-wins', String(me.wins)); h.set('x-losses', String(me.losses));
      return lobbyOf(env).fetch(new Request(req.url, { headers: h }));
    }
    if (path === '/match/new' && req.method === 'POST') return json({ code: newCode() }, 200, cors);
    if (path === '/match/quick' && req.method === 'POST') return json(await (await lobbyOf(env).fetch(`https://lobby/?player=${me.id}`)).json(), 200, cors);
    const ws = path.match(/^\/match\/([A-Z2-9]{6})\/ws$/);
    if (ws) {
      const h = new Headers(req.headers); h.set('x-player', String(me.id));
      return env.MATCH.get(env.MATCH.idFromName(ws[1])).fetch(new Request(req.url, { headers: h }));
    }
    return json({ error: 'not found' }, 404, cors);
  },
};
