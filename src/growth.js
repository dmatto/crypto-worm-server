// Growing the game inside Telegram: where players come from, invite rewards, share cards, group duels, the weekly top 10
// and gentle bot reminders. Every reward here is play-money $CWORM for the game's own wallet: never real tokens, never
// part of the ranking or the airdrop list.
//
//   POST /played   {mode}                -> {played, rewards: [{amount, reason, note}]}   the game finished a match (any mode)
//   POST /rewards                        -> {rewards}   play money the server owes this player (invite rewards), claimed once
//   POST /share/prepare {kind, hp}       -> {id}        a prepared challenge card for Telegram.WebApp.shareMessage
//   POST /me/remind {on}                 -> {remind}    bot reminders on or off (Settings)
//
// Source tags: links like t.me/CryptoWormWarsBot/play?startapp=s_<tag> (or ?src=<tag> on the web). The game sends the tag
// when it signs in, and the first one is kept on a brand-new account. /sources (admins, in the bot) counts new players
// per tag and how many of them finished 1 and 3 matches.

import { tg } from './bot.js';
import { friendCode } from './auth.js';
import { newCode } from './match.js';

export const INVITE_REWARD = 200, INVITES_PER_DAY = 10, NEW_ACCOUNT_MS = 864e5, PLAYED_GAP_MS = 20000;
const DAY = 864e5, REMIND_GAP = 20 * 3600e3, ACTIVE_MS = 7 * DAY, RECENT_MS = 2 * 3600e3, REMIND_MAX = 100, DAILY_HOUR = 16;

// Monday 00:00 UTC of this week: the weekly ranking starts over then.
export function weekStart(now = Date.now()) { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.getTime() }
export const cleanSource = s => { s = String(s || '').trim().toLowerCase(); return /^[a-z0-9_]{1,24}$/.test(s) ? s : null };
export const flag = cc => /^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map(c => 0x1f1a5 + c.charCodeAt(0))) : '';
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const site = env => (env.SITE_URL || (env.MENU_URL || 'https://play.cryptoworm.io/')).replace(/\/+$/, '');
export const gameLink = (env, param) => { const l = env.GAME_LINK || 'https://t.me/CryptoWormWarsBot/play'; return param ? l + (l.includes('?') ? '&' : '?') + 'startapp=' + param : l };
const botName = env => ((env.GAME_LINK || '').match(/t\.me\/(\w+)/) || [])[1] || 'CryptoWormWarsBot';
const country = c => { c = String(c || '').toUpperCase(); return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null };

// A brand-new account: remember where it came from (first touch only).
export function newPlayer(env, id, src) {
  return env.DB.prepare('INSERT OR IGNORE INTO player_meta (player, source, last_seen) VALUES (?, ?, ?)').bind(id, cleanSource(src), Date.now()).run().catch(() => { });
}
export function seen(env, id, cc) {
  return env.DB.prepare('INSERT INTO player_meta (player, last_seen, cc) VALUES (?, ?, ?) ON CONFLICT(player) DO UPDATE SET last_seen = excluded.last_seen, cc = COALESCE(excluded.cc, cc)')
    .bind(id, Date.now(), country(cc)).run().catch(() => { });
}
const meta = (env, id) => env.DB.prepare('SELECT * FROM player_meta WHERE player = ?').bind(id).first();

// A friend link added `me` as someone's friend. When `me` is a brand-new account that hasn't finished a match yet, the
// friend becomes their inviter: both get the invite reward once `me` finishes a first match.
export async function noteInvite(env, me, inviter) {
  if (!me || !inviter || me.id === inviter || Date.now() - me.created > NEW_ACCOUNT_MS) return false;
  await env.DB.prepare('INSERT OR IGNORE INTO player_meta (player, last_seen) VALUES (?, ?)').bind(me.id, Date.now()).run();
  const r = await env.DB.prepare("UPDATE player_meta SET invited_by = ?, source = COALESCE(source, 'friend') WHERE player = ? AND invited_by IS NULL AND played = 0").bind(inviter, me.id).run();
  return !!(r && (r.meta ? r.meta.changes : r.changes));
}

