// Community teams (Damian 2026-10-20: "Allow players to build teams to fight ... so one community can fight others in
// points or even a battle"). A team has a name, a short tag, an emoji, an invite code and maybe its Telegram group. Up to
// 50 members; anyone can join, the leader can remove members. Team War: every play-money $CWORM a member banks (the same
// capped amounts as the ranking, see addScore in index.js) scores for the team, and beating a rival team's member online
// (a finished 1v1 or winning an online Worm Royale against them) adds CLASH points. A weekly Teams ranking; the bot posts
// last week's top 3 teams on Mondays. Everything here is play money and bragging rights: no real prize.
//
//   GET  /teams?period=week|all       -> {period, since, top: [{rank, id, name, tag, emoji, members, pts}], mine, can, wait}
//   GET  /teams/<id>                  -> {team: {..., rank, pts, code?}, members: [{id, name, av, role, pts, online?}], mine}
//   GET  /teams/code/<code>           -> the same, for an invite link (startapp=t_<code>)
//   POST /teams/create {name, tag, emoji, tg?}  -> the new team (as /teams/<id>)
//   POST /teams/join   {id} | {code}  -> the team
//   POST /teams/leave                 -> {ok}   the leader's place goes to the longest member; an empty team is deleted
//   POST /teams/kick   {id}           -> the team   (leader)
//   POST /teams/edit   {emoji?, tg?}  -> the team   (leader)
//   POST /teams/logo   {img}          -> the team   (leader) the team's own picture: a 256 px JPEG data URL from the game, checked by
//                                      Grok first; {img: null} takes it off. Turned down: {error, code: 'logo'}
//   GET  /teams/logo/<id>.jpg         the picture (no sign-in: the ids are random); `logo` on teams is its id
//   GET  /teams/suggest?q=            -> {players: [{id, name, av?, why, online?, invited?}]}  who a member could invite: friends,
//                                      players online now and players active this week who have no team (or a name search)
//   POST /teams/invite {id}           -> {ok, name, dm}  a member invites a player who has no team (dm: the bot told them too)
//   POST /teams/invites/join {id}     -> the team      the invited player says yes (the same checks as /teams/join)
//   POST /teams/invites/no {id}       -> {ok, invites} ... or no thanks
//   GET /teams also carries `invites`: [{id, at, from, team: {id, name, tag, emoji, logo?, members}}] waiting for this player
// Points a member earned stay with the team they earned them for.

import { newCode } from './match.js';
import { weekStart, gameLink } from './growth.js';
import { xai, VISION_MODEL } from './worms.js';
import { tg } from './bot.js';

export const LOGO_TRIES = 5, MAX_LOGO = 200_000;   // uploads a team can try a UTC day, and the biggest data URL taken
export const MAX_MEMBERS = 50, CREATE_PLAYED = 3, REJOIN_MS = 12 * 3600e3, CLASH = 100, CLASH_DAY = 5, TOP = 50;
export const EMOJI = ['🪱', '🐸', '🐶', '🐱', '🦊', '🐻', '🐼', '🦁', '🐯', '🐺', '🦈', '🐋', '🐙', '🦄', '🐲', '🦅', '🔥', '⚡', '🌙', '🚀', '💎', '👑', '⚔️', '🍀'];
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.\-'&!]{1,18}[\p{L}\p{N}!.]$/u, TAG = /^[A-Z0-9]{2,5}$/;
const BLOCK = /(fuck|shit|bitch|cunt|nigg|fag|rape|nazi|hitler|porn|whore|slut|dick|pussy|admin|moderator|official|cryptoworm|crypto worm|cwormteam|support)/i;
const DAY = 864e5;
// Load-test bots (sim_players) can be in teams so the Teams chart isn't empty, but they score only SIM_SHARE of their play
// money and never get rival-win points, so a few active real players can always catch a bot team.
export const SIM_SHARE = 0.2;
const isSim = (env, id) => q(env, 'SELECT 1 AS y FROM sim_players WHERE player = ?', id).first().then(r => !!r).catch(() => false);
const q = (env, s, ...v) => env.DB.prepare(s).bind(...v);

