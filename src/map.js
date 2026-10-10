// World Map: the real world cut into ~5,000 hex tiles (src/world.js). Every player starts with a free home plot of 3 tiles
// in their own country and wins more by beating the land next to theirs in a battle. The owner's team is played by the
// CPU, made tougher by what the owner bought: defenses on that tile (mines, a bunker, an arsenal, an extra worm) and
// worm upgrades for all their land (accuracy, resistance). Land nobody owns is held by CPU worms. Everything is play
// money: land, defenses and upgrades are bought with in-game $CWORM, which is not a real token.
//   GET  /map                          -> the whole map: owned tiles, owners and this player's state
//   POST /map/join     {cc}            -> free home plot (first time only), in country cc or the one Cloudflare sees
//   POST /map/buy                      -> buy a new plot after losing all land: {price} is what the game takes from the wallet
//   POST /map/attack   {tile}          -> {ticket, def, acc, res, owner}: start a battle for a tile next to this player's land
//   POST /map/result   {ticket, win}   -> a battle ended; a win takes the tile
//   POST /map/defend   {tile, item}    -> one more level of a defense on one of this player's tiles: {price}
//   POST /map/upgrade  {stat}          -> one more level of worm accuracy or resistance: {price}
// The game spends the wallet after the server says yes; the server caps levels and counts, and battles have a minimum
// length, so a tampered phone can't take the world in a minute.
import { HEX, TERRAIN, COUNTRIES, TILES } from './world.js';
import { tg } from './bot.js';
import { flag, gameLink } from './growth.js';

export const ATTACKS_PER_DAY = 10, HOME_TILES = 3, SHIELD_MS = 3 * 864e5, TRUCE_MS = 20 * 60e3, MIN_BATTLE_MS = 40e3, TICKET_MS = 2 * 3600e3,
  INACTIVE_MS = 14 * 864e5, NOTIFY_GAP_MS = 30 * 60e3, BUYS_PER_DAY = 3, SEA_REACH = 3;
// defenses, one digit each in a tile's `def`: mines, bunker, arsenal, garrison. PRICES[item][level - 1]
export const DEFENSES = ['mines', 'bunker', 'arsenal', 'garrison'];
export const DEF_PRICES = { mines: [150, 300, 600], bunker: [400], arsenal: [200, 400, 800], garrison: [1000] };
export const UPGRADE_PRICES = [300, 600, 1200, 2400, 4800];          // accuracy and resistance, levels 1-5
export const landPrice = buys => 500 + 250 * Math.min(buys, 8);

const key = (q, r) => q * 4096 + r;
const AT = new Map(TILES.map((t, i) => [key(t[0], t[1]), i]));
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
export const neighbours = i => DIRS.map(([dq, dr]) => AT.get(key(TILES[i][0] + dq, TILES[i][1] + dr))).filter(n => n != null);
const COAST = TILES.map((t, i) => neighbours(i).length < 6);
const dist = (a, b) => { const dq = TILES[a][0] - TILES[b][0], dr = TILES[a][1] - TILES[b][1]; return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 };
export const terrain = i => TERRAIN[TILES[i][3]];
export const countryOf = i => COUNTRIES[TILES[i][2]];
// a tile can be attacked from land next to it, or across the sea from a coast up to SEA_REACH tiles away
export function reachable(target, mine) {
  for (const m of mine) { const d = dist(target, m); if (d <= 1 || (d <= SEA_REACH && COAST[target] && COAST[m])) return true }
  return false;
}
// land nobody owns: CPU worms, a little tougher in cities
export const neutralDef = i => terrain(i) === 'c' ? '1010' : '0000';

const json = (body, status = 200, cors = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } });
const day = now => Math.floor(now / 864e5);
const q = (env, s, ...v) => env.DB.prepare(s).bind(...v);

async function lord(env, id) { return q(env, 'SELECT * FROM landlords WHERE player = ?', id).first() }
async function myTiles(env, id) { return (await q(env, 'SELECT tile FROM land WHERE owner = ?', id).all()).results.map(r => r.tile) }
function meOut(l, tiles, now) {
  const today = l && l.day === day(now);
  return { joined: !!(l && l.joined), cc: l ? l.cc : null, home: l ? l.home : null, tiles: tiles.length, shield: l && l.shield > now ? l.shield : 0,
    acc: l ? l.acc : 0, res: l ? l.res : 0, attacksLeft: ATTACKS_PER_DAY - (today ? l.attacks : 0), buyPrice: landPrice(l ? l.buys : 0),
    won: l ? l.won : 0, lost: l ? l.lost : 0, held: l ? l.held : 0 };
}

