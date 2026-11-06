// Invite Race (Damian 2026-11-06: "The player that gets more referrals till x day gets a reward. Needs to refer a new player, with
// wallet linked and play at least 3 games"; he chose 1 SOL for the top 3). From Monday 9 to Sunday 22 November (UTC) players race to
// bring the most new players. A friend counts once they:
//   - joined through the player's friend link as a brand-new account during the race (player_meta.invited_by, growth.js),
//   - linked a Solana wallet (one account per wallet, so no two friends share one), and
//   - finished RACE.matches matches the server saw start and end (run_log: 20 s or longer, not the tutorial or mini games).
// The moment a friend counts is saved in race_friends (after each match, after a wallet sign-in, and by the quarter-hour sweep). The
// top 3 with at least RACE.min friends win RACE.prizes SOL, paid by an admin with /pay after a check; a tie goes to whoever got
// there first. Load-test bots, admins and anyone an admin takes out (/race skip) never count, as inviters or as friends.
//   GET /race  -> {on, state: soon|on|over, start, end, min, matches, prizes, unit, rules, top: [{rank, id, name, n}],
//                  me: {rank, n, friends: [{name, wallet, matches, counted}]}}
// Admins in the bot: /race (standings and the /pay lines), /race check <id> (that player's friends, with on-chain and timing flags),
// /race skip <id> [why], /race unskip <id>, /race post (the standings, or the winners once it's over, to the community group).
import { rpc } from './holders.js';
import { gameLink } from './growth.js';

export const RACE = { id: 'r1', start: Date.UTC(2026, 10, 9), end: Date.UTC(2026, 10, 23), show: Date.UTC(2026, 10, 6), until: Date.UTC(2026, 10, 30),
  prizes: [0.5, 0.3, 0.2], unit: 'SOL', min: 3, matches: 3, top: 10 };
export const RULES = 'https://play.cryptoworm.io/race.html';
const q = (env, s, ...v) => env.DB.prepare(s).bind(...v);
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const admins = env => String(env.ADMIN_PLAYERS || '').split(',').map(Number).filter(n => n > 0);
export const stateOf = (now = Date.now(), R = RACE) => now < R.start ? 'soon' : now < R.end ? 'on' : 'over';
export const raceOn = (now = Date.now(), R = RACE) => now >= R.show && now < R.until;
// Players who can neither win nor count as a friend: load-test bots, admins and the ones taken out with /race skip.
const OUT = `(SELECT player FROM sim_players UNION SELECT player FROM race_skip WHERE race = ?1)`;

// Does this player count as a friend now? Saves the moment once; true when it was saved by this call.
export async function check(env, id, now = Date.now(), R = RACE) {
  if (now < R.start || now >= R.end || !id) return false;
  const f = await q(env, `SELECT p.id, p.created, p.wallet, m.invited_by AS by FROM players p JOIN player_meta m ON m.player = p.id WHERE p.id = ?`, id).first();
  if (!f || !f.by || f.by === f.id || !f.wallet || f.created < R.start || f.created >= R.end) return false;
  const ok = await q(env, `SELECT (SELECT 1 FROM players WHERE id = ?2) AS inv, (SELECT COUNT(*) FROM run_log WHERE player = ?3 AND at >= ?4 AND at < ?5) AS n,
      (SELECT 1 FROM ${OUT} WHERE player IN (?2, ?3)) AS out, (SELECT 1 FROM race_friends WHERE race = ?1 AND friend = ?3) AS done`, R.id, f.by, f.id, R.start, R.end).first();
  if (!ok || !ok.inv || ok.out || ok.done || ok.n < R.matches || admins(env).includes(f.by)) return false;
  const r = await q(env, 'INSERT OR IGNORE INTO race_friends (race, friend, inviter, at) VALUES (?, ?, ?, ?)', R.id, f.id, f.by, now).run();
  return !!(r && (r.meta ? r.meta.changes : r.changes));
}
// The quarter-hour backup for a friend a hook missed (a match that ended while the server was busy, a wallet linked by a merge).
export async function sweep(env, now = Date.now(), R = RACE) {
  if (now < R.start || now >= R.end) return 0;
  const { results } = await q(env, `SELECT p.id FROM players p JOIN player_meta m ON m.player = p.id WHERE m.invited_by IS NOT NULL AND p.wallet IS NOT NULL
      AND p.created >= ? AND p.created < ? AND NOT EXISTS (SELECT 1 FROM race_friends r WHERE r.race = ? AND r.friend = p.id) LIMIT 300`, R.start, R.end, R.id).all();
  let n = 0; for (const r of results) if (await check(env, r.id, now, R)) n++;
  return n;
}