// a Telegram group link: t.me/name, @name or a t.me/+invite link, kept as https://t.me/...
export function cleanTg(s) {
  s = String(s || '').trim(); if (!s) return '';
  let m = s.match(/^@([A-Za-z0-9_]{5,32})$/) || s.match(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(\+?[A-Za-z0-9_\-]{5,40})\/?$/);
  return m ? 'https://t.me/' + m[1] : null;
}
const bad = s => BLOCK.test(s) || BLOCK.test(s.replace(/[\s_.\-'&!]/g, ''));

export async function teamOf(env, player) {
  return q(env, 'SELECT t.id, t.name, t.tag, t.emoji, m.role, l.id AS logo FROM team_members m JOIN teams t ON t.id = m.team LEFT JOIN team_logos l ON l.team = t.id WHERE m.player = ?', player).first().catch(() => null);
}

// The weekly (or all time) table: every team, ranked by the points its members earned for it.
async function table(env, period, now = Date.now()) {
  const wk = weekStart(now), week = period !== 'all';
  const { results } = await q(env, `SELECT t.id, t.name, t.tag, t.emoji, t.created, (SELECT l.id FROM team_logos l WHERE l.team = t.id) AS logo,
      (SELECT COUNT(*) FROM team_members m WHERE m.team = t.id) AS members,
      COALESCE((SELECT SUM(p.pts) FROM team_points p WHERE p.team = t.id ${week ? 'AND p.week_start = ?' : ''}), 0) AS pts
      FROM teams t ORDER BY pts DESC, t.created ASC`, ...(week ? [wk] : [])).all();
  return results.map((r, i) => ({ rank: i + 1, id: r.id, name: r.name, tag: r.tag, emoji: r.emoji, ...(r.logo ? { logo: r.logo } : {}), members: r.members, pts: r.pts | 0 }));
}

async function detail(env, id, me, opts = {}, now = Date.now()) {
  const t = await q(env, 'SELECT * FROM teams WHERE id = ?', id).first(); if (!t) return { error: 'no such team', status: 404 };
  const wk = weekStart(now), rows = await table(env, 'week', now), row = rows.find(r => r.id === t.id) || { rank: rows.length + 1, pts: 0, members: 0 };
  const all = await q(env, 'SELECT COALESCE(SUM(pts), 0) AS n FROM team_points WHERE team = ?', t.id).first();
  const { results } = await q(env, `SELECT p.id, p.name, a.av, m.role, m.joined, COALESCE(tp.pts, 0) AS pts FROM team_members m JOIN players p ON p.id = m.player
      LEFT JOIN team_points tp ON tp.team = m.team AND tp.player = m.player AND tp.week_start = ? LEFT JOIN player_avatar a ON a.player = p.id
      WHERE m.team = ? ORDER BY pts DESC, m.joined ASC`, wk, t.id).all();
  const mine = !!me && results.some(r => r.id === me.id);
  let online = new Set();
  if (mine && opts.lobby && results.length) try { online = new Set((await (await opts.lobby.fetch('https://lobby/online?ids=' + results.map(r => r.id).join(','))).json()).online) } catch (e) { }
  const logo = await q(env, 'SELECT id FROM team_logos WHERE team = ?', t.id).first();
  return { team: { id: t.id, name: t.name, tag: t.tag, emoji: t.emoji, ...(logo ? { logo: logo.id } : {}), tg: t.tg || '', owner: t.owner, created: t.created, members: results.length, rank: row.rank, pts: row.pts, ptsAll: all ? all.n | 0 : 0,
      ...(mine ? { code: t.code, link: gameLink(opts.env || env, 't_' + t.code) } : {}) },
    members: results.map(r => ({ id: r.id, name: r.name, ...(r.av ? { av: r.av } : {}), role: r.role, pts: r.pts | 0, ...(mine ? { online: online.has(r.id) } : {}) })), mine };
}

async function canCreate(env, me) {
  const m = await q(env, 'SELECT played FROM player_meta WHERE player = ?', me.id).first();
  return (m && m.played | 0) >= CREATE_PLAYED;
}
async function waitFor(env, me, now) {
  const l = await q(env, 'SELECT left_at FROM team_leave WHERE player = ?', me.id).first();
  return l && now - l.left_at < REJOIN_MS ? l.left_at + REJOIN_MS : 0;
}

export async function handle(path, env, me, body, opts = {}, now = Date.now()) {
  const sub = path.slice('/teams'.length);
  if (sub === '' || sub === '/') {
    const period = opts.period === 'all' ? 'all' : 'week', rows = await table(env, period, now), mine = await teamOf(env, me.id);
    return { period, since: period === 'week' ? weekStart(now) : null, top: rows.slice(0, TOP), players: rows.length,
      mine: mine ? { ...mine, ...(rows.find(r => r.id === mine.id) || {}) } : null, can: !mine && await canCreate(env, me), wait: mine ? 0 : await waitFor(env, me, now),
      invites: await myInvites(env, me, now) };
  }
  if (sub === '/suggest') return suggest(env, me, opts, now);
  const one = sub.match(/^\/(\d+)$/);
  if (one) return detail(env, Number(one[1]), me, opts, now);
  const byCode = sub.match(/^\/code\/([A-Za-z0-9]{4,8})$/);                    // an invite link's team, before joining it
  if (byCode) { const t = await q(env, 'SELECT id FROM teams WHERE code = ?', byCode[1].toUpperCase()).first(); return t ? detail(env, t.id, me, opts, now) : { error: 'that team does not exist any more', status: 404 } }
  if (opts.post === false) return null;                                     // the rest change things: POST only
  if (sub === '/invite') return invite(env, me, body, opts, now);
  if (sub === '/invites/join' || sub === '/invites/no') {
    const i = await q(env, 'SELECT id, team FROM team_invites WHERE id = ? AND player = ? AND state = 0', Number(body.id) || 0, me.id).first();
    if (!i) return { error: 'that invitation is gone', status: 404 };
    if (sub === '/invites/no') { await q(env, 'UPDATE team_invites SET state = 2 WHERE id = ?', i.id).run(); return { ok: true, invites: await myInvites(env, me, now) } }
    return handle('/teams/join', env, me, { id: i.team }, opts, now);
  }
  if (sub === '/create') {
    if (await teamOf(env, me.id)) return { error: 'leave your team first', status: 400 };
    if (!await canCreate(env, me)) return { error: `finish ${CREATE_PLAYED} matches first, then you can start a team`, status: 403 };
    const w = await waitFor(env, me, now); if (w) return { error: 'you left a team a moment ago: try again later', status: 429, wait: w };
    const name = String(body.name || '').normalize('NFC').replace(/\s+/g, ' ').trim(), tag = String(body.tag || '').trim().toUpperCase(), emoji = String(body.emoji || '');
    if (!NAME.test(name)) return { error: 'team name: 3 to 20 letters or numbers', status: 400 };
    if (!TAG.test(tag)) return { error: 'tag: 2 to 5 letters or numbers', status: 400 };
    if (bad(name) || bad(tag)) return { error: 'pick a different name', status: 400 };
    if (!EMOJI.includes(emoji)) return { error: 'pick one of the emoji', status: 400 };
    const tgl = cleanTg(body.tg); if (tgl === null) return { error: 'the Telegram link should look like t.me/yourgroup', status: 400 };
    if (await q(env, 'SELECT 1 AS y FROM teams WHERE name = ? COLLATE NOCASE OR tag = ?', name, tag).first()) return { error: 'that name or tag is taken', status: 409 };
    const made = await q(env, 'SELECT COUNT(*) AS n FROM teams WHERE owner = ? AND created > ?', me.id, now - DAY).first();
    if (made && made.n >= 1) return { error: 'one new team a day', status: 429 };
    const t = await q(env, 'INSERT INTO teams (name, tag, emoji, tg, owner, code, created) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id', name, tag, emoji, tgl, me.id, newCode(), now).first();
    await env.DB.batch([q(env, "INSERT INTO team_members (player, team, role, joined) VALUES (?, ?, 'lead', ?)", me.id, t.id, now), closeInvites(env, me.id, 0)]);
    return detail(env, t.id, me, opts, now);
  }
  if (sub === '/join') {
    if (await teamOf(env, me.id)) return { error: 'leave your team first', status: 400 };
    const t = body.code ? await q(env, 'SELECT id FROM teams WHERE code = ?', String(body.code).trim().toUpperCase().slice(0, 8)).first() : await q(env, 'SELECT id FROM teams WHERE id = ?', Number(body.id) || 0).first();
    if (!t) return { error: 'that team does not exist any more', status: 404 };
    const w = await waitFor(env, me, now); if (w) return { error: 'you left a team a moment ago: you can join another one later', status: 429, wait: w };
    const n = await q(env, 'SELECT COUNT(*) AS n FROM team_members WHERE team = ?', t.id).first();
    if (n.n >= MAX_MEMBERS) return { error: `that team is full (${MAX_MEMBERS} worms)`, status: 409 };
    await env.DB.batch([q(env, "INSERT INTO team_members (player, team, role, joined) VALUES (?, ?, 'member', ?)", me.id, t.id, now), closeInvites(env, me.id, t.id)]);
    return detail(env, t.id, me, opts, now);
  }
  if (sub === '/leave') {
    const mine = await teamOf(env, me.id); if (!mine) return { ok: true };
    await leave(env, me.id, mine, now); return { ok: true, wait: now + REJOIN_MS };
  }
  const mine = await teamOf(env, me.id);
  if (sub === '/kick') {
    if (!mine || mine.role !== 'lead') return { error: 'only the team leader can do that', status: 403 };
    const id = Number(body.id); if (!id || id === me.id) return { error: 'pick a member', status: 400 };
    const r = await q(env, 'DELETE FROM team_members WHERE player = ? AND team = ?', id, mine.id).run();
    if (r.changes || (r.meta && r.meta.changes)) await q(env, 'INSERT INTO team_leave (player, left_at) VALUES (?, ?) ON CONFLICT(player) DO UPDATE SET left_at = excluded.left_at', id, now).run();
    return detail(env, mine.id, me, opts, now);
  }
  if (sub === '/edit') {
    if (!mine || mine.role !== 'lead') return { error: 'only the team leader can do that', status: 403 };
    if (body.emoji != null && !EMOJI.includes(String(body.emoji))) return { error: 'pick one of the emoji', status: 400 };
    const tgl = body.tg != null ? cleanTg(body.tg) : undefined; if (tgl === null) return { error: 'the Telegram link should look like t.me/yourgroup', status: 400 };
    if (body.emoji != null) await q(env, 'UPDATE teams SET emoji = ? WHERE id = ?', String(body.emoji), mine.id).run();
    if (tgl !== undefined) await q(env, 'UPDATE teams SET tg = ? WHERE id = ?', tgl, mine.id).run();
    return detail(env, mine.id, me, opts, now);
  }
  if (sub === '/logo') {
    if (!mine || mine.role !== 'lead') return { error: 'only the team leader can do that', status: 403 };
    if (body.img == null || body.img === '') { await q(env, 'DELETE FROM team_logos WHERE team = ?', mine.id).run(); return detail(env, mine.id, me, opts, now) }
    const r = await logo(env, me, mine, String(body.img), opts, now); if (r) return r;
    return detail(env, mine.id, me, opts, now);
  }
  return null;
}

// ---- invitations from inside the game (Damian 2026-10-20: "send invitations to the team within the game, to other players").
// Any member can invite a player who has no team. It waits on the player's Teams page (a dot on Friends), and the bot tells
// them on Telegram when they allow bot messages (at most INVITE_DM_DAY a day, whoever sends them). Join or No thanks; after
// a "no" that team can't ask again for INVITE_AGAIN. Load-test bots are never suggested.
export const INVITE_DAY = 20, INVITE_DM_DAY = 3, INVITE_AGAIN = 3 * DAY, INVITE_KEEP = 14 * DAY;
const closeInvites = (env, player, team) => q(env, 'UPDATE team_invites SET state = CASE WHEN team = ? THEN 1 ELSE 3 END WHERE player = ? AND state = 0', team, player);
export async function inviteCount(env, player, now = Date.now()) {
  const r = await q(env, 'SELECT COUNT(*) AS n FROM team_invites i JOIN teams t ON t.id = i.team WHERE i.player = ? AND i.state = 0 AND i.at > ?', player, now - INVITE_KEEP).first().catch(() => null);
  return r ? r.n | 0 : 0;
}
async function myInvites(env, me, now) {
  const { results } = await q(env, `SELECT i.id, i.at, s.name AS sname, t.id AS tid, t.name, t.tag, t.emoji, l.id AS logo, (SELECT COUNT(*) FROM team_members m WHERE m.team = t.id) AS members
      FROM team_invites i JOIN teams t ON t.id = i.team JOIN players s ON s.id = i.sender LEFT JOIN team_logos l ON l.team = t.id
      WHERE i.player = ? AND i.state = 0 AND i.at > ? ORDER BY i.at DESC LIMIT 10`, me.id, now - INVITE_KEEP).all();
  return results.map(r => ({ id: r.id, at: r.at, from: r.sname, team: { id: r.tid, name: r.name, tag: r.tag, emoji: r.emoji, ...(r.logo ? { logo: r.logo } : {}), members: r.members } }));
}
async function suggest(env, me, opts, now) {
  const mine = await teamOf(env, me.id); if (!mine) return { error: 'join a team first', status: 400 };
  let online = [];
  if (opts.lobby) try { online = ((await (await opts.lobby.fetch('https://lobby/ids')).json()).ids || []).filter(Number.isInteger) } catch (e) { }
  const on = new Set(online), out = [], seen = new Set([me.id]);
  const sel = `SELECT p.id, p.name, a.av, (SELECT 1 FROM team_invites i WHERE i.player = p.id AND i.team = ? AND i.state = 0 AND i.at > ?) AS invited FROM players p LEFT JOIN player_avatar a ON a.player = p.id`;
  const free = 'p.id NOT IN (SELECT player FROM team_members) AND p.id NOT IN (SELECT player FROM sim_players)';
  const add = async (why, sql, ...v) => { for (const r of (await q(env, sql, mine.id, now - INVITE_KEEP, ...v).all()).results) if (!seen.has(r.id)) { seen.add(r.id);
    out.push({ id: r.id, name: r.name, ...(r.av ? { av: r.av } : {}), why, ...(on.has(r.id) ? { online: true } : {}), ...(r.invited ? { invited: true } : {}) }) } };
  const name = String(opts.q || '').normalize('NFC').trim().slice(0, 20);
  if (name) { if (name.length >= 2) await add('search', `${sel} WHERE p.name LIKE ? ESCAPE '!' AND ${free} ORDER BY length(p.name), p.id LIMIT 20`, name.replace(/[!%_]/g, '!$&') + '%'); return { players: out } }
  await add('friend', `${sel} JOIN friends f ON f.friend = p.id AND f.player = ? WHERE ${free} LIMIT 30`, me.id);
  const ids = online.filter(id => !seen.has(id)).slice(0, 90);
  if (ids.length) await add('online', `${sel} WHERE p.id IN (${ids.map(() => '?').join(',')}) AND ${free} LIMIT 15`, ...ids);
  await add('active', `${sel} JOIN cworm_scores c ON c.player = p.id WHERE c.week_start = ? AND c.week > 0 AND ${free} ORDER BY c.last DESC LIMIT 25`, weekStart(now));
  return { players: out.slice(0, 50) };
}
async function invite(env, me, body, opts, now) {
  const mine = await teamOf(env, me.id); if (!mine) return { error: 'join a team first', status: 400 };
  const id = Number(body.id) || 0; if (!id || id === me.id) return { error: 'pick a player', status: 400 };
  const p = await q(env, 'SELECT p.id, p.name, p.tg_id, m.remind, m.no_dm FROM players p LEFT JOIN player_meta m ON m.player = p.id WHERE p.id = ?', id).first();
  if (!p) return { error: 'no such player', status: 404 };
  const in_ = await q(env, 'SELECT team FROM team_members WHERE player = ?', id).first();
  if (in_) return { error: in_.team === mine.id ? `${p.name} is already in your team` : `${p.name} is already in a team`, status: 409 };
  const day = Math.floor(now / DAY) * DAY;
  const [sent, open, no] = await Promise.all([q(env, 'SELECT COUNT(*) AS n FROM team_invites WHERE sender = ? AND at >= ?', me.id, day).first(),
    q(env, 'SELECT 1 AS y FROM team_invites WHERE team = ? AND player = ? AND state = 0 AND at > ?', mine.id, id, now - INVITE_KEEP).first(),
    q(env, 'SELECT 1 AS y FROM team_invites WHERE team = ? AND player = ? AND state = 2 AND at > ?', mine.id, id, now - INVITE_AGAIN).first()]);
  if (open) return { ok: true, name: p.name, dm: false, already: true };
  if (no) return { error: `${p.name} said no thanks. Your team can ask again in a few days.`, status: 409 };
  if (sent.n >= INVITE_DAY) return { error: `that is ${INVITE_DAY} invitations today: try again tomorrow`, status: 429 };
  let dm = 0;
  if (p.tg_id != null && env.BOT_TOKEN && (p.remind == null || p.remind) && !p.no_dm && !(await isSim(env, id))) {
    const n = await q(env, 'SELECT COUNT(*) AS n FROM team_invites WHERE player = ? AND dm = 1 AND at > ?', id, now - DAY).first();
    const t = n.n < INVITE_DM_DAY && await q(env, 'SELECT code FROM teams WHERE id = ?', mine.id).first();
    if (t) { const r = await tg(env, 'sendMessage', { chat_id: p.tg_id, text: `🛡️ ${me.name} invited you to join ${mine.emoji} ${mine.name} [${mine.tag}] in Crypto Worm Wars!\n\nEvery match you play scores for the team, and beating a rival team's worm online scores extra. (Play money, not real tokens.)\n\nTurn bot messages off with /stop or in the game's Settings.`,
        reply_markup: { inline_keyboard: [[{ text: '🛡️ See the team', url: gameLink(opts.env || env, 't_' + t.code) }]] } }).catch(() => null);
      if (r && r.ok) dm = 1; else if (r && r.error_code === 403) await q(env, 'UPDATE player_meta SET no_dm = 1 WHERE player = ?', id).run() }
  }
  await env.DB.batch([q(env, 'INSERT INTO team_invites (team, sender, player, at, dm) VALUES (?, ?, ?, ?, ?)', mine.id, me.id, id, now, dm), q(env, 'DELETE FROM team_invites WHERE at < ?', now - 30 * DAY)]);
  return { ok: true, name: p.name, dm: !!dm };
}

// Grok looks at a team picture before anyone else sees it (PG-13 game, shown to every player).
const LOGO_CHECK = 'You check pictures that a team in a PG-13 mobile game uploads as its team logo. Every player sees it. Answer with JSON only: {"ok":true|false,"reason":"<short>"}. ' +
  'ok is false if the picture shows: nudity or sexual content; violence, blood or gore; hate symbols or extremist signs; drugs; real guns or knives as the focus (cartoon game weapons are fine); ' +
  'rude or offensive words; a real photo of a person (cartoon or drawn characters are fine); a child; a scam (wallet addresses, QR codes, "send crypto", "free airdrop", giveaway promises); ' +
  'or the logo of a real company or exchange presented as official. Team logos, emblems, mascots, animals, cartoon characters, coins and crypto community art are fine.';
const LOGO_ID = /^[a-z0-9]{12,24}$/;
const logoNo = (error, status = 422) => ({ error, code: 'logo', status });
async function logo(env, me, mine, img, opts, now) {
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > MAX_LOGO) return logoNo('send a JPEG, PNG or WebP picture', 400);
  const d = Math.floor(now / DAY) * DAY;
  const [tries, banned] = await Promise.all([q(env, 'SELECT COUNT(*) AS n FROM team_logo_log WHERE team = ? AND at >= ? AND ok < 2', mine.id, d).first(), q(env, 'SELECT 1 AS y FROM team_logo_log WHERE team = ? AND ok = 2', mine.id).first()]);
  if (banned) return logoNo('team pictures are turned off for this team', 403);
  if (!env.XAI_API_KEY) return logoNo('team pictures are resting right now: try again later', 503);
  if (tries.n >= LOGO_TRIES) return logoNo('that is enough pictures for today: try again tomorrow', 429);
  let v; try { const r = await xai(env, 'chat/completions', { model: VISION_MODEL, temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: img } }, { type: 'text', text: LOGO_CHECK }] }] }); v = JSON.parse(r.choices[0].message.content) }
  catch (e) { return logoNo('busy right now: try again in a minute', 502) }
  const ok = v && v.ok === true, why = String(v && v.reason || '').slice(0, 200);
  await q(env, 'INSERT INTO team_logo_log (team, player, at, ok, why) VALUES (?, ?, ?, ?, ?)', mine.id, me.id, now, ok ? 1 : 0, why || null).run();
  if (!ok) return logoNo('that picture can not be used: try your community logo or a drawing' + (why ? ' (' + why + ')' : ''));
  const id = [...crypto.getRandomValues(new Uint8Array(12))].map(b => (b % 36).toString(36)).join('') + now.toString(36).slice(-4);
  await q(env, `INSERT INTO team_logos (team, id, img, created) VALUES (?, ?, ?, ?) ON CONFLICT(team) DO UPDATE SET id = excluded.id, img = excluded.img, created = excluded.created`,
    mine.id, id, img.slice(img.indexOf(',') + 1), now).run();
  if (opts.tell) await opts.tell((opts.origin || '') + '/teams/logo/' + id + '.jpg', `🛡️ New team picture: ${mine.emoji} ${mine.name} [${mine.tag}] (team ${mine.id}), uploaded by ${me.name} (player ${me.id}).\n/teams logooff ${mine.id} removes it and stops new ones; /teams off ${mine.id} removes the team.`).catch(() => { });
  return null;
}
// The picture itself, for anyone (img tags and the bot's photo messages).
export async function teamLogo(env, id) {
  const row = LOGO_ID.test(id) && await env.DB.prepare('SELECT img FROM team_logos WHERE id = ?').bind(id).first().catch(() => null);
  if (!row) return new Response('not found', { status: 404, headers: { 'access-control-allow-origin': '*' } });
  const bin = atob(row.img), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const type = row.img.startsWith('iVBOR') ? 'image/png' : row.img.startsWith('UklGR') ? 'image/webp' : 'image/jpeg';
  return new Response(bytes, { headers: { 'content-type': type, 'cache-control': 'public, max-age=604800', 'access-control-allow-origin': '*' } });
}

