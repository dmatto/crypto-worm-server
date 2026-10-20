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
// Points a member earned stay with the team they earned them for.

import { newCode } from './match.js';
import { weekStart, gameLink } from './growth.js';

export const MAX_MEMBERS = 50, CREATE_PLAYED = 3, REJOIN_MS = 12 * 3600e3, CLASH = 100, CLASH_DAY = 5, TOP = 50;
export const EMOJI = ['🪱', '🐸', '🐶', '🐱', '🦊', '🐻', '🐼', '🦁', '🐯', '🐺', '🦈', '🐋', '🐙', '🦄', '🐲', '🦅', '🔥', '⚡', '🌙', '🚀', '💎', '👑', '⚔️', '🍀'];
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.\-'&!]{1,18}[\p{L}\p{N}!.]$/u, TAG = /^[A-Z0-9]{2,5}$/;
const BLOCK = /(fuck|shit|bitch|cunt|nigg|fag|rape|nazi|hitler|porn|whore|slut|dick|pussy|admin|moderator|official|cryptoworm|crypto worm|cwormteam|support)/i;
const DAY = 864e5;
const q = (env, s, ...v) => env.DB.prepare(s).bind(...v);

// a Telegram group link: t.me/name, @name or a t.me/+invite link, kept as https://t.me/...
export function cleanTg(s) {
  s = String(s || '').trim(); if (!s) return '';
  let m = s.match(/^@([A-Za-z0-9_]{5,32})$/) || s.match(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(\+?[A-Za-z0-9_\-]{5,40})\/?$/);
  return m ? 'https://t.me/' + m[1] : null;
}
const bad = s => BLOCK.test(s) || BLOCK.test(s.replace(/[\s_.\-'&!]/g, ''));

export async function teamOf(env, player) {
  return q(env, 'SELECT t.id, t.name, t.tag, t.emoji, m.role FROM team_members m JOIN teams t ON t.id = m.team WHERE m.player = ?', player).first().catch(() => null);
}

// The weekly (or all time) table: every team, ranked by the points its members earned for it.
async function table(env, period, now = Date.now()) {
  const wk = weekStart(now), week = period !== 'all';
  const { results } = await q(env, `SELECT t.id, t.name, t.tag, t.emoji, t.created,
      (SELECT COUNT(*) FROM team_members m WHERE m.team = t.id) AS members,
      COALESCE((SELECT SUM(p.pts) FROM team_points p WHERE p.team = t.id ${week ? 'AND p.week_start = ?' : ''}), 0) AS pts
      FROM teams t ORDER BY pts DESC, t.created ASC`, ...(week ? [wk] : [])).all();
  return results.map((r, i) => ({ rank: i + 1, id: r.id, name: r.name, tag: r.tag, emoji: r.emoji, members: r.members, pts: r.pts | 0 }));
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
  return { team: { id: t.id, name: t.name, tag: t.tag, emoji: t.emoji, tg: t.tg || '', owner: t.owner, created: t.created, members: results.length, rank: row.rank, pts: row.pts, ptsAll: all ? all.n | 0 : 0,
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
      mine: mine ? { ...mine, ...(rows.find(r => r.id === mine.id) || {}) } : null, can: !mine && await canCreate(env, me), wait: mine ? 0 : await waitFor(env, me, now) };
  }
  const one = sub.match(/^\/(\d+)$/);
  if (one) return detail(env, Number(one[1]), me, opts, now);
  const byCode = sub.match(/^\/code\/([A-Za-z0-9]{4,8})$/);                    // an invite link's team, before joining it
  if (byCode) { const t = await q(env, 'SELECT id FROM teams WHERE code = ?', byCode[1].toUpperCase()).first(); return t ? detail(env, t.id, me, opts, now) : { error: 'that team does not exist any more', status: 404 } }
  if (opts.post === false) return null;                                     // the rest change things: POST only
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
    await q(env, "INSERT INTO team_members (player, team, role, joined) VALUES (?, ?, 'lead', ?)", me.id, t.id, now).run();
    return detail(env, t.id, me, opts, now);
  }
  if (sub === '/join') {
    if (await teamOf(env, me.id)) return { error: 'leave your team first', status: 400 };
    const t = body.code ? await q(env, 'SELECT id FROM teams WHERE code = ?', String(body.code).trim().toUpperCase().slice(0, 8)).first() : await q(env, 'SELECT id FROM teams WHERE id = ?', Number(body.id) || 0).first();
    if (!t) return { error: 'that team does not exist any more', status: 404 };
    const w = await waitFor(env, me, now); if (w) return { error: 'you left a team a moment ago: you can join another one later', status: 429, wait: w };
    const n = await q(env, 'SELECT COUNT(*) AS n FROM team_members WHERE team = ?', t.id).first();
    if (n.n >= MAX_MEMBERS) return { error: `that team is full (${MAX_MEMBERS} worms)`, status: 409 };
    await q(env, "INSERT INTO team_members (player, team, role, joined) VALUES (?, ?, 'member', ?)", me.id, t.id, now).run();
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
  return null;
}

async function leave(env, player, mine, now) {
  await env.DB.batch([q(env, 'DELETE FROM team_members WHERE player = ?', player),
    q(env, 'INSERT INTO team_leave (player, left_at) VALUES (?, ?) ON CONFLICT(player) DO UPDATE SET left_at = excluded.left_at', player, now)]);
  if (mine.role !== 'lead') return;
  const next = await q(env, 'SELECT player FROM team_members WHERE team = ? ORDER BY joined ASC LIMIT 1', mine.id).first();
  if (next) await env.DB.batch([q(env, "UPDATE team_members SET role = 'lead' WHERE player = ?", next.player), q(env, 'UPDATE teams SET owner = ? WHERE id = ?', next.player, mine.id)]);
  else await env.DB.batch([q(env, 'DELETE FROM team_points WHERE team = ?', mine.id), q(env, 'DELETE FROM teams WHERE id = ?', mine.id)]);   // nobody left: the team goes
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
  await q(env, `INSERT INTO team_points (team, week_start, player, pts) VALUES (?, ?, ?, ?)
    ON CONFLICT(team, week_start, player) DO UPDATE SET pts = pts + excluded.pts`, m.team, weekStart(now), player, amount).run();
}

// An online win over a rival team's member (a finished 1v1, or an online Worm Royale won against them): CLASH points for the
// winner's team. At most CLASH_DAY clashes a day per winner, and one per rival per day, so two friends can't farm it.
export async function teamClash(env, winner, loser, now = Date.now()) {
  if (winner == null || loser == null || winner === loser) return 0;
  const a = await q(env, 'SELECT team FROM team_members WHERE player = ?', winner).first().catch(() => null), b = a && await q(env, 'SELECT team FROM team_members WHERE player = ?', loser).first();
  if (!a || !b || a.team === b.team) return 0;
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
  return '🛡 <b>Top teams of last week</b>\n' + results.map((r, i) => `${['🥇', '🥈', '🥉'][i]} ${esc(r.emoji)} <b>${esc(r.name)}</b> [${esc(r.tag)}]: ${(r.pts | 0).toLocaleString('en-US')} points`).join('\n');
}

// the bot's /teams (players, and in groups): this week's top 10 teams
export async function teamBoard(env, now = Date.now()) {
  const rows = (await table(env, 'week', now)).filter(r => r.pts > 0).slice(0, 10);
  const head = '🛡 Teams this week\n\n';
  if (!rows.length) return { text: head + 'No team has scored yet this week. Start a team or join one in the game (Friends > Teams), then win matches for it! 🪱\n\n(Play money in the game, not real tokens.)', reply_markup: { inline_keyboard: [[{ text: '🛡 Teams', url: gameLink(env, 'teams') }]] } };
  return { text: head + rows.map(r => `${r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank + '.'} ${r.emoji} ${r.name} [${r.tag}]: ${r.pts.toLocaleString('en-US')} points`).join('\n') + '\n\nEvery match a member plays scores for the team. Beat a rival team\'s worm online for +' + CLASH + ' more!\n\n(Play money in the game, not real tokens.)',
    reply_markup: { inline_keyboard: [[{ text: '🛡 Teams', url: gameLink(env, 'teams') }]] } };
}

// the bot's /team: this player's team and its invite link
export async function teamMessage(env, player) {
  const mine = player && await teamOf(env, player.id);
  if (!mine) return { text: '🛡 Teams: join a team or start your own, then win matches for it. Every match a member plays scores for the team, and beating a rival team\'s worm online scores extra. Weekly Teams ranking!\n\nOpen the game: Friends > Teams.\n\n(Play money in the game, not real tokens.)', reply_markup: { inline_keyboard: [[{ text: '🛡 Teams', url: gameLink(env, 'teams') }]] } };
  const d = await detail(env, mine.id, player, { env });
  const link = d.team.link;
  return { text: `🛡 ${mine.emoji} ${mine.name} [${mine.tag}]\nThis week: #${d.team.rank} with ${d.team.pts.toLocaleString('en-US')} points · ${d.team.members} worms\n\nInvite your community with this link:\n${link}\n\n(Play money in the game, not real tokens.)`,
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: '📤 Share the team link', url: 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(`Join ${mine.emoji} ${mine.name} in Crypto Worm Wars and fight for our team! 🪱`) }], [{ text: '🛡 Open my team', url: gameLink(env, 'teams') }]] } };
}

// /teams and /teamoff <id> (admins): the table, and taking down a team with an abusive name or link
export async function adminTeams(env, arg) {
  const off = String(arg || '').trim().match(/^off\s+(\d+)/i);
  if (off) {
    const t = await q(env, 'SELECT id, name FROM teams WHERE id = ?', Number(off[1])).first(); if (!t) return `No team with id ${off[1]}.`;
    await env.DB.batch([q(env, 'DELETE FROM team_members WHERE team = ?', t.id), q(env, 'DELETE FROM team_points WHERE team = ?', t.id), q(env, 'DELETE FROM teams WHERE id = ?', t.id)]);
    return `🚫 Removed the team ${t.name} (id ${t.id}). Its members are free to join another team.`;
  }
  const rows = (await table(env, 'week')).slice(0, 25);
  if (!rows.length) return '🛡 No teams yet.';
  return '🛡 Teams this week\n' + rows.map(r => `#${r.rank} ${r.emoji} ${r.name} [${r.tag}] · ${r.members} worms · ${r.pts.toLocaleString('en-US')} pts · id ${r.id}`).join('\n') + '\n\n/teams off <id> removes a team.';
}
