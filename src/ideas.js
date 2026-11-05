// Ideas & polls (Damian 2026-11-05: "I want the players to be able to propose weapons, changes in the game and things for the
// game in general. After my approval the proposal becomes a poll ... Also load my polls to the players to decide").
// A Home row in the game opens two tabs. Propose: a player who finished 3 matches sends a type, a title and a short description
// (one idea a UTC day, at most 3 waiting). Every idea reaches the admins as a bot message with Approve and Reject buttons, and
// nothing is public before that (an admin can fix the wording first with /idea edit). Approved, it becomes a Yes/No poll for 7
// days, and the author gets +500 play money and a bot note. Admins post their own polls with /newpoll (2 to 4 options, or
// Yes/No). Vote: one vote per real player with a finished match, changeable while the poll runs; the results show once you
// voted, and to everyone after the end. Admins tag polls Planned, Done or Not now; Done pays the author +2,000 once.
// Load-test bots never vote or propose, and their votes would not count anyway.
//   GET /ideas -> {open, closed, mine, me}     POST /ideas/propose {kind, title, text}, POST /ideas/vote {id, choice} -> the same
// Bot (admins): the buttons (callback data idea:ok:<id> / idea:no:<id>), /ideas, /idea ok|no|edit|tag|end|del <id>, /newpoll.
import { tg, adminTgIds } from './bot.js';
import { gameLink } from './growth.js';

const DAY = 864e5;
export const OPEN_DAYS = 7, NEED_PROPOSE = 3, NEED_VOTE = 1, MAX_WAITING = 3, POLL_REWARD = 500, DONE_REWARD = 2000;
export const KINDS = ['weapon', 'change', 'other'], TAGS = ['planned', 'done', 'notnow'];
const TITLE_MAX = 70, TEXT_MAX = 300, Q_MAX = 120, OPT_MAX = 40;
const ICON = { weapon: '🔫 Weapon', change: '🛠️ Game change', other: '💬 Other', poll: '🗳️ Team poll' };
const TAGNAME = { planned: '🛠️ Planned', done: '✅ Done', notnow: '⏸️ Not now' };
const q = (env, s, ...v) => env.DB.prepare(s).bind(...v);
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const fmt = n => Number(n).toLocaleString('en-US');
const changed = r => !!(r && (r.meta ? r.meta.changes : r.changes));
// one line of plain text: no control characters, no runs of spaces
export const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const optionsOf = r => { if (!r || !r.options) return null; try { const o = JSON.parse(r.options); return Array.isArray(o) && o.length >= 2 ? o.map(String) : null } catch { return null } };
const size = r => (optionsOf(r) || ['Yes', 'No']).length;
const dayStart = now => Math.floor(now / DAY) * DAY;
const SELECT = 'SELECT i.*, p.name AS author, p.tg_id AS author_tg FROM ideas i LEFT JOIN players p ON p.id = i.player';
const byId = (env, id) => q(env, SELECT + ' WHERE i.id = ?', id).first();

// Votes per option of these polls, without the load-test bots.
async function counts(env, rows) {
  const out = new Map(rows.map(r => [r.id, Array(size(r)).fill(0)]));
  if (!rows.length) return out;
  const { results } = await q(env, `SELECT idea, choice AS c, COUNT(*) AS n FROM idea_votes WHERE idea IN (${rows.map(() => '?').join(',')})
    AND player NOT IN (SELECT player FROM sim_players) GROUP BY idea, choice`, ...rows.map(r => r.id)).all();
  for (const r of results) { const c = out.get(r.idea); if (c && r.c >= 0 && r.c < c.length) c[r.c] = r.n | 0 }
  return out;
}

// What the game shows for one poll: its votes only once this player voted, or after the end.
function view(r, c, mine, now) {
  const open = r.state === 'open' && now < r.ends;
  const o = { id: r.id, kind: r.kind, team: !!r.team, by: r.team ? null : (r.author || 'Worm'), title: r.title, text: r.text || '', options: optionsOf(r), open, ends: r.ends, tag: r.tag || null, mine: mine == null ? null : mine };
  if (mine != null || !open) { o.counts = c || Array(size(r)).fill(0); o.total = o.counts.reduce((a, b) => a + b, 0) }
  return o;
}

