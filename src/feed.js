// The live feed on the game's Home screen (Damian 2026-10-16: "a small live feed with victories and nice shots in a funny
// way ... bots or not bots"). It keeps the latest wins, kills and great shots of everyone, real players and load-test bots
// alike. The server keeps only the facts; the game words each line, in a funny way and in the player's language.
//
//   GET /feed -> {feed: [{id, at, k, p, a, ac, b, bc, w, wp, n, how, m}], now}    the latest FEED_N, newest first
//
//   k     what happened: win (an online match; m = played | left | timeout), land (World Map land taken; m = its country),
//         solo (won against the CPU or a bot; m = cpu | camp | daily | bot), lost (the CPU or a bot won; m as for solo),
//         kill (a took out the worm w), died (a lost their worm w to the CPU or a bot), oops (a took out their own worm w),
//         multi (one shot of a's hit n worms), big (one shot of a's did n damage)
//   p, a, ac   the player: id, name, country      b, bc   the other side, when there is one (a bot or boss name for solo/lost)
//   w     a worm's name      wp   the weapon id      n   damage, worms hit or campaign mission      how   blast | drown | off | bird
//
// Online wins (match.js) and land taken (map.js) come with both names from the database. Everything else comes from the
// game's /played report: up to FEED_PER_MATCH moments of the player's own match, checked and trimmed here (moments()), with
// the player's own name and country always from the database. At most FEED_PER_10MIN lines per player in 10 minutes, so no
// one fills the feed alone. Lines older than FEED_KEEP are cleaned up by the cron.

export const FEED_N = 30, FEED_PER_MATCH = 3, FEED_PER_10MIN = 8, FEED_KEEP = 2 * 864e5, FEED_CACHE_S = 10;
const MODES = new Set(['cpu', 'camp', 'daily', 'bot']), HOW = new Set(['blast', 'drown', 'off', 'bird']);
const KINDS = { solo: 1, lost: 1, kill: 1, died: 1, oops: 1, multi: 1, big: 1 };
const COLS = 'id, at, k, p, a, ac, b, bc, w, wp, n, how, m';

// a name from the phone: no control characters or brackets, one space at a time, at most 18 characters
export const clean = (s, max = 18) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) || null;
const int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null };

// A finished online match: "w beat l". A statement to batch with the match's own result.
export const winRow = (env, w, l, reason, now = Date.now()) => env.DB.prepare(`INSERT INTO feed (at, k, p, a, ac, b, bc, m)
    SELECT ?, 'win', w.id, w.name, wm.cc, l.name, lm.cc, ? FROM players w LEFT JOIN player_meta wm ON wm.player = w.id
    CROSS JOIN players l LEFT JOIN player_meta lm ON lm.player = l.id WHERE w.id = ? AND l.id = ?`).bind(now, String(reason || 'played').slice(0, 8), w, l);

// World Map land taken: from its owner (or from the CPU when there was none), in country cc
export const landRow = (env, attacker, owner, cc, now = Date.now()) => env.DB.prepare(`INSERT INTO feed (at, k, p, a, ac, b, bc, m)
    SELECT ?, 'land', w.id, w.name, wm.cc, l.name, lm.cc, ? FROM players w LEFT JOIN player_meta wm ON wm.player = w.id
    LEFT JOIN players l ON l.id = ? LEFT JOIN player_meta lm ON lm.player = l.id WHERE w.id = ?`).bind(now, /^[A-Z]{2}$/.test(cc || '') ? cc : null, owner || null, attacker);

// The moments the game sent with /played: kept when they make sense, up to FEED_PER_MATCH, and only while the player has
// room in their FEED_PER_10MIN. mode is the match's mode as /played got it; online matches send no solo or lost (the
// match server words those itself), and neither do World Map battles (land taken says it).
export async function moments(env, me, mode, list, now = Date.now()) {
  if (!Array.isArray(list) || !list.length || !me || !me.name) return 0;
  const rows = [];
  for (const e of list.slice(0, 10)) {
    if (!e || typeof e !== 'object' || !KINDS[e.k] || rows.length >= FEED_PER_MATCH) continue;
    const r = { k: e.k, b: null, w: null, wp: null, n: null, how: null, m: null };
    if (e.k === 'solo' || e.k === 'lost') {
      if (!MODES.has(mode) || e.m !== mode) continue;
      r.m = mode; r.b = clean(e.b); r.n = mode === 'camp' ? int(e.n, 1, 99) : null;
      if (rows.some(x => x.k === 'solo' || x.k === 'lost')) continue;
    } else if (e.k === 'kill' || e.k === 'died' || e.k === 'oops') {
      r.w = clean(e.w); if (!r.w) continue;
      r.how = HOW.has(e.how) ? e.how : 'blast';
      if (e.k === 'died' && mode === 'online') continue;                               // online the other phone tells it as a kill
    } else {
      r.n = e.k === 'multi' ? int(e.n, 2, 12) : int(e.n, 40, 999); if (r.n == null) continue;
    }
    if (r.m == null && /^[a-z0-9]{2,14}$/.test(e.wp || '')) r.wp = e.wp;
    rows.push(r);
  }
  if (!rows.length) return 0;
  const used = (await env.DB.prepare('SELECT COUNT(*) AS n FROM feed WHERE p = ? AND at > ?').bind(me.id, now - 6e5).first()).n;
  const keep = rows.slice(0, Math.max(0, FEED_PER_10MIN - used)); if (!keep.length) return 0;
  const cc = await env.DB.prepare('SELECT cc FROM player_meta WHERE player = ?').bind(me.id).first().then(x => x && x.cc).catch(() => null);
  await env.DB.batch(keep.map((r, i) => env.DB.prepare('INSERT INTO feed (at, k, p, a, ac, b, w, wp, n, how, m) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(now + i, r.k, me.id, me.name, cc || null, r.b, r.w, r.wp, r.n, r.how, r.m)));
  return keep.length;
}

export async function list(env) {
  const { results } = await env.DB.prepare(`SELECT ${COLS} FROM feed ORDER BY id DESC LIMIT ?`).bind(FEED_N).all();
  return { feed: (results || []).map(r => { const o = {}; for (const k in r) if (r[k] != null) o[k] = r[k]; return o }), now: Date.now() };
}

// GET /feed: everyone asks for the same list, so it is kept FEED_CACHE_S seconds at the edge (when there is a cache)
export async function feedResponse(env, ctx, headers) {
  const cache = typeof caches !== 'undefined' && caches.default, key = 'https://feed.cache/v1';
  if (cache) { const hit = await cache.match(key).catch(() => null); if (hit) { const r = new Response(hit.body, hit); for (const [k, v] of Object.entries(headers)) r.headers.set(k, v); return r } }
  const r = new Response(JSON.stringify(await list(env)), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${FEED_CACHE_S}` } });
  if (cache) { const put = cache.put(key, r.clone()).catch(() => { }); if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put }
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
  return r;
}

export const cleanup = (env, now = Date.now()) => env.DB.prepare('DELETE FROM feed WHERE at < ?').bind(now - FEED_KEEP).run();
