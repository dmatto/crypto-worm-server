// Team Prize (Damian 2026-11-03: "un premio jugoso para grupos sin ser holders ... Así los jugadores tratan de traer amigos al
// juego para poder ganarlo", 50 USDC), a 4-week test from the week of Monday 9 November (first paid Monday 16 November).
// Each week the #1 team wins TP_USDC, split equally between its active members. The ranking is the weekly team points (teams.js:
// the members' capped play money plus rival wins) of real players only, so the load-test bot teams can never win. Active members:
// still in the team when the list is made, scored for it that week, finished matches on TP_DAYS different UTC days that week,
// an account TP_AGE days old by the Monday payout and a linked Solana wallet; not taken out by an admin (/prize skip) and not a
// team wallet. Members who don't qualify get nothing and the others share it; a team with no active member passes the prize to
// the next one. No $CWORM needed. Damian pays by hand from /prize teams; the Monday group post names the winner (no amounts or
// token names in Telegram). Separate from the weekly 1 SOL prize (prize.js).
import { weekStart } from './growth.js';
import { teamWallets } from './prize.js';

export const TP_USDC = 50, TP_FROM = Date.UTC(2026, 10, 9), TP_WEEKS = 4, TP_DAYS = 3, TP_AGE = 8;
const DAY = 864e5, WEEK = 7 * DAY;
export const tpOn = w => w >= TP_FROM && w < TP_FROM + TP_WEEKS * WEEK;
const q = (env, s, ...v) => env.DB.prepare(s).bind(...v);

// One member's place in the prize for week `w`: what they still need.
export function memberCheck(m, w, team) {
  const age = m.created <= w + WEEK - TP_AGE * DAY, out = [];
  if (m.sim) out.push('load-test bot');
  if (m.skipped) out.push('taken out by an admin');
  if (m.wallet && team.has(m.wallet)) out.push('team wallet');
  if (!(m.pts > 0)) out.push('no points for the team this week');
  if ((m.days | 0) < TP_DAYS) out.push(`played on ${m.days | 0} of ${TP_DAYS} days`);
  if (!age) out.push(`account ${Math.max(0, Math.floor((w + WEEK - m.created) / DAY))} days old at payout, needs ${TP_AGE}`);
  if (!m.wallet) out.push('no wallet linked');
  return out;
}
async function members(env, team, w) {
  const { results } = await q(env, `SELECT p.id, p.name, p.wallet, p.created, p.tg_id, COALESCE(tp.pts, 0) AS pts,
      (SELECT COUNT(*) FROM play_days d WHERE d.player = p.id AND d.day >= ? AND d.day < ?) AS days,
      EXISTS (SELECT 1 FROM sim_players s WHERE s.player = p.id) AS sim, EXISTS (SELECT 1 FROM prize_skip k WHERE k.player = p.id) AS skipped
      FROM team_members m JOIN players p ON p.id = m.player LEFT JOIN team_points tp ON tp.team = m.team AND tp.player = m.player AND tp.week_start = ?
      WHERE m.team = ? ORDER BY pts DESC, m.joined ASC`, Math.floor(w / DAY), Math.floor(w / DAY) + 7, w, team).all();
  return results;
}

// The prize of week `w`: the top teams by real players' points, the first one with an active member wins, and each active
// member's share in USDC (whole cents, rounded down; the cents left over are shown).
export async function teamPrize(env, w) {
  const { results: top } = await q(env, `SELECT t.id, t.name, t.tag, t.emoji, SUM(p.pts) AS pts FROM team_points p JOIN teams t ON t.id = p.team
      WHERE p.week_start = ? AND p.player NOT IN (SELECT player FROM sim_players) GROUP BY t.id HAVING pts > 0 ORDER BY pts DESC, t.created ASC LIMIT 10`, w).all();
  const team = teamWallets(env), passed = [];
  for (const t of top) {
    const all = (await members(env, t.id, w)).map(m => ({ ...m, why: memberCheck(m, w, team) }));
    const active = all.filter(m => !m.why.length);
    if (!active.length) { passed.push({ ...t, pts: t.pts | 0, members: all.length }); continue }
    const share = Math.floor(TP_USDC * 100 / active.length) / 100;
    return { week: w, on: tpOn(w), winner: { ...t, pts: t.pts | 0 }, active: active.map(m => ({ ...m, usdc: share })), others: all.filter(m => m.why.length),
      share, left: Math.round((TP_USDC - share * active.length) * 100) / 100, passed, teams: top.length };
  }
  return { week: w, on: tpOn(w), winner: null, active: [], others: [], share: 0, left: 0, passed, teams: top.length };
}

