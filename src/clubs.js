// Football clubs (Damian 2026-10-26: "Lets include the futbol teams in the game. You can add your favorite futbol team of all the
// world. How can we do it to get more attraction to the battles?", then he picked club battles plus derby days). A player picks the
// club they support from ~5,000 real clubs (clubs-data.js, made by the game's clubs/source/build.py from openfootball/clubs and
// Grok). Names and kit colors only: never a crest or a logo, and never in ads. Their worms wear a scarf in the club's colors, and
// the club shows next to their name online and in the ranking.
// Club war: every play-money $CWORM a fan banks (the same capped amounts as the ranking, addScore in index.js) scores for their
// club this week, and an online win over another club's fan adds WIN points, or DERBY points when the two clubs are rivals (a
// derby). Admins call derby days (/derby in the bot): that UTC day both fan bases score double, in the club war and in the game
// (a gift of play money that doesn't count for the ranking or the weekly prize). Bragging rights and play money only.
//
//   GET  /clubs                 -> {mine, top: [{rank, id, name, cc, c, fans, pts}], day, extra: [[id, name, cc, 'rrggbb,rrggbb']], since}
//   POST /me/club {id}          (index.js) pick or change the club: the first pick any time, then once every CHANGE_MS (a change
//                               within UNDO_MS of a pick is free, for a wrong tap); {id: null} leaves the club. Answers the session.
//   POST /clubs/suggest {name, country}  a club that isn't in the list: Grok checks it is a real club, then it is added for everyone
//                               and picked for this player -> {ok, club}; admins hear about it and can take it off (/clubs off <id>)
// Points a fan earned stay with the club they earned them for.

import { CLUBS, DERBIES } from './clubs-data.js';
import { weekStart, gameLink } from './growth.js';
import { xai, VISION_MODEL } from './worms.js';
import { tg } from './bot.js';

export const CHANGE_MS = 7 * 864e5, UNDO_MS = 15 * 60e3, WIN = 50, DERBY = 200, WIN_DAY = 5, TOP = 50, SUGGEST_DAY = 3, SIM_SHARE = 0.2;
const DAY = 864e5, ID = /^[a-z0-9]{1,4}-[a-z0-9-]{1,40}$/;
const q = (env, s, ...v) => env.DB.prepare(s).bind(...v);
const isSim = (env, id) => q(env, 'SELECT 1 AS y FROM sim_players WHERE player = ?', id).first().then(r => !!r).catch(() => false);
const cols = s => s ? s.split(',').map(x => '#' + x) : null;
export const fold = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[øØ]/g, 'o').replace(/ß/g, 'ss').replace(/[łŁ]/g, 'l').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// derbies, both ways: id -> Map(rival id -> derby name)
let RIVALS = null;
function rivalMap() {
  if (RIVALS) return RIVALS; RIVALS = new Map();
  for (const [a, b, name] of DERBIES) for (const [x, y] of [[a, b], [b, a]]) { if (!RIVALS.has(x)) RIVALS.set(x, new Map()); RIVALS.get(x).set(y, name) }
  return RIVALS;
}
export const derbyName = (a, b) => (a && b && a !== b && rivalMap().get(a)?.get(b)) || null;
export const rivalsOf = id => [...(rivalMap().get(id) || new Map())].map(([r, d]) => ({ ...lite(r), d })).filter(r => r.id);

// A club from the list: {id, n, cc, c}. Clubs players added (club_extra) need the database: see clubInfo.
export function lite(id) { const r = CLUBS[id]; return r ? { id, n: r[0], cc: r[1], c: cols(r[2]) } : null }
let extraAt = 0, extraRows = new Map();
async function extras(env, now = Date.now()) {
  if (now - extraAt < 60e3) return extraRows;
  const { results } = await q(env, "SELECT id, name, cc, c FROM club_extra WHERE state = 'on'").all().catch(() => ({ results: [] }));
  extraRows = new Map(results.map(r => [r.id, { id: r.id, n: r.name, cc: r.cc, c: cols(r.c) }])); extraAt = now; return extraRows;
}
export async function clubInfo(env, id) { return !id ? null : lite(id) || (await extras(env)).get(id) || null }
export async function clubsInfo(env, ids) {          // many at once (the ranking): one look at the added clubs at most
  const out = new Map(); let ex = null;
  for (const id of new Set(ids.filter(Boolean))) { const c = lite(id) || (ex = ex || await extras(env)).get(id); if (c) out.set(id, c) }
  return out;
}