export async function claim(env, id) {
  const { results } = await env.DB.prepare('UPDATE rewards SET claimed = ? WHERE player = ? AND claimed IS NULL RETURNING amount, reason, note').bind(Date.now(), id).all();
  return results || [];
}

async function payInvite(env, me, m) {
  const inviter = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(m.invited_by).first();
  if (!inviter) return;
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM rewards WHERE player = ? AND reason = 'invite' AND created > ?").bind(inviter.id, Date.now() - DAY).first();
  if (n.n >= INVITES_PER_DAY) { await env.DB.prepare('UPDATE player_meta SET invite_paid = 0 WHERE player = ?').bind(me.id).run(); return }
  const now = Date.now(), add = (p, reason, note) => env.DB.prepare('INSERT INTO rewards (player, amount, reason, note, created) VALUES (?, ?, ?, ?, ?)').bind(p, INVITE_REWARD, reason, note, now);
  await env.DB.batch([add(inviter.id, 'invite', me.name), add(me.id, 'invited', inviter.name),
    env.DB.prepare('UPDATE player_meta SET invite_paid = ? WHERE player = ?').bind(now, me.id)]);
  if (inviter.tg_id != null && env.BOT_TOKEN) await tg(env, 'sendMessage', { chat_id: inviter.tg_id, text:
    `🎉 ${me.name} joined Crypto Worm Wars through your invite and finished a first match!\n\n+${INVITE_REWARD} $CWORM for each of you. It lands in your game wallet next time you open the game. (Play money, not real tokens.)`,
    reply_markup: { inline_keyboard: [[{ text: '🎮 Play', url: gameLink(env) }]] } }).catch(() => { });
}

// The game finished a match. Counts it (at most one every 20 s), pays a pending invite reward on a first match, and
// hands back any rewards waiting for this player.
export async function played(env, me, mode, cc) {
  const now = Date.now(), day = Math.floor(now / DAY), daily = mode === 'daily' ? 1 : 0;
  await env.DB.prepare('INSERT OR IGNORE INTO player_meta (player, last_seen) VALUES (?, ?)').bind(me.id, now).run();
  const r = await env.DB.prepare(`UPDATE player_meta SET played = played + 1, last_played = ?, last_seen = ?, cc = COALESCE(?, cc),
      daily = MAX(daily, ?), daily_day = CASE WHEN ? = 1 THEN ? ELSE daily_day END WHERE player = ? AND last_played < ? RETURNING *`)
    .bind(now, now, country(cc), daily, daily, day, me.id, now - PLAYED_GAP_MS).first();
  const m = r || await meta(env, me.id);
  if (r && r.played === 1 && r.invited_by && r.invite_paid == null) await payInvite(env, me, r);
  return { played: m ? m.played : 0, rewards: await claim(env, me.id) };
}

export async function setRemind(env, me, on) {
  await env.DB.prepare('INSERT INTO player_meta (player, last_seen, remind) VALUES (?, ?, ?) ON CONFLICT(player) DO UPDATE SET remind = excluded.remind, no_dm = CASE WHEN excluded.remind = 1 THEN 0 ELSE no_dm END')
    .bind(me.id, Date.now(), on ? 1 : 0).run();
  return { remind: !!on };
}

