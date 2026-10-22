// World and Team chat (Damian 2026-10-22: "improve communication between players within the game to generate community
// interactions"; he chose typed chat with a filter over ready-made lines). One World room for everyone and one room per
// community team. Anyone signed in can read; writing takes CHAT_PLAYED finished matches, which keeps throwaway spam accounts
// out. Every message goes through the same checks: length, pace, no repeats, no links, wallet addresses or contact details
// (crypto chat's usual scams), a short list of slurs, then Grok, which judges the rest (PG-13, any language, trash talk about
// the game is fine). Two reports from different players, or one from an admin, hide a message, and the admins get every first
// report in the bot with /chatdel and /chatmute. Blocking a player hides their messages for you. Load-test bots never chat.
//
//   GET  /chat?room=w|t&after=<id>  -> {room, msgs: [{id, at, text, p: {id, name, av?, cc?, team?}}], can, why?, left?, until?, team?}
//                                      the latest MAX_LOAD messages, or the ones after <id>; reading the Team room marks it read
//   POST /chat/send {room, text}     -> {msg} or {error, code: played|muted|team|empty|long|slow|repeat|link|rude}
//   POST /chat/report {id}           -> {ok, hidden}
//   POST /chat/block {id, on}        -> {ok, blocked: [ids]}
//   GET  /chat/blocks                -> {blocked: [{id, name}]}
//   GET  /chat/player?id=            -> a player's card: {id, name, av?, cc?, team?, wins, losses, played, since, friend, blocked, invite, online?}
import { xai } from './worms.js';
import { teamOf } from './teams.js';
import { gameLink } from './growth.js';
import { tg, adminTgIds } from './bot.js';

export const CHAT_PLAYED = 3, MAX_LEN = 160, MAX_LOAD = 50, GAP_MS = 5000, PER_10MIN = 15, PER_DAY = 150, HIDE_REPORTS = 2;
export const KEEP_WORLD = 7 * 864e5, KEEP_TEAM = 30 * 864e5, TEAM_DM_GAP = 12 * 3600e3, TEAM_DM_MAX = 25;
const MODEL = 'grok-4.20-0309-non-reasoning';
const q = (env, s, ...v) => env.DB.prepare(s).bind(...v);

// Things Grok never has to see: links and handles of other places, wallet addresses, seed phrases, phone numbers, e-mails.
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|io|net|org|xyz|app|gg|me|co|fun|finance|link|site|online|club|pro|ly|to|ru|cn|tk|ws)\b|t\.me\b|telegram\.me|discord\.(gg|com)|wa\.me|@[a-z0-9_]{4,})/i;
const WALLET = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b|\b0x[0-9a-f]{20,}\b|\b(seed|secret|recovery)\s*(phrase|words?)\b/i;
const CONTACT = /[\w.+-]+@[\w-]+\.[a-z]{2,}|(\+?\d[\d\s().-]{7,}\d)|\b(dm|pm|inbox|message|text|whats ?app|signal)\s+me\b/i;
const SLURS = /(nigg|f[a@]gg?ot|\bfag\b|retard|\bkike\b|\bspic\b|\bchink\b|tranny|\bcunt\b|\brape|hitler|\bnazi|kill yourself|\bkys\b)/i;
const RULES = 'You moderate one chat message in Crypto Worm Wars, a PG-13 worm battle game with players from many countries. ' +
  'Answer with JSON only: {"ok":true|false,"why":"<2 to 4 words>"}. Say ok:false for: insults about race, religion, gender, sexuality, ' +
  'nationality or disability; sexual content; threats, or pushing self-harm; bullying or harassing a player; personal details (phone, ' +
  'address, e-mail, social media handles, other people\'s real names); asking people to DM, add or contact them outside the game; links, or ' +
  'promoting other coins, tokens, projects, groups or channels; scams, giveaways, airdrops, begging for crypto, wallet or seed phrase ' +
  'requests; drugs; spam or keyboard mashing. Say ok:true for normal chat in any language, friendly trash talk about the game (rekt, noob, ' +
  'gg, ngmi, cope, skill issue), crypto slang and jokes, mild words like damn or hell, emojis, and talk about $CWORM and Crypto Worm.';

