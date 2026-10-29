// Challenges (Damian 2026-10-28: "a best of 3 matches challenge to the general public. And bet as much CWORM as you want. For
// example I make a 1000 CWORM challenge, other player take it have to put his 1000 CWORM and the winner take it all").
// A player posts a challenge with a stake; anyone takes it by putting in the same stake; the two play online matches until one
// has won 2, and the winner gets both stakes. All play money: the stakes leave the game's own wallet when game 1 starts (the
// phone spends them and reports it, /wager/paid), the pot comes back as a reward the game claims (reason 'wager', or
// 'wagerback' for each stake when a series ends even), and none of it counts for the ranking, team points or the weekly prize.
// A series that never starts moves nothing.
//
//   GET  /wagers                   -> {open: [{id, stake, at, by: {id, name, wins, losses, av}, online}], mine, last, min, max, n}
//   POST /wager/new    {stake}     -> {mine}      post a challenge (one at a time, after PLAYED_MIN matches, up to `max`)
//   POST /wager/take   {id}        -> {mine}      take one: the series starts, the poster hears it in the game or from the bot
//   POST /wager/cancel {id}        -> {mine, last}  take back an open one, call off one that hasn't started, or give up (the other wins)
//   POST /wager/paid   {id}        -> {ok}        this phone has spent its stake
// `mine` is the player's challenge that hasn't ended: {id, stake, pot, state, posted, opp, score: [mine, theirs], games, code,
// deadline, live, started, owe}; `last` the one that ended last (in the past LAST_MS): {..., why, won, draw}. `max` is what the
// server knows the player has earned (ranked play money and rewards, less stakes already in), the most they can put in.
//
// The series' matches are ordinary online matches (match.js) on the codes this file hands out, so only the two players can
// open them (room() in index.js). match.js calls start() when a game starts and finish() when it ends; a draw is played again
// (at most MAX_GAMES games, then the leader wins or it ends even), leaving or going quiet loses that game. Between games the
// next one must start within NEXT_MS: the player who turned up wins, else the leader, else it ends even (sweep(), from the
// cron every minute). Open challenges expire after OPEN_MS; a taken one whose game 1 hasn't started in FIRST_MS is called off.

import { newCode } from './match.js';
import { gameLink } from './growth.js';
import { tg } from './bot.js';

export const MIN_STAKE = 100, MAX_STAKE = 10_000_000, WINS = 2, MAX_GAMES = 5, PLAYED_MIN = 3, PER_DAY = 20;
export const OPEN_MS = 24 * 3600e3, FIRST_MS = 30 * 60e3, NEXT_MS = 5 * 60e3, GAME_MS = 45 * 60e3, LAST_MS = 2 * 3600e3;
const ACTIVE = "('open', 'taken', 'playing')", fmt = n => n.toLocaleString('en-US');
const q = (env, s, ...v) => env.DB.prepare(s).bind(...v);
const lobby = env => env.LOBBY ? env.LOBBY.get(env.LOBBY.idFromName('lobby')) : null;
const row = (env, id) => q(env, 'SELECT * FROM wagers WHERE id = ?', id).first();
const active = (env, id) => q(env, `SELECT * FROM wagers WHERE (p0 = ? OR p1 = ?) AND state IN ${ACTIVE} ORDER BY id DESC LIMIT 1`, id, id).first();
const nameOf = (env, id) => id == null ? null : q(env, 'SELECT name FROM players WHERE id = ?', id).first().then(r => r ? r.name : null);
const isSim = (env, id) => q(env, 'SELECT 1 AS y FROM sim_players WHERE player = ?', id).first().then(r => !!r).catch(() => false);
const played = (env, id) => q(env, 'SELECT played FROM player_meta WHERE player = ?', id).first().then(r => r ? r.played : 0);
const reward = (env, p, amount, reason, note, now) => q(env, 'INSERT INTO rewards (player, amount, reason, note, created) VALUES (?, ?, ?, ?, ?)', p, amount, reason, note, now);

// The most a player can put in: what the server has seen them earn (ranked play money plus rewards), less stakes already in.
export async function ceiling(env, id) {
  const s = await q(env, 'SELECT total FROM cworm_scores WHERE player = ?', id).first();
  const r = await q(env, 'SELECT COALESCE(SUM(amount), 0) AS n FROM rewards WHERE player = ?', id).first();
  const put = await q(env, 'SELECT COALESCE(SUM(stake), 0) AS n FROM wagers WHERE (p0 = ? OR p1 = ?) AND started IS NOT NULL', id, id).first();
  return Math.max(0, Math.min(MAX_STAKE, (s ? s.total : 0) + r.n - put.n));
}

