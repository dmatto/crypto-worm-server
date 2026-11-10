// ---- One save for every device (Damian 2026-11-10: "I have my daily progress only on my phone") ----
// The game keeps a player's progress in the device's localStorage (and, inside Telegram, Telegram's cloud, which the web never
// sees). Now every device also sends its copy here: POST /me/save {data, t} merges it into the account's copy and answers with
// the merged copy, which the device adopts. So the Telegram app on a phone, Telegram Desktop and the web game (signed in to
// the same account) all show the same Battle Points, daily missions, daily reward, stars, campaign, looks and Worm Rescue.
// Merges only ever add: the most of a number, every item in a list, the newer day for daily things (and the most of both on
// the same day), and for choices (the worn look, the picked campaign level, the age rating) the one picked last, by the time
// the device stamped it in `t`. Device settings (graphics, sound, language, zoom) stay on each device and never come here.
// When two accounts are joined (Telegram login, wallet, login code), index.js link() folds their copies together.
export const SAVE_MAX = 64000;

const MAXN = 1e9;
const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(n, MAXN) : 0 };
const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : null;
const has = v => v !== undefined && v !== null;
const max = (a, b) => Math.max(num(a), num(b));
const maxMap = (a, b) => { const r = {}; for (const o of [obj(a), obj(b)]) if (o) for (const [k, v] of Object.entries(o)) if (k.length <= 40) r[k] = Math.max(num(r[k]), num(v)); return r };
const union = (a, b, cap = 1500) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].filter(x => typeof x === 'string' || typeof x === 'number').map(String))].slice(0, cap);
const flag = (a, b) => a === true || b === true ? true : max(a, b);
// a daily thing {<day>: 'YYYY-MM-DD', ...}: the newer day wins; on the same day `same` merges the two
const daily = (dk, same) => (a, b) => { a = obj(a); b = obj(b); const da = a && String(a[dk] || ''), db = b && String(b[dk] || '');
  if (!da) return b || a; if (!db) return a; if (da !== db) return da > db ? a : b; return same(a, b) };

// Achievements: the same merge the game does with Telegram's cloud copy (ACH.merge in crypto-worm.html)
function achFix(d) { d = obj(d) || {}; const o = x => obj(x) || {};
  return { c: o(d.c), b: o(d.b), wp: Array.isArray(d.wp) ? d.wp.map(String).slice(0, 200) : [], got: o(d.got), cur: num(d.cur), live: num(d.live), last: num(d.last), run: num(d.run) } }
function ach(a, b) { if (!obj(a)) return b; if (!obj(b)) return a; a = achFix(a); b = achFix(b);
  const got = { ...a.got }; for (const k in b.got) got[k] = got[k] ? Math.min(got[k], b.got[k]) : b.got[k];
  const late = b.last > a.last ? b : a;
  return { c: maxMap(a.c, b.c), b: maxMap(a.b, b.b), wp: union(a.wp, b.wp, 200), got, cur: late.cur, live: late.live, last: late.last, run: late.run } }

// Worm Rescue (rescue/rescue.js): levels opened, stars per level, gems per level (bits), BP earned there; its sound switches stay on the device
function rescue(a, b) { if (!obj(a)) return b; if (!obj(b)) return a; const st = [], gm = [];
  const at = Array.isArray(a.st) ? a.st : [], bt = Array.isArray(b.st) ? b.st : [], ag = Array.isArray(a.gm) ? a.gm : [], bg = Array.isArray(b.gm) ? b.gm : [];
  for (let i = 0; i < 10; i++) { st.push(max(at[i], bt[i])); gm.push(((num(ag[i]) | 0) | (num(bg[i]) | 0)) >>> 0) }
  return { lv: Math.min(10, max(a.lv, b.lv)), st, gm, bp: max(a.bp, b.bp), snd: b.snd !== false, mus: b.mus !== false } }

