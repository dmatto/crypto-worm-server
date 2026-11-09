// Gift codes (Damian 2026-10-31: "add the possibility to enter gift codes, so I or others can send gifts in the game. Like: CWORM,
// Skins, Personalized worm free, etc."). An admin (ADMIN_PLAYERS) makes a code with the bot's /gift; anyone who has it types it in
// the game (More › 🎁 Gift code) or opens its link (startapp=g_<CODE> in Telegram, ?gift=<CODE> on the web) and gets what it
// holds, once per account. A code can hold any mix of:
//   play $CWORM   a reward row (reason 'gift', note the code) the game claims like invite rewards: play money, outside the ranking
//                 and the weekly prize
//   looks         store items (hats, skins, trails, graves; ITEMS below, the game's SHOP ids), invite-only and achievement skins too,
//                 and the Lucky skin that only codes give. The session's player.gifts lists every look the account got from codes,
//                 so they come back on any device
//   custom worm   free Custom Worm sets (gift_credits, see worms.js): no holder tier needed and no price, and that portrait shows
//                 even while the player doesn't hold
// plus a number of uses (first come, first served), an end date, and a source tag (s_<tag>) given to brand-new players who came
// in with the code's link (the game sends source 'gift' for those).
//   POST /gift/redeem {code}  -> {ok, code, cworm, items, worm, rewards}   or {error, code, status}: code bad | used | full | gone | wait
// The store build of the game doesn't show codes at all.

export const ITEMS = {
  hat: 'pirate chef propeller santa wizard horns halo astro hardhat fur beanie bandana grad flowers laurel unicorn bunny catears flower beret sunhat tiara',
  skin: 'mint neon ape ice shadow gold rainbow lava ocean toxic sakura copper midnight ruby emerald platinum galaxy coral ambassador influencer godlike untouch royal lucky',
  trail: 'coins hearts fire candles stars rainbowt rockets diamonds moons bolts snow money bubbles comet butterflies sparkles',
  grave: 'bag btc rocketg gem statue trophy moong whaleg crowng ufo pyramid heartg perfume lipstick',
};
const ITEM = new Map(Object.entries(ITEMS).flatMap(([cat, s]) => s.split(' ').map(id => [id, cat])));
export const MAX_CWORM = 1_000_000, MAX_WORMS = 3, MAX_USES = 100_000, MAX_BATCH = 50, FAILS_PER_HOUR = 10, DEFAULT_DAYS = 30;
const CODE = /^[A-Z0-9]{4,20}$/, HOUR = 3600e3, DAY = 864e5;
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';                   // no 0/O or 1/I to mix up
const q = (env, s, ...v) => env.DB.prepare(s).bind(...v);
const changed = r => !!(r && (r.meta ? r.meta.changes : r.changes));
const fmt = n => n.toLocaleString('en-US');
export const clean = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const randomCode = (n = 8) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => ABC[b % ABC.length]).join('');
const site = env => (env.SITE_URL || env.MENU_URL || 'https://play.cryptoworm.io/').replace(/\/+$/, '');
const tgLink = (env, code) => { const l = env.GAME_LINK || 'https://t.me/CryptoWormWarsBot/play'; return l + (l.includes('?') ? '&' : '?') + 'startapp=g_' + code };
export const links = (env, code) => ({ tg: tgLink(env, code), web: site(env) + '/?gift=' + code });

const WHY = {
  bad: "That code doesn't exist. Check the letters and try again.", used: 'You already used this code.', full: 'This code was used up.',
  gone: 'This code has expired.', wait: 'Too many wrong codes. Try again in an hour.',
};
const no = (code, status) => ({ error: WHY[code], code, status });

export async function handle(path, env, me, body, { now = Date.now() } = {}) {
  if (path !== '/gift/redeem') return null;
  const code = clean(body && body.code);
  const fails = await q(env, 'SELECT COUNT(*) AS n FROM gift_fails WHERE player = ? AND at > ?', me.id, now - HOUR).first();
  if (fails.n >= FAILS_PER_HOUR) return no('wait', 429);
  const g = CODE.test(code) ? await q(env, 'SELECT * FROM gift_codes WHERE code = ?', code).first() : null;
  if (!g) { await env.DB.batch([q(env, 'DELETE FROM gift_fails WHERE at < ?', now - DAY), q(env, 'INSERT INTO gift_fails (player, at) VALUES (?, ?)', me.id, now)]); return no('bad', 404) }
  if (await q(env, 'SELECT 1 AS y FROM gift_redeems WHERE code = ? AND player = ?', code, me.id).first()) return no('used', 409);
  if (g.off || (g.expires && g.expires < now)) return no('gone', 410);
  if (g.uses >= g.max_uses) return no('full', 410);
  // take a use first (one statement, so two players can't both take the last one), then the player's row; undo the use if that row exists
  if (!changed(await q(env, 'UPDATE gift_codes SET uses = uses + 1 WHERE code = ? AND uses < max_uses AND off = 0', code).run())) return no('full', 410);
  if (!changed(await q(env, 'INSERT OR IGNORE INTO gift_redeems (code, player, at) VALUES (?, ?, ?)', code, me.id, now).run())) {
    await q(env, 'UPDATE gift_codes SET uses = uses - 1 WHERE code = ?', code).run(); return no('used', 409);
  }
  const items = itemsOf(g.items), worm = g.worm | 0, cworm = g.cworm | 0, writes = [];
  if (cworm > 0) writes.push(q(env, "INSERT INTO rewards (player, amount, reason, note, created) VALUES (?, ?, 'gift', ?, ?)", me.id, cworm, code, now));
  if (worm > 0) writes.push(q(env, 'INSERT INTO gift_credits (player, worm) VALUES (?, ?) ON CONFLICT(player) DO UPDATE SET worm = worm + excluded.worm', me.id, worm));
  if (g.src) writes.push(q(env, "UPDATE player_meta SET source = ? WHERE player = ? AND source = 'gift'", g.src, me.id));   // a new player who came with the code's link
  if (writes.length) await env.DB.batch(writes);
  const { results } = await q(env, 'UPDATE rewards SET claimed = ? WHERE player = ? AND claimed IS NULL RETURNING amount, reason, note', now, me.id).all();
  return { ok: true, code, cworm, items, worm, rewards: results || [] };
}

