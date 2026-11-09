// Team wars (Damian 2026-11-03, "opción 1" of his idea: "a team can challenge other team for a predeposited amount ... filled with
// deposits of several integrants of each side ... the team that reaches the goal in points take the prize"), with play money
// only: no real money, no real fee.
// A member challenges another team for a pot of MIN..MAX play $CWORM a side. Members of both teams chip in (a pledge leaves the
// player's game wallet right away: the phone spends it and reports it, /teams/war/paid) until both sides are full, within
// FILL_MS. Then a WAR_MS war starts, and the team with more war points takes the pot: the winning side's pledgers share it by
// what each put in, less a BURN share that is burned (never paid out). War points: the members' score reports in the war (the
// same capped amounts as team points), each player's counting on a UTC day only up to what the server saw them play that day
// (match credit, as for the weekly prize) plus FREE_PTS for mini games, and +CLASH for each rival team's worm beaten online. A
// tie, a side that didn't fill in time or a war called off before it starts gives every pledge back. One war at a time per
// team; teams with load-test bots never take part. The pot comes back through the rewards the game claims ('teamwar',
// 'teamwarback'); none of it counts for the ranking, team points or the prizes.
//
//   GET  /teams/war                     -> {war, last, owe, min, max, chip, ceiling}   my team's war, the one that ended last
//   POST /teams/war/new   {team, stake} -> {war}   challenge a team (any member with PLAYED_MIN matches; the rival's leader hears it from the bot)
//   POST /teams/war/pledge {id, amount} -> {war, owe}
//   POST /teams/war/paid  {ids}         -> {ok}    this phone spent those pledges
//   POST /teams/war/cancel {id}         -> {war}   a leader of either team, or whoever made it, calls it off before it starts
// A team's page (teams.js detail) and the Teams list carry {war, warLast, warOwe} for members, and {warOk} on a rival's page when this
// player's team can challenge it.

import { ceiling } from './wager.js';
import { gameLink } from './growth.js';
import { tg } from './bot.js';

export const MIN = 500, MAX = 5000, CHIP = 50, PLAYED_MIN = 3, PER_DAY = 3, BURN = 0.05, CLASH = 100, FREE_PTS = 150;
export const FILL_MS = 24 * 3600e3, WAR_MS = 24 * 3600e3, LAST_MS = 48 * 3600e3;
const DAY = 864e5, ACTIVE = "('filling', 'live')", fmt = n => (n | 0).toLocaleString('en-US');
const q = (env, s, ...v) => env.DB.prepare(s).bind(...v);
const reward = (env, p, amount, reason, note, now) => q(env, 'INSERT INTO rewards (player, amount, reason, note, created) VALUES (?, ?, ?, ?, ?)', p, amount, reason, note, now);
const teamOfP = (env, id) => q(env, 'SELECT t.id, t.name, t.tag, t.emoji, t.owner, m.role FROM team_members m JOIN teams t ON t.id = m.team WHERE m.player = ?', id).first();
const team = (env, id) => q(env, 'SELECT id, name, tag, emoji, owner FROM teams WHERE id = ?', id).first();
const botTeam = (env, id) => q(env, 'SELECT 1 AS y FROM team_members m JOIN sim_players s ON s.player = m.player WHERE m.team = ? LIMIT 1', id).first().then(r => !!r);
const isSim = (env, id) => q(env, 'SELECT 1 AS y FROM sim_players WHERE player = ?', id).first().then(r => !!r).catch(() => false);
const played = (env, id) => q(env, 'SELECT played FROM player_meta WHERE player = ?', id).first().then(r => r ? r.played | 0 : 0);
export const warOf = (env, t) => q(env, `SELECT * FROM team_wars WHERE (a = ? OR b = ?) AND state IN ${ACTIVE} ORDER BY id DESC LIMIT 1`, t, t).first();
const pledged = async (env, w) => { const { results } = await q(env, 'SELECT team, COALESCE(SUM(amount), 0) AS n FROM team_war_pledges WHERE war = ? GROUP BY team', w.id).all();
  const m = new Map(results.map(r => [r.team, r.n | 0])); return [m.get(w.a) || 0, m.get(w.b) || 0] };

