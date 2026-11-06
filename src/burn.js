// Community burn teaser (Damian 2026-10-23: "make the burn bar visible in the main lobby, but with a coming soon message, let's
// see how the community reacts"). Nothing is burned yet: the Home bar shows 0 of the goal, and its card has an "I want this"
// button. One row per player who opened the card; admins read the reaction with /burnvotes. Load-test bots never count.
//   GET /burn, POST /burn/open, /burn/vote   -> {soon, burned, goal, votes, mine}
export const BURN_GOAL = 1000000;
const DAY = 864e5;

export async function handle(path, env, me, method, sim) {
  const now = Date.now();
  if (path === '/burn' && method === 'GET') return status(env, me.id);
  if (path === '/burn/open' && method === 'POST') {
    if (!sim) await env.DB.prepare('INSERT OR IGNORE INTO burn_votes (player, opened) VALUES (?, ?)').bind(me.id, now).run();
    return status(env, me.id);
  }
  if (path === '/burn/vote' && method === 'POST') {
    if (!sim) await env.DB.prepare('INSERT INTO burn_votes (player, opened, want) VALUES (?, ?, ?) ON CONFLICT(player) DO UPDATE SET want = excluded.want WHERE want = 0')
      .bind(me.id, now, now).run();
    return status(env, me.id);
  }
  return null;
}

async function status(env, player) {
  const r = await env.DB.prepare('SELECT SUM(want > 0) AS n, MAX(player = ? AND want > 0) AS mine FROM burn_votes').bind(player).first();
  return { soon: true, burned: 0, goal: BURN_GOAL, votes: r && r.n | 0, mine: !!(r && r.mine) };
}

// /burnvotes (admins): how many opened the card, how many want it, out of the players active this week, and votes by UTC day.
export async function votesText(env, now = Date.now()) {
  const t = await env.DB.prepare('SELECT COUNT(*) AS opened, SUM(want > 0) AS want FROM burn_votes').first();
  const a = await env.DB.prepare('SELECT COUNT(*) AS n FROM player_meta WHERE last_seen > ? AND played >= 1 AND player NOT IN (SELECT player FROM sim_players)').bind(now - 7 * DAY).first();
  const { results } = await env.DB.prepare("SELECT strftime('%Y-%m-%d', want / 1000, 'unixepoch') AS d, COUNT(*) AS n FROM burn_votes WHERE want > 0 GROUP BY d ORDER BY d DESC LIMIT 14").all();
  const opened = t.opened | 0, want = t.want | 0, pct = opened ? Math.round(want * 100 / opened) : 0;
  return '🔥 <b>Community burn teaser</b>\n\n' +
    `Opened the card: ${opened} players\nTapped "I want this": ${want} (${pct}% of those who opened it)\nActive players, last 7 days: ${a.n | 0}` +
    (results.length ? '\n\n<b>"I want this" by day (UTC)</b>\n' + results.map(r => `${r.d}: ${r.n}`).join('\n') : '');
}
