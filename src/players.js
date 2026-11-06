// Player IDs (Damian 2026-11-06: "Implement player id. To allow players to identify"). Every account already has a number
// (players.id), the one admins use in /prize skip, /wormon, /chatmute and the payout lists. The game shows it in Settings and
// More with a Copy button; here /id tells a Telegram player theirs, and /player <id or name> (admins) shows who a number is.
import { gameLink } from './growth.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const fmt = n => Number(n || 0).toLocaleString('en-US');
const day = t => t ? new Date(t).toISOString().slice(0, 10) : '?';
const when = t => t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never';
const TIERS = ['', 'Holder', 'Dolphin', 'Shark', 'Whale', 'Big Whale'];

// /id: the player's own number, to give the team when they ask for help or win a prize.
export async function idMessage(env, from) {
  const p = from && await env.DB.prepare('SELECT id, name FROM players WHERE tg_id = ?').bind(from.id).first().catch(() => null);
  if (!p) return { text: '🆔 You get your player ID when you open the game for the first time. Tap Play, then send /id again.', reply_markup: { inline_keyboard: [[{ text: '🎮 Play', url: gameLink(env) }]] } };
  return { text: `🆔 Your player ID: <b>${p.id}</b> (${esc(p.name)})\n\nGive this number to the team when you ask for help or win a prize. You also find it in the game under More and Settings.`, parse_mode: 'HTML' };
}

// /player <id> or /player <part of a name> (admins): who that is.
export async function lookup(env, arg, now = Date.now()) {
  const a = String(arg || '').trim().replace(/^#/, '');
  if (!a) return 'Send /player 1234 for a player ID, or /player Ana to find IDs by name.';
  if (!/^\d+$/.test(a)) {
    const { results } = await env.DB.prepare(`SELECT p.id, p.name, (SELECT 1 FROM sim_players s WHERE s.player = p.id) AS sim FROM players p WHERE p.name LIKE ? ESCAPE '\\' ORDER BY p.id DESC LIMIT 15`)
      .bind('%' + a.slice(0, 40).replace(/[\\%_]/g, c => '\\' + c) + '%').all();
    if (!results.length) return `No player named like "${esc(a)}".`;
    return `🆔 Players named like "${esc(a)}"${results.length === 15 ? ' (newest 15)' : ''}:\n` + results.map(r => `${r.id} · ${esc(r.name)}${r.sim ? ' (load-test bot)' : ''}`).join('\n') + '\n\n/player &lt;id&gt; for one of them.';
  }
  const id = Number(a), p = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(id).first();
  if (!p) return `No player with ID ${id}. (Merged accounts keep the ID of the account they were merged into.)`;
  const one = (q, ...v) => env.DB.prepare(q).bind(...v).first().catch(() => null);
  const [m, h, t, c, skip, mute, sim] = await Promise.all([
    one('SELECT played, last_seen, source FROM player_meta WHERE player = ?', id),
    one('SELECT tier, balance, wallet FROM holders WHERE player = ?', id),
    one('SELECT t.name, t.tag, t.emoji, tm.role FROM team_members tm JOIN teams t ON t.id = tm.team WHERE tm.player = ?', id),
    one('SELECT club FROM player_club WHERE player = ?', id),
    one('SELECT at FROM prize_skip WHERE player = ?', id),
    one('SELECT until FROM chat_mutes WHERE player = ? AND until > ?', id, now),
    one('SELECT 1 AS y FROM sim_players WHERE player = ?', id)]);
  const holder = h && p.wallet && h.wallet === p.wallet && h.tier > 0 ? ` · ${TIERS[h.tier] || 'Holder'} tier, ${fmt(Math.floor(h.balance || 0))} $CWORM` : '';
  const flags = [sim ? '🤖 load-test bot' : '', skip ? `🚫 out of the weekly prize since ${day(skip.at)}` : '', mute ? `🔇 chat muted until ${when(mute.until)}` : ''].filter(Boolean);
  return `🆔 Player <b>${id}</b>: <b>${esc(p.name)}</b>\n` +
    `Telegram: ${p.tg_id != null ? `<a href="tg://user?id=${p.tg_id}">open chat</a> (${p.tg_id})` : 'not linked'}\n` +
    `Wallet: ${p.wallet ? `<code>${esc(p.wallet)}</code>${holder}` : 'not linked'}\n` +
    `Joined ${day(p.created)}${m && m.source ? ' from ' + esc(m.source) : ''} · ${fmt(m ? m.played : 0)} matches · online ${p.wins | 0} W / ${p.losses | 0} L\n` +
    `Last seen ${when(m && m.last_seen)}\n` +
    `Team: ${t ? `${esc(t.emoji)} ${esc(t.name)} [${esc(t.tag)}]${t.role === 'lead' ? ' (leader)' : ''}` : 'none'}${c ? ' · Club: ' + esc(c.club) : ''}` +
    (flags.length ? '\n' + flags.join('\n') : '');
}
