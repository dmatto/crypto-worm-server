// The control panel (Damian 2026-11-13: "a web real time control panel, so I can see players enter the game, actives and all the
// data that can help me to improve. Also trigger some events, send gifts and reminder of reward and payments").
// The page is play.cryptoworm.io/panel/ ; it calls these two routes with the game's own sign-in, and only the accounts listed in
// ADMIN_PLAYERS get an answer. GET /panel/data is one read of everything the page shows (it asks again every 15 seconds).
// POST /panel/act does one thing: a gift to a player, a gift code, a derby day, an update note, a reward reminder.
// Money never moves from here: prize payouts stay with the bot's /pay and its code. Every action is written to bot_log.
// Numbers count real players only (never the load-test bots).
import { weekStart, gameLink, addAnnouncement, kickAnnounce, utcDay } from './growth.js';
import { parse as giftParse, create as giftCreate, describe as giftDescribe, links as giftLinks } from './gifts.js';
import { derbyCommand, postDerby } from './clubs.js';
import { lookup } from './players.js';
import { pushPlayer } from './push.js';
import { tpOn } from './teamprize.js';
import { rookieOn, drawOn, FIRST_WEEK } from './prize.js';
import { FUNNEL_STEPS } from './funnel.js';
import { tg } from './bot.js';

const DAY = 864e5, WEEK = 7 * DAY, MIN = 60e3;
export const GIFT_MAX = 50000, REMIND_BATCH = 30, REMIND_GAP = 20 * 3600e3, REMIND_AWAY = 6 * 3600e3, REMIND_AGE = 3600e3;
export const isAdmin = (env, me) => !!me && String(env.ADMIN_PLAYERS || '').split(',').map(Number).includes(me.id);
const REAL = 'NOT IN (SELECT player FROM sim_players)';
const all = (env, sql, ...v) => env.DB.prepare(sql).bind(...v).all().then(r => r.results || []).catch(() => []);
const one = (env, sql, ...v) => env.DB.prepare(sql).bind(...v).first().catch(() => null);
const iso = t => new Date(t).toISOString().slice(0, 10);
const log = (env, me, note) => env.DB.prepare('INSERT INTO bot_log (at, note) VALUES (?, ?)').bind(Date.now(), `panel ${me.id}: ${note}`.slice(0, 500)).run().catch(() => { });

// What is due: the payouts of the week that ended, each with the bot commands that pay it, and whether a batch for it exists.
export async function todo(env, now = Date.now()) {
  const w = weekStart(now) - WEEK, d = iso(w), out = [];
  if (w < FIRST_WEEK) return out;
  const batches = await all(env, 'SELECT label, status FROM pay_batch WHERE created >= ? ORDER BY id DESC', w + WEEK);
  const state = label => { const b = batches.find(x => x.label === label && x.status !== 'cancelled'); return b ? b.status : null };
  const add = (name, label, list, pay) => out.push({ name, week: d, list, pay, state: label ? state(label) : null });
  add('Weekly prize', 'Weekly prize, week of ' + d, '/prize last', '/pay prize');
  if (rookieOn(w)) add('New players prize', 'New players prize, week of ' + d, '/prize new last', '/pay rookies');
  if (drawOn(w)) add('Weekly draw', 'Weekly draw, week of ' + d, '/prize draw last', '/pay draw');
  if (tpOn(w)) add('Team Prize', null, '/prize team last', '/pay new Team Prize');
  return out;
}