// ---- share cards ----
const CARDS = { duel: 'duel.jpg', win: 'win.jpg', story: 'story.jpg' };
export const cardUrl = (env, k) => site(env) + '/cards/' + CARDS[k];
export function challengeCaption(kind, hp) {
  hp = Math.max(0, Math.min(300, Math.round(Number(hp) || 0)));
  if (kind === 'win') return `🏆 I just won a Crypto Worm Wars battle${hp ? ` with ${hp} HP left` : ''}. Think you can beat me? Tap Play and fight me! 🪱`;
  if (kind === 'loss') return '😤 I just lost a Crypto Worm Wars battle. Bet you can\'t do better. Tap Play and show me! 🪱';
  return '⚔️ Fight me in Crypto Worm Wars! Worms-style battles right here in Telegram, free, no download. Tap Play 🪱';
}
async function cardResult(env, player, kind, hp, id) {
  const code = player ? await friendCode(player.id, env.SESSION_SECRET) : null, img = cardUrl(env, kind === 'win' ? 'win' : 'duel');
  return { type: 'photo', id: id || crypto.randomUUID().slice(0, 32), photo_url: img, thumbnail_url: img, photo_width: 1280, photo_height: 720,
    title: 'Duel me', description: 'Send a challenge card with a Play button', caption: challengeCaption(kind, hp),
    reply_markup: { inline_keyboard: [[{ text: '🎮 Play', url: gameLink(env, code ? 'f_' + code : null) }]] } };
}
// The end screen's "Challenge a friend": Telegram keeps the card for us, the game opens the share dialog with its id.
export async function prepareShare(env, me, body) {
  if (me.tg_id == null) return { error: 'sign in with Telegram first', status: 400 };
  const kind = ['win', 'loss', 'duel'].includes(body.kind) ? body.kind : 'duel';
  const r = await tg(env, 'savePreparedInlineMessage', { user_id: me.tg_id, result: await cardResult(env, me, kind, body.hp),
    allow_user_chats: true, allow_bot_chats: false, allow_group_chats: true, allow_channel_chats: true });
  return r && r.ok && r.result ? { id: r.result.id } : { error: 'Telegram did not prepare the card', status: 502 };
}

// ---- inline mode: @CryptoWormWarsBot in any chat ----
export async function inlineQuery(env, q) {
  const p = await env.DB.prepare('SELECT * FROM players WHERE tg_id = ?').bind(q.from.id).first();
  const code = p ? await friendCode(p.id, env.SESSION_SECRET) : null;
  const results = [await cardResult(env, p, 'duel', 0, 'duel'),
    { type: 'article', id: 'play', title: 'Play Crypto Worm Wars', description: 'Bulls vs Bears worm battles, free in Telegram', thumbnail_url: cardUrl(env, 'win'),
      input_message_content: { message_text: '🪱 Crypto Worm Wars: Bulls vs Bears in a Worms-style battle, free right here in Telegram. Come play with me!' },
      reply_markup: { inline_keyboard: [[{ text: '🎮 Play', url: gameLink(env, code ? 'f_' + code : null) }]] } }];
  return tg(env, 'answerInlineQuery', { inline_query_id: q.id, results, cache_time: 300, is_personal: true });
}

// ---- groups ----
const fromName = f => (f && [f.first_name, f.last_name].filter(Boolean).join(' ').slice(0, 40)) || (f && f.username) || 'Someone';
export async function duel(env, m) {
  const code = newCode(), name = esc(fromName(m.from)), link = gameLink(env, 'm_' + code);
  const caption = `⚔️ <b>${name}</b> wants a duel in Crypto Worm Wars!\n\nFirst to tap <b>Fight</b> takes them on. ${name}, tap Fight too to get into your match.`;
  const reply_markup = { inline_keyboard: [[{ text: '⚔️ Fight', url: link }]] };
  const sent = await tg(env, 'sendPhoto', { chat_id: m.chat.id, photo: cardUrl(env, 'duel'), caption, parse_mode: 'HTML', reply_markup });
  if (!sent.ok) await tg(env, 'sendMessage', { chat_id: m.chat.id, text: caption, parse_mode: 'HTML', reply_markup });
}