export async function clubOf(env, player) {
  const r = await q(env, 'SELECT club, at FROM player_club WHERE player = ?', player).first().catch(() => null);
  const c = r && await clubInfo(env, r.club); return c ? { ...c, since: r.at } : null;
}
// what the session carries: the club, its rivals (the game picks bots that support them: a derby) and when it can change
export async function sessionClub(env, player, now = Date.now()) {
  const c = await clubOf(env, player); if (!c) return null;
  return { ...c, rivals: rivalsOf(c.id).slice(0, 12), change: now - c.since < UNDO_MS ? 0 : Math.max(0, c.since + CHANGE_MS - now) };
}

export async function setClub(env, me, id, now = Date.now()) {
  const cur = await q(env, 'SELECT club, at FROM player_club WHERE player = ?', me.id).first();
  if (id == null || id === '') { await q(env, 'DELETE FROM player_club WHERE player = ?', me.id).run(); return null }
  const c = ID.test(String(id)) && await clubInfo(env, String(id)); if (!c) return { error: 'pick a club from the list', status: 400 };
  if (cur && cur.club === c.id) return null;
  if (cur && now - cur.at >= UNDO_MS && now - cur.at < CHANGE_MS) return { error: 'you can change your club once a week', status: 429, wait: cur.at + CHANGE_MS };
  await q(env, 'INSERT INTO player_club (player, club, at) VALUES (?, ?, ?) ON CONFLICT(player) DO UPDATE SET club = excluded.club, at = excluded.at', me.id, c.id,
    cur && now - cur.at < UNDO_MS ? cur.at : now).run();   // fixing a wrong tap doesn't start the week again
  return null;
}

// The derby day for a UTC day (the cron and every score read it): {day, a, b, name} or null. Kept a minute per Worker.
let dayCache = { at: 0, day: -1, row: null };
export async function derbyDay(env, now = Date.now()) {
  const day = Math.floor(now / DAY);
  if (dayCache.day === day && now - dayCache.at < 60e3) return dayCache.row;
  const r = await q(env, 'SELECT day, a, b, name FROM derby_days WHERE day = ?', day).first().catch(() => null);
  dayCache = { at: now, day, row: r || null }; return dayCache.row;
}
const onDay = (d, club) => !!d && (d.a === club || d.b === club);

// A fan banked play money (addScore in index.js, already capped): the same amount scores for their club this week, twice on its derby day.
export async function clubScore(env, player, amount, now = Date.now()) {
  if (!(amount > 0)) return;
  const m = await q(env, 'SELECT club FROM player_club WHERE player = ?', player).first().catch(() => null); if (!m) return;
  if (await isSim(env, player)) amount = Math.round(amount * SIM_SHARE);
  if (onDay(await derbyDay(env, now), m.club)) amount *= 2;
  if (!(amount > 0)) return;
  await q(env, `INSERT INTO club_points (club, week_start, player, pts) VALUES (?, ?, ?, ?)
    ON CONFLICT(club, week_start, player) DO UPDATE SET pts = pts + excluded.pts`, m.club, weekStart(now), player, amount).run();
}