// Inviters by counted friends, most first; a tie goes to whoever reached their count first.
export async function board(env, now = Date.now(), R = RACE) {
  const { results } = await q(env, `SELECT r.inviter AS id, p.name, p.wallet, COUNT(*) AS n, MAX(r.at) AS last FROM race_friends r JOIN players p ON p.id = r.inviter
      JOIN players f ON f.id = r.friend WHERE r.race = ?1 AND r.at < ?2 AND r.inviter NOT IN ${OUT} AND r.friend NOT IN ${OUT}
      GROUP BY r.inviter ORDER BY n DESC, last ASC, r.inviter ASC`, R.id, Math.min(now + 1, R.end)).all();
  const ad = admins(env);
  return results.filter(r => !ad.includes(r.id)).map((r, i) => ({ rank: i + 1, ...r }));
}
// Who wins: the first places with at least R.min friends, one prize each.
export const winners = (rows, R = RACE) => rows.filter(r => r.n >= R.min).slice(0, R.prizes.length).map((r, i) => ({ ...r, prize: R.prizes[i] }));

// The player's friends who joined during the race, and what each still needs.
async function myFriends(env, me, now, R) {
  const { results } = await q(env, `SELECT p.id, p.name, p.wallet IS NOT NULL AS w, (SELECT COUNT(*) FROM run_log l WHERE l.player = p.id AND l.at >= ?1 AND l.at < ?2) AS n,
      (SELECT 1 FROM race_friends r WHERE r.race = ?3 AND r.friend = p.id) AS ok FROM player_meta m JOIN players p ON p.id = m.player
      WHERE m.invited_by = ?4 AND p.created >= ?1 AND p.created < ?2 ORDER BY p.created DESC LIMIT 30`, R.start, R.end, R.id, me.id).all();
  for (const f of results) if (!f.ok && f.w && f.n >= R.matches && await check(env, f.id, now, R)) f.ok = 1;   // caught up here too
  return results.map(f => ({ name: f.name, wallet: !!f.w, matches: Math.min(f.n, R.matches), counted: !!f.ok }));
}

export async function handle(path, env, me, now = Date.now(), R = RACE) {
  if (path !== '/race') return null;
  if (!raceOn(now, R) && !(me && admins(env).includes(me.id))) return { on: false };
  const friends = me ? await myFriends(env, me, now, R) : null;                     // first: it may count a friend on the spot
  const rows = await board(env, now, R), mine = me && rows.find(r => r.id === me.id);
  return { on: true, state: stateOf(now, R), start: R.start, end: R.end, min: R.min, matches: R.matches, prizes: R.prizes, unit: R.unit, rules: RULES,
    top: rows.slice(0, R.top).map(r => ({ rank: r.rank, id: r.id, name: r.name, n: r.n })),
    me: me ? { rank: mine ? mine.rank : null, n: mine ? mine.n : 0, friends } : null };
}

// An inviter folded into another account (index.js link): their race friends move with them.
export async function mergeRace(env, from, to) {
  await env.DB.batch([q(env, 'UPDATE race_friends SET inviter = ? WHERE inviter = ?', to, from), q(env, 'UPDATE OR IGNORE race_skip SET player = ? WHERE player = ?', to, from)]);
}