export async function data(env, now = Date.now()) {
  const day0 = Math.floor(now / DAY) * DAY, w = weekStart(now), dn = Math.floor(now / DAY);
  const lobby = env.LOBBY ? env.LOBBY.get(env.LOBBY.idFromName('lobby')) : null;
  const lj = async p => { try { return await (await lobby.fetch('https://lobby' + p)).json() } catch (e) { return null } };
  const [online, live, tot, act, fresh, matches, joins, here, newDays, actDays, cohorts, sources, funnel, holders, three, top, gifts, sales, feedback, owed, note, noteDay, batches, due] = await Promise.all([
    lobby ? lj('/count') : null, lobby ? lj('/live') : null,
    one(env, `SELECT COUNT(*) AS players, SUM(tg_id IS NOT NULL) AS tg, SUM(wallet IS NOT NULL) AS wallets FROM players WHERE id ${REAL}`),
    one(env, `SELECT SUM(last_seen > ?) AS m5, SUM(last_seen > ?) AS h1, SUM(last_seen > ?) AS d1, SUM(last_seen > ?) AS d7 FROM player_meta WHERE player ${REAL}`, now - 5 * MIN, now - 60 * MIN, now - DAY, now - WEEK),
    one(env, `SELECT SUM(created >= ?) AS today, SUM(created >= ? AND created < ?) AS yesterday, SUM(created >= ?) AS week FROM players WHERE created >= ? AND id ${REAL}`, day0, day0 - DAY, day0, now - WEEK, now - WEEK),
    one(env, `SELECT SUM(at >= ?) AS today, SUM(at >= ?) AS hour, COUNT(DISTINCT CASE WHEN at >= ? THEN player END) AS players FROM run_log WHERE at >= ? AND player ${REAL}`, day0, now - 60 * MIN, day0, day0 - DAY),
    all(env, `SELECT p.id, p.name, p.created, p.tg_id IS NOT NULL AS tg, p.wallet IS NOT NULL AS wallet, m.source, m.cc, m.played, m.last_seen FROM players p LEFT JOIN player_meta m ON m.player = p.id
      WHERE p.id ${REAL} ORDER BY p.id DESC LIMIT 40`),
    all(env, `SELECT p.id, p.name, p.created, m.source, m.cc, m.played, m.last_seen FROM player_meta m JOIN players p ON p.id = m.player
      WHERE m.last_seen > ? AND m.player ${REAL} ORDER BY m.last_seen DESC LIMIT 40`, now - 30 * MIN),
    all(env, `SELECT created / ${DAY} AS d, COUNT(*) AS n FROM players WHERE created >= ? AND id ${REAL} GROUP BY d`, day0 - 13 * DAY),
    all(env, `SELECT day AS d, COUNT(*) AS n FROM play_days WHERE day >= ? AND player ${REAL} GROUP BY day`, dn - 13),
    all(env, `SELECT p.created / ${DAY} AS d, COUNT(*) AS n, SUM(m.played > 0) AS played, SUM(EXISTS (SELECT 1 FROM play_days x WHERE x.player = p.id AND x.day > p.created / ${DAY})) AS back
      FROM players p LEFT JOIN player_meta m ON m.player = p.id WHERE p.created >= ? AND p.id ${REAL} GROUP BY d`, day0 - 13 * DAY),
    all(env, `SELECT COALESCE(m.source, '?') AS source, COUNT(*) AS n, SUM(m.played > 0) AS played, SUM(m.played >= 3) AS three FROM players p JOIN player_meta m ON m.player = p.id
      WHERE p.created >= ? AND p.id ${REAL} GROUP BY source ORDER BY n DESC LIMIT 12`, now - WEEK),
    all(env, 'SELECT plat, step, SUM(n) AS n FROM funnel WHERE day >= ? GROUP BY plat, step', iso(now - 6 * DAY)),
    one(env, `SELECT SUM(tier > 0) AS holders, COUNT(*) AS wallets FROM holders WHERE player ${REAL}`),
    one(env, `SELECT COUNT(*) AS n FROM (SELECT player FROM play_days WHERE day >= ? AND player ${REAL} GROUP BY player HAVING COUNT(*) >= 3)`, Math.floor(w / DAY)),
    all(env, `SELECT s.player AS id, p.name, s.week AS bp FROM cworm_scores s JOIN players p ON p.id = s.player WHERE s.week_start = ? AND s.week > 0 AND s.player ${REAL} ORDER BY s.week DESC LIMIT 10`, w),
    all(env, 'SELECT * FROM gift_codes WHERE off = 0 AND (expires IS NULL OR expires > ?) ORDER BY created DESC LIMIT 12', now),
    one(env, 'SELECT COUNT(*) AS n, COALESCE(SUM(stars), 0) AS stars FROM purchases WHERE refunded IS NULL AND created >= ?', now - 30 * DAY),
    all(env, 'SELECT id, player, name, rating, text, info, created FROM feedback ORDER BY id DESC LIMIT 8'),
    one(env, `SELECT COUNT(DISTINCT player) AS players, COALESCE(SUM(amount), 0) AS bp FROM rewards WHERE claimed IS NULL AND player ${REAL}`),
    one(env, 'SELECT id, text, created, sent, done FROM announcements ORDER BY id DESC LIMIT 1'),
    one(env, "SELECT v FROM bot_kv WHERE k = 'note_day'"),
    all(env, 'SELECT b.id, b.label, b.status, b.created, COUNT(l.n) AS n FROM pay_batch b LEFT JOIN pay_line l ON l.batch = b.id GROUP BY b.id ORDER BY b.id DESC LIMIT 5'),
    todo(env, now).catch(() => []),
  ]);
  const days = [];
  for (let d = dn - 13; d <= dn; d++) {
    const c = cohorts.find(x => x.d === d) || {};
    days.push({ day: iso(d * DAY), joined: (newDays.find(x => x.d === d) || {}).n || 0, active: (actDays.find(x => x.d === d) || {}).n || 0, played: c.played || 0, back: c.back || 0 });
  }
  const fun = {}; for (const r of funnel) (fun[r.plat] = fun[r.plat] || {})[r.step] = r.n;
  return {
    now, me: true,
    online: online && typeof online.online === 'number' ? online.online : null, playing: online && typeof online.playing === 'number' ? online.playing : null,
    live: live && Array.isArray(live.live) ? live.live.length : 0,
    totals: { players: tot && tot.players || 0, tg: tot && tot.tg || 0, wallets: tot && tot.wallets || 0, holders: holders && holders.holders || 0 },
    active: { m5: act && act.m5 || 0, h1: act && act.h1 || 0, d1: act && act.d1 || 0, d7: act && act.d7 || 0 },
    joined: { today: fresh && fresh.today || 0, yesterday: fresh && fresh.yesterday || 0, week: fresh && fresh.week || 0 },
    matches: { today: matches && matches.today || 0, hour: matches && matches.hour || 0, players: matches && matches.players || 0 },
    joins, here, days, sources, funnel: { steps: FUNNEL_STEPS, plats: fun },
    prize: { week: iso(w), three: three && three.n || 0, top },
    gifts: gifts.map(g => ({ code: g.code, what: giftDescribe(g), uses: g.uses, max: g.max_uses, expires: g.expires, src: g.src })),
    sales: sales || { n: 0, stars: 0 }, feedback, owed: owed || { players: 0, bp: 0 },
    note: note ? { text: String(note.text).slice(0, 300), created: note.created, sent: note.sent, done: note.done } : null, noteToday: !!noteDay && noteDay.v === utcDay(now),
    batches, todo: due,
  };
}