// An online win over another club's fan (a finished 1v1, or an online Worm Royale won with them in it): WIN points for the
// winner's club, DERBY when the clubs are rivals, twice on the club's derby day. At most WIN_DAY a day per winner and one per
// opponent per day, so two friends can't farm it. -> {pts, derby} (derby: the derby's name)
export async function clubWin(env, winner, loser, now = Date.now()) {
  if (winner == null || loser == null || winner === loser) return { pts: 0 };
  const a = await q(env, 'SELECT club FROM player_club WHERE player = ?', winner).first().catch(() => null), b = a && await q(env, 'SELECT club FROM player_club WHERE player = ?', loser).first();
  if (!a || !b || a.club === b.club || await isSim(env, winner)) return { pts: 0 };
  const day = Math.floor(now / DAY) * DAY, derby = derbyName(a.club, b.club);
  const done = await q(env, 'SELECT COUNT(*) AS n, SUM(loser = ?) AS same FROM club_wins WHERE winner = ? AND at >= ?', loser, winner, day).first();
  if ((done.n | 0) >= WIN_DAY || (done.same | 0) > 0) return { pts: 0, derby };
  const pts = (derby ? DERBY : WIN) * (onDay(await derbyDay(env, now), a.club) ? 2 : 1);
  await env.DB.batch([q(env, 'INSERT INTO club_wins (at, winner, loser, wclub, lclub, derby) VALUES (?, ?, ?, ?, ?, ?)', now, winner, loser, a.club, b.club, derby ? 1 : 0),
    q(env, `INSERT INTO club_points (club, week_start, player, pts) VALUES (?, ?, ?, ?)
      ON CONFLICT(club, week_start, player) DO UPDATE SET pts = pts + excluded.pts`, a.club, weekStart(now), winner, pts),
    q(env, 'DELETE FROM club_wins WHERE at < ?', now - 35 * DAY)]);
  return { pts, derby };
}

// The club war: clubs ranked by this week's points, with their fans (players who picked them).
async function table(env, now = Date.now()) {
  const wk = weekStart(now);
  const [pts, fans] = await Promise.all([q(env, 'SELECT club, SUM(pts) AS pts FROM club_points WHERE week_start = ? GROUP BY club ORDER BY pts DESC LIMIT 500', wk).all(),
    q(env, 'SELECT club, COUNT(*) AS n FROM player_club GROUP BY club').all()]);
  const fan = new Map(fans.results.map(r => [r.club, r.n])), info = await clubsInfo(env, pts.results.map(r => r.club));
  return pts.results.filter(r => info.has(r.club) && r.pts > 0).map((r, i) => { const c = info.get(r.club); return { rank: i + 1, id: c.id, name: c.n, cc: c.cc, c: c.c, fans: fan.get(r.club) || 0, pts: r.pts | 0 } });
}

export async function handle(path, env, me, body, opts = {}, now = Date.now()) {
  if (path === '/clubs' && !opts.post) {
    const rows = await table(env, now), mine = await clubOf(env, me.id), d = await derbyDay(env, now);
    let my = null;
    if (mine) {
      const row = rows.find(r => r.id === mine.id), fans = await q(env, 'SELECT COUNT(*) AS n FROM player_club WHERE club = ?', mine.id).first();
      const own = await q(env, 'SELECT COALESCE(SUM(pts), 0) AS n FROM club_points WHERE club = ? AND week_start = ? AND player = ?', mine.id, weekStart(now), me.id).first();
      my = { ...mine, rank: row ? row.rank : null, pts: row ? row.pts : 0, fans: fans.n | 0, myPts: own.n | 0, rivals: rivalsOf(mine.id).slice(0, 12),
        change: now - mine.since < UNDO_MS ? 0 : Math.max(0, mine.since + CHANGE_MS - now) };
    }
    const ex = [...(await extras(env, now)).values()].map(c => [c.id, c.n, c.cc, c.c ? c.c.map(x => x.slice(1)).join(',') : '']);
    return { since: weekStart(now), mine: my, top: rows.slice(0, TOP), clubs: rows.length, day: d ? { a: await clubInfo(env, d.a), b: await clubInfo(env, d.b), name: d.name || null } : null, extra: ex, cc: opts.cc || null };
  }
  if (path === '/clubs/suggest' && opts.post) return suggest(env, me, body, opts, now);
  return null;
}