// ---- admins ----
const day = t => new Date(t).toISOString().slice(5, 16).replace('T', ' ');
const nice = t => new Date(t).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });   // Sunday 22 November
const ends = R => nice(R.end - 60e3) + ', 23:59 UTC', starts = R => nice(R.start) + ', 00:00 UTC';
const short = w => w ? w.slice(0, 4) + '…' + w.slice(-4) : 'no wallet';
// A wallet on Solana: how many transactions it has (up to 1000), when the first one was, and who paid for it (the funder).
async function chain(env, wallet) {
  try {
    const s = (await rpc(env, { jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [wallet, { limit: 1000 }] })).result || [];
    if (!s.length) return { n: 0 };
    const first = s[s.length - 1], t = (await rpc(env, { jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [first.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }] })).result;
    const keys = t && t.transaction && t.transaction.message && t.transaction.message.accountKeys || [];
    const payer = keys[0] && (keys[0].pubkey || keys[0]);
    return { n: s.length, first: first.blockTime ? first.blockTime * 1000 : null, funder: payer && payer !== wallet ? payer : null };
  } catch (e) { return { err: String(e && e.message || e).slice(0, 80) } }
}

// /race check <id>: that inviter's friends, oldest first, with what looks off.
async function checkText(env, id, now, R) {
  const p = await q(env, 'SELECT id, name, wallet FROM players WHERE id = ?', id).first();
  if (!p) return `No player with ID ${id}.`;
  const { results } = await q(env, `SELECT p.id, p.name, p.wallet, p.created, p.tg_id, r.at, (SELECT COUNT(*) FROM run_log l WHERE l.player = p.id AND l.at >= ?1 AND l.at < ?2) AS n,
      (SELECT 1 FROM race_skip s WHERE s.race = ?3 AND s.player = p.id) AS skip FROM player_meta m JOIN players p ON p.id = m.player
      LEFT JOIN race_friends r ON r.race = ?3 AND r.friend = p.id WHERE m.invited_by = ?4 AND p.created >= ?1 AND p.created < ?2 ORDER BY p.created LIMIT 40`, R.start, R.end, R.id, id).all();
  if (!results.length) return `🏁 ${esc(p.name)} (${id}) has no friends who joined during the race.`;
  const mine = p.wallet ? await chain(env, p.wallet) : null, info = [];
  for (const f of results) info.push(f.wallet ? await chain(env, f.wallet) : null);
  const funders = new Map(); info.forEach(c => { if (c && c.funder) funders.set(c.funder, (funders.get(c.funder) || 0) + 1) });
  const wallets = new Set(results.map(f => f.wallet).filter(Boolean));
  const lines = results.map((f, i) => {
    const c = info[i], flags = [];
    if (f.skip) flags.push('🚫 taken out');
    if (c && c.n === 0) flags.push('empty wallet, never used');
    if (c && c.funder && (c.funder === p.wallet || (mine && mine.funder && c.funder === mine.funder))) flags.push('funded by the inviter');
    else if (c && c.funder && wallets.has(c.funder)) flags.push('funded by another friend');
    else if (c && c.funder && funders.get(c.funder) > 1) flags.push(`same funder as ${funders.get(c.funder) - 1} other friend(s)`);
    if (c && c.first && c.first > f.created - 864e5) flags.push('wallet made today');
    const near = results.filter(g => g !== f && Math.abs(g.created - f.created) < 10 * 60e3).length;
    if (near) flags.push(`joined within 10 min of ${near} other(s)`);
    if (f.tg_id == null) flags.push('no Telegram');
    if (c && c.err) flags.push('chain check failed');
    return `${f.at ? '✅' : '⏳'} ${f.id} ${esc(f.name)} · joined ${day(f.created)} · ${Math.min(f.n, R.matches)}/${R.matches} matches · ${short(f.wallet)}${c && c.n != null ? ` (${c.n >= 1000 ? '1000+' : c.n} tx)` : ''}` +
      (flags.length ? '\n    ⚠️ ' + flags.join(', ') : '');
  });
  return `🏁 Friends of ${esc(p.name)} (${id}) who joined during the race: ${results.filter(f => f.at).length} count of ${results.length}\n\n` + lines.join('\n') +
    '\n\n⚠️ flags are hints to look at, not proof. /race skip &lt;id&gt; takes a friend or the inviter out.';
}