export const clean = s => String(s || '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
  .replace(/\s+/g, ' ').trim();
// The quick checks. Returns the error code or ''.
export function precheck(text) {
  if (LINK.test(text) || WALLET.test(text) || CONTACT.test(text)) return 'link';
  const leet = text.toLowerCase().replace(/[4@]/g, 'a').replace(/3/g, 'e').replace(/[1!]/g, 'i').replace(/0/g, 'o').replace(/\$/g, 's');
  if (SLURS.test(text) || SLURS.test(leet) || SLURS.test(leet.replace(/[\s_.*\-]/g, ''))) return 'rude';
  return '';
}
// Grok's call on everything else. If Grok can't answer in time the message goes through (the quick checks already ran,
// and players can still report it).
async function grokOk(env, text) {
  if (!env.XAI_API_KEY) return true;
  try {
    const d = await Promise.race([xai(env, 'chat/completions', { model: MODEL, temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: RULES }, { role: 'user', content: text }] }), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 6000))]);
    const v = JSON.parse(d.choices[0].message.content);
    return v.ok !== false;
  } catch (e) { return true }
}

const ERR = {
  played: n => `finish ${n} more ${n === 1 ? 'match' : 'matches'} to chat`, muted: () => 'you can\'t chat for a while', team: () => 'join a team to use Team chat',
  empty: () => 'write something first', long: () => `keep it under ${MAX_LEN} characters`, slow: () => 'slow down a little',
  repeat: () => 'you just sent that', link: () => 'no links, wallet addresses or contact details in chat', rude: () => 'that message isn\'t allowed here',
};
const fail = (code, status = 400, n) => ({ error: ERR[code](n), code, status });

async function standing(env, me, now) {
  const [m, mute] = await Promise.all([q(env, 'SELECT played FROM player_meta WHERE player = ?', me.id).first(),
    q(env, 'SELECT until FROM chat_mutes WHERE player = ? AND until > ?', me.id, now).first()]);
  const left = Math.max(0, CHAT_PLAYED - (m && m.played | 0));
  return mute ? { can: false, why: 'muted', until: mute.until } : left ? { can: false, why: 'played', left } : { can: true };
}
async function roomOf(env, me, room) {
  if (room === 'w') return { key: 'w' };
  const t = await teamOf(env, me.id); if (!t) return null;
  return { key: 't' + t.id, team: { id: t.id, name: t.name, tag: t.tag, emoji: t.emoji } };
}
const row = r => ({ id: r.id, at: r.at, text: r.text, p: { id: r.player, name: r.name, ...(r.av ? { av: r.av } : {}), ...(r.cc ? { cc: r.cc } : {}),
  ...(r.tag ? { team: { tag: r.tag, emoji: r.emoji } } : {}) } });
const SELECT = `SELECT c.id, c.at, c.text, c.player, p.name, a.av, m.cc, t.tag, t.emoji FROM chat c JOIN players p ON p.id = c.player
  LEFT JOIN player_avatar a ON a.player = c.player LEFT JOIN player_meta m ON m.player = c.player
  LEFT JOIN team_members tm ON tm.player = c.player LEFT JOIN teams t ON t.id = tm.team`;