// Everything the screen needs in one answer.
export async function list(env, me, now = Date.now()) {
  const meta = await q(env, 'SELECT played FROM player_meta WHERE player = ?', me.id).first();
  const played = meta ? meta.played | 0 : 0;
  const open = (await q(env, SELECT + " WHERE i.state = 'open' AND i.ends > ? ORDER BY i.team DESC, i.opened DESC, i.id DESC LIMIT 30", now).all()).results;
  const closed = (await q(env, SELECT + ` WHERE i.state = 'open' AND i.ends <= ? AND (i.ends > ? OR (i.tag IN ('planned', 'done') AND i.ends > ?)) ORDER BY i.ends DESC LIMIT 20`,
    now, now - 30 * DAY, now - 120 * DAY).all()).results;
  const all = [...open, ...closed], votes = new Map();
  if (all.length) for (const v of (await q(env, `SELECT idea, choice FROM idea_votes WHERE player = ? AND idea IN (${all.map(() => '?').join(',')})`, me.id, ...all.map(r => r.id)).all()).results) votes.set(v.idea, v.choice);
  const c = await counts(env, all.filter(r => votes.has(r.id) || r.ends <= now));
  const { results: myRows } = await q(env, "SELECT id, kind, title, state, note, tag, ends, created FROM ideas WHERE player = ? AND team = 0 AND state != 'gone' ORDER BY created DESC LIMIT 10", me.id).all();
  const today = myRows.filter(r => r.created >= dayStart(now)).length, waiting = myRows.filter(r => r.state === 'wait').length;
  const why = played < NEED_PROPOSE ? 'matches' : today ? 'today' : waiting >= MAX_WAITING ? 'waiting' : null;
  return {
    open: open.map(r => view(r, c.get(r.id), votes.get(r.id), now)),
    closed: closed.map(r => view(r, c.get(r.id), votes.get(r.id), now)),
    mine: myRows.map(r => ({ id: r.id, kind: r.kind, title: r.title, state: r.state === 'open' ? (r.ends > now ? 'live' : 'closed') : r.state, note: r.note || null, tag: r.tag || null, ends: r.ends })),
    me: { played, needPropose: NEED_PROPOSE, needVote: NEED_VOTE, canVote: played >= NEED_VOTE, canPropose: !why, why, days: OPEN_DAYS, reward: POLL_REWARD, done: DONE_REWARD },
  };
}

export async function handle(path, env, me, body, { post, sim, wait }, now = Date.now()) {
  if (path === '/ideas' && !post) return list(env, me, now);
  if (!post || (path !== '/ideas/propose' && path !== '/ideas/vote')) return null;
  if (sim) return { error: 'not for test players', status: 403 };
  const meta = await q(env, 'SELECT played FROM player_meta WHERE player = ?', me.id).first(), played = meta ? meta.played | 0 : 0;
  if (path === '/ideas/vote') {
    const id = Number(body.id), choice = Number(body.choice);
    const r = Number.isInteger(id) ? await byId(env, id) : null;
    if (!r || r.state !== 'open') return { error: 'this poll is over', status: 404 };
    if (now >= r.ends) return { error: 'voting is closed', status: 409 };
    if (!Number.isInteger(choice) || choice < 0 || choice >= size(r)) return { error: 'pick one of the options', status: 400 };
    if (played < NEED_VOTE) return { error: 'finish a match to vote', status: 403 };
    await q(env, 'INSERT INTO idea_votes (idea, player, choice, at) VALUES (?, ?, ?, ?) ON CONFLICT(idea, player) DO UPDATE SET choice = excluded.choice, at = excluded.at', id, me.id, choice, now).run();
    return list(env, me, now);
  }
  const kind = KINDS.includes(body.kind) ? body.kind : null, title = clean(body.title, TITLE_MAX), text = clean(body.text, TEXT_MAX);
  if (!kind) return { error: 'pick a type', status: 400 };
  if (title.length < 4) return { error: 'write a short title', status: 400 };
  if (text.length < 10) return { error: 'tell us a bit more in the description', status: 400 };
  if (played < NEED_PROPOSE) return { error: `finish ${NEED_PROPOSE} matches to send ideas`, status: 403 };
  const mine = await q(env, "SELECT SUM(CASE WHEN created >= ? THEN 1 ELSE 0 END) AS today, SUM(CASE WHEN state = 'wait' THEN 1 ELSE 0 END) AS waiting FROM ideas WHERE player = ? AND team = 0", dayStart(now), me.id).first();
  if (mine && mine.today > 0) return { error: 'one idea a day: send the next one tomorrow', status: 429 };
  if (mine && mine.waiting >= MAX_WAITING) return { error: `you have ${MAX_WAITING} ideas waiting: the team checks them first`, status: 429 };
  const row = await q(env, "INSERT INTO ideas (player, team, kind, title, text, state, created) VALUES (?, 0, ?, ?, ?, 'wait', ?) RETURNING id", me.id, kind, title, text, now).first();
  const t = tellAdmins(env, row.id, played).catch(() => { });
  if (wait) wait(t); else await t;
  return list(env, me, now);
}