// The top 10 of a week: weeks that already rolled over are kept in week_scores, the rest are still in cworm_scores.
export async function weekTop(env, start, n = 10) {
  const { results } = await env.DB.prepare(`SELECT x.player, SUM(x.cworm) AS cworm, p.name, m.cc FROM
      (SELECT player, cworm FROM week_scores WHERE week_start = ? UNION ALL SELECT player, week AS cworm FROM cworm_scores WHERE week_start = ? AND week > 0) x
      JOIN players p ON p.id = x.player LEFT JOIN player_meta m ON m.player = x.player GROUP BY x.player ORDER BY cworm DESC LIMIT ?`).bind(start, start, n).all();
  return results || [];
}
const MEDAL = ['🥇', '🥈', '🥉'];
export function topText(rows, title) {
  if (!rows.length) return null;
  return `🏆 <b>${title}</b>\n\n` + rows.map((r, i) => `${MEDAL[i] || (i + 1) + '.'} ${r.cc ? flag(r.cc) + ' ' : ''}${esc(r.name)}: ${(r.cworm | 0).toLocaleString('en-US')} $CWORM`).join('\n') +
    '\n\n<i>$CWORM gained in all game modes. Play money, not real tokens.</i>';
}
export async function postTop(env, chat_id, start, title, extra) {
  const text = topText(await weekTop(env, start), title);
  return tg(env, 'sendMessage', { chat_id, text: text ? text + (extra || '') : 'No scores yet this week. Be the first! 🪱', parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: '🎮 Play', url: gameLink(env) }]] } });
}
const kv = {
  get: (env, k) => env.DB.prepare('SELECT v FROM bot_kv WHERE k = ?').bind(k).first().then(r => r && r.v),
  set: (env, k, v) => env.DB.prepare('INSERT INTO bot_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v)).run(),
};
export const setGroup = (env, id) => kv.set(env, 'group', id);
// Monday from 00:05 UTC: last week's top 10 to the community group, once.
export async function weekly(env, now = Date.now()) {
  const start = weekStart(now); if (now - start < 5 * 60e3) return;
  const group = await kv.get(env, 'group'); if (!group) return;
  if (await kv.get(env, 'top_posted') === String(start)) return;
  await kv.set(env, 'top_posted', start);
  const text = topText(await weekTop(env, start - 7 * DAY), 'Top 10 of last week');
  if (text) await tg(env, 'sendMessage', { chat_id: Number(group), text: text + '\n\nA new week has started. Tap Play to climb the ranking! 🪱', parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '🎮 Play', url: gameLink(env) }]] } });
}

// ---- /sources (admins) ----
export async function sourcesText(env, now = Date.now()) {
  const wk = now - 7 * DAY;
  const { results } = await env.DB.prepare(`SELECT COALESCE(m.source, 'untagged') AS s, COUNT(*) AS n, SUM(COALESCE(m.played, 0) >= 1) AS p1, SUM(COALESCE(m.played, 0) >= 3) AS p3,
      SUM(p.created > ?) AS n7, SUM(p.created > ? AND COALESCE(m.played, 0) >= 1) AS p17, SUM(p.created > ? AND COALESCE(m.played, 0) >= 3) AS p37
      FROM players p LEFT JOIN player_meta m ON m.player = p.id GROUP BY s ORDER BY n7 DESC, n DESC LIMIT 40`).bind(wk, wk, wk).all();
  if (!results.length) return 'No players yet.';
  return '📊 <b>Where new players come from</b>\nnew players · finished 1+ · finished 3+ matches\n\n' +
    results.map(r => `<b>${esc(r.s)}</b>\n  last 7 days: ${r.n7 | 0} · ${r.p17 | 0} · ${r.p37 | 0}\n  all time: ${r.n | 0} · ${r.p1 | 0} · ${r.p3 | 0}`).join('\n') +
    '\n\n<i>"untagged" are players from before tracking started (Oct 8). Tag a link with ?startapp=s_yourtag.</i>';
}