// War points of each side: score reports up to the day's match credit plus FREE_PTS, and the rival wins.
export async function scores(env, w) {
  const { results } = await q(env, `SELECT team, SUM(MIN(reported, credit + ?) + clash) AS n FROM team_war_pts WHERE war = ? GROUP BY team`, FREE_PTS, w.id).all();
  const m = new Map(results.map(r => [r.team, r.n | 0])); return [m.get(w.a) || 0, m.get(w.b) || 0];
}

// A war as a member of one of its teams (or anyone) sees it.
async function view(env, w, me, now = Date.now()) {
  const [ta, tb] = await Promise.all([team(env, w.a), team(env, w.b)]), [pa, pb] = await pledged(env, w);
  const { results } = await q(env, `SELECT k.team, k.player, p.name, SUM(k.amount) AS n FROM team_war_pledges k JOIN players p ON p.id = k.player WHERE k.war = ? GROUP BY k.team, k.player ORDER BY n DESC`, w.id).all();
  const sc = w.state === 'live' ? await scores(env, w) : [w.sa | 0, w.sb | 0];
  const side = (k, x, pl, s) => ({ id: w[k], name: x ? x.name : '?', tag: x ? x.tag : '', emoji: x ? x.emoji : '🪱',
    pledged: pl, score: s, pledgers: results.filter(r => r.team === w[k]).map(r => ({ id: r.player, name: r.name, n: r.n | 0 })) });
  const mine = me ? results.filter(r => r.player === me.id).reduce((a, r) => a + (r.n | 0), 0) : 0;
  return { id: w.id, stake: w.stake, pot: 2 * w.stake, state: w.state, a: side('a', ta, pa, sc[0]), b: side('b', tb, pb, sc[1]), mine, by: w.by, created: w.created,
    fillBy: w.fill_by, started: w.started, ends: w.ends, now, ...(w.state === 'done' || w.state === 'off' ? { winner: w.winner, why: w.why, burned: w.burned | 0, ended: w.ended } : {}) };
}
// pledges this player hasn't reported spending yet (any war of the last week)
const owed = async (env, me, now) => (await q(env, 'SELECT id, amount FROM team_war_pledges WHERE player = ? AND paid IS NULL AND at > ? ORDER BY id', me.id, now - 7 * DAY).all()).results.map(r => ({ id: r.id, n: r.amount }));

// For a team's page: the war of my own team (and the one that ended last), or whether my team can challenge this one.
export async function forTeam(env, me, teamId, mine, now = Date.now()) {
  if (!me) return {};
  if (mine) { const w = await warOf(env, teamId); const l = w ? null : await q(env, `SELECT * FROM team_wars WHERE (a = ? OR b = ?) AND state IN ('done', 'off') AND ended > ? ORDER BY ended DESC LIMIT 1`, teamId, teamId, now - LAST_MS).first();
    const owe = await owed(env, me, now);
    return { war: w ? await view(env, w, me, now) : null, ...(l ? { warLast: await view(env, l, me, now) } : {}), ...(owe.length ? { warOwe: owe } : {}) } }
  const t = await teamOfP(env, me.id); if (!t || t.id === teamId) return {};
  return { warOk: !(await warOf(env, t.id)) && !(await warOf(env, teamId)) && !(await botTeam(env, teamId)) && !(await botTeam(env, t.id)) };
}

async function tell(env, playerId, text) {
  const p = playerId == null ? null : await q(env, 'SELECT tg_id FROM players WHERE id = ?', playerId).first();
  if (!p || p.tg_id == null || !env.BOT_TOKEN) return;
  await tg(env, 'sendMessage', { chat_id: p.tg_id, text: text + '\n\n(Play money in the game, not real tokens.)', reply_markup: { inline_keyboard: [[{ text: '🛡️ Teams', url: gameLink(env, 'teams') }]] } }).catch(() => { });
}
const label = t => t ? `${t.emoji} ${t.name} [${t.tag}]` : 'a team that closed';