// The message admins get for a waiting idea, and what it turns into once someone decided.
function preview(r, played) {
  const who = r.author_tg != null ? `<a href="tg://user?id=${r.author_tg}">${esc(r.author || 'Worm')}</a>` : esc(r.author || 'Worm');
  return `💡 New idea #${r.id} from ${who} (player ${r.player}${played != null ? `, ${fmt(played)} matches` : ''})\n${ICON[r.kind] || r.kind}\n\n<b>${esc(r.title)}</b>\n${esc(r.text)}`;
}
const buttons = id => ({ inline_keyboard: [[{ text: '✅ Approve', callback_data: `idea:ok:${id}` }, { text: '❌ Reject', callback_data: `idea:no:${id}` }]] });
const askText = r => `\n\n✅ Approve: it becomes a Yes/No poll in the game for ${OPEN_DAYS} days and ${esc(r.author || 'the player')} gets +${fmt(POLL_REWARD)} play $CWORM.\n` +
  `✏️ To fix the wording first: /idea edit ${r.id} New title | New description`;

async function tellAdmins(env, id, played, only) {
  const r = await byId(env, id); if (!r || !env.BOT_TOKEN) return;
  const msgs = (() => { try { return JSON.parse(r.msgs || '[]') } catch { return [] } })();
  for (const chat_id of only != null ? [only] : await adminTgIds(env)) {
    const s = await tg(env, 'sendMessage', { chat_id, text: (preview(r, played) + askText(r)).slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: buttons(r.id) });
    if (s && s.ok && s.result) msgs.push([chat_id, s.result.message_id]);
  }
  await q(env, 'UPDATE ideas SET msgs = ? WHERE id = ?', JSON.stringify(msgs.slice(-10)), id).run();
}

// A bot note to the author (not after /stop, the Settings switch, or when Telegram refuses them).
async function dm(env, player, text) {
  const p = await q(env, 'SELECT p.tg_id, COALESCE(m.remind, 1) AS remind, COALESCE(m.no_dm, 0) AS no_dm FROM players p LEFT JOIN player_meta m ON m.player = p.id WHERE p.id = ?', player).first();
  if (!env.BOT_TOKEN || !p || p.tg_id == null || !p.remind || p.no_dm) return false;
  const r = await tg(env, 'sendMessage', { chat_id: p.tg_id, text, reply_markup: { inline_keyboard: [[{ text: '🎮 Open the game', url: gameLink(env) }]] } });
  return !!(r && r.ok);
}