// What the game shows a member about their own place this week (GET /teams/<id> of their own team).
export async function myTeamPrize(env, me, team, now = Date.now()) {
  const w = weekStart(now), m = (await members(env, team, w)).find(x => x.id === me.id); if (!m) return null;
  return { on: tpOn(w), from: TP_FROM, until: TP_FROM + TP_WEEKS * WEEK, days: Math.min(TP_DAYS, m.days | 0), need: TP_DAYS, wallet: !!m.wallet, pts: m.pts > 0,
    age: m.created <= w + WEEK - TP_AGE * DAY, minAge: TP_AGE, active: !memberCheck(m, w, teamWallets(env)).length };
}

// /prize teams (admins): the winner of week `w`, its active members' wallets and shares, and why the others get nothing.
export async function teamPrizeText(env, w, now = Date.now()) {
  const d = t => new Date(t).toISOString().slice(0, 10), fmt = n => Number(n).toLocaleString('en-US'), esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const r = await teamPrize(env, w), head = `🛡️ Team Prize ${d(w)} to ${d(w + 6 * DAY)}${now < w + WEEK ? ' (still running)' : ''}` +
    (r.on ? `\n${TP_USDC} USDC for the #1 team, split between its active members.` : `\n⚠️ The test runs ${TP_WEEKS} weeks from ${d(TP_FROM)}: this week has no Team Prize.`);
  const passed = r.passed.length ? `\n\nPassed over (no active member): ${r.passed.map(t => `${esc(t.emoji)} ${esc(t.name)} [${esc(t.tag)}] ${fmt(t.pts)} pts`).join(', ')}` : '';
  if (!r.winner) return head + '\n\n' + (r.teams ? 'No team has an active member yet.' : 'No team has scored yet.') + passed;
  const w0 = r.winner;
  return head + `\n\n🏆 ${esc(w0.emoji)} <b>${esc(w0.name)}</b> [${esc(w0.tag)}] (id ${w0.id}) · ${fmt(w0.pts)} points (real players)\n` +
    `${r.active.length} active ${r.active.length === 1 ? 'member' : 'members'}: ${r.share} USDC each` + (r.left ? ` (${r.left} USDC left over from rounding)` : '') + '\n\n' +
    r.active.map((m, i) => `${i + 1}. ${esc(m.name)} (id ${m.id}) · ${fmt(m.pts)} pts · ${m.days} days · ${r.share} USDC\n    <code>${esc(m.wallet)}</code>`).join('\n') +
    (r.others.length ? `\n\nNo share: ${r.others.map(m => `${esc(m.name)} (${m.why.join(', ')})`).join('; ')}` : '') + passed +
    '\n\nPay by hand in USDC on Solana. /prize skip &lt;id&gt; takes a member out (scripts, shared accounts); the others then share more.' +
    `\n\nPayout lines (wallet,USDC):\n<code>${r.active.map(m => m.wallet + ',' + r.share).join('\n')}</code>`;
}

// The Monday post in the community group: last week's winning team, without amounts or token names (Telegram).
export async function teamPrizePost(env, w) {
  if (!tpOn(w)) return '';
  const r = await teamPrize(env, w).catch(() => null); if (!r || !r.winner) return '';
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return `🏆 <b>Team prize of last week</b>: ${esc(r.winner.emoji)} <b>${esc(r.winner.name)}</b> [${esc(r.winner.tag)}] wins! It goes to its ${r.active.length} active ${r.active.length === 1 ? 'player' : 'players'}. Build your team and bring your friends for this week's prize.`;
}