// key (without "cww-") -> how two copies merge. 'lww' = the latest pick by its stamp.
const RULES = {
  bank: max, spent: max, stars: max, played: max, inv: max, tut: max, coach: max,     // lifetime BP earned / spent, stars, matches...
  wins: maxMap, camp: maxMap, 'mini-best': maxMap,                                     // Bulls/Bears wins, campaign stars per level, mini game bests
  owned: union, seen: union,                                                           // store items; splashes and tips already seen
  starter: flag, 'tut-hide': flag,
  missions: daily('date', (a, b) => ({ date: a.date, ids: Array.isArray(a.ids) && a.ids.length ? a.ids : b.ids, prog: maxMap(a.prog, b.prog), done: union(a.done, b.done, 20) })),
  streak: daily('d', (a, b) => ({ d: a.d, n: max(a.n, b.n), g: max(a.g, b.g), w: max(a.w, b.w) })),   // the daily reward
  daily: daily('date', (a, b) => ({ date: a.date, best: max(a.best, b.best) })),                   // the Daily island's best
  mini: daily('day', (a, b) => ({ day: a.day, got: max(a.got, b.got) })),                          // BP from mini games today (cap)
  'rescue-day': daily('day', (a, b) => ({ day: a.day, got: max(a.got, b.got) })),                  // BP from Worm Rescue today (cap)
  ach, rescue,
  look: 'lww', hat: 'lww', camplvl: 'lww', rating: 'lww', age18: 'lww',
};
export const SAVE_KEYS = Object.keys(RULES).map(k => 'cww-' + k);

// Merge two copies {d: {key: value}, t: {key: ms}}. `a` is the stored one: on a tie it keeps its pick.
export function mergeSave(a, b) {
  a = obj(a) || {}; b = obj(b) || {}; const ad = obj(a.d) || {}, bd = obj(b.d) || {}, at = obj(a.t) || {}, bt = obj(b.t) || {};
  const d = {}, t = {};
  for (const [k, rule] of Object.entries(RULES)) {
    const K = 'cww-' + k, x = ad[K], y = bd[K];
    if (!has(x) && !has(y)) continue;
    if (rule === 'lww') { const tx = num(at[K]), ty = num(bt[K]); const useB = !has(x) || (has(y) && ty > tx); d[K] = useB ? y : x; const tt = useB ? ty : tx; if (tt) t[K] = tt; continue }
    let v; try { v = !has(x) ? rule(y, undefined) ?? y : !has(y) ? rule(x, undefined) ?? x : rule(x, y) } catch (e) { v = has(x) ? x : y }
    if (has(v)) d[K] = v;
  }
  return { d, t };
}

// what a device sent: only the keys above, as plain JSON
function clean(data, stamps) {
  const d = {}, t = {}; data = obj(data) || {}; stamps = obj(stamps) || {};
  for (const K of SAVE_KEYS) { if (has(data[K])) d[K] = data[K]; if (has(stamps[K])) { const n = num(stamps[K]); if (n) t[K] = n } }
  return { d, t };
}

async function load(env, id) {
  const r = await env.DB.prepare('SELECT data, at FROM saves WHERE player = ?').bind(id).first();
  if (!r) return null; try { const v = JSON.parse(r.data); return { ...v, at: r.at } } catch (e) { return null }
}
async function store(env, id, s) {
  const text = JSON.stringify({ d: s.d, t: s.t }); if (text.length > SAVE_MAX) return false;
  await env.DB.prepare('INSERT INTO saves (player, data, at) VALUES (?, ?, ?) ON CONFLICT(player) DO UPDATE SET data = excluded.data, at = excluded.at').bind(id, text, Date.now()).run();
  return true;
}

export async function saveGet(env, me) { const s = await load(env, me.id); return { data: s ? s.d : {}, t: s ? s.t : {}, at: s ? s.at : 0 } }

export async function savePut(env, me, body) {
  const inc = clean(body && body.data, body && body.t);
  if (JSON.stringify(inc).length > SAVE_MAX) return { error: 'too much to save', status: 413 };
  const old = await load(env, me.id), m = mergeSave(old, inc);
  const same = old && JSON.stringify({ d: old.d, t: old.t }) === JSON.stringify(m);
  if (!same && !await store(env, me.id, m)) return { data: old ? old.d : inc.d, t: old ? old.t : inc.t, error: 'too much to save', status: 413 };
  return { data: m.d, t: m.t, at: same ? old.at : Date.now() };
}

// two accounts joined into `b` (index.js link): one copy with the most of both
export async function mergeSaves(env, a, b) {
  const x = await load(env, a); if (!x) return;
  const y = await load(env, b), m = mergeSave(y, x);
  await store(env, b, m);
  await env.DB.prepare('DELETE FROM saves WHERE player = ?').bind(a).run();
}