export async function state(env, me, now = Date.now()) {
  const rows = (await env.DB.prepare(`SELECT l.tile, l.owner, l.def, l.truce, d.cc, d.shield, d.acc, d.res, p.name FROM land l
    JOIN landlords d ON d.player = l.owner JOIN players p ON p.id = l.owner`).all()).results;
  const owners = {};
  for (const r of rows) if (!owners[r.owner]) owners[r.owner] = [r.name || 'Worm', r.cc || '', r.shield > now ? r.shield : 0, r.acc, r.res];
  const l = me && await lord(env, me.id);
  return { now, tiles: rows.map(r => [r.tile, r.owner, r.def, r.truce > now ? r.truce : 0]), owners,
    me: me ? { id: me.id, ...meOut(l, rows.filter(r => r.owner === me.id).map(r => r.tile), now) } : null };
}

// the home plot: a free seed tile in the country with free tiles next to it, a few tiles from other players when there
// are some (so there is somebody to challenge), else anywhere in the country; small countries spill over the border
async function pickHome(env, cc, now) {
  const owned = new Set((await env.DB.prepare('SELECT tile FROM land').all()).results.map(r => r.tile));
  const free = i => !owned.has(i);
  let pool = TILES.map((t, i) => i).filter(i => COUNTRIES[TILES[i][2]] === cc && free(i));
  if (!pool.length) {                                                   // the country is full: the nearest free land
    const mine = TILES.map((t, i) => i).filter(i => COUNTRIES[TILES[i][2]] === cc);
    pool = TILES.map((t, i) => i).filter(free).sort((a, b) => Math.min(...mine.map(m => dist(a, m))) - Math.min(...mine.map(m => dist(b, m)))).slice(0, 40);
  }
  if (!pool.length) return null;
  const others = [...owned];
  const score = i => { const n = neighbours(i).filter(free).length, d = others.length ? Math.min(...others.map(o => dist(i, o))) : 5;
    return (n >= 2 ? 10 : n) + (d >= 2 && d <= 6 ? 6 : d > 6 ? 3 : 0) + Math.random() * 3 };
  const seed = pool.map(i => [i, score(i)]).sort((a, b) => b[1] - a[1])[0][0];
  const plot = [seed], seen = new Set(plot);
  for (let k = 0; k < plot.length && plot.length < HOME_TILES; k++)                     // grow outward, same country first
    for (const n of neighbours(plot[k]).sort((a, b) => (countryOf(b) === cc) - (countryOf(a) === cc)))
      if (plot.length < HOME_TILES && free(n) && !seen.has(n)) { plot.push(n); seen.add(n) }
  return plot;
}

async function notify(env, ownerId, text, now) {
  if (!env.BOT_TOKEN) return;
  const p = await q(env, `SELECT p.tg_id, d.notified, COALESCE(m.no_dm, 0) AS no_dm, COALESCE(m.remind, 1) AS remind FROM players p JOIN landlords d ON d.player = p.id
    LEFT JOIN player_meta m ON m.player = p.id WHERE p.id = ?`, ownerId).first();
  if (!p || p.tg_id == null || p.no_dm || !p.remind || now - p.notified < NOTIFY_GAP_MS) return;
  await q(env, 'UPDATE landlords SET notified = ? WHERE player = ?', now, ownerId).run();
  const r = await tg(env, 'sendMessage', { chat_id: p.tg_id, text, reply_markup: { inline_keyboard: [[{ text: '🌍 Defend your land', url: gameLink(env, 'map') }]] } });
  if (r && r.error_code === 403) await q(env, 'UPDATE player_meta SET no_dm = 1 WHERE player = ?', ownerId).run();
}

const countryName = cc => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) } catch (e) { return cc } };