async function leave(env, player, mine, now) {
  await env.DB.batch([q(env, 'DELETE FROM team_members WHERE player = ?', player),
    q(env, 'INSERT INTO team_leave (player, left_at) VALUES (?, ?) ON CONFLICT(player) DO UPDATE SET left_at = excluded.left_at', player, now)]);
  if (mine.role !== 'lead') return;
  const next = await q(env, 'SELECT player FROM team_members WHERE team = ? ORDER BY joined ASC LIMIT 1', mine.id).first();
  if (next) await env.DB.batch([q(env, "UPDATE team_members SET role = 'lead' WHERE player = ?", next.player), q(env, 'UPDATE teams SET owner = ? WHERE id = ?', next.player, mine.id)]);
  else await env.DB.batch([q(env, 'DELETE FROM team_points WHERE team = ?', mine.id), q(env, 'DELETE FROM team_logos WHERE team = ?', mine.id), q(env, 'DELETE FROM team_invites WHERE team = ?', mine.id), q(env, 'DELETE FROM teams WHERE id = ?', mine.id)]);   // nobody left: the team goes
}

// Two accounts become one (index.js link: `a` folds into `b`). b's own team wins; points a earned move to b.
export async function mergeTeams(env, a, b, now = Date.now()) {
  const ma = await teamOf(env, a), mb = await teamOf(env, b);
  if (ma && mb && ma.id !== mb.id) await leave(env, a, ma, now);
  else if (ma && mb) { await q(env, 'DELETE FROM team_members WHERE player = ?', a).run(); if (ma.role === 'lead') await env.DB.batch([q(env, "UPDATE team_members SET role = 'lead' WHERE player = ?", b), q(env, 'UPDATE teams SET owner = ? WHERE id = ?', b, ma.id)]) }
  else if (ma) await env.DB.batch([q(env, 'UPDATE team_members SET player = ? WHERE player = ?', b, a), q(env, 'UPDATE teams SET owner = ? WHERE owner = ?', b, a)]);
  await env.DB.batch([
    q(env, `INSERT INTO team_points (team, week_start, player, pts) SELECT team, week_start, ?, pts FROM team_points WHERE player = ?
      ON CONFLICT(team, week_start, player) DO UPDATE SET pts = pts + excluded.pts`, b, a), q(env, 'DELETE FROM team_points WHERE player = ?', a),
    q(env, 'UPDATE team_clash SET winner = ? WHERE winner = ?', b, a), q(env, 'UPDATE team_clash SET loser = ? WHERE loser = ?', b, a),
    q(env, 'DELETE FROM team_leave WHERE player = ?', a)]);
}