async function load(env, me, roomName, after, now) {
  const room = await roomOf(env, me, roomName);
  if (!room) return { room: 't', none: true, msgs: [], ...(await standing(env, me, now)) };
  const { results } = await q(env, `${SELECT} WHERE c.room = ? AND c.hidden = 0 AND c.id > ? AND c.player NOT IN (SELECT blocked FROM chat_blocks WHERE player = ?)
      ORDER BY c.id DESC LIMIT ?`, room.key, after, me.id, MAX_LOAD).all();
  const msgs = results.reverse().map(row);
  if (room.team) await q(env, `INSERT INTO chat_seen (player, room, last, seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(player, room) DO UPDATE SET last = MAX(last, excluded.last), seen_at = excluded.seen_at`, me.id, room.key, msgs.length ? msgs[msgs.length - 1].id : 0, now).run();
  return { room: roomName, msgs, ...(room.team ? { team: room.team } : {}), ...(await standing(env, me, now)) };
}

async function send(env, me, body, opts, now) {
  const st = await standing(env, me, now);
  if (!st.can) return st.why === 'muted' ? { ...fail('muted', 403), until: st.until } : fail('played', 403, st.left);
  const room = await roomOf(env, me, body.room === 't' ? 't' : 'w'); if (!room) return fail('team', 403);
  const text = clean(body.text);
  if (!text) return fail('empty'); if ([...text].length > MAX_LEN) return fail('long');
  const r = await q(env, `SELECT MAX(at) AS last, SUM(at > ?) AS ten, COUNT(*) AS day, (SELECT text FROM chat WHERE player = ? ORDER BY id DESC LIMIT 1) AS prev
      FROM chat WHERE player = ? AND at > ?`, now - 600e3, me.id, me.id, now - 864e5).first();
  if (r && (now - (r.last || 0) < GAP_MS || (r.ten | 0) >= PER_10MIN || (r.day | 0) >= PER_DAY)) return fail('slow', 429);
  if (r && r.prev && r.prev.toLowerCase() === text.toLowerCase() && now - (r.last || 0) < 120e3) return fail('repeat');
  const pre = precheck(text); if (pre) return fail(pre);
  if (!await grokOk(env, text)) return fail('rude');
  const ins = await q(env, 'INSERT INTO chat (room, player, text, at) VALUES (?, ?, ?, ?) RETURNING id', room.key, me.id, text, now).first();
  const msg = (await q(env, `${SELECT} WHERE c.id = ?`, ins.id).first());
  if (room.team) {
    await q(env, `INSERT INTO chat_seen (player, room, last, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(player, room) DO UPDATE SET last = MAX(last, excluded.last), seen_at = excluded.seen_at`, me.id, room.key, ins.id, now).run();
    const dm = teamDm(env, me, room, text, now).catch(() => { });
    if (opts.wait) opts.wait(dm); else await dm;
  }
  return { msg: row(msg) };
}

// A team message reaches the members who haven't looked at Team chat lately, in the bot: at most once every TEAM_DM_GAP each,
// only to players who allow bot messages.
async function teamDm(env, me, room, text, now) {
  if (!env.BOT_TOKEN) return 0;
  const { results } = await q(env, `SELECT p.id, p.tg_id FROM team_members tm JOIN players p ON p.id = tm.player LEFT JOIN player_meta m ON m.player = p.id
      LEFT JOIN chat_seen s ON s.player = p.id AND s.room = ?
      WHERE tm.team = ? AND p.id != ? AND p.tg_id IS NOT NULL AND COALESCE(m.remind, 1) = 1 AND COALESCE(m.no_dm, 0) = 0
        AND p.id NOT IN (SELECT player FROM sim_players) AND COALESCE(s.seen_at, 0) < ? AND COALESCE(s.dm, 0) < ? LIMIT ?`,
    room.key, room.team.id, me.id, now - 1800e3, now - TEAM_DM_GAP, TEAM_DM_MAX).all();
  let sent = 0;
  for (const p of results) {
    const r = await tg(env, 'sendMessage', { chat_id: p.tg_id, text: `💬 ${me.name} in ${room.team.emoji} ${room.team.name}: ${text}`,
      reply_markup: { inline_keyboard: [[{ text: '💬 Open team chat', url: gameLink(env, 'chat_t') }]] } }).catch(() => null);
    await q(env, `INSERT INTO chat_seen (player, room, last, dm) VALUES (?, ?, 0, ?) ON CONFLICT(player, room) DO UPDATE SET dm = excluded.dm`, p.id, room.key, now).run();
    if (r && r.ok) sent++; else if (r && r.error_code === 403) await q(env, 'UPDATE player_meta SET no_dm = 1 WHERE player = ?', p.id).run();
  }
  return sent;
}