// Approve or reject a waiting idea (a button or /idea ok|no). Every admin's copy of the message loses its buttons.
export async function decide(env, id, ok, by, note, now = Date.now()) {
  const r = await byId(env, id);
  if (!r || r.team) return { done: false, text: `No idea #${id}.` };
  if (r.state !== 'wait') return { done: false, text: `Idea #${id} was already ${r.state === 'no' ? 'rejected' : r.state === 'gone' ? 'removed' : 'approved'}.` };
  const res = ok ? await q(env, "UPDATE ideas SET state = 'open', opened = ?, ends = ?, paid = paid | 1 WHERE id = ? AND state = 'wait'", now, now + OPEN_DAYS * DAY, id).run()
    : await q(env, "UPDATE ideas SET state = 'no', note = ? WHERE id = ? AND state = 'wait'", clean(note, 200) || null, id).run();
  if (!changed(res)) return { done: false, text: `Idea #${id} was already decided.` };
  if (ok) {
    await q(env, "INSERT INTO rewards (player, amount, reason, note, created) VALUES (?, ?, 'idea', ?, ?)", r.player, POLL_REWARD, r.title.slice(0, 60), now).run();
    await dm(env, r.player, `💡 Your idea "${r.title}" is now a poll in the game! Players vote on it for ${OPEN_DAYS} days.\n\n+${fmt(POLL_REWARD)} $CWORM for you (play money). If it gets made, you get +${fmt(DONE_REWARD)} more.`).catch(() => false);
  }
  const end = ok ? `\n\n✅ Approved${by ? ' by ' + esc(by) : ''}: live in the game until ${new Date(now + OPEN_DAYS * DAY).toISOString().slice(0, 10)}. ${esc(r.author || 'The player')} got +${fmt(POLL_REWARD)}.`
    : `\n\n❌ Rejected${by ? ' by ' + esc(by) : ''}. Nobody else sees it.`;
  const after = await byId(env, id), text = (preview(after) + end).slice(0, 4000);
  let msgs = []; try { msgs = JSON.parse(r.msgs || '[]') } catch { }
  for (const [chat_id, message_id] of msgs) await tg(env, 'editMessageText', { chat_id, message_id, text, parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => { });
  return { done: true, text: ok ? `✅ Idea #${id} is a poll now, open for ${OPEN_DAYS} days.` : `❌ Idea #${id} rejected.` };
}

// A tap on Approve or Reject.
export async function callback(env, cq, admin, now = Date.now()) {
  const m = /^idea:(ok|no):(\d+)$/.exec(cq.data || '');
  if (!m) return false;
  if (!admin) { await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Only admins can do that.' }); return true }
  const by = [cq.from.first_name, cq.from.last_name].filter(Boolean).join(' ') || cq.from.username || '';
  const r = await decide(env, Number(m[2]), m[1] === 'ok', by, null, now);
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: r.text.slice(0, 190) });
  return true;
}

const pct = (n, t) => t ? Math.round(n * 100 / t) + '%' : '0%';
const result = (r, c) => { const o = optionsOf(r) || ['👍 Yes', '👎 No'], t = c.reduce((a, b) => a + b, 0); return o.map((x, i) => `${esc(x)} ${c[i]} (${pct(c[i], t)})`).join(' · ') + ` · ${t} vote${t === 1 ? '' : 's'}` };
const left = (r, now) => { const h = Math.ceil((r.ends - now) / 36e5); return h > 36 ? `${Math.ceil(h / 24)} days left` : `${h} h left` };