// A member banked play money (addScore in index.js, already capped): the same amount scores for their team this week.
export async function teamScore(env, player, amount, now = Date.now()) {
  if (!(amount > 0)) return;
  const m = await q(env, 'SELECT team FROM team_members WHERE player = ?', player).first().catch(() => null); if (!m) return;
  if (await isSim(env, player)) amount = Math.round(amount * SIM_SHARE); if (!(amount > 0)) return;
  await q(env, `INSERT INTO team_points (team, week_start, player, pts) VALUES (?, ?, ?, ?)
    ON CONFLICT(team, week_start, player) DO UPDATE SET pts = pts + excluded.pts`, m.team, weekStart(now), player, amount).run();
}

// An online win over a rival team's member (a finished 1v1, or an online Worm Royale won against them): CLASH points for the
// winner's team. At most CLASH_DAY clashes a day per winner, and one per rival per day, so two friends can't farm it.
export async function teamClash(env, winner, loser, now = Date.now()) {
  if (winner == null || loser == null || winner === loser) return 0;
  const a = await q(env, 'SELECT team FROM team_members WHERE player = ?', winner).first().catch(() => null), b = a && await q(env, 'SELECT team FROM team_members WHERE player = ?', loser).first();
  if (!a || !b || a.team === b.team || await isSim(env, winner)) return 0;
  const day = Math.floor(now / DAY) * DAY;
  const done = await q(env, 'SELECT COUNT(*) AS n, SUM(loser = ?) AS same FROM team_clash WHERE winner = ? AND at >= ?', loser, winner, day).first();
  if ((done.n | 0) >= CLASH_DAY || (done.same | 0) > 0) return 0;
  await env.DB.batch([q(env, 'INSERT INTO team_clash (at, winner, loser, wteam, lteam) VALUES (?, ?, ?, ?, ?)', now, winner, loser, a.team, b.team),
    q(env, `INSERT INTO team_points (team, week_start, player, pts) VALUES (?, ?, ?, ?)
      ON CONFLICT(team, week_start, player) DO UPDATE SET pts = pts + excluded.pts`, a.team, weekStart(now), winner, CLASH),
    q(env, 'DELETE FROM team_clash WHERE at < ?', now - 35 * DAY)]);
  return CLASH;
}

