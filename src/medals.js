// Medals (Damian 2026-11-09): "reserve Medals for condecorations occasions. Like first to try a weapon, or special
// achievements, like player 2k or first invitation. So the medals can be sold for Battle Points. Its a new scheme."
// A medal is a one-off honour, shown on the player card and on the game's Medals page. Each one has a value in Battle Points
// (play money, never real tokens): selling it pays that value once (a 'medal' reward the game claims, outside the ranking like
// every gift) and takes the medal off the card for good. The row stays, marked sold, so the same medal is never given twice.
// Load-test bots never get one.
//   pioneer    the first PIONEER_N players to win a match with a new weapon (PIONEER: weapon id -> name); the game sends the
//              weapons this player fired with the /played report of a match it won
//   milestone  the player whose first finished match makes the count of real players reach 2,000, 3,000, 4,000...
//   recruiter  the first friend who joined with this player's invite and finished a match
//   royale     an online Worm Royale win, at most one a week
//   weektop    the week's top 10 real players in the ranking, given with the Monday post (#1 is one of a kind)
//   teamwar    every member who scored war points for the winning side of a team war
//   race       the Invite Race winners, given when an admin posts the result (after the fair-play check)
//   special    given by an admin with /medal give, for a moment worth remembering
import { tg } from './bot.js';
import { gameLink } from './growth.js';

export const TIERS = { common: 300, rare: 1500, unique: 5000 };
export const KINDS = {
  pioneer: { emo: '🧪', name: 'Pioneer', tier: 'rare' },
  milestone: { emo: '🎉', name: 'Milestone', tier: 'unique' },
  recruiter: { emo: '🤝', name: 'Recruiter', tier: 'common' },
  royale: { emo: '👑', name: 'Royale champion', tier: 'rare' },
  weektop: { emo: '🏆', name: 'Weekly top 10', tier: 'rare' },
  teamwar: { emo: '🛡️', name: 'Team war victory', tier: 'common' },
  race: { emo: '🏁', name: 'Invite Race winner', tier: 'unique' },
  special: { emo: '🎖️', name: 'Special honour', tier: 'rare' },
};
export const PIONEER = { saber: 'Laser Saber', football: 'Golazo' };
export const PIONEER_N = 10, MILESTONE_FROM = 2000, MILESTONE_STEP = 1000;
const PIONEER_MODES = new Set(['cpu', 'bot', 'online', 'daily', 'camp', 'map']);
const DAY = 864e5, WEEK = 7 * DAY, MONDAY = 4 * DAY;               // 1970-01-01 was a Thursday
const q = (env, s, ...v) => env.DB.prepare(s).bind(...v);
const fmt = n => (n | 0).toLocaleString('en-US');
const changed = r => !!(r && (r.meta ? r.meta.changes : r.changes));
const REAL = `NOT EXISTS (SELECT 1 FROM sim_players s WHERE s.player = ?1) AND COALESCE((SELECT source FROM player_meta WHERE player = ?1), '') != 'loadtest'`;
export const weekOf = (now = Date.now()) => Math.floor((now - MONDAY) / WEEK) * WEEK + MONDAY;
const shape = r => r && { id: r.id, kind: r.kind, ref: r.ref, label: r.label || '', tier: r.tier, value: r.value, at: r.at, emo: (KINDS[r.kind] || KINDS.special).emo, name: (KINDS[r.kind] || KINDS.special).name };

// Gives a medal once per player, kind and ref; `cap` limits how many players can hold the same kind and ref (1 for one of a
// kind, PIONEER_N for a weapon's pioneers). Returns the new medal, or null when it was not given.
export async function award(env, player, kind, ref, { label = '', tier, cap = 0, note = true, now = Date.now() } = {}) {
  if (!player || !KINDS[kind]) return null;
  tier = TIERS[tier] ? tier : KINDS[kind].tier; ref = String(ref ?? '').slice(0, 40); label = String(label || '').slice(0, 80);
  const r = await q(env, `INSERT OR IGNORE INTO medals (player, kind, ref, label, tier, value, at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
      WHERE ${REAL} AND (?8 = 0 OR (SELECT COUNT(*) FROM medals WHERE kind = ?2 AND ref = ?3) < ?8) RETURNING *`,
    player, kind, ref, label, tier, TIERS[tier], now, cap | 0).first();
  if (!r) return null;
  if (note) await tell(env, player, r).catch(() => { });
  return shape(r);
}

// The bot tells a Telegram player about a new medal, with a button to the Medals page.
async function tell(env, player, m) {
  const p = await q(env, `SELECT p.tg_id FROM players p LEFT JOIN player_meta x ON x.player = p.id WHERE p.id = ? AND COALESCE(x.no_dm, 0) = 0`, player).first();
  if (!p || p.tg_id == null || !env.BOT_TOKEN) return;
  const k = KINDS[m.kind] || KINDS.special;
  const r = await tg(env, 'sendMessage', { chat_id: p.tg_id, text: `${k.emo} New medal: ${k.name}${m.label ? ' · ' + m.label : ''}!\n\n` +
      `It shows on your player card. Keep it to show off, or sell it any time for ${fmt(m.value)} BP (the medal is gone for good once sold).\n\n(Battle Points are play money, not real tokens.)`,
    reply_markup: { inline_keyboard: [[{ text: '🎖️ My medals', url: gameLink(env, 'medals') }]] } });
  if (r && r.error_code === 403) await q(env, 'UPDATE player_meta SET no_dm = 1 WHERE player = ?', player).run();
}