// A challenge as one of its players sees it.
async function view(env, w, me, now = Date.now()) {
  const side = w.p0 === me ? 0 : 1, oid = side ? w.p0 : w.p1, wins = [w.w0, w.w1];
  const out = { id: w.id, stake: w.stake, pot: 2 * w.stake, state: w.state, posted: side === 0, opp: oid == null ? null : { id: oid, name: await nameOf(env, oid) },
    score: [wins[side], wins[1 - side]], games: w.games, code: w.state === 'taken' || w.state === 'playing' ? w.code : null, deadline: w.deadline, now,
    live: !!w.live, started: !!w.started, owe: !!w.started && !(side ? w.paid1 : w.paid0) };
  if (w.state === 'done' || w.state === 'off') Object.assign(out, { why: w.why, won: w.winner === me, draw: w.state === 'done' && w.winner == null, ended: w.ended });
  return out;
}

export async function handle(path, env, me, body, opt = {}) {
  const now = opt.now || Date.now();
  if (path === '/wagers') return list(env, me, now);
  if (!opt.post) return null;
  if (await isSim(env, me.id)) return { status: 403, error: 'not for test players' };
  if (path === '/wager/new') {
    const stake = Math.floor(Number(body.stake));
    if (!(stake >= MIN_STAKE)) return { status: 400, error: `the smallest stake is ${fmt(MIN_STAKE)}` };
    if (await played(env, me.id) < PLAYED_MIN) return { status: 403, error: `play ${PLAYED_MIN} matches first`, code: 'played' };
    if (await active(env, me.id)) return { status: 409, error: 'you already have a challenge going', code: 'busy' };
    const max = await ceiling(env, me.id); if (stake > max) return { status: 400, error: `you can put in up to ${fmt(max)} $CWORM`, code: 'max', max };
    const today = await q(env, 'SELECT COUNT(*) AS n FROM wagers WHERE p0 = ? AND created > ?', me.id, now - 864e5).first();
    if (today.n >= PER_DAY) return { status: 429, error: 'that is plenty of challenges for today' };
    const w = await q(env, "INSERT INTO wagers (p0, stake, state, created, deadline) VALUES (?, ?, 'open', ?, ?) RETURNING *", me.id, stake, now, now + OPEN_MS).first();
    await count(env, now);
    return { mine: await view(env, w, me.id, now) };
  }
  const id = Number(body.id) | 0, w = id ? await row(env, id) : null;
  if (path === '/wager/take') {
    if (!w || w.state !== 'open' || w.deadline <= now) return { status: 409, error: 'that challenge is gone', code: 'gone' };
    if (w.p0 === me.id) return { status: 400, error: 'that is your own challenge' };
    if (await played(env, me.id) < PLAYED_MIN) return { status: 403, error: `play ${PLAYED_MIN} matches first`, code: 'played' };
    if (await active(env, me.id)) return { status: 409, error: 'you already have a challenge going', code: 'busy' };
    const max = await ceiling(env, me.id); if (w.stake > max) return { status: 400, error: `you can put in up to ${fmt(max)} $CWORM`, code: 'max', max };
    const t = await q(env, "UPDATE wagers SET p1 = ?, state = 'taken', taken = ?, code = ?, deadline = ?, here0 = NULL, here1 = NULL WHERE id = ? AND state = 'open' RETURNING *",
      me.id, now, newCode(), now + FIRST_MS, id).first();
    if (!t) return { status: 409, error: 'someone else just took it', code: 'gone' };
    await tellTaken(env, t, me, opt); await count(env, now);
    return { mine: await view(env, t, me.id, now) };
  }
  if (!w || (w.p0 !== me.id && w.p1 !== me.id)) return { status: 404, error: 'no such challenge' };
  if (path === '/wager/paid') {
    if (w.started) await q(env, `UPDATE wagers SET ${w.p0 === me.id ? 'paid0' : 'paid1'} = COALESCE(${w.p0 === me.id ? 'paid0' : 'paid1'}, ?) WHERE id = ?`, now, id).run();
    return { ok: true };
  }
  if (path === '/wager/cancel') {
    if (w.state === 'open' || (w.state === 'taken' && !w.started)) {
      const off = await q(env, "UPDATE wagers SET state = 'off', why = 'cancelled', ended = ? WHERE id = ? AND state IN ('open', 'taken') RETURNING *", now, id).first();
      if (off && off.p1 != null) await tell(env, off.p0 === me.id ? off.p1 : off.p0, { t: 'wager', ev: 'off', id, by: me.name });
      await count(env, now);
    } else if (w.state === 'playing') await settle(env, w, w.p0 === me.id ? 1 : 0, 'forfeit', now);   // giving up: the other player wins
    const last = await row(env, id);
    return { mine: null, last: await view(env, last, me.id, now) };
  }
  return null;
}