// /ideas (admins): what waits for a decision, the open polls and the latest results.
export async function adminList(env, now = Date.now()) {
  const wait = (await q(env, SELECT + " WHERE i.state = 'wait' ORDER BY i.created LIMIT 15").all()).results;
  const open = (await q(env, SELECT + " WHERE i.state = 'open' AND i.ends > ? ORDER BY i.opened DESC LIMIT 15", now).all()).results;
  const done = (await q(env, SELECT + " WHERE i.state = 'open' AND i.ends <= ? ORDER BY i.ends DESC LIMIT 8", now).all()).results;
  const c = await counts(env, [...open, ...done]);
  const line = r => `#${r.id} ${r.team ? '🗳️' : (ICON[r.kind] || '').split(' ')[0]} <b>${esc(r.title)}</b>${r.team ? '' : ' · ' + esc(r.author || 'Worm')}`;
  return `💡 <b>Ideas &amp; polls</b>\n\n<b>Waiting for you (${wait.length})</b>\n` +
    (wait.length ? wait.map(r => `${line(r)}\n    ${esc(r.text).slice(0, 140)}\n    /idea ok ${r.id} · /idea no ${r.id}`).join('\n') : 'Nothing waiting.') +
    `\n\n<b>Open polls (${open.length})</b>\n` + (open.length ? open.map(r => `${line(r)} · ${left(r, now)}\n    ${result(r, c.get(r.id))}`).join('\n') : 'None.') +
    (done.length ? `\n\n<b>Closed lately</b>\n` + done.map(r => `${line(r)}${r.tag ? ' · ' + TAGNAME[r.tag] : ''}\n    ${result(r, c.get(r.id))}`).join('\n') : '') +
    `\n\n/newpoll Question | option 1 | option 2 (up to 4 options; no options = Yes/No; /newpoll 3d ... for 3 days)\n/idea edit &lt;id&gt; Title | Description · /idea tag &lt;id&gt; planned|done|notnow|none\n/idea end &lt;id&gt; closes a poll early · /idea del &lt;id&gt; takes it out of the game`;
}

// /newpoll [Nd] Question | option | option ...: a team poll, live right away.
export async function newPoll(env, arg, adminPlayer, now = Date.now()) {
  let s = String(arg || '').trim(), days = OPEN_DAYS;
  const d = /^(\d{1,2})d\s+/i.exec(s); if (d) { days = Math.max(1, Math.min(14, +d[1])); s = s.slice(d[0].length) }
  const [qq, ...rest] = s.split('|'), title = clean(qq, Q_MAX), opts = rest.map(o => clean(o, OPT_MAX)).filter(Boolean);
  if (title.length < 4 || opts.length === 1 || opts.length > 4 || rest.length !== opts.length)
    return 'Write it like this:\n/newpoll Which weapon next? | Laser | Freeze ray | Mega mole\n\n2 to 4 options, or just the question for a Yes/No poll. /newpoll 3d ... keeps it open 3 days (7 by default).';
  const r = await q(env, "INSERT INTO ideas (player, team, kind, title, options, state, created, opened, ends) VALUES (?, 1, 'poll', ?, ?, 'open', ?, ?, ?) RETURNING id",
    adminPlayer || null, title, opts.length ? JSON.stringify(opts) : null, now, now, now + days * DAY).first();
  return `🗳️ Poll #${r.id} is live in the game for ${days} day${days === 1 ? '' : 's'}:\n${title}\n${(opts.length ? opts : ['Yes', 'No']).map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\n/idea end ${r.id} closes it early, /idea del ${r.id} takes it out.`;
}