// One reminder to players who have Battle Points waiting and haven't been in for a while: a bot message (Telegram players who
// allow reminders) or a browser reminder (web players who switched them on). At most REMIND_BATCH per press; never twice in 20 hours.
export async function remindRewards(env, now = Date.now()) {
  const rows = await all(env, `SELECT p.id, p.tg_id, SUM(r.amount) AS bp, m.remind, m.no_dm, (SELECT COUNT(*) FROM push_subs s WHERE s.player = p.id) AS subs
      FROM rewards r JOIN players p ON p.id = r.player JOIN player_meta m ON m.player = p.id
      WHERE r.claimed IS NULL AND r.created < ? AND m.last_seen < ? AND m.reminded < ? AND p.id ${REAL}
      GROUP BY p.id HAVING bp > 0 AND ((p.tg_id IS NOT NULL AND m.remind = 1 AND m.no_dm = 0) OR subs > 0) ORDER BY bp DESC LIMIT ?`, now - REMIND_AGE, now - REMIND_AWAY, now - REMIND_GAP, REMIND_BATCH + 1);
  let sent = 0; const batch = rows.slice(0, REMIND_BATCH);
  for (const r of batch) {
    const text = `🎁 ${Number(r.bp).toLocaleString('en-US')} BP are waiting for you in Crypto Worm Wars (play money). Open the game to collect them.`;
    let ok = false, refused = false;
    if (r.tg_id != null && r.remind === 1 && r.no_dm === 0 && env.BOT_TOKEN) {
      const res = await tg(env, 'sendMessage', { chat_id: r.tg_id, text: text + '\n\nTurn these off with /stop or in the game\'s Settings.', reply_markup: { inline_keyboard: [[{ text: '🎮 Play', url: gameLink(env) }]] } });
      ok = !!(res && res.ok); refused = !!res && (res.error_code === 403 || res.error_code === 400);
    }
    if (!ok && r.subs > 0) ok = await pushPlayer(env, r.id, { title: 'Crypto Worm Wars', body: text, url: 'https://play.cryptoworm.io/?src=push', tag: 'cww-reward' }, now).catch(() => 0) > 0;
    await env.DB.prepare(refused ? 'UPDATE player_meta SET no_dm = 1, reminded = ? WHERE player = ?' : 'UPDATE player_meta SET reminded = ? WHERE player = ?').bind(now, r.id).run();
    if (ok) sent++;
  }
  return { sent, tried: batch.length, more: rows.length > REMIND_BATCH };
}