async function list(env, me, now) {
  const { results } = await q(env, `SELECT w.id, w.stake, w.created, p.id AS pid, p.name, p.wins, p.losses, (SELECT av FROM player_avatar WHERE player = p.id) AS av
    FROM wagers w JOIN players p ON p.id = w.p0 WHERE w.state = 'open' AND w.deadline > ? ORDER BY w.stake DESC, w.id DESC LIMIT 40`, now).all();
  let on = new Set();
  const l = lobby(env); if (l && results.length) try { on = new Set(((await (await l.fetch('https://lobby/online?ids=' + results.map(r => r.pid).join(','))).json()).online || [])) } catch { }
  const open = results.map(r => ({ id: r.id, stake: r.stake, at: r.created, by: { id: r.pid, name: r.name, wins: r.wins, losses: r.losses, av: r.av || null }, online: on.has(r.pid) || r.pid === me.id }))
    .sort((a, b) => (b.by.id === me.id) - (a.by.id === me.id) || b.online - a.online || b.stake - a.stake);
  const w = await active(env, me.id);
  const e = await q(env, "SELECT * FROM wagers WHERE (p0 = ? OR p1 = ?) AND state IN ('done', 'off') AND ended > ? AND p1 IS NOT NULL ORDER BY ended DESC LIMIT 1", me.id, me.id, now - LAST_MS).first();
  return { open, mine: w ? await view(env, w, me.id, now) : null, last: e ? await view(env, e, me.id, now) : null, min: MIN_STAKE, max: await ceiling(env, me.id), n: open.length, played: await played(env, me.id), need: PLAYED_MIN };
}

// The poster hears that someone took their challenge: in the game when it's open, else from the bot.
async function tellTaken(env, w, me, opt) {
  const said = await tell(env, w.p0, { t: 'wager', ev: 'taken', id: w.id, by: me.name, stake: w.stake });
  if (said) return;
  const p = await q(env, 'SELECT tg_id FROM players WHERE id = ?', w.p0).first();
  if (!p || p.tg_id == null || !env.BOT_TOKEN) return;
  const send = tg(env, 'sendMessage', { chat_id: p.tg_id, text: `⚔️ ${me.name} took your ${fmt(w.stake)} $CWORM challenge! Best of 3, the winner takes ${fmt(2 * w.stake)}. They are waiting for you: open the game in the next 30 minutes to play.\n\nIn-game $CWORM is play money, not real tokens.`,
    reply_markup: { inline_keyboard: [[{ text: '⚔️ Play now', url: gameLink(env, 'b_' + w.id) }]] } }).catch(() => { });
  if (opt.wait) opt.wait(send); else await send;
}
async function tell(env, id, msg) {
  const l = lobby(env); if (!l || id == null) return false;
  try { return !!(await (await l.fetch('https://lobby/tell', { method: 'POST', body: JSON.stringify({ id, msg }) })).json()).ok } catch { return false }
}
// how many challenges are open, for the badge on the Online tab (the lobby passes it on with the player list)
async function count(env, now = Date.now()) {
  const l = lobby(env); if (!l) return;
  const r = await q(env, "SELECT COUNT(*) AS n FROM wagers WHERE state = 'open' AND deadline > ?", now).first();
  await l.fetch('https://lobby/wagers', { method: 'POST', body: JSON.stringify({ n: r.n }) }).catch(() => { });
}

// The series ends: the winner side (0 = p0, 1 = p1) gets the pot, or with no winner each stake goes back. Once only.
async function settle(env, w, side, why, now = Date.now()) {
  const winner = side === 0 ? w.p0 : side === 1 ? w.p1 : null, w0 = w.w0, w1 = w.w1;
  const done = await q(env, "UPDATE wagers SET state = 'done', winner = ?, why = ?, ended = ?, live = NULL WHERE id = ? AND state IN ('taken', 'playing') RETURNING *", winner, why, now, w.id).first();
  if (!done) return null;
  if (done.started) {
    const [n0, n1] = [await nameOf(env, w.p0), await nameOf(env, w.p1)];
    if (winner != null) await reward(env, winner, 2 * w.stake, 'wager', side ? n0 : n1, now).run();
    else await env.DB.batch([reward(env, w.p0, w.stake, 'wagerback', n1, now), reward(env, w.p1, w.stake, 'wagerback', n0, now)]);
  }
  for (const id of [w.p0, w.p1]) await tell(env, id, { t: 'wager', ev: 'done', id: w.id, won: winner === id, draw: winner == null, score: id === w.p0 ? [w0, w1] : [w1, w0] });
  return done;
}
const lead = w => w.w0 > w.w1 ? 0 : w.w1 > w.w0 ? 1 : -1;

