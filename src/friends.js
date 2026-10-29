// Friends and friend requests (Damian 2026-10-22: "a simple messaging system with specific players. Must be friends: you ask to
// be friends first, then you can send direct messages"). A row in friends means "player wants friend as a friend": rows both
// ways make them friends, a row one way is a request the other player hasn't answered yet. A friend code or link adds both
// rows at once (sharing your code is the yes). Saying no drops the request and stops that player asking again for NO_DAYS.
// Removing a friend removes both rows. Requests, and a yes, reach players in the bot when they allow bot messages. Only
// friends can send each other private messages (chat.js).
//
//   GET  /friends              -> {friends: [{id, name, wins, losses, online, av?, cc?}], sent: [{id, name, wins, losses}], requests: [{id, name, wins, losses, av?, cc?, at}]}
//   POST /friends/add {code}   -> {friend, state: 'friend', invited}   both ways at once
//   POST /friends/add {id}     -> {friend, state: 'sent' | 'friend'}   a request, or a yes when they asked first
//   POST /friends/no {id}      -> {ok}                                  no to a request
//   POST /friends/remove {id}  -> {ok}                                  not friends any more, or a request taken back
import { readFriendCode } from './auth.js';
import { gameLink, noteInvite } from './growth.js';
import { tg } from './bot.js';

export const MAX_FRIENDS = 200, ASK_PER_DAY = 30, NO_DAYS = 30;
const q = (env, s, ...v) => env.DB.prepare(s).bind(...v);
const PERSON = `p.id, p.name, p.wins, p.losses, a.av, m.cc FROM players p LEFT JOIN player_avatar a ON a.player = p.id LEFT JOIN player_meta m ON m.player = p.id`;
const person = r => ({ id: r.id, name: r.name, wins: r.wins | 0, losses: r.losses | 0, ...(r.av ? { av: r.av } : {}), ...(r.cc ? { cc: r.cc } : {}) });

// 'friend', 'sent' (I asked), 'req' (they asked me) or ''
export async function friendState(env, me, id) {
  const { results } = await q(env, 'SELECT player FROM friends WHERE (player = ? AND friend = ?) OR (player = ? AND friend = ?)', me, id, id, me).all();
  const mine = results.some(r => r.player === me), theirs = results.some(r => r.player === id);
  return mine && theirs ? 'friend' : mine ? 'sent' : theirs ? 'req' : '';
}
// Incoming requests not answered yet (the dot on Friends, from the session).
export async function requestCount(env, me) {
  const r = await q(env, `SELECT COUNT(*) AS n FROM friends f WHERE f.friend = ? AND NOT EXISTS (SELECT 1 FROM friends g WHERE g.player = ? AND g.friend = f.player)
      AND f.player NOT IN (SELECT blocked FROM chat_blocks WHERE player = ?)`, me, me, me).first().catch(() => null);
  return r ? r.n | 0 : 0;
}

async function list(env, me, lobby) {
  const [fr, sent, reqs] = await Promise.all([
    q(env, `SELECT ${PERSON} JOIN friends f ON f.friend = p.id WHERE f.player = ? AND EXISTS (SELECT 1 FROM friends g WHERE g.player = p.id AND g.friend = ?) ORDER BY p.name LIMIT ?`, me.id, me.id, MAX_FRIENDS).all(),
    q(env, `SELECT p.id, p.name, p.wins, p.losses FROM friends f JOIN players p ON p.id = f.friend WHERE f.player = ? AND NOT EXISTS (SELECT 1 FROM friends g WHERE g.player = p.id AND g.friend = ?) ORDER BY f.created DESC LIMIT 50`, me.id, me.id).all(),
    q(env, `SELECT p.id, p.name, p.wins, p.losses, a.av, m.cc, f.created AS at FROM friends f JOIN players p ON p.id = f.player
        LEFT JOIN player_avatar a ON a.player = p.id LEFT JOIN player_meta m ON m.player = p.id
        WHERE f.friend = ? AND NOT EXISTS (SELECT 1 FROM friends g WHERE g.player = ? AND g.friend = p.id) AND p.id NOT IN (SELECT blocked FROM chat_blocks WHERE player = ?)
        ORDER BY f.created DESC LIMIT 50`, me.id, me.id, me.id).all()]);
  let online = new Set();
  if (fr.results.length && lobby) try { online = new Set((await (await lobby.fetch('https://lobby/online?ids=' + fr.results.map(f => f.id).join(','))).json()).online) } catch (e) { }
  return { friends: fr.results.map(f => ({ ...person(f), online: online.has(f.id) })), sent: sent.results, requests: reqs.results.map(r => ({ ...person(r), at: r.at })) };
}