// A club that isn't in the list. Grok says whether it is a real football club and gives its usual name, country and colors.
const SUGGEST_CHECK = 'A player of a football game wants to support a club that is not in our list. Is this a real, existing football (soccer) club '
  + '(any level: national league, regional league, women\'s club, fan-owned club)? Answer JSON {"real": true|false, "name": "the club\'s common name in Latin letters, '
  + 'max 30 characters", "cc": "ISO 3166 two-letter country code (ENG, SCO, WAL or NIR for the UK nations)", "city": "home city", "colors": ["#rrggbb", "#rrggbb"] the two main '
  + 'home kit colors, "same": "if this is the same club as one of the listed near matches, its id, else null"}. Say real: false for a made-up name, a joke, an insult, '
  + 'a national team, a person, a company or anything that is not a football club.';
async function suggest(env, me, body, opts, now) {
  const name = String(body.name || '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 40), country = String(body.country || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (name.length < 2) return { error: 'write the club\'s name', status: 400 };
  const day = Math.floor(now / DAY) * DAY, n = await q(env, 'SELECT COUNT(*) AS n FROM club_suggest WHERE player = ? AND at >= ?', me.id, day).first();
  if ((n.n | 0) >= SUGGEST_DAY) return { error: 'that is enough clubs for today: try again tomorrow', status: 429 };
  const near = search(name, 6).concat([...(await extras(env, now)).values()].filter(c => fold(c.n).includes(fold(name)) || fold(name).includes(fold(c.n))).slice(0, 4));
  let v = null;
  if (env.XAI_API_KEY) try {
    const r = await xai(env, 'chat/completions', { model: VISION_MODEL, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SUGGEST_CHECK },
      { role: 'user', content: `Club: ${name}\nCountry: ${country || 'not given'}\nNear matches already in our list: ${near.map(c => `${c.id} = ${c.n} (${c.cc})`).join('; ') || 'none'}` }] });
    v = JSON.parse(r.choices[0].message.content);
  } catch (e) { v = null }
  const ok = !!(v && v.real === true), same = ok && v.same && await clubInfo(env, String(v.same));
  await q(env, 'INSERT INTO club_suggest (player, name, country, at, result) VALUES (?, ?, ?, ?, ?)', me.id, name, country || null, now, !v ? 'unchecked' : same ? 'same ' + same.id : ok ? 'added' : 'no').run();
  if (!v) { if (opts.tell) await opts.tell(`⚽ ${me.name} (player ${me.id}) asked for a club that isn't in the list: ${name}${country ? ' (' + country + ')' : ''}. Grok couldn't check it just now.`).catch(() => { });
    return { error: 'we could not check that club right now: try again in a minute', status: 502 } }
  if (!ok) return { error: 'we could not find that club: check the name, or pick it from the list', status: 422 };
  if (same) { const e = await setClub(env, me, same.id, now); return e || { ok: true, club: same, found: true } }
  const cc = String(v.cc || '').toUpperCase().replace(/^(GB|UK)$/, 'ENG'), clean = String(v.name || name).replace(/\s+/g, ' ').trim().slice(0, 30);
  if (!/^[A-Z]{2,3}$/.test(cc) || clean.length < 2) return { error: 'we could not find that club: check the name, or pick it from the list', status: 422 };
  const c = (Array.isArray(v.colors) ? v.colors : []).filter(x => /^#[0-9a-fA-F]{6}$/.test(x)).slice(0, 2).map(x => x.slice(1).toLowerCase());
  const slug = fold(clean).replace(/ /g, '-').slice(0, 28).replace(/-+$/, ''), id = 'x' + cc.toLowerCase().slice(0, 3) + '-' + slug;
  if (!ID.test(id)) return { error: 'we could not find that club: check the name, or pick it from the list', status: 422 };
  await q(env, `INSERT INTO club_extra (id, name, cc, c, city, player, at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'on') ON CONFLICT(id) DO NOTHING`,
    id, clean, cc, c.length === 2 ? c.join(',') : null, String(v.city || '').slice(0, 40) || null, me.id, now).run();
  extraAt = 0;
  const club = await clubInfo(env, id); if (!club) return { error: 'that club can not be picked', status: 403 };
  const e = await setClub(env, me, id, now); if (e) return e;
  if (opts.tell) await opts.tell(`⚽ New club added by ${me.name} (player ${me.id}): ${clean} (${cc}${v.city ? ', ' + String(v.city).slice(0, 40) : ''}), asked as "${name}".\n/clubs off ${id} takes it off the list.`).catch(() => { });
  return { ok: true, club };
}