export async function handle(path, env, me, body, now = Date.now()) {
  if (path === '/teams/war') {
    const t = await teamOfP(env, me.id), w = t && await warOf(env, t.id);
    const l = t && !w ? await q(env, `SELECT * FROM team_wars WHERE (a = ? OR b = ?) AND state IN ('done', 'off') AND ended > ? ORDER BY ended DESC LIMIT 1`, t.id, t.id, now - LAST_MS).first() : null;
    return { war: w ? await view(env, w, me, now) : null, last: l ? await view(env, l, me, now) : null, owe: await owed(env, me, now), min: MIN, max: MAX, chip: CHIP, ceiling: await ceiling(env, me.id) };
  }
  if (body === null) return null;                                           // the rest change things: POST only
  if (path === '/teams/war/paid') {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Number.isInteger).slice(0, 40);
    for (const id of ids) await q(env, 'UPDATE team_war_pledges SET paid = ? WHERE id = ? AND player = ? AND paid IS NULL', now, id, me.id).run();
    return { ok: true };
  }
  if (await isSim(env, me.id)) return { error: 'load-test players don\'t take part in team wars', status: 403 };
  const t = await teamOfP(env, me.id);
  if (path === '/teams/war/new') {
    if (!t) return { error: 'join a team first', status: 400 };
    if (await played(env, me.id) < PLAYED_MIN) return { error: `finish ${PLAYED_MIN} matches first`, status: 403 };
    const stake = Math.floor(Number(body.stake)); if (!(stake >= MIN && stake <= MAX)) return { error: `the pot is ${fmt(MIN)} to ${fmt(MAX)} BP a side`, status: 400 };
    const r = await team(env, Number(body.team)); if (!r || r.id === t.id) return { error: 'no such team', status: 404 };
    if (await botTeam(env, t.id) || await botTeam(env, r.id)) return { error: 'that team can\'t take part in team wars', status: 403 };
    if (await warOf(env, t.id)) return { error: 'your team already has a team war', status: 409 };
    if (await warOf(env, r.id)) return { error: `${r.name} already has a team war`, status: 409 };
    const today = await q(env, 'SELECT COUNT(*) AS n FROM team_wars WHERE a = ? AND created > ?', t.id, now - DAY).first();
    if ((today.n | 0) >= PER_DAY) return { error: `your team can start ${PER_DAY} team wars a day`, status: 429 };
    const w = await q(env, `INSERT INTO team_wars (a, b, stake, state, by, created, fill_by) SELECT ?, ?, ?, 'filling', ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM team_wars WHERE (a IN (?, ?) OR b IN (?, ?)) AND state IN ${ACTIVE}) RETURNING *`, t.id, r.id, stake, me.id, now, now + FILL_MS, t.id, r.id, t.id, r.id).first();
    if (!w) return { error: 'one of the teams already has a team war', status: 409 };
    await tell(env, r.owner, `⚔️ ${label(t)} challenged your team ${label(r)} to a team war: ${fmt(stake)} BP a side. Your members chip in from the team page; once both sides are full, the team with more points in 24 hours takes the pot. Fill your side within 24 hours or it's called off.`);
    return { war: await view(env, w, me, now) };
  }
  const w = await q(env, 'SELECT * FROM team_wars WHERE id = ?', Number(body.id)).first();
  if (!w) return { error: 'no such team war', status: 404 };
  if (path === '/teams/war/pledge') {
    if (w.state !== 'filling' || now >= w.fill_by) return { error: 'this team war isn\'t taking pledges', status: 409 };
    if (!t || (t.id !== w.a && t.id !== w.b)) return { error: 'only members of the two teams can chip in', status: 403 };
    if (await played(env, me.id) < PLAYED_MIN) return { error: `finish ${PLAYED_MIN} matches first`, status: 403 };
    const [pa, pb] = await pledged(env, w), left = w.stake - (t.id === w.a ? pa : pb), amount = Math.floor(Number(body.amount));
    if (left <= 0) return { error: 'your side is full', status: 409 };
    if (!(amount >= Math.min(CHIP, left) && amount <= left)) return { error: `chip in ${fmt(Math.min(CHIP, left))} to ${fmt(left)} BP`, status: 400 };
    if (await q(env, 'SELECT 1 AS y FROM team_war_pledges WHERE war = ? AND player = ? AND team != ?', w.id, me.id, t.id).first()) return { error: 'you already chipped in for the other side', status: 409 };
    if (amount > await ceiling(env, me.id)) return { error: 'that is more than you have', status: 400 };
    const k = await q(env, `INSERT INTO team_war_pledges (war, team, player, amount, at) SELECT ?, ?, ?, ?, ?
        WHERE (SELECT COALESCE(SUM(amount), 0) FROM team_war_pledges WHERE war = ? AND team = ?) + ? <= ? RETURNING id`, w.id, t.id, me.id, amount, now, w.id, t.id, amount, w.stake).first();
    if (!k) return { error: 'your side filled up a moment ago', status: 409 };
    const [na, nb] = await pledged(env, w);
    if (na >= w.stake && nb >= w.stake) {                                    // both sides full: the war is on
      const on = await q(env, "UPDATE team_wars SET state = 'live', started = ?, ends = ? WHERE id = ? AND state = 'filling' RETURNING *", now, now + WAR_MS, w.id).first();
      if (on) { const [ta, tb] = await Promise.all([team(env, w.a), team(env, w.b)]);
        for (const [x, y] of [[ta, tb], [tb, ta]]) await tell(env, x.owner, `⚔️ Team war on! ${label(x)} vs ${label(y)}, ${fmt(2 * w.stake)} BP in the pot. For 24 hours every match your members play scores, and each worm of another team beaten online scores +${CLASH}. Rally your team!`) }
    }
    return { war: await view(env, await q(env, 'SELECT * FROM team_wars WHERE id = ?', w.id).first(), me, now), owe: await owed(env, me, now) };
  }
  if (path === '/teams/war/cancel') {
    if (w.state !== 'filling') return { error: 'a team war that started can\'t be called off', status: 409 };
    const lead = t && (t.id === w.a || t.id === w.b) && t.role === 'lead';
    if (!lead && w.by !== me.id) return { error: 'only a team leader or whoever started it can call it off', status: 403 };
    await refund(env, w, 'cancelled', now);
    return { war: await view(env, await q(env, 'SELECT * FROM team_wars WHERE id = ?', w.id).first(), me, now) };
  }
  return null;
}