// index.js, before a player opens a match: the code of a series' current game is only for its two players.
// Returns null (not a challenge), {error} or {id, stake} for the match's x-wager header.
export async function room(env, code, me, now = Date.now()) {
  const w = await q(env, "SELECT * FROM wagers WHERE code = ? AND state IN ('taken', 'playing')", code).first();
  if (!w) return null;
  if (w.p0 !== me && w.p1 !== me) return { error: 'this is a challenge match between two other players' };
  await q(env, `UPDATE wagers SET ${w.p0 === me ? 'here0' : 'here1'} = ? WHERE id = ?`, now, w.id).run();
  return { id: w.id, stake: w.stake };
}

// The series as match.js passes it to the two phones: wins by player, the game number, the next game's code, the result.
const series = w => ({ id: w.id, stake: w.stake, p0: w.p0, p1: w.p1, w0: w.w0, w1: w.w1, games: w.games, state: w.state, next: w.state === 'playing' && !w.live ? w.code : null,
  done: w.state === 'done' || w.state === 'off', winner: w.winner, why: w.why || null, paid0: !!w.paid0, paid1: !!w.paid1 });

// match.js: a series game has started (the first one puts the stakes in).
export async function start(env, id, code, now = Date.now()) {
  const w = await q(env, "UPDATE wagers SET state = 'playing', live = ?, started = COALESCE(started, ?), deadline = ? WHERE id = ? AND code = ? AND state IN ('taken', 'playing') AND live IS NULL RETURNING *",
    now, now, now + GAME_MS, id, code).first();
  return w ? series(w) : null;
}

// match.js: a series game has ended. winner: the player id, null for a draw.
export async function finish(env, id, code, winner, now = Date.now()) {
  const w = await row(env, id);
  if (!w || w.code !== code || w.state !== 'playing' || !w.live) return null;
  const w0 = w.w0 + (winner === w.p0 ? 1 : 0), w1 = w.w1 + (winner === w.p1 ? 1 : 0), games = w.games + 1;
  await q(env, 'UPDATE wagers SET w0 = ?, w1 = ?, games = ? WHERE id = ?', w0, w1, games, id).run();
  const now2 = { ...w, w0, w1, games };
  if (w0 >= WINS || w1 >= WINS || games >= MAX_GAMES) { await settle(env, now2, lead(now2), lead(now2) < 0 ? 'even' : 'won', now); return series(await row(env, id)) }
  const next = await q(env, 'UPDATE wagers SET code = ?, live = NULL, here0 = NULL, here1 = NULL, deadline = ? WHERE id = ? RETURNING *', newCode(), now + NEXT_MS, id).first();
  return series(next);
}

// The cron, every minute: challenges past their deadline.
export async function sweep(env, now = Date.now()) {
  const { results } = await q(env, `SELECT * FROM wagers WHERE state IN ${ACTIVE} AND deadline < ? ORDER BY deadline LIMIT 50`, now).all();
  for (const w of results) {
    if (w.state === 'open') await q(env, "UPDATE wagers SET state = 'off', why = 'expired', ended = ? WHERE id = ? AND state = 'open'", now, w.id).run();
    else if (!w.started) {                                         // game 1 never started: nothing was put in
      const off = await q(env, "UPDATE wagers SET state = 'off', why = 'noshow', ended = ? WHERE id = ? AND state = 'taken' RETURNING id", now, w.id).first();
      if (off) for (const id of [w.p0, w.p1]) await tell(env, id, { t: 'wager', ev: 'off', id: w.id });
    } else if (!w.live) {                                          // between games: whoever turned up for the next one wins
      const side = w.here0 && !w.here1 ? 0 : w.here1 && !w.here0 ? 1 : lead(w);
      await settle(env, w, side, 'noshow', now);
    } else await settle(env, w, lead(w), 'stuck', now);           // a game that never ended
  }
  if (results.length) await count(env, now);
  return results.length;
}