export async function act(env, me, b, now = Date.now()) {
  const a = String(b && b.a || '');
  if (a === 'player') return { text: await lookup(env, String(b.q || '').slice(0, 60), now) };
  if (a === 'gift') {                                                              // Battle Points to one player: a reward row their game collects
    const id = Number(b.player), amount = Math.floor(Number(b.amount)), note = String(b.note || '').replace(/[<>]/g, '').trim().slice(0, 80);
    if (!Number.isInteger(id) || id <= 0) return { error: 'Which player? Type their player ID.' };
    if (!(amount > 0) || amount > GIFT_MAX) return { error: `An amount between 1 and ${GIFT_MAX.toLocaleString('en-US')} BP.` };
    const p = await one(env, 'SELECT id, name FROM players WHERE id = ?', id);
    if (!p) return { error: `No player with ID ${id}.` };
    await env.DB.prepare("INSERT INTO rewards (player, amount, reason, note, created) VALUES (?, ?, 'present', ?, ?)").bind(id, amount, note, now).run();
    await log(env, me, `gift ${amount} BP to ${id}${note ? ' (' + note + ')' : ''}`);
    return { ok: true, text: `${amount.toLocaleString('en-US')} BP are waiting for ${p.name} (ID ${id}). They get them the next time they open the game.` };
  }
  if (a === 'code') {                                                              // a gift code, the same words as the bot's /gift
    const r = giftParse(String(b.spec || '').slice(0, 200)); if (r.error) return { error: r.error };
    const tgId = (await one(env, 'SELECT tg_id FROM players WHERE id = ?', me.id) || {}).tg_id || null;
    const made = await giftCreate(env, r.make, tgId, now); if (made.error) return { error: made.error };
    await log(env, me, `gift codes ${made.made.map(g => g.code).join(' ')}`);
    return { ok: true, codes: made.made.map(g => ({ code: g.code, what: giftDescribe(g), max: g.max_uses, expires: g.expires, ...giftLinks(env, g.code) })) };
  }
  if (a === 'derby') {
    const r = await derbyCommand(env, String(b.arg || '').slice(0, 120), me.id, now);
    const posted = r.post ? await postDerby(env, r.post) : null;
    await log(env, me, `derby ${String(b.arg || '').slice(0, 80)}`);
    return { ok: true, text: r.text + (r.post ? (posted ? '\n\nPosted in the community group.' : '\n\nThe group post did not go out.') : '') };
  }
  if (a === 'note') {                                                              // an update note: the group and every Telegram player, one a day
    const text = String(b.text || '').trim();
    if (text.length < 10) return { error: 'Write the note first (at least a sentence).' };
    if (text.length > 3500) return { error: 'At most 3,500 characters.' };
    await addAnnouncement(env, text); await kickAnnounce(env);
    const today = (await one(env, "SELECT v FROM bot_kv WHERE k = 'note_day'") || {}).v === utcDay(now);
    await log(env, me, `note queued (${text.length} chars)`);
    return { ok: true, text: today ? 'Queued. A note already went out today, so this one goes out tomorrow (one note a day).' : 'Sending now to the group and every Telegram player (except those who sent /stop).' };
  }
  if (a === 'remind') {
    const r = await remindRewards(env, now);
    await log(env, me, `reward reminder: ${r.sent} of ${r.tried}`);
    return { ok: true, ...r, text: r.tried ? `Reminder sent to ${r.sent} of ${r.tried} players.` + (r.more ? ' More are waiting: press again.' : '') : 'Nobody to remind right now: no player with Battle Points waiting who has been away and can be reached.' };
  }
  return { error: 'unknown action' };
}