// last week's top 3 teams, for the Monday post in the community group (growth.js weekly)
export async function teamTopText(env, start) {
  const { results } = await q(env, `SELECT t.name, t.tag, t.emoji, SUM(p.pts) AS pts FROM team_points p JOIN teams t ON t.id = p.team
    WHERE p.week_start = ? GROUP BY t.id ORDER BY pts DESC LIMIT 3`, start).all().catch(() => ({ results: [] }));
  if (!results.length) return '';
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return '🛡️ <b>Top teams of last week</b>\n' + results.map((r, i) => `${['🥇', '🥈', '🥉'][i]} ${esc(r.emoji)} <b>${esc(r.name)}</b> [${esc(r.tag)}]: ${(r.pts | 0).toLocaleString('en-US')} points`).join('\n');
}

// the bot's /teams (players, and in groups): this week's top 10 teams
export async function teamBoard(env, now = Date.now()) {
  const rows = (await table(env, 'week', now)).filter(r => r.pts > 0).slice(0, 10);
  const head = '🛡️ Teams this week\n\n';
  if (!rows.length) return { text: head + 'No team has scored yet this week. Start a team or join one in the game (Friends > Teams), then win matches for it! 🪱\n\n(Play money in the game, not real tokens.)', reply_markup: { inline_keyboard: [[{ text: '🛡️ Teams', url: gameLink(env, 'teams') }]] } };
  return { text: head + rows.map(r => `${r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank + '.'} ${r.emoji} ${r.name} [${r.tag}]: ${r.pts.toLocaleString('en-US')} points`).join('\n') + '\n\nEvery match a member plays scores for the team. Beat a rival team\'s worm online for +' + CLASH + ' more!\n\n(Play money in the game, not real tokens.)',
    reply_markup: { inline_keyboard: [[{ text: '🛡️ Teams', url: gameLink(env, 'teams') }]] } };
}