async function standings(env, now, R) {
  const rows = await board(env, now, R), win = winners(rows, R), st = stateOf(now, R);
  const head = st === 'soon' ? `🏁 Invite Race starts ${starts(R)}.` : st === 'on' ? `🏁 Invite Race, ends ${ends(R)}.` : '🏁 Invite Race is over.';
  if (!rows.length) return head + '\nNo friends counted yet.';
  const lines = rows.slice(0, R.top).map(r => `${r.rank}. ${esc(r.name)} (${r.id}) · ${r.n} friend${r.n === 1 ? '' : 's'}${r.wallet ? '' : ' · ⚠️ no wallet'}`);
  const pay = win.filter(w => w.wallet).map(w => `${w.wallet} ${w.prize} ${R.unit} Invite Race #${w.rank} ${w.name}`.slice(0, 120));
  return head + '\n\n' + lines.join('\n') + `\n\nTo win: top ${R.prizes.length} with at least ${R.min} friends. /race check &lt;id&gt; before paying.` +
    (st === 'over' && pay.length ? '\n\nAfter the checks, send this to pay:\n<code>/pay new Invite Race\n' + esc(pay.join('\n')) + '</code>' : '');
}

async function post(env, now, R, tg) {
  const g = await q(env, "SELECT v FROM bot_kv WHERE k = 'group'").first().catch(() => null);
  const chat = env.PRIZE_GROUP || (g && g.v) || '@CryptoWorm_Group', rows = await board(env, now, R), st = stateOf(now, R);
  const medal = ['🥇', '🥈', '🥉'];
  const list = (st === 'over' ? winners(rows, R) : rows.slice(0, 5)).map((r, i) => `${medal[i] || (i + 1) + '.'} ${esc(r.name)} · ${r.n} friend${r.n === 1 ? '' : 's'}`);
  const text = st === 'over'
    ? (list.length ? `🏁 Invite Race winners!\n\n${list.join('\n')}\n\nThank you for bringing new worms to the battle. Prizes go out after the fair-play check. 🪱` : '🏁 The Invite Race is over. Nobody reached the minimum this time.')
    : `🏁 Invite Race standings\n\n${list.join('\n') || 'Nobody yet: be the first!'}\n\nBring new players with your invite link: each one who links a wallet and plays ${R.matches} matches counts. Ends ${ends(R)}.`;
  const r = await tg(env, 'sendMessage', { chat_id: /^-?\d+$/.test(chat) ? Number(chat) : chat, text, parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: '🎮 Play', url: gameLink(env) }, { text: '📜 Rules', url: RULES }]] } });
  return r && r.ok ? 'Posted in the community group.' : 'The group post did not go out: is the bot set up in the group (/setgroup)?';
}

// /race [check <id> | skip <id> [why] | unskip <id> | post]
export async function command(env, arg, { by, tg } = {}, now = Date.now(), R = RACE) {
  const [a, b, ...rest] = String(arg || '').trim().split(/\s+/), id = Number(String(b || '').replace(/^#/, ''));
  if (!a) return standings(env, now, R);
  if (a === 'check' && id > 0) return checkText(env, id, now, R);
  if (a === 'skip' && id > 0) { await q(env, 'INSERT OR REPLACE INTO race_skip (race, player, at, why) VALUES (?, ?, ?, ?)', R.id, id, now, rest.join(' ').slice(0, 200) || null).run(); return `🚫 Player ${id} is out of the Invite Race (as inviter and as friend). /race unskip ${id} undoes it.` }
  if (a === 'unskip' && id > 0) { await q(env, 'DELETE FROM race_skip WHERE race = ? AND player = ?', R.id, id).run(); return `✅ Player ${id} is back in the Invite Race.` }
  if (a === 'post' && tg) return post(env, now, R, tg);
  return 'Use: /race · /race check &lt;id&gt; · /race skip &lt;id&gt; [why] · /race unskip &lt;id&gt; · /race post';
}