// Monday 12:00 UTC: one bot message to the admins with the payouts that are due (a reminder; paying stays with /pay).
export async function payReminder(env, admins, now = Date.now()) {
  const d = new Date(now); if (d.getUTCDay() !== 1 || d.getUTCHours() !== 12 || d.getUTCMinutes() >= 15 || !env.BOT_TOKEN) return 0;
  const k = 'pay_remind', wk = iso(weekStart(now));
  if ((await one(env, 'SELECT v FROM bot_kv WHERE k = ?', k) || {}).v === wk) return 0;
  await env.DB.prepare('INSERT INTO bot_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, wk).run();
  const due = (await todo(env, now)).filter(t => t.state !== 'done');
  if (!due.length) return 0;
  const text = '💸 Payouts due for the week of ' + due[0].week + ':\n\n' + due.map(t => `• ${t.name}: ${t.list}, then ${t.pay}`).join('\n') + '\n\nNothing is paid until you send /pay send with its code.';
  let n = 0; for (const chat_id of admins) { const r = await tg(env, 'sendMessage', { chat_id, text }); if (r && r.ok) n++ }
  return n;
}

// ---- sign-in with a user name and a password (Damian 2026-11-13: "Set a user and password system to enter the control panel") ----
// The server keeps no password: PANEL_USER and PANEL_PASS are Worker secrets, PANEL_PASS being "pbkdf2$<rounds>$<salt>$<hash>"
// (tools/panel_pass.py makes it). A right pair gets a panel token, good for a day; five wrong tries from one network in 15 minutes
// (or thirty from anywhere in an hour) close the door until they age out.
const enc = new TextEncoder(), b64 = u => btoa(String.fromCharCode(...new Uint8Array(u))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = t => Uint8Array.from(atob(String(t).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const same = (x, y) => { x = String(x); y = String(y); let d = x.length ^ y.length; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i % (y.length || 1)); return d === 0 };
export const TOKEN_S = 86400, FAILS_IP = 5, FAILS_ALL = 30, FAIL_MS = 15 * MIN;
export async function passHash(pass, salt, rounds = 100000) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pass)), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: rounds }, key, 256));
}
export async function makePass(pass, rounds = 100000) { const salt = b64(crypto.getRandomValues(new Uint8Array(16))); return `pbkdf2$${rounds}$${salt}$${await passHash(pass, salt, rounds)}` }
async function sign(env, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode('panel:' + env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
export async function panelToken(env, now = Date.now()) { const exp = Math.floor(now / 1000) + TOKEN_S; return `panel.${exp}.${await sign(env, 'panel.' + exp)}` }
export async function readPanelToken(env, req, now = Date.now()) {
  const auth = req.headers.get('Authorization') || '', [k, exp, sig] = (auth.startsWith('Bearer ') ? auth.slice(7) : '').split('.');
  return k === 'panel' && !!sig && !!env.SESSION_SECRET && Number(exp) > now / 1000 && same(sig, await sign(env, 'panel.' + exp));
}
export async function login(env, req, body, now = Date.now()) {
  if (!env.PANEL_USER || !env.PANEL_PASS) return { status: 503, error: 'The password sign-in is not set up yet.' };
  const ip = b64(await crypto.subtle.digest('SHA-256', enc.encode('panel-ip:' + env.SESSION_SECRET + ':' + (req.headers.get('CF-Connecting-IP') || '')))).slice(0, 16);
  const mine = (await one(env, 'SELECT COUNT(*) AS n FROM panel_fails WHERE ip = ? AND at > ?', ip, now - FAIL_MS) || {}).n || 0;
  const everyone = (await one(env, 'SELECT COUNT(*) AS n FROM panel_fails WHERE at > ?', now - 4 * FAIL_MS) || {}).n || 0;
  if (mine >= FAILS_IP || everyone >= FAILS_ALL) return { status: 429, error: 'Too many wrong tries. Wait 15 minutes and try again.' };
  const [kind, rounds, salt, hash] = String(env.PANEL_PASS).split('$');
  const got = kind === 'pbkdf2' && salt && hash ? await passHash(String(body && body.pass || '').slice(0, 200), salt, Number(rounds)) : '';
  const okUser = same(String(body && body.user || '').trim().toLowerCase(), String(env.PANEL_USER).trim().toLowerCase()), okPass = !!got && same(got, hash);
  if (!okUser || !okPass) {
    await env.DB.batch([env.DB.prepare('INSERT INTO panel_fails (ip, at) VALUES (?, ?)').bind(ip, now), env.DB.prepare('DELETE FROM panel_fails WHERE at < ?').bind(now - DAY)]);
    await env.DB.prepare('INSERT INTO bot_log (at, note) VALUES (?, ?)').bind(now, 'panel: wrong sign-in').run().catch(() => { });
    return { status: 401, error: 'Wrong user or password.' };
  }
  await env.DB.prepare('INSERT INTO bot_log (at, note) VALUES (?, ?)').bind(now, 'panel: signed in with the password').run().catch(() => { });
  return { token: await panelToken(env, now) };
}

// Who may use the panel: a panel token from the password sign-in, or a game session of an account in ADMIN_PLAYERS.
export async function handle(path, req, env, me, body, now = Date.now()) {
  if (path === '/panel/login' && req.method === 'POST') return login(env, req, body, now);
  let who = isAdmin(env, me) ? me : null;
  if (!who && await readPanelToken(env, req, now)) {                               // the password: act as the first admin account, when there is one
    const id = String(env.ADMIN_PLAYERS || '').split(',').map(Number).find(n => n > 0);
    who = (id && await one(env, 'SELECT * FROM players WHERE id = ?', id)) || { id: 0, name: 'panel' };
  }
  if (!who) return me ? { status: 403, error: 'not an admin' } : { status: 401, error: 'sign in first' };
  if (path === '/panel/data' && req.method === 'GET') return data(env, now);
  if (path === '/panel/act' && req.method === 'POST') return act(env, who, body, now);
  return { status: 404, error: 'not found' };
}