// ---- the hooks ----
// A match this player won, with the weapons they fired (from /played): a new weapon's first PIONEER_N winners.
export async function pioneer(env, me, mode, weapons, won, now = Date.now()) {
  if (!won || !PIONEER_MODES.has(mode) || !Array.isArray(weapons)) return [];
  const out = [];
  for (const w of new Set(weapons.slice(0, 40).map(String))) if (PIONEER[w]) {
    const m = await award(env, me.id, 'pioneer', w, { label: PIONEER[w], cap: PIONEER_N, now }); if (m) out.push(m) }
  return out;
}
// A player finished a first match: are they the 2,000th (3,000th...) real player to do so?
export async function milestone(env, me, now = Date.now()) {
  const r = await q(env, `SELECT COUNT(*) AS n FROM player_meta m WHERE m.played > 0 AND COALESCE(m.source, '') != 'loadtest'
      AND NOT EXISTS (SELECT 1 FROM sim_players s WHERE s.player = m.player)`).first();
  const n = r ? r.n : 0, k = Math.floor(n / MILESTONE_STEP) * MILESTONE_STEP;
  if (k < MILESTONE_FROM) return null;
  return award(env, me.id, 'milestone', k, { label: 'Player #' + fmt(k), cap: 1, now });
}
// The first friend who came with this player's invite finished a match.
export const recruiter = (env, inviter, friendName, now = Date.now(), note = true) => award(env, inviter, 'recruiter', '', { label: friendName ? 'First friend: ' + String(friendName).slice(0, 40) : '', now, note });
// An online Worm Royale win (royale.js record), one medal a week.
export function royaleWin(env, player, now = Date.now()) {
  const w = weekOf(now);
  return award(env, player, 'royale', 'w' + w, { label: 'Week of ' + new Date(w).toISOString().slice(0, 10), now });
}
// The Monday post: the week's top 10 in the ranking (growth.js weekTop), counting real players only: no load-test bots, no admins.
export async function weekTop(env, start, now = Date.now()) {
  const day = new Date(start).toISOString().slice(0, 10), out = [], ad = String(env.ADMIN_PLAYERS || '').split(',').map(Number).filter(n => n > 0);
  const { results: real } = await q(env, `SELECT x.player, SUM(x.cworm) AS cworm FROM
      (SELECT player, cworm FROM week_scores WHERE week_start = ?1 UNION ALL SELECT player, week AS cworm FROM cworm_scores WHERE week_start = ?1 AND week > 0) x
      WHERE x.player NOT IN (SELECT player FROM sim_players) AND x.player NOT IN (SELECT player FROM player_meta WHERE source = 'loadtest')
      AND x.player NOT IN (SELECT value FROM json_each(?2)) GROUP BY x.player HAVING cworm > 0 ORDER BY cworm DESC LIMIT 10`, start, JSON.stringify(ad)).all();
  for (let i = 0; i < real.length; i++) {
    const m = await award(env, real[i].player, 'weektop', 'w' + start, { label: `#${i + 1} · week of ${day}`, tier: i === 0 ? 'unique' : 'rare', now }); if (m) out.push(m) }
  return out;
}
// A team war is over: the winning side's members who scored war points in it (`quiet`: told in another DM, the team owner's).
export async function teamWar(env, war, team, teamName, now = Date.now(), quiet = null) {
  const { results } = await q(env, `SELECT player, SUM(COALESCE(reported, 0) + COALESCE(credit, 0) + COALESCE(clash, 0)) AS pts FROM team_war_pts WHERE war = ? AND team = ? GROUP BY player HAVING pts > 0`, war, team).all();
  const out = [];
  for (const r of results || []) { const m = await award(env, r.player, 'teamwar', 'war' + war, { label: teamName ? 'With ' + String(teamName).slice(0, 40) : '', now, note: r.player !== quiet }); if (m) out.push(m) }
  return out;
}
// The Invite Race result went out: its winners (race.js post).
export async function raceWinners(env, raceId, list, now = Date.now()) {
  const out = [], place = ['1st', '2nd', '3rd'];
  for (let i = 0; i < list.length; i++) { const m = await award(env, list[i].id, 'race', raceId, { label: (place[i] || '#' + (i + 1)) + ' place · ' + list[i].n + ' friends', now }); if (m) out.push(m) }
  return out;
}