async function report(env, me, body, opts, now) {
  const m = await q(env, `${SELECT} WHERE c.id = ?`, Number(body.id) || 0).first();
  if (!m) return { error: 'that message is gone', status: 404 };
  if (m.player === me.id) return { ok: true, hidden: false };
  const ins = await q(env, 'INSERT OR IGNORE INTO chat_reports (msg, player, at) VALUES (?, ?, ?)', m.id, me.id, now).run(), fresh = (ins.meta || ins).changes !== 0;
  const n = await q(env, 'SELECT COUNT(*) AS n FROM chat_reports WHERE msg = ?', m.id).first();
  const admin = me.tg_id != null && (await adminTgIds(env)).includes(me.tg_id);
  const hide = admin || (n.n | 0) >= HIDE_REPORTS;
  if (hide) await q(env, 'UPDATE chat SET hidden = 1 WHERE id = ?', m.id).run();
  if ((n.n | 0) === 1 && !admin && fresh) {
    const t = tellReport(env, m, me).catch(() => { }); if (opts.wait) opts.wait(t); else await t;
  }
  return { ok: true, hidden: hide };
}
async function tellReport(env, m, me) {
  if (!env.BOT_TOKEN) return;
  const where = m.room === 'w' ? 'World chat' : 'Team chat';
  const text = `🚩 Chat report in ${where}\n${m.name} (player ${m.player}): "${m.text}"\nReported by ${me.name} (player ${me.id}).\n\n` +
    `/chatdel ${m.id} hides the message\n/chatmute ${m.player} 24 mutes the player for 24 hours (0 lifts it)`;
  for (const chat_id of await adminTgIds(env)) await tg(env, 'sendMessage', { chat_id, text });
}

async function block(env, me, body) {
  const id = Number(body.id) || 0; if (!id || id === me.id) return { error: 'pick a player', status: 400 };
  if (body.on === false) await q(env, 'DELETE FROM chat_blocks WHERE player = ? AND blocked = ?', me.id, id).run();
  else await q(env, 'INSERT OR IGNORE INTO chat_blocks (player, blocked, at) VALUES (?, ?, ?)', me.id, id, Date.now()).run();
  const { results } = await q(env, 'SELECT blocked FROM chat_blocks WHERE player = ?', me.id).all();
  return { ok: true, blocked: results.map(r => r.blocked) };
}

async function card(env, me, id, opts) {
  const p = await q(env, `SELECT p.id, p.name, p.wins, p.losses, p.created, a.av, m.cc, m.played FROM players p LEFT JOIN player_avatar a ON a.player = p.id
      LEFT JOIN player_meta m ON m.player = p.id WHERE p.id = ?`, id).first();
  if (!p) return { error: 'no such player', status: 404 };
  const [t, mine, fr, bl, sim] = await Promise.all([teamOf(env, id), teamOf(env, me.id), q(env, 'SELECT 1 AS y FROM friends WHERE player = ? AND friend = ?', me.id, id).first(),
    q(env, 'SELECT 1 AS y FROM chat_blocks WHERE player = ? AND blocked = ?', me.id, id).first(), q(env, 'SELECT 1 AS y FROM sim_players WHERE player = ?', id).first().catch(() => null)]);
  let online = false;
  if (opts.lobby) try { online = ((await (await opts.lobby.fetch('https://lobby/online?ids=' + id)).json()).online || []).includes(id) } catch (e) { }
  return { id: p.id, name: p.name, wins: p.wins | 0, losses: p.losses | 0, played: p.played | 0, since: p.created, ...(p.av ? { av: p.av } : {}), ...(p.cc ? { cc: p.cc } : {}),
    ...(t ? { team: { id: t.id, name: t.name, tag: t.tag, emoji: t.emoji } } : {}), friend: !!fr, blocked: !!bl, me: id === me.id,
    invite: !!mine && !t && !sim && id !== me.id, online };
}

