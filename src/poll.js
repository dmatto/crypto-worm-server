// In-game polls (Damian 2026-11-02: "Lets create a pull in the game to decide that", after players said that holding 100K
// $CWORM all week is a bad requirement for the weekly prize). One vote per real player who finished a few matches; they can
// change it until the poll ends. The game shows the poll at the top of the weekly prize popup and the results once you voted
// (everyone sees them after the end). Load-test bots never vote. Admins read the results with /poll, holders and others apart.
//   GET /poll -> {poll}        POST /poll/vote {id, choice} -> {poll}
// The weekly prize card (/prize, index.js) carries the same {poll}, so the game needs no extra request.
const DAY = 864e5;
// from: when the card appears · ends: votes close (exclusive) · starts: when the winning option applies · played: finished
// matches needed to vote · options: what the bot shows admins (the game has its own words, in 8 languages and Telegram-safe)
export const POLLS = [
  { id: 'prize-rule', from: Date.UTC(2026, 10, 2), ends: Date.UTC(2026, 10, 7), starts: Date.UTC(2026, 10, 9), played: 3,
    title: 'Weekly prize rules from Monday 9 November',
    options: ['Holders only, as now (100K $CWORM, 3 days in a row since 11-03; it was all week)', 'Holder bonus: everyone can win, holders get 1.5x prize points',
      'Two prizes: half for the best players, half for the best holders'] },   // Damian 2026-11-02: no "open to everyone" option
];
const SHOW = 7 * DAY;   // the results stay on the card for a week after the end
const q = (env, s, ...v) => env.DB.prepare(s).bind(...v);

export const current = (now = Date.now()) => POLLS.find(p => p.from <= now && now < p.ends + SHOW) || null;

async function counts(env, p) {
  const { results } = await q(env, 'SELECT choice AS c, COUNT(*) AS n FROM poll_votes WHERE poll = ? AND player NOT IN (SELECT player FROM sim_players) GROUP BY choice', p.id).all();
  const c = p.options.map(() => 0); for (const r of results) if (r.c >= 0 && r.c < c.length) c[r.c] = r.n | 0;
  return c;
}

// What the game shows: whether this player can vote, their vote, and the counts once they voted or the poll ended.
export async function card(env, me, now = Date.now()) {
  const p = current(now); if (!p) return null;
  const open = now < p.ends;
  const meta = await q(env, 'SELECT played FROM player_meta WHERE player = ?', me.id).first();
  const mine = await q(env, 'SELECT choice FROM poll_votes WHERE poll = ? AND player = ?', p.id, me.id).first();
  const played = meta ? meta.played | 0 : 0, voted = mine ? mine.choice : null;
  const out = { id: p.id, n: p.options.length, ends: p.ends, starts: p.starts, open, need: p.played, played: Math.min(played, p.played), can: open && played >= p.played, mine: voted };
  if (voted != null || !open) { out.counts = await counts(env, p); out.total = out.counts.reduce((a, b) => a + b, 0) }
  return out;
}

export async function handle(path, env, me, body, { post, sim }, now = Date.now()) {
  if (path === '/poll' && !post) return { poll: await card(env, me, now) };
  if (path !== '/poll/vote' || !post) return null;
  if (sim) return { error: 'not for test players', status: 403 };
  const p = current(now), choice = Number(body.choice);
  if (!p || body.id !== p.id) return { error: 'this poll is over', status: 404 };
  if (now >= p.ends) return { error: 'voting is closed', status: 409 };
  if (!Number.isInteger(choice) || choice < 0 || choice >= p.options.length) return { error: 'pick one of the options', status: 400 };
  const meta = await q(env, 'SELECT played FROM player_meta WHERE player = ?', me.id).first();
  if (!meta || (meta.played | 0) < p.played) return { error: `finish ${p.played} matches to vote`, status: 403 };
  await q(env, 'INSERT INTO poll_votes (poll, player, choice, at) VALUES (?, ?, ?, ?) ON CONFLICT(poll, player) DO UPDATE SET choice = excluded.choice, at = excluded.at',
    p.id, me.id, choice, now).run();
  return { poll: await card(env, me, now) };
}

// Two accounts become one (index.js link): the target's own vote wins.
export async function mergePoll(env, a, b) {
  await env.DB.batch([q(env, 'INSERT OR IGNORE INTO poll_votes (poll, player, choice, at) SELECT poll, ?, choice, at FROM poll_votes WHERE player = ?', b, a),
    q(env, 'DELETE FROM poll_votes WHERE player = ?', a)]);
}

// /poll (admins): the latest poll's votes per option, holders (Holder tier on the linked wallet) and everyone else apart.
const pct = (n, t) => t ? Math.round(n * 100 / t) + '%' : '0%';
const when = t => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export async function resultsText(env, now = Date.now()) {
  const p = current(now) || [...POLLS].reverse().find(x => x.from <= now) || POLLS[0];
  const { results } = await q(env, `SELECT v.choice AS c, COALESCE(h.tier, 0) >= 1 AS holder, COUNT(*) AS n FROM poll_votes v JOIN players pl ON pl.id = v.player
    LEFT JOIN holders h ON h.player = v.player AND h.wallet = pl.wallet WHERE v.poll = ? AND v.player NOT IN (SELECT player FROM sim_players) GROUP BY c, holder`, p.id).all();
  const row = p.options.map(() => ({ h: 0, o: 0 }));
  for (const r of results) if (row[r.c]) row[r.c][r.holder ? 'h' : 'o'] += r.n | 0;
  const tot = row.reduce((a, r) => a + r.h + r.o, 0), th = row.reduce((a, r) => a + r.h, 0);
  const can = await q(env, 'SELECT COUNT(*) AS n FROM player_meta WHERE played >= ? AND last_seen > ? AND player NOT IN (SELECT player FROM sim_players)', p.played, now - 7 * DAY).first();
  const best = Math.max(...row.map(r => r.h + r.o)), lead = tot ? row.map((r, i) => r.h + r.o === best ? i : -1).filter(i => i >= 0) : [];
  const state = now < p.from ? `Opens ${when(p.from)}` : now < p.ends ? `Open until ${when(p.ends - 1)} 23:59 UTC` : `Closed ${when(p.ends - 1)}`;
  return `🗳️ <b>Poll: ${p.title}</b>\n${state}\n\nVotes: ${tot} (holders ${th}, others ${tot - th})\nCould vote (${p.played}+ matches, seen in the last 7 days): ${can ? can.n | 0 : 0}\n\n` +
    p.options.map((o, i) => `${i + 1}. ${o}\n    <b>${row[i].h + row[i].o}</b> (${pct(row[i].h + row[i].o, tot)}) · holders ${row[i].h}, others ${row[i].o}`).join('\n') +
    (lead.length ? `\n\n${lead.length > 1 ? 'Tied' : 'Leading'}: ${lead.map(i => i + 1 + '. ' + p.options[i].split(':')[0].split(' (')[0]).join(' and ')}` : '');
}