// ---- the game ----
const mine = (env, id) => q(env, 'SELECT * FROM medals WHERE player = ? AND sold IS NULL ORDER BY at DESC, id DESC LIMIT 100', id).all().then(r => (r.results || []).map(shape));
// Medals this player hasn't been shown yet; marks them shown. Rides on /played and /rewards for the game's "New medal" toast.
export async function fresh(env, id) {
  const { results } = await q(env, 'UPDATE medals SET seen = ? WHERE player = ? AND seen IS NULL AND sold IS NULL RETURNING *', Date.now(), id).all();
  return (results || []).map(shape);
}
// GET /medals: this player's medals and what each tier sells for.
export async function list(env, me) {
  await fresh(env, me.id);
  const sold = await q(env, 'SELECT COUNT(*) AS n, COALESCE(SUM(value), 0) AS bp FROM medals WHERE player = ? AND sold IS NOT NULL', me.id).first();
  return { medals: await mine(env, me.id), tiers: TIERS, sold: { n: sold ? sold.n : 0, bp: sold ? sold.bp : 0 }, pioneer: { weapons: Object.values(PIONEER), n: PIONEER_N } };
}
// POST /medals/sell {id}: the medal's value in BP, once; the medal leaves the card for good.
export async function sell(env, me, id, now = Date.now()) {
  id = Number(id); if (!(id > 0)) return { error: 'no such medal', status: 400 };
  const m = await q(env, 'UPDATE medals SET sold = ? WHERE id = ? AND player = ? AND sold IS NULL RETURNING *', now, id, me.id).first();
  if (!m) return { error: 'no such medal', status: 404 };
  const k = KINDS[m.kind] || KINDS.special;
  await q(env, 'INSERT INTO rewards (player, amount, reason, note, created) VALUES (?, ?, ?, ?, ?)', me.id, m.value, 'medal', k.name + (m.label ? ' · ' + m.label : ''), now).run();
  return { sold: shape(m) };
}
// The player card (GET /chat/player): someone's medals, newest first.
export const forCard = (env, id) => q(env, 'SELECT * FROM medals WHERE player = ? AND sold IS NULL ORDER BY at DESC, id DESC LIMIT 24', id).all().then(r => (r.results || []).map(m => { const s = shape(m); return { kind: s.kind, label: s.label, tier: s.tier, emo: s.emo, name: s.name } }));

// ---- admins: /medal ----
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const line = m => `${(KINDS[m.kind] || KINDS.special).emo} #${m.id} · ${esc(m.name || '')} (${m.player}) · ${(KINDS[m.kind] || KINDS.special).name}${m.label ? ' · ' + esc(m.label) : ''} · ${m.tier} ${fmt(m.value)} BP${m.sold ? ' · sold' : ''}`;
export async function command(env, arg, now = Date.now()) {
  const [a, b, c, ...rest] = String(arg || '').trim().split(/\s+/);
  if (a === 'give') {                                     // /medal give <player id> <common|rare|unique> <what for>
    const id = Number(String(b || '').replace(/^#/, '')), why = rest.join(' ').trim();
    if (!(id > 0) || !TIERS[c] || why.length < 3) return 'Use: /medal give &lt;player id&gt; &lt;common|rare|unique&gt; &lt;what for&gt;\nExample: /medal give 1234 rare First to find the secret island';
    const p = await q(env, 'SELECT id, name FROM players WHERE id = ?', id).first(); if (!p) return `No player ${id}.`;
    const m = await award(env, id, 'special', 's' + now, { label: why, tier: c, now });
    return m ? `🎖️ Medal given to ${esc(p.name)} (${id}): ${esc(why)} · ${c}, sells for ${fmt(m.value)} BP. They see it next time they open the game.` : 'Not given (a load-test bot?).';
  }
  if (a === 'take') {                                     // /medal take <medal id>: a medal given by mistake
    const id = Number(String(b || '').replace(/^#/, ''));
    const m = id > 0 && await q(env, 'DELETE FROM medals WHERE id = ? AND sold IS NULL RETURNING *', id).first();
    return m ? `Removed medal #${id} (${(KINDS[m.kind] || KINDS.special).name}${m.label ? ' · ' + esc(m.label) : ''}) from player ${m.player}.` : 'No unsold medal with that number. Use: /medal take &lt;medal id&gt; (see /medal)';
  }
  const { results } = await q(env, 'SELECT m.*, p.name FROM medals m LEFT JOIN players p ON p.id = m.player ORDER BY m.id DESC LIMIT 25').all();
  const t = await q(env, 'SELECT COUNT(*) AS n, SUM(sold IS NOT NULL) AS s, COALESCE(SUM(CASE WHEN sold IS NOT NULL THEN value END), 0) AS bp FROM medals').first();
  const pio = await Promise.all(Object.entries(PIONEER).map(async ([w, n]) => `${n} ${(await q(env, "SELECT COUNT(*) AS n FROM medals WHERE kind = 'pioneer' AND ref = ?", w).first()).n}/${PIONEER_N}`));
  return `🎖️ <b>Medals</b>: ${t.n | 0} given, ${t.s | 0} sold for ${fmt(t.bp)} BP\nPioneers: ${pio.join(' · ')}\n\n` + (results.length ? results.map(line).join('\n') : 'None yet.') +
    '\n\n/medal give &lt;player id&gt; &lt;common|rare|unique&gt; &lt;what for&gt; · /medal take &lt;medal id&gt;';
}