const itemsOf = s => String(s || '').split(',').filter(id => ITEM.has(id));
// Every look this account got from codes (the session's player.gifts), so the game can add them on each device.
export async function giftItems(env, id) {
  const { results } = await q(env, "SELECT g.items FROM gift_redeems r JOIN gift_codes g ON g.code = r.code WHERE r.player = ? AND g.items != ''", id).all();
  return [...new Set(results.flatMap(r => itemsOf(r.items)))];
}
// Free Custom Worm sets this player has left (worms.js).
export const wormCredits = (env, id) => q(env, 'SELECT worm FROM gift_credits WHERE player = ?', id).first().then(r => r ? r.worm | 0 : 0).catch(() => 0);

// ---- /gift (admins, in the bot's private chat)
export const HELP = '🎁 Gift codes\n\n' +
  'Make one: /gift followed by what it holds, in any order:\n' +
  '  1000        BP\n' +
  '  gold        a look from the store (any hat, skin, trail or grave id), as many as you like\n' +
  '  worm        a free Custom Worm (worm2 = two)\n' +
  '  x50         how many players can use it (1 if left out)\n' +
  '  7d          how long it works (30 days if left out; 0d = no end)\n' +
  '  s_fomo      source tag for new players who come with its link\n' +
  '  HALLOWEEN   your own code name in CAPITALS (a random one if left out)\n' +
  '  *10         ten separate codes (with a source tag: s_fomo1 … s_fomo10)\n\n' +
  'Examples:\n/gift 1000 lucky\n/gift 2000 worm gold x100 7d HALLOWEEN\n/gift 1000 coral *10 s_fomo\n\n' +
  '/gift list: the latest codes · /gift CODE: who used it · /gift off CODE · /gift on CODE\n\n' +
  'Looks: ' + Object.entries(ITEMS).map(([c, s]) => c + 's: ' + s.replace(/ /g, ', ')).join('\n') +
  '\n(lucky is a skin only gift codes give.)\n\nAll play money and looks: nothing real.';

// What a code holds, in words.
export function describe(g) {
  const parts = [];
  if (g.cworm > 0) parts.push(`+${fmt(g.cworm)} BP`);
  for (const id of itemsOf(g.items)) parts.push(`${id} ${ITEM.get(id)}`);
  if (g.worm > 0) parts.push(g.worm > 1 ? `${g.worm} free Custom Worms` : 'a free Custom Worm');
  return parts.join(' + ') || 'nothing';
}
const when = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const line = (g, now) => `${g.code}: ${describe(g)} · ${g.uses}/${g.max_uses} used` + (g.off ? ' · OFF' : g.expires ? (g.expires < now ? ' · expired' : ' · until ' + when(g.expires)) : '') + (g.src ? ' · s_' + g.src : '');