// every pledge back (a side that didn't fill, called off, or a tie)
async function refund(env, w, why, now, state = 'off') {
  const r = await q(env, `UPDATE team_wars SET state = ?, why = ?, ended = ?, burned = 0 WHERE id = ? AND state IN ${ACTIVE} RETURNING id`, state, why, now, w.id).first(); if (!r) return false;
  const { results } = await q(env, 'SELECT k.player, k.team, SUM(k.amount) AS n, t.name FROM team_war_pledges k LEFT JOIN teams t ON t.id = k.team WHERE k.war = ? GROUP BY k.player, k.team', w.id).all();
  for (const p of results) if (p.n > 0) await reward(env, p.player, p.n | 0, 'teamwarback', p.name || '', now).run();
  return true;
}
// the war is over: the side with more points takes the pot, less the burn, shared by what each pledger put in
async function settle(env, w, now) {
  const [sa, sb] = await scores(env, w);
  await q(env, 'UPDATE team_wars SET sa = ?, sb = ? WHERE id = ?', sa, sb, w.id).run();
  const [ta, tb] = await Promise.all([team(env, w.a), team(env, w.b)]);
  if (sa === sb) { if (await refund(env, w, 'even', now, 'done')) for (const x of [ta, tb]) if (x) await tell(env, x.owner, `🤝 The team war ${label(ta)} vs ${label(tb)} ended even, ${fmt(sa)} to ${fmt(sb)}. Every pledge goes back.`); return }
  const win = sa > sb ? w.a : w.b, pot = 2 * w.stake, burned = Math.round(pot * BURN), pay = pot - burned;
  const r = await q(env, "UPDATE team_wars SET state = 'done', winner = ?, why = 'won', burned = ?, ended = ? WHERE id = ? AND state = 'live' RETURNING id", win, burned, now, w.id).first(); if (!r) return;
  const { results } = await q(env, 'SELECT player, SUM(amount) AS n FROM team_war_pledges WHERE war = ? AND team = ? GROUP BY player ORDER BY n DESC, MIN(id)', w.id, win).all();
  const total = results.reduce((a, p) => a + (p.n | 0), 0) || 1, shares = results.map(p => Math.floor(pay * p.n / total));
  if (shares.length) shares[0] += pay - shares.reduce((a, b) => a + b, 0);  // the cents left over go to the biggest pledger
  const wt = win === w.a ? ta : tb, lt = win === w.a ? tb : ta;
  for (let i = 0; i < results.length; i++) if (shares[i] > 0) await reward(env, results[i].player, shares[i], 'teamwar', wt ? wt.name : '', now).run();
  if (wt) await tell(env, wt.owner, `🏆 ${label(wt)} won the team war against ${label(lt)}, ${fmt(Math.max(sa, sb))} to ${fmt(Math.min(sa, sb))}! ${fmt(pay)} BP go to the members who chipped in (${fmt(burned)} burned).`);
  if (lt) await tell(env, lt.owner, `⚔️ ${label(lt)} lost the team war against ${label(wt)}, ${fmt(Math.min(sa, sb))} to ${fmt(Math.max(sa, sb))}. Challenge them again from the team page!`);
}
// every minute (the bot's cron): sides that didn't fill in time, wars that are over
export async function sweep(env, now = Date.now()) {
  const { results } = await q(env, `SELECT * FROM team_wars WHERE (state = 'filling' AND fill_by <= ?) OR (state = 'live' AND ends <= ?) ORDER BY id LIMIT 20`, now, now).all();
  for (const w of results) {
    if (w.state === 'live') { await settle(env, w, now); continue }
    if (await refund(env, w, 'expired', now)) { const [ta, tb] = await Promise.all([team(env, w.a), team(env, w.b)]);
      for (const x of [ta, tb]) if (x) await tell(env, x.owner, `⌛ The team war ${label(ta)} vs ${label(tb)} didn't fill in 24 hours, so it's off. Every pledge goes back.`) }
  }
  return results.length;
}