// the bot's /team: this player's team and its invite link
export async function teamMessage(env, player) {
  const mine = player && await teamOf(env, player.id);
  if (!mine) return { text: '🛡️ Teams: join a team or start your own, then win matches for it. Every match a member plays scores for the team, and beating a rival team\'s worm online scores extra. Weekly Teams ranking!\n\nOpen the game: Friends > Teams.\n\n(Play money in the game, not real tokens.)', reply_markup: { inline_keyboard: [[{ text: '🛡️ Teams', url: gameLink(env, 'teams') }]] } };
  const d = await detail(env, mine.id, player, { env });
  const link = d.team.link;
  return { text: `🛡️ ${mine.emoji} ${mine.name} [${mine.tag}]\nThis week: #${d.team.rank} with ${d.team.pts.toLocaleString('en-US')} points · ${d.team.members} worms\n\nInvite your community with this link:\n${link}\n\n(Play money in the game, not real tokens.)`,
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: '📤 Share the team link', url: 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(`Join ${mine.emoji} ${mine.name} in Crypto Worm Wars and fight for our team! 🪱`) }], [{ text: '🛡️ Open my team', url: gameLink(env, 'teams') }]] } };
}

// /teams and /teamoff <id> (admins): the table, and taking down a team with an abusive name or link
export async function adminTeams(env, arg) {
  const off = String(arg || '').trim().match(/^off\s+(\d+)/i), nologo = String(arg || '').trim().match(/^logooff\s+(\d+)/i);
  if (nologo) {
    const t = await q(env, 'SELECT id, name FROM teams WHERE id = ?', Number(nologo[1])).first(); if (!t) return `No team with id ${nologo[1]}.`;
    await env.DB.batch([q(env, 'DELETE FROM team_logos WHERE team = ?', t.id), q(env, "INSERT INTO team_logo_log (team, player, at, ok, why) VALUES (?, 0, ?, 2, 'removed by an admin')", t.id, Date.now())]);
    return `🚫 Removed the picture of the team ${t.name} (id ${t.id}). It can't upload a new one.`;
  }
  if (off) {
    const t = await q(env, 'SELECT id, name FROM teams WHERE id = ?', Number(off[1])).first(); if (!t) return `No team with id ${off[1]}.`;
    await env.DB.batch([q(env, 'DELETE FROM team_members WHERE team = ?', t.id), q(env, 'DELETE FROM team_points WHERE team = ?', t.id), q(env, 'DELETE FROM team_logos WHERE team = ?', t.id), q(env, 'DELETE FROM team_invites WHERE team = ?', t.id), q(env, 'DELETE FROM teams WHERE id = ?', t.id)]);
    return `🚫 Removed the team ${t.name} (id ${t.id}). Its members are free to join another team.`;
  }
  const rows = (await table(env, 'week')).slice(0, 25);
  if (!rows.length) return '🛡️ No teams yet.';
  return '🛡️ Teams this week\n' + rows.map(r => `#${r.rank} ${r.emoji} ${r.name} [${r.tag}] · ${r.members} worms · ${r.pts.toLocaleString('en-US')} pts · id ${r.id}`).join('\n') + '\n\n/teams off <id> removes a team, /teams logooff <id> only its picture.';
}
