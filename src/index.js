// Crypto Worm Wars match server (Cloudflare Worker).
//
//   POST /auth/telegram      {initData}                         -> {token, player}
//   POST /auth/solana/nonce  {address}                          -> {message}   the text the wallet signs
//   POST /auth/solana        {address, message, signature}      -> {token, player}   (links the wallet when signed in)
//   POST /auth/guest                                            -> {token, player}
//   GET  /me                                                    -> {player}
//   POST /match/new                                             -> {code}      challenge a friend
//   POST /match/quick                                           -> {code, side} quick match
//   GET  /match/<code>/ws?token=...                             websocket into the match
//
// Players are identified by Telegram account and/or Solana wallet. Signing in with a wallet never asks for a
// transaction. Scores are for fun: the server never sends tokens or anything of value.

import { verifyTelegram, makeNonce, signInMessage, verifySolana, makeToken, readToken } from './auth.js';
import { Match, Lobby, newCode } from './match.js';
export { Match, Lobby };

const json = (body, status = 200, cors = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } });

function corsFor(req, env) {
  const origin = req.headers.get('Origin') || '', allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(origin) || allowed.includes('*') ? { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Vary': 'Origin' } : {};
}

const publicPlayer = p => p && { id: p.id, name: p.name, tg: p.tg_id != null, wallet: p.wallet || null, wins: p.wins, losses: p.losses };

async function playerById(env, id) { return env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(id).first() }

async function signedIn(req, env) {
  const auth = req.headers.get('Authorization') || '', token = auth.startsWith('Bearer ') ? auth.slice(7) : new URL(req.url).searchParams.get('token');
  const id = await readToken(token, env.SESSION_SECRET);
  return id ? playerById(env, id) : null;
}

async function session(env, p, cors) { return json({ token: await makeToken(p.id, env.SESSION_SECRET), player: publicPlayer(p) }, 200, cors) }

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, ''), cors = corsFor(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST' } });
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

    if (path === '/auth/telegram' && req.method === 'POST') {
      const u = await verifyTelegram(body.initData, env.BOT_TOKEN);
      if (!u) return json({ error: 'telegram sign-in failed' }, 401, cors);
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 40) || u.username || 'Worm';
      const me = await signedIn(req, env);
      if (me && me.tg_id == null) await env.DB.prepare('UPDATE players SET tg_id = ?, name = ? WHERE id = ?').bind(u.id, name, me.id).run();
      else await env.DB.prepare('INSERT INTO players (tg_id, name, created) VALUES (?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name').bind(u.id, name, Date.now()).run();
      return session(env, await env.DB.prepare('SELECT * FROM players WHERE tg_id = ?').bind(u.id).first(), cors);
    }

    if (path === '/auth/solana/nonce' && req.method === 'POST') {
      if (typeof body.address !== 'string' || body.address.length > 50) return json({ error: 'bad address' }, 400, cors);
      return json({ message: signInMessage(env.SIGNIN_DOMAIN, body.address, await makeNonce(body.address, env.SESSION_SECRET)) }, 200, cors);
    }

    if (path === '/auth/solana' && req.method === 'POST') {
      if (!(await verifySolana(body, env.SIGNIN_DOMAIN, env.SESSION_SECRET))) return json({ error: 'wallet sign-in failed' }, 401, cors);
      const me = await signedIn(req, env), owner = await env.DB.prepare('SELECT * FROM players WHERE wallet = ?').bind(body.address).first();
      if (me && !owner) { await env.DB.prepare('UPDATE players SET wallet = ? WHERE id = ?').bind(body.address, me.id).run(); return session(env, await playerById(env, me.id), cors) }
      if (owner) return session(env, owner, cors);
      const r = await env.DB.prepare('INSERT INTO players (wallet, name, created) VALUES (?, ?, ?) RETURNING *').bind(body.address, body.address.slice(0, 4) + '…' + body.address.slice(-4), Date.now()).first();
      return session(env, r, cors);
    }

    if (path === '/auth/guest' && req.method === 'POST') {
      const r = await env.DB.prepare('INSERT INTO players (name, created) VALUES (?, ?) RETURNING *').bind('Guest ' + Math.floor(1000 + Math.random() * 9000), Date.now()).first();
      return session(env, r, cors);
    }

    const me = await signedIn(req, env);
    if (path === '/me') return me ? json({ player: publicPlayer(me) }, 200, cors) : json({ error: 'sign in first' }, 401, cors);
    if (!me) return json({ error: 'sign in first' }, 401, cors);

    if (path === '/match/new' && req.method === 'POST') return json({ code: newCode() }, 200, cors);
    if (path === '/match/quick' && req.method === 'POST') {
      const lobby = env.LOBBY.get(env.LOBBY.idFromName('lobby'));
      return json(await (await lobby.fetch(`https://lobby/?player=${me.id}`)).json(), 200, cors);
    }
    const ws = path.match(/^\/match\/([A-Z2-9]{6})\/ws$/);
    if (ws) {
      const h = new Headers(req.headers); h.set('x-player', String(me.id));
      return env.MATCH.get(env.MATCH.idFromName(ws[1])).fetch(new Request(req.url, { headers: h }));
    }
    return json({ error: 'not found' }, 404, cors);
  },
};