// ---- war points, from the scoring code (index.js, prize.js runEnd, teams.js teamClash) ----
const live = (env, t, now) => q(env, "SELECT id, a, b FROM team_wars WHERE state = 'live' AND (a = ? OR b = ?) AND started <= ? AND ends > ? LIMIT 1", t, t, now, now).first();
const add = (env, war, t, player, now, col, n) => q(env, `INSERT INTO team_war_pts (war, team, player, day, ${col}) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(war, team, player, day) DO UPDATE SET ${col} = ${col} + excluded.${col}`, war, t, player, Math.floor(now / DAY), n).run();
// a member banked play money (the capped amount that also scores for the team)
export async function warScore(env, t, player, amount, now = Date.now()) { if (!(amount > 0)) return; const w = await live(env, t, now); if (w) await add(env, w.id, t, player, now, 'reported', amount) }
// a member finished a match the server saw start: what that match can carry
export async function warRun(env, player, credit, now = Date.now()) {
  if (!(credit > 0)) return; const m = await q(env, 'SELECT team FROM team_members WHERE player = ?', player).first(); if (!m) return;
  const w = await live(env, m.team, now); if (w) await add(env, w.id, m.team, player, now, 'credit', credit);
}
// a member beat a rival team's worm online
export async function warClash(env, t, player, now = Date.now()) { const w = await live(env, t, now); if (w) await add(env, w.id, t, player, now, 'clash', CLASH) }