// Reads the /gift words into a code to make: {make: {cworm, items, worm, max, days, src, name, count}} or {error}.
export function parse(arg) {
  const out = { cworm: 0, items: [], worm: 0, max: 1, days: DEFAULT_DAYS, src: null, name: null, count: 1 };
  for (const w of String(arg || '').trim().split(/\s+/).filter(Boolean)) {
    const lw = w.toLowerCase(); let m;
    if (/^\d[\d,.]*$/.test(w)) out.cworm += Number(w.replace(/[,.]/g, ''));
    else if ((m = lw.match(/^(?:worm|cw|customworm)(\d*)$/))) out.worm += m[1] ? +m[1] : 1;
    else if (ITEM.has(lw) && w === lw) { if (!out.items.includes(lw)) out.items.push(lw) }
    else if ((m = lw.match(/^x(\d+)$/))) out.max = +m[1];
    else if ((m = lw.match(/^(\d+)d$/))) out.days = +m[1];
    else if ((m = lw.match(/^\*(\d+)$/))) out.count = +m[1];
    else if ((m = lw.match(/^s_([a-z0-9_]{1,20})$/))) out.src = m[1];
    else if (CODE.test(w)) out.name = w;
    else if (ITEM.has(lw)) out.items.includes(lw) || out.items.push(lw);
    else return { error: `I don't know "${w}". Send /gift for help.` };
  }
  if (!out.cworm && !out.items.length && !out.worm) return { error: 'A code needs something inside: an amount, a look or worm. Send /gift for help.' };
  if (out.cworm > MAX_CWORM) return { error: `At most ${fmt(MAX_CWORM)} BP per code.` };
  if (out.worm > MAX_WORMS) return { error: `At most ${MAX_WORMS} free Custom Worms per code.` };
  if (out.max < 1 || out.max > MAX_USES) return { error: `Uses: between x1 and x${fmt(MAX_USES)}.` };
  if (out.days > 365) return { error: 'At most 365 days.' };
  if (out.count < 1 || out.count > MAX_BATCH) return { error: `At most *${MAX_BATCH} codes at once.` };
  if (out.count > 1 && out.name) return { error: 'A code name works for one code only. Leave it out with *N.' };
  return { make: out };
}

export async function create(env, m, byTg, now = Date.now()) {
  const made = [];
  for (let i = 1; i <= m.count; i++) {
    const src = m.src ? (m.count > 1 ? m.src + i : m.src).slice(0, 24) : null;
    for (let t = 0; t < 5; t++) {
      const code = m.name || randomCode();
      const r = await q(env, 'INSERT OR IGNORE INTO gift_codes (code, cworm, items, worm, max_uses, expires, src, by_tg, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        code, m.cworm, m.items.join(','), m.worm, m.max, m.days ? now + m.days * DAY : null, src, byTg || null, now).run();
      if (changed(r)) { made.push(await q(env, 'SELECT * FROM gift_codes WHERE code = ?', code).first()); break }
      if (m.name) return { error: `The code ${m.name} already exists. Pick another name.` };
    }
  }
  return { made };
}

// /gift <arg> for an admin: the bot's reply text.
export async function command(env, arg, byTg, now = Date.now()) {
  const a = String(arg || '').trim(), [w0, w1] = a.split(/\s+/);
  if (!a || /^help$/i.test(a)) return HELP + '\n\n' + await recent(env, now);
  if (/^list$/i.test(w0)) return await recent(env, now);
  if (/^(off|on)$/i.test(w0) && w1) {
    const code = clean(w1), r = await q(env, 'UPDATE gift_codes SET off = ? WHERE code = ?', /^off$/i.test(w0) ? 1 : 0, code).run();
    return !changed(r) ? `No code ${code}.` : /^off$/i.test(w0) ? `🚫 ${code} is off: nobody new can use it. (Players who used it keep what they got.)\n/gift on ${code} turns it back on.` : `✅ ${code} works again.`;
  }
  if (!a.includes(' ') && CODE.test(a)) {                                                // one code's details
    const g = await q(env, 'SELECT * FROM gift_codes WHERE code = ?', a).first();
    if (g) {
      const { results } = await q(env, 'SELECT p.id, p.name, r.at FROM gift_redeems r LEFT JOIN players p ON p.id = r.player WHERE r.code = ? ORDER BY r.at DESC LIMIT 15', a).all();
      return line(g, now) + '\n\n' + (results.length ? 'Used by (latest first):\n' + results.map(r => `${r.name || '?'} (player ${r.id}) · ${when(r.at)}`).join('\n') : 'Nobody used it yet.') +
        '\n\n' + links(env, a).tg + '\n' + links(env, a).web;
    }
  }
  const p = parse(a); if (p.error) return p.error;
  const r = await create(env, p.make, byTg, now); if (r.error) return r.error;
  const g = r.made[0], m = p.make, f = r.made.length;
  const head = `🎁 ${f > 1 ? f + ' new gift codes' : 'New gift code'}: ${describe(g)}\n` +
    `${m.max > 1 ? `Up to ${fmt(m.max)} players each` : 'One player each'} · ${g.expires ? 'works until ' + when(g.expires) : 'no end date'}\n\n`;
  const body = f > 1 ? r.made.map(c => `${c.code}${c.src ? ' (s_' + c.src + ')' : ''}  ${links(env, c.code).tg}`).join('\n')
    : `Code: ${g.code}\n\nTelegram link (opens the game and fills in the code):\n${links(env, g.code).tg}\n\nWeb link:\n${links(env, g.code).web}`;
  return head + body + '\n\nPlayers can also type it in the game: More › 🎁 Gift code.';
}

async function recent(env, now) {
  const { results } = await q(env, 'SELECT * FROM gift_codes ORDER BY created DESC LIMIT 15').all();
  return results.length ? 'Latest codes:\n' + results.map(g => line(g, now)).join('\n') : 'No gift codes yet.';
}