// ---- reminders: at most one bot message a day, only for players active in the last 7 days who allowed them ----
async function send(env, row, text, link) {
  const r = await tg(env, 'sendMessage', { chat_id: row.tg_id, text: text + '\n\nTurn these off with /stop or in the game\'s Settings.',
    reply_markup: { inline_keyboard: [[{ text: '🎮 Play', url: link }]] } });
  const q = r && r.ok ? 'UPDATE player_meta SET reminded = ? WHERE player = ?' : r && r.error_code === 403 ? 'UPDATE player_meta SET no_dm = 1, reminded = ? WHERE player = ?' : null;
  if (q) await env.DB.prepare(q).bind(Date.now(), row.id).run();
  return !!(r && r.ok);
}
export async function reminders(env, now = Date.now()) {
  if (!env.BOT_TOKEN || !env.LOBBY) return 0;
  let sent = 0; const done = new Set();
  const ok = `m.remind = 1 AND m.no_dm = 0 AND p.tg_id IS NOT NULL AND m.last_seen > ${now - ACTIVE_MS} AND m.last_seen < ${now - RECENT_MS} AND m.reminded < ${now - REMIND_GAP}`;
  const ids = ((await (await env.LOBBY.get(env.LOBBY.idFromName('lobby')).fetch('https://lobby/ids')).json().catch(() => ({}))).ids || []).filter(Number.isInteger);
  const here = new Set(ids);
  for (let i = 0; i < ids.length && sent < REMIND_MAX; i += 90) {
    const part = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT p.id, p.tg_id, f.friend, (SELECT name FROM players WHERE id = f.friend) AS fname FROM friends f
        JOIN players p ON p.id = f.player JOIN player_meta m ON m.player = p.id WHERE f.friend IN (${part.map(() => '?').join(',')}) AND ${ok} LIMIT 200`).bind(...part).all();
    for (const r of results) {
      if (sent >= REMIND_MAX || done.has(r.id) || here.has(r.id)) continue; done.add(r.id);
      if (await send(env, r, `🟢 Your friend ${r.fname} is online in Crypto Worm Wars right now. Challenge them!`, gameLink(env))) sent++;
    }
  }
  if (new Date(now).getUTCHours() === DAILY_HOUR) {
    const { results } = await env.DB.prepare(`SELECT p.id, p.tg_id FROM player_meta m JOIN players p ON p.id = m.player WHERE m.daily = 1 AND m.daily_day < ? AND ${ok} LIMIT ?`)
      .bind(Math.floor(now / DAY), REMIND_MAX).all();
    for (const r of results) {
      if (sent >= REMIND_MAX || done.has(r.id)) continue; done.add(r.id);
      if (await send(env, r, '🏝️ Today\'s Daily island is ready. Same island for everyone: can you beat your best score?', gameLink(env, 'daily'))) sent++;
    }
  }
  return sent;
}
export const botUsername = botName;

// ---- update notes: the cron sends the oldest unfinished announcement to the group, then to players in batches ----
// A Worker run may make only 50 outside calls (Bot API and database together), so each run sends a small batch and saves
// its place after every message; the cron runs every minute while a note is going out.
export const ANNOUNCE_BATCH = 40;   // Telegram calls per run stay under the 50-subrequest cap; progress is saved per message, so hitting it loses nothing
export async function announce(env) {
  const a = await env.DB.prepare('SELECT * FROM announcements WHERE done = 0 ORDER BY id LIMIT 1').first();
  if (!a) return;
  const kb = { inline_keyboard: [[{ text: '🎮 Play', url: gameLink(env) }]] };
  if (!a.group_done) {
    const group = await kv.get(env, 'group');
    if (group) await tg(env, 'sendMessage', { chat_id: Number(group), text: a.text, reply_markup: kb, disable_web_page_preview: true });
    await env.DB.prepare('UPDATE announcements SET group_done = 1 WHERE id = ?').bind(a.id).run();
  }
  const { results } = await env.DB.prepare(`SELECT p.id, p.tg_id FROM players p LEFT JOIN player_meta m ON m.player = p.id
      WHERE p.tg_id IS NOT NULL AND p.id > ? AND COALESCE(m.remind, 1) = 1 AND COALESCE(m.no_dm, 0) = 0 ORDER BY p.id LIMIT ?`).bind(a.last_player, ANNOUNCE_BATCH).all();
  for (const r of results) {
    const res = await tg(env, 'sendMessage', { chat_id: r.tg_id, text: a.text + '\n\nNo more of these: /stop', reply_markup: kb, disable_web_page_preview: true });
    const ok = !!(res && res.ok);
    if (res && res.error_code === 403) await env.DB.prepare('INSERT INTO player_meta (player, last_seen, no_dm) VALUES (?, 0, 1) ON CONFLICT(player) DO UPDATE SET no_dm = 1').bind(r.id).run();
    await env.DB.prepare('UPDATE announcements SET last_player = ?, sent = sent + ? WHERE id = ?').bind(r.id, ok ? 1 : 0, a.id).run();
  }
  if (results.length < ANNOUNCE_BATCH) await env.DB.prepare('UPDATE announcements SET done = 1 WHERE id = ?').bind(a.id).run();
}
export const addAnnouncement = (env, text) => env.DB.prepare('INSERT INTO announcements (text, created) VALUES (?, ?)').bind(String(text).slice(0, 3500), Date.now()).run();