export async function handle(path, env, me, body, opts = {}, now = Date.now()) {
  if (path === '/chat') return load(env, me, opts.room === 't' ? 't' : 'w', Math.max(0, Number(opts.after) || 0), now);
  if (path === '/chat/player') return card(env, me, Number(opts.id) || 0, opts);
  if (path === '/chat/blocks') {
    const { results } = await q(env, 'SELECT p.id, p.name FROM chat_blocks b JOIN players p ON p.id = b.blocked WHERE b.player = ? ORDER BY b.at DESC LIMIT 200', me.id).all();
    return { blocked: results };
  }
  if (!opts.post) return null;
  if (path === '/chat/send') return send(env, me, body, opts, now);
  if (path === '/chat/report') return report(env, me, body, opts, now);
  if (path === '/chat/block') return block(env, me, body);
  return null;
}

// Team messages from others this player hasn't read (the dot on Friends, from the session).
export async function teamUnread(env, player, team) {
  if (!team) return 0;
  const r = await q(env, `SELECT COUNT(*) AS n FROM (SELECT 1 FROM chat WHERE room = ? AND hidden = 0 AND player != ?
      AND id > COALESCE((SELECT last FROM chat_seen WHERE player = ? AND room = ?), 0) LIMIT 99)`, 't' + team, player, player, 't' + team).first().catch(() => null);
  return r ? r.n | 0 : 0;
}

// Admins in the bot: /chatdel <message id>, /chatmute <player id> [hours] (0 lifts it).
export async function chatAdmin(env, cmd, arg, now = Date.now()) {
  const [a, b] = String(arg || '').trim().split(/\s+/), id = Number(a) || 0;
  if (!id) return cmd === '/chatdel' ? 'Use /chatdel <message id>' : 'Use /chatmute <player id> <hours> (0 lifts it)';
  if (cmd === '/chatdel') {
    const r = await q(env, 'UPDATE chat SET hidden = 1 WHERE id = ? RETURNING player, text', id).first();
    return r ? `🗑 Message ${id} hidden: "${r.text}"` : 'No such message.';
  }
  const p = await q(env, 'SELECT name FROM players WHERE id = ?', id).first(); if (!p) return 'No such player.';
  const h = b == null || b === '' ? 24 : Math.max(0, Math.min(24 * 365, Number(b) || 0));
  if (!h) { await q(env, 'DELETE FROM chat_mutes WHERE player = ?', id).run(); return `🔊 ${p.name} can chat again.` }
  await q(env, 'INSERT INTO chat_mutes (player, until, why) VALUES (?, ?, ?) ON CONFLICT(player) DO UPDATE SET until = excluded.until', id, now + h * 3600e3, 'admin').run();
  await q(env, 'UPDATE chat SET hidden = 1 WHERE player = ? AND at > ?', id, now - 864e5).run();
  return `🔇 ${p.name} can't chat for ${h} hours. Their messages from the last day are hidden.`;
}

export async function chatCleanup(env, now = Date.now()) {
  await env.DB.batch([q(env, "DELETE FROM chat WHERE room = 'w' AND at < ?", now - KEEP_WORLD), q(env, "DELETE FROM chat WHERE room != 'w' AND at < ?", now - KEEP_TEAM),
    q(env, 'DELETE FROM chat_reports WHERE at < ?', now - KEEP_TEAM), q(env, 'DELETE FROM chat_mutes WHERE until < ?', now)]);
}