// /idea ok|no|edit|tag|end|del <id> ..., or /idea <id> for one idea's numbers.
export async function command(env, arg, { by, chat } = {}, now = Date.now()) {
  const m = /^(?:(ok|yes|approve|no|reject|edit|tag|end|close|del|delete|remove)\s+)?#?(\d+)\s*([\s\S]*)$/i.exec(String(arg || '').trim());
  if (!m) return adminList(env, now);
  const what = (m[1] || 'show').toLowerCase(), id = Number(m[2]), rest = m[3].trim(), r = await byId(env, id);
  if (!r || r.state === 'gone') return `No idea #${id}.`;
  if (what === 'ok' || what === 'yes' || what === 'approve') return (await decide(env, id, true, by, null, now)).text;
  if (what === 'no' || what === 'reject') return (await decide(env, id, false, by, rest, now)).text;
  if (what === 'edit') {
    const [t, x] = rest.split('|'), title = clean(t, r.team ? Q_MAX : TITLE_MAX), text = x == null ? r.text : clean(x, TEXT_MAX);
    if (title.length < 4) return `Write it like this: /idea edit ${id} New title | New description`;
    await q(env, 'UPDATE ideas SET title = ?, text = ? WHERE id = ?', title, text, id).run();
    if (r.state === 'wait' && chat != null) { await tellAdmins(env, id, null, chat); return null }   // the fixed version, with the buttons again
    return `✏️ Idea #${id} now reads:\n${title}${text ? '\n' + text : ''}`;
  }
  if (r.state !== 'open') return `Idea #${id} is ${r.state === 'wait' ? 'still waiting: /idea ok ' + id + ' or /idea no ' + id : 'not a poll (rejected)'}.`;
  if (what === 'end' || what === 'close') {
    if (r.ends <= now) return `Poll #${id} is already closed.`;
    await q(env, 'UPDATE ideas SET ends = ? WHERE id = ?', now, id).run(); return `⏹️ Poll #${id} is closed. Everyone sees the results now.`;
  }
  if (what === 'del' || what === 'delete' || what === 'remove') { await q(env, "UPDATE ideas SET state = 'gone' WHERE id = ?", id).run(); return `🗑️ Poll #${id} is out of the game.` }
  if (what === 'tag') {
    const t = rest.toLowerCase().replace(/[\s_-]+/g, ''), tag = t === 'none' || t === 'off' ? null : TAGS.includes(t) ? t : null;
    if (tag === null && !(t === 'none' || t === 'off')) return `Use /idea tag ${id} planned, done, notnow or none.`;
    await q(env, 'UPDATE ideas SET tag = ? WHERE id = ?', tag, id).run();
    let extra = '';
    if (tag === 'done' && !r.team && r.player && changed(await q(env, 'UPDATE ideas SET paid = paid | 2 WHERE id = ? AND (paid & 2) = 0', id).run())) {
      await q(env, "INSERT INTO rewards (player, amount, reason, note, created) VALUES (?, ?, 'ideadone', ?, ?)", r.player, DONE_REWARD, r.title.slice(0, 60), now).run();
      await dm(env, r.player, `🎉 Your idea "${r.title}" made it into the game! Thank you.\n\n+${fmt(DONE_REWARD)} $CWORM for you (play money).`).catch(() => false);
      extra = `\n${r.author || 'The player'} got +${fmt(DONE_REWARD)} play $CWORM. For the update note: "Idea by ${r.author || 'a player'}".`;
    }
    return `${tag ? TAGNAME[tag] : 'No tag'} on #${id}: ${r.title}${extra}`;
  }
  const c = (await counts(env, [r])).get(r.id);
  return `#${id} ${r.team ? '🗳️ Team poll' : ICON[r.kind] + ' by ' + (r.author || 'Worm')}\n${r.title}${r.text ? '\n' + r.text : ''}\n\n${result(r, c).replace(/<[^>]+>/g, '')}\n${r.ends > now ? left(r, now) : 'Closed'}${r.tag ? ' · ' + TAGNAME[r.tag] : ''}`;
}

// Cron (every 15 minutes): the results of each poll that just closed go to the admins once, with the tag commands.
export async function cron(env, now = Date.now()) {
  if (!env.BOT_TOKEN) return 0;
  const { results } = await q(env, SELECT + " WHERE i.state = 'open' AND i.ends <= ? AND i.told = 0 ORDER BY i.ends LIMIT 5", now).all();
  if (!results.length) return 0;
  const c = await counts(env, results), admins = await adminTgIds(env);
  for (const r of results) {
    await q(env, 'UPDATE ideas SET told = 1 WHERE id = ?', r.id).run();
    const text = `🗳️ Poll #${r.id} closed${r.team ? '' : ` (idea by ${esc(r.author || 'Worm')})`}\n<b>${esc(r.title)}</b>\n${result(r, c.get(r.id))}\n\n/idea tag ${r.id} planned · done · notnow`;
    for (const chat_id of admins) await tg(env, 'sendMessage', { chat_id, text, parse_mode: 'HTML' });
  }
  return results.length;
}

// Two accounts become one (index.js link): ideas follow the account, and the target's own votes win.
export async function mergeIdeas(env, a, b) {
  await env.DB.batch([q(env, 'UPDATE ideas SET player = ? WHERE player = ?', b, a),
    q(env, 'INSERT OR IGNORE INTO idea_votes (idea, player, choice, at) SELECT idea, ?, choice, at FROM idea_votes WHERE player = ?', b, a),
    q(env, 'DELETE FROM idea_votes WHERE player = ?', a)]);
}