export async function handle(path, req, env, me, body, cors, ctx, now = Date.now()) {
  const out = (b, s = 200) => json(b, s, cors), err = (e, s = 400) => out({ error: e }, s);
  const full = async extra => out({ ...(await state(env, me, now)), geo: (req.cf && req.cf.country) || null, ...extra });
  if (path === '/map' && req.method === 'GET') return full();
  if (req.method !== 'POST') return null;
  let l = await lord(env, me.id);

  if (path === '/map/join') {
    if (l && l.joined) return err('you already have a home plot');
    let cc = String(body.cc || (req.cf && req.cf.country) || '').toUpperCase();
    if (!COUNTRIES.includes(cc)) cc = COUNTRIES.includes(String(req.cf && req.cf.country || '').toUpperCase()) ? String(req.cf.country).toUpperCase() : 'US';
    const plot = await pickHome(env, cc, now);
    if (!plot) return err('the world is full', 409);
    await env.DB.batch([
      q(env, `INSERT INTO landlords (player, cc, home, joined, shield) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(player) DO UPDATE SET cc = excluded.cc, home = excluded.home, joined = excluded.joined, shield = excluded.shield`, me.id, cc, plot[0], now, now + SHIELD_MS),
      ...plot.map(t => q(env, 'INSERT OR IGNORE INTO land (tile, owner, since, def, truce) VALUES (?, ?, ?, ?, 0)', t, me.id, now, '0000')),
    ]);
    return full({ plot });
  }
  if (!l || !l.joined) return err('claim your home plot first', 409);
  const tiles = await myTiles(env, me.id), today = day(now);

  if (path === '/map/buy') {
    if (tiles.length) return err('you still have land');
    if (l.buy_day === today && l.buys_today >= BUYS_PER_DAY) return err('that is enough land for today', 429);
    const price = landPrice(l.buys), plot = await pickHome(env, l.cc, now);
    if (!plot) return err('the world is full', 409);
    await env.DB.batch([
      q(env, 'UPDATE landlords SET buys = buys + 1, buys_today = CASE WHEN buy_day = ? THEN buys_today + 1 ELSE 1 END, buy_day = ?, home = ? WHERE player = ?', today, today, plot[0], me.id),
      ...plot.map(t => q(env, 'INSERT OR IGNORE INTO land (tile, owner, since, def, truce) VALUES (?, ?, ?, ?, 0)', t, me.id, now, '0000')),
    ]);
    return full({ plot, price });
  }

  if (path === '/map/attack') {
    const t = Math.floor(Number(body.tile));
    if (!(t >= 0 && t < TILES.length)) return err('no such tile');
    if (!tiles.length) return err('buy land first', 409);
    if (tiles.includes(t)) return err('that is your land');
    if (!reachable(t, tiles)) return err('attack land next to yours');
    if (l.day === today && l.attacks >= ATTACKS_PER_DAY) return err('no attacks left today. More tomorrow!', 429);
    const row = await q(env, 'SELECT l.owner, l.def, l.truce, d.shield, d.acc, d.res, p.name FROM land l JOIN landlords d ON d.player = l.owner JOIN players p ON p.id = l.owner WHERE l.tile = ?', t).first();
    if (row && row.shield > now) return err('this player is new and protected for a few days');
    if (row && row.truce > now) return err('this land was just taken. Try again in a few minutes');
    const ticket = crypto.randomUUID().replace(/-/g, '');
    await env.DB.batch([
      q(env, "UPDATE attacks SET ended = ?, result = 'dropped' WHERE attacker = ? AND ended IS NULL", now, me.id),   // one battle at a time
      q(env, 'INSERT INTO attacks (ticket, attacker, tile, defender, started) VALUES (?, ?, ?, ?, ?)', ticket, me.id, t, row ? row.owner : null, now),
      q(env, 'UPDATE landlords SET attacks = CASE WHEN day = ? THEN attacks + 1 ELSE 1 END, day = ?, shield = CASE WHEN ? THEN 0 ELSE shield END WHERE player = ?', today, today, row ? 1 : 0, me.id),
    ]);
    return out({ ticket, tile: t, terrain: terrain(t), cc: countryOf(t), def: row ? row.def : neutralDef(t), acc: row ? row.acc : 0, res: row ? row.res : 0,
      owner: row ? { id: row.owner, name: row.name } : null, me: meOut(await lord(env, me.id), tiles, now) });
  }

  if (path === '/map/result') {
    const a = await q(env, 'SELECT * FROM attacks WHERE ticket = ? AND attacker = ?', String(body.ticket || ''), me.id).first();
    if (!a || a.ended != null) return err('that battle is over');
    if (now - a.started > TICKET_MS) { await q(env, "UPDATE attacks SET ended = ?, result = 'late' WHERE id = ?", now, a.id).run(); return err('that battle took too long') }
    const win = !!body.win;
    if (win && now - a.started < MIN_BATTLE_MS) return err('that was too quick', 400);
    if (!win) {
      await env.DB.batch([q(env, "UPDATE attacks SET ended = ?, result = 'lost' WHERE id = ?", now, a.id), q(env, 'UPDATE landlords SET lost = lost + 1 WHERE player = ?', me.id),
        ...(a.defender ? [q(env, 'UPDATE landlords SET held = held + 1 WHERE player = ?', a.defender)] : [])]);
      return full({ won: false });
    }
    const prev = await q(env, 'SELECT owner FROM land WHERE tile = ?', a.tile).first();
    await env.DB.batch([
      q(env, "UPDATE attacks SET ended = ?, result = 'won' WHERE id = ?", now, a.id),
      q(env, 'UPDATE landlords SET won = won + 1 WHERE player = ?', me.id),
      q(env, `INSERT INTO land (tile, owner, since, def, truce) VALUES (?, ?, ?, '0000', ?)
        ON CONFLICT(tile) DO UPDATE SET owner = excluded.owner, since = excluded.since, def = excluded.def, truce = excluded.truce`, a.tile, me.id, now, now + TRUCE_MS),
    ]);
    if (prev && prev.owner !== me.id) {
      const left = (await q(env, 'SELECT COUNT(*) AS n FROM land WHERE owner = ?', prev.owner).first()).n, cc = countryOf(a.tile);
      const text = `⚔️ ${me.name} took your land in ${flag(cc)} ${countryName(cc)}!\n\n` +
        (left ? `You have ${left} tile${left === 1 ? '' : 's'} left. Win it back, and buy defenses to keep it.` : 'That was your last tile. Buy a new plot and take your revenge!') +
        '\n\nLand is play money, not real tokens.';
      const n = notify(env, prev.owner, text, now).catch(() => { });
      if (ctx && ctx.waitUntil) ctx.waitUntil(n); else await n;
    }
    return full({ won: true, tile: a.tile });
  }

  if (path === '/map/defend') {
    const t = Math.floor(Number(body.tile)), item = DEFENSES.indexOf(String(body.item));
    if (item < 0) return err('no such defense');
    const row = await q(env, 'SELECT def FROM land WHERE tile = ? AND owner = ?', t, me.id).first();
    if (!row) return err('that is not your land');
    const lv = +row.def[item] || 0, prices = DEF_PRICES[DEFENSES[item]];
    if (lv >= prices.length) return err('that defense is already at the top level');
    const def = row.def.slice(0, item) + (lv + 1) + row.def.slice(item + 1);
    await q(env, 'UPDATE land SET def = ? WHERE tile = ?', def, t).run();
    return full({ price: prices[lv], tile: t, def });
  }

  if (path === '/map/upgrade') {
    const stat = body.stat === 'acc' ? 'acc' : body.stat === 'res' ? 'res' : null;
    if (!stat) return err('no such upgrade');
    const lv = l[stat];
    if (lv >= UPGRADE_PRICES.length) return err('already at the top level');
    await q(env, `UPDATE landlords SET ${stat} = ${stat} + 1 WHERE player = ?`, me.id).run();
    return full({ price: UPGRADE_PRICES[lv], stat, level: lv + 1 });
  }
  return null;
}

// Land of players who haven't opened the game for 14 days goes back to the CPU (run from the cron).
export async function cleanup(env, now = Date.now()) {
  await q(env, 'DELETE FROM land WHERE owner IN (SELECT player FROM player_meta WHERE last_seen < ?)', now - INACTIVE_MS).run();
  await q(env, "UPDATE attacks SET ended = ?, result = 'late' WHERE ended IS NULL AND started < ?", now, now - TICKET_MS).run();
}