async function add(env, me, body, opts, now) {
  const byCode = body.code != null, id = byCode ? await readFriendCode(body.code, env.SESSION_SECRET) : Number(body.id);
  const f = id && id !== me.id && await q(env, `SELECT ${PERSON} WHERE p.id = ?`, id).first();
  if (!f) return { error: byCode ? 'that friend code is wrong' : 'no such player', status: 404 };
  const n = await q(env, 'SELECT COUNT(*) AS n FROM friends WHERE player = ?', me.id).first();
  const was = await friendState(env, me.id, f.id);
  if (n.n >= MAX_FRIENDS && !was) return { error: 'friend list is full', status: 400 };
  const put = (a, b) => q(env, 'INSERT OR IGNORE INTO friends (player, friend, created) VALUES (?, ?, ?)', a, b, now);
  if (byCode) {
    await env.DB.batch([put(me.id, f.id), put(f.id, me.id), q(env, 'DELETE FROM friend_no WHERE (player = ? AND other = ?) OR (player = ? AND other = ?)', me.id, f.id, f.id, me.id)]);
    const invited = await noteInvite(env, me, f.id);                                       // a brand-new player who came through a friend link
    return { friend: person(f), state: 'friend', invited };
  }
  if (was === 'friend' || was === 'sent') return { friend: person(f), state: was };
  if (was === '') {                                                                         // a new request
    const [no, bl, day] = await Promise.all([q(env, 'SELECT at FROM friend_no WHERE player = ? AND other = ? AND at > ?', f.id, me.id, now - NO_DAYS * 864e5).first(),
      q(env, 'SELECT 1 AS y FROM chat_blocks WHERE player = ? AND blocked = ?', f.id, me.id).first(),
      q(env, `SELECT COUNT(*) AS n FROM friends f WHERE f.player = ? AND f.created > ? AND NOT EXISTS (SELECT 1 FROM friends g WHERE g.player = f.friend AND g.friend = f.player)`, me.id, now - 864e5).first()]);
    if (no || bl) return { error: 'they can\'t get a friend request from you right now', code: 'no', status: 403 };
    if ((day.n | 0) >= ASK_PER_DAY) return { error: 'that\'s a lot of friend requests for one day, try again tomorrow', code: 'many', status: 429 };
  }
  await put(me.id, f.id).run();
  const state = was === 'req' ? 'friend' : 'sent';
  if (was === 'req') await q(env, 'DELETE FROM friend_no WHERE player = ? AND other = ?', me.id, f.id).run();
  const t = tell(env, me, f.id, state).catch(() => { }); if (opts.wait) opts.wait(t); else await t;
  return { friend: person(f), state };
}

// The bot tells the other player about a new request, or that their request was accepted.
async function tell(env, me, to, state) {
  if (!env.BOT_TOKEN) return false;
  const p = await q(env, `SELECT p.tg_id FROM players p LEFT JOIN player_meta m ON m.player = p.id WHERE p.id = ? AND p.tg_id IS NOT NULL
      AND COALESCE(m.remind, 1) = 1 AND COALESCE(m.no_dm, 0) = 0 AND p.id NOT IN (SELECT player FROM sim_players)`, to).first();
  if (!p) return false;
  const msg = state === 'friend'
    ? { text: `🤝 ${me.name} accepted your friend request in Crypto Worm Wars. Now you can send each other messages!`, button: { text: '✉️ Send a message', url: gameLink(env, 'dm_' + me.id) } }
    : { text: `👋 ${me.name} wants to be your friend in Crypto Worm Wars. Friends can send each other messages and challenge each other.`, button: { text: '👀 See the request', url: gameLink(env, 'freq') } };
  const r = await tg(env, 'sendMessage', { chat_id: p.tg_id, text: msg.text, reply_markup: { inline_keyboard: [[msg.button]] } }).catch(() => null);
  if (r && r.error_code === 403) await q(env, 'UPDATE player_meta SET no_dm = 1 WHERE player = ?', to).run();
  return !!(r && r.ok);
}

export async function handle(path, env, me, body, opts = {}, now = Date.now()) {
  if (path === '/friends') return list(env, me, opts.lobby);
  if (!opts.post) return null;
  if (path === '/friends/add') return add(env, me, body, opts, now);
  const id = Number(body.id) || 0;
  if (path === '/friends/no') {
    await env.DB.batch([q(env, 'DELETE FROM friends WHERE player = ? AND friend = ? AND NOT EXISTS (SELECT 1 FROM friends g WHERE g.player = ? AND g.friend = ?)', id, me.id, me.id, id),
      q(env, 'INSERT INTO friend_no (player, other, at) VALUES (?, ?, ?) ON CONFLICT(player, other) DO UPDATE SET at = excluded.at', me.id, id, now)]);
    return { ok: true };
  }
  if (path === '/friends/remove') {
    await q(env, 'DELETE FROM friends WHERE (player = ? AND friend = ?) OR (player = ? AND friend = ?)', me.id, id, id, me.id).run();
    return { ok: true };
  }
  return null;
}