// Clubs by name, for /derby and the suggestion check: the best matches first (whole name, then start of a word, then anywhere; the most popular first).
export function search(text, n = 8) {
  const f = fold(text); if (!f) return [];
  const out = [];
  for (const id in CLUBS) {
    const r = CLUBS[id], name = fold(r[0]);
    const score = name === f ? 0 : name.startsWith(f) ? 1 : (' ' + name).includes(' ' + f) ? 2 : name.includes(f) ? 3 : -1;
    if (score >= 0) out.push([score, r[3] < 0 ? 99 : r[3], id]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, n).map(x => lite(x[2]));
}

// Two accounts become one (index.js link: `a` folds into `b`): b's own club wins; points a earned stay with their club, now b's.
export async function mergeClubs(env, a, b) {
  await env.DB.batch([
    q(env, 'INSERT OR IGNORE INTO player_club (player, club, at) SELECT ?, club, at FROM player_club WHERE player = ?', b, a), q(env, 'DELETE FROM player_club WHERE player = ?', a),
    q(env, `INSERT INTO club_points (club, week_start, player, pts) SELECT club, week_start, ?, pts FROM club_points WHERE player = ?
      ON CONFLICT(club, week_start, player) DO UPDATE SET pts = pts + excluded.pts`, b, a), q(env, 'DELETE FROM club_points WHERE player = ?', a),
    q(env, 'UPDATE club_wins SET winner = ? WHERE winner = ?', b, a), q(env, 'UPDATE club_wins SET loser = ? WHERE loser = ?', b, a)]);
}

const medal = i => ['🥇', '🥈', '🥉'][i] || (i + 1) + '.';
const fmt = n => (n | 0).toLocaleString('en-US');
// last week's top 3 clubs, for the Monday post in the community group (growth.js weekly)
export async function clubTopText(env, start) {
  const { results } = await q(env, 'SELECT club, SUM(pts) AS pts FROM club_points WHERE week_start = ? GROUP BY club ORDER BY pts DESC LIMIT 3', start).all().catch(() => ({ results: [] }));
  const info = await clubsInfo(env, results.map(r => r.club)), rows = results.filter(r => info.has(r.club) && r.pts > 0);
  if (!rows.length) return '';
  return '⚽ <b>Club war: top clubs of last week</b>\n' + rows.map((r, i) => `${medal(i)} <b>${esc(info.get(r.club).n)}</b>: ${fmt(r.pts)} points`).join('\n');
}

// the bot's /clubs (players, and in groups): this week's top 10 clubs
export async function clubBoard(env, now = Date.now()) {
  const rows = (await table(env, now)).slice(0, 10), d = await derbyDay(env, now);
  const day = d ? `\n\n🔥 Derby day today: ${(await clubInfo(env, d.a))?.n} vs ${(await clubInfo(env, d.b))?.n}. Fans of both clubs score double!` : '';
  const kb = { inline_keyboard: [[{ text: '⚽ Pick my club', url: gameLink(env, 'club') }]] };
  if (!rows.length) return { text: '⚽ Club war this week\n\nNo club has scored yet. Pick the club you support in the game (More › My club), then win matches for it! 🪱' + day + '\n\n(Play money in the game, not real tokens.)', reply_markup: kb };
  return { text: '⚽ Club war this week\n\n' + rows.map((r, i) => `${medal(i)} ${r.name}: ${fmt(r.pts)} points · ${r.fans} ${r.fans === 1 ? 'fan' : 'fans'}`).join('\n') +
    `\n\nEvery match a fan plays scores for the club. Beat a rival club's fan online for +${DERBY}!` + day + '\n\n(Play money in the game, not real tokens.)', reply_markup: kb };
}

// /clubs (admins): the table, clubs players added, and /clubs off <id> to take an added club off the list
export async function adminClubs(env, arg, now = Date.now()) {
  const off = String(arg || '').trim().match(/^off\s+(x[a-z]{2,3}-[a-z0-9-]+)/i);
  if (off) {
    const c = await q(env, 'SELECT id, name FROM club_extra WHERE id = ?', off[1].toLowerCase()).first(); if (!c) return `No added club with id ${off[1]}. Only clubs players added (ids starting with x) can be taken off.`;
    const fans = await q(env, 'SELECT COUNT(*) AS n FROM player_club WHERE club = ?', c.id).first();
    await env.DB.batch([q(env, "UPDATE club_extra SET state = 'off' WHERE id = ?", c.id), q(env, 'DELETE FROM player_club WHERE club = ?', c.id)]); extraAt = 0;
    return `🚫 Took ${c.name} off the club list. Its ${fans.n | 0} fans can pick another club.`;
  }
  const rows = (await table(env, now)).slice(0, 15), fans = await q(env, 'SELECT COUNT(*) AS n, COUNT(DISTINCT club) AS c FROM player_club').first();
  const { results: added } = await q(env, "SELECT id, name, cc, player FROM club_extra WHERE state = 'on' ORDER BY at DESC LIMIT 10").all();
  const { results: asked } = await q(env, "SELECT name, country, result FROM club_suggest WHERE result != 'added' ORDER BY at DESC LIMIT 8").all();
  const d = await derbyDay(env, now);
  return `⚽ Club war this week (${fans.n | 0} players picked ${fans.c | 0} clubs)\n` + (rows.map(r => `#${r.rank} ${r.name} (${r.cc}) · ${r.fans} fans · ${fmt(r.pts)} pts`).join('\n') || 'No points yet.') +
    (d ? `\n\n🔥 Derby day today: ${(await clubInfo(env, d.a))?.n} vs ${(await clubInfo(env, d.b))?.n}` : '') +
    (added.length ? '\n\nClubs players added:\n' + added.map(c => `${c.name} (${c.cc}) · ${c.id} · by player ${c.player}`).join('\n') : '') +
    (asked.length ? '\n\nAsked for, not added:\n' + asked.map(s => `${s.name}${s.country ? ' (' + s.country + ')' : ''}: ${s.result}`).join('\n') : '') +
    '\n\n/clubs off <id> takes an added club off. /derby Club A vs Club B calls a derby day.';
}

// /derby (admins): "Peñarol vs Nacional" (today, UTC), "... tomorrow" or "... 2026-11-01", "off" (today's), or nothing (what is set).
// Each side can be a club id or a name; a name that fits several clubs gets a list of ids to pick from. Posts the day to the group.
export async function derbyCommand(env, arg, by, now = Date.now()) {
  const a = String(arg || '').trim(), today = Math.floor(now / DAY);
  if (!a) {
    const { results } = await q(env, 'SELECT day, a, b, name FROM derby_days WHERE day >= ? ORDER BY day LIMIT 5', today).all();
    if (!results.length) return { text: '⚽ No derby day set.\n\n/derby Peñarol vs Nacional calls one for today (UTC): fans of both clubs score double play money and club war points all day, and the bot tells the group.\nAdd "tomorrow" or a date (2026-11-01) for another day. /derby off cancels today\'s.' };
    return { text: '⚽ Derby days:\n' + (await Promise.all(results.map(async r => `${new Date(r.day * DAY).toISOString().slice(0, 10)}: ${(await clubInfo(env, r.a))?.n} vs ${(await clubInfo(env, r.b))?.n}${r.name ? ' (' + r.name + ')' : ''}`))).join('\n') };
  }
  if (/^off\b/i.test(a)) { await q(env, 'DELETE FROM derby_days WHERE day = ?', today).run(); dayCache.day = -1; return { text: '⚽ Today\'s derby day is off.' } }
  let day = today, rest = a;
  const dm = rest.match(/\s+(tomorrow|\d{4}-\d{2}-\d{2})$/i);
  if (dm) { day = /tomorrow/i.test(dm[1]) ? today + 1 : Math.floor(Date.parse(dm[1] + 'T00:00:00Z') / DAY); rest = rest.slice(0, dm.index).trim() }
  if (!(day >= today && day < today + 60)) return { text: 'Pick today, tomorrow or a date in the next 60 days (2026-11-01).' };
  const sides = rest.split(/\s+(?:vs\.?|v|x|-|–)\s+/i);
  if (sides.length !== 2) return { text: 'Write it like this: /derby Peñarol vs Nacional' };
  const pick = async s => { s = s.trim(); const byId = await clubInfo(env, s.toLowerCase()); if (byId) return [byId]; const f = fold(s), hits = search(s, 6), exact = hits.filter(c => fold(c.n) === f); return exact.length === 1 ? exact : hits };
  const [A, B] = [await pick(sides[0]), await pick(sides[1])];
  for (const [hits, s] of [[A, sides[0]], [B, sides[1]]]) {
    if (!hits.length) return { text: `No club found for "${s}". Try another name, or a club id.` };
    if (hits.length > 1) return { text: `Which club is "${s}"? Use its id:\n` + hits.map(c => `${c.n} (${c.cc}): ${c.id}`).join('\n') };
  }
  const [ca, cb] = [A[0], B[0]]; if (ca.id === cb.id) return { text: 'Pick two different clubs.' };
  const name = derbyName(ca.id, cb.id);
  await q(env, 'INSERT INTO derby_days (day, a, b, name, admin, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET a = excluded.a, b = excluded.b, name = excluded.name, admin = excluded.admin, at = excluded.at',
    day, ca.id, cb.id, name, by || null, now).run(); dayCache.day = -1;
  const when = day === today ? 'today' : day === today + 1 ? 'tomorrow' : new Date(day * DAY).toISOString().slice(0, 10);
  return { text: `✅ Derby day ${when} (UTC): ${ca.n} vs ${cb.n}${name ? ' · ' + name : ''}.`, post: derbyPost(env, ca, cb, name, when), day };
}
export function derbyPost(env, a, b, name, when = 'today') {
  return { text: `⚽🔥 <b>DERBY DAY${when === 'today' ? '' : ' ' + esc(when.toUpperCase())}!</b>\n\n<b>${esc(a.n)}</b> vs <b>${esc(b.n)}</b>${name ? '\n<i>' + esc(name) + '</i>' : ''}\n\n` +
    `${when === 'today' ? 'All day today' : 'All that day'} (UTC), fans of both clubs win double play money in every match, and their club war points count double. Who has the bigger fan base? 🪱\n\n` +
    'Not a fan of either? Pick your own club in the game: More › My club.\n\n<i>Play money in the game, not real tokens.</i>', parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: '⚽ Play the derby', url: gameLink(env, 'club') }]] } };
}
export async function postDerby(env, msg) {
  const g = await q(env, "SELECT v FROM bot_kv WHERE k = 'group'").first().catch(() => null);
  if (!g || !msg) return false;
  const r = await tg(env, 'sendMessage', { chat_id: Number(g.v), ...msg }); return !!(r && r.ok);
}
