// Same-network hints against one person playing with many accounts (Damian 2026-11-09 chose "Flag only").
// When a signed-in player's match is counted (/played), the server keeps a scrambled code of the network the request came
// from, never the IP address itself: SHA-256 of SESSION_SECRET and the address (an IPv6 address cut to its /64, the part one
// home or phone keeps while the rest changes), first 16 hex characters, so nobody can turn it back into the address.
// One row per player, network and UTC day; the cron deletes rows older than NET_DAYS (the privacy page says so).
// Admins see shared networks as flags in /race check, the weekly prize list and /player. A flag is a hint, never a block:
// people on mobile data share addresses with strangers, and a family or a school shares one wifi.
export const NET_DAYS = 30;
const DAY = 864e5;

// The part of an address that stays the same for one connection: an IPv4 address whole, IPv6 its first 64 bits.
export function netAddr(ip) {
  ip = String(ip || '').trim().toLowerCase();
  if (!ip) return '';
  if (!ip.includes(':')) return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : '';
  const v4 = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/); if (v4) return v4[1];
  if (!/^[0-9a-f:]+$/.test(ip) || ip.split('::').length > 2) return '';
  const [head, tail] = ip.split('::'), h = head ? head.split(':') : [], t = tail == null ? null : tail ? tail.split(':') : [];
  const all = t == null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  if (all.length !== 8 || all.some(x => !x || x.length > 4)) return '';
  return all.slice(0, 4).map(x => parseInt(x, 16).toString(16)).join(':') + '::/64';
}

export async function netCode(ip, secret) {
  const a = netAddr(ip); if (!a || !secret) return null;
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret + '|net|' + a)));
  return [...d.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Called for a counted match; load-test bots (x-sim-key) are never recorded.
export async function netSeen(env, req, player, now = Date.now()) {
  if (!player || req.headers.has('x-sim-key')) return false;
  const h = await netCode(req.headers.get('CF-Connecting-IP'), env.SESSION_SECRET); if (!h) return false;
  await env.DB.prepare('INSERT OR IGNORE INTO net_seen (player, h, day) VALUES (?, ?, ?)').bind(player, h, Math.floor(now / DAY)).run();
  return true;
}

const since = now => Math.floor(now / DAY) - NET_DAYS;

// Each player's network codes of the last NET_DAYS days, for a few players at once: Map id -> Set of codes.
export async function netShared(env, ids, now = Date.now()) {
  const out = new Map(); ids = [...new Set(ids.filter(i => i != null))];
  if (!ids.length) return out;
  const { results } = await env.DB.prepare(`SELECT DISTINCT player, h FROM net_seen WHERE player IN (${ids.map(() => '?').join(',')}) AND day >= ?`).bind(...ids, since(now)).all();
  for (const r of results) { if (!out.has(r.player)) out.set(r.player, new Set()); out.get(r.player).add(r.h) }
  return out;
}

// Which of `others` used a network that `id` used too.
export function netMatch(map, id, others) {
  const mine = map.get(id); if (!mine) return [];
  return others.filter(o => o !== id && map.has(o) && [...map.get(o)].some(h => mine.has(h)));
}

// For /player: how many networks a player used, and the other accounts seen on them (load-test bots left out).
export async function netOthers(env, id, now = Date.now(), limit = 8) {
  const d = since(now);
  const n = await env.DB.prepare('SELECT COUNT(DISTINCT h) AS n FROM net_seen WHERE player = ? AND day >= ?').bind(id, d).first();
  const { results } = await env.DB.prepare(`SELECT o.player AS id, p.name, COUNT(DISTINCT o.h) AS nets FROM net_seen me JOIN net_seen o ON o.h = me.h AND o.player != me.player AND o.day >= ?2
      JOIN players p ON p.id = o.player WHERE me.player = ?1 AND me.day >= ?2 AND o.player NOT IN (SELECT player FROM sim_players)
      GROUP BY o.player ORDER BY nets DESC, o.player LIMIT ?3`).bind(id, d, limit + 1).all();
  return { nets: n ? n.n : 0, others: results.slice(0, limit), more: results.length > limit };
}

export const netCleanup = (env, now = Date.now()) => env.DB.prepare('DELETE FROM net_seen WHERE day < ?').bind(since(now)).run();
