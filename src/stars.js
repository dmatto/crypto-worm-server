// Telegram Stars (Damian 2026-11-02, "yes" to monetization/telegram-stars-plan.md, cosmetics and status first). Players pay in
// Telegram Stars (currency XTR, the only money Telegram allows for digital goods in a bot or Mini App) for exclusive looks and the
// 💚 Supporter badge. Stars never buy play $CWORM, ranking points, weekly prize entries, real $CWORM or power in a battle: looks
// and status only. The store build of the game doesn't show any of it.
//
//   GET  /stars                 -> {items, sup, admin?, live?}   what this account owns (packs come as their looks); live: open to all
//   POST /stars/invoice {item}  -> {url}                    a Telegram invoice link for one catalog item (the game opens it with
//                                                           Telegram.WebApp.openInvoice; on the web the link opens Telegram)
// The bot's webhook (bot.js) answers pre_checkout_query (preCheckout: the item is on sale, the price is right, not owned yet;
// Telegram wants the answer within 10 s) and records successful_payment (paid) in purchases; a refunded_payment, or an admin's
// /refund, sets refunded and the look goes away. Admin bot commands: /sales, /refund <charge id>, /reply <telegram id> <text>
// (to answer a /paysupport), /stars open|close (only admins see the shop until /stars open). Everyone: /paysupport <problem> (passed on to the admins) and /terms.
//
// Donations (Damian 2026-11-03: "Donations button in the main screen. Allow people to support the game"): the tip50..tip1000
// items are gifts of 50 to 1,000 Stars from Home's 💚 Support button. They give nothing in the game, can be given again and again,
// and 150 Stars of them in total (or the Supporter item) bring the 💚 Supporter badge. GET /stars also says how many Stars this
// account gave (tips) and how many players back the game (backers).
//
// The game holds the same ids and prices (SHOP items with xtr or pack, XTR.list and SUP.TIPS in crypto-worm.html): change both together.
// Invoice pictures: play.cryptoworm.io/xtr/<id>.jpg (the game folder's xtr/).
import { tg, tellAdminsText } from './bot.js';
import { gameLink } from './growth.js';

const LOOKS = 'Looks only: no power in battles, no BP, never real tokens.';
export const CATALOG = {
  goldhelm:  { stars: 45, cat: 'hat', title: 'Gold helmet', text: 'A gold-plated army helmet with an emerald star, for all your worms.' },
  captain:   { stars: 30, cat: 'hat', title: "Captain's cap", text: 'A navy captain\'s cap with a gold star, for all your worms.' },
  aurora:    { stars: 40, cat: 'skin', title: 'Aurora skin', text: 'A skin that slowly shifts from green to violet, like the northern lights.' },
  blackgold: { stars: 35, cat: 'skin', title: 'Black gold skin', text: 'A black skin with a gold shine.' },
  starcoins: { stars: 25, cat: 'trail', title: 'Star coin trail', text: 'Your shots leave a trail of gold star coins.' },
  monument:  { stars: 50, cat: 'grave', title: "Veteran's monument", text: 'A granite war memorial with a gold star, where your worms rest.' },
  fpack:     { stars: 99, pack: ['fcrown', 'founder', 'fsparks'], title: 'Founder pack', until: Date.UTC(2026, 11, 1),
    text: "Founder's crown, the Founder skin and the Founder sparks trail. Only in the launch month." },
  supporter: { stars: 150, sup: true, title: 'Supporter 💚', text: 'A green heart and a green name in the lobby and the ranking. Thank you for backing the game.' },
  test1:     { stars: 1, admin: true, test: true, title: 'Test item', text: 'Admins only: a 1 Star test purchase. It gives nothing; refund it with /refund.' },
  tip50:     { stars: 50, tip: true, img: 'supporter', title: 'Support: 50 Stars', text: 'A coffee for the team' },
  tip150:    { stars: 150, tip: true, img: 'supporter', title: 'Support: 150 Stars', text: 'Pays for a day of servers' },
  tip500:    { stars: 500, tip: true, img: 'supporter', title: 'Support: 500 Stars', text: 'Pays for new art' },
  tip1000:   { stars: 1000, tip: true, img: 'supporter', title: 'Support: 1,000 Stars', text: 'Helps build a new mode' },
};
const TIP_TEXT = 'Thank you for supporting Crypto Worm Wars! A gift to help us keep the game free: servers, art and new modes. It gives no BP, points, prize entries or tokens. 150 Stars in total bring the green Supporter badge.';
export const SUP_TIPS = 150;   // Stars of donations, in total, that bring the 💚 Supporter badge
// players with the badge: the Supporter item, or 150 Stars of donations (index.js joins it for the ranking and the lobby)
export const SUP_SQL = `SELECT player FROM purchases WHERE refunded IS NULL AND (item = 'supporter' OR item LIKE 'tip%') GROUP BY player
  HAVING MAX(item = 'supporter') = 1 OR SUM(CASE WHEN item LIKE 'tip%' THEN stars ELSE 0 END) >= ${SUP_TIPS}`;
const q = (env, s, ...v) => env.DB.prepare(s).bind(...v);
const changed = r => !!(r && (r.meta ? r.meta.changes : r.changes));
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const site = env => (env.SITE_URL || env.MENU_URL || 'https://play.cryptoworm.io/').replace(/\/+$/, '');
const admins = env => new Set(String(env.ADMIN_PLAYERS || '').split(',').map(Number).filter(n => n > 0));
const onSale = (it, now) => !!it && !(it.until && now >= it.until);
const payload = (player, item) => `x1:${player}:${item}`;
const parse = s => { const m = /^x1:(\d+):([a-z0-9]{1,16})$/.exec(String(s || '')); return m ? { player: +m[1], item: m[2] } : null };

// What a player owns: the looks (packs opened into their looks), the Supporter badge and the Stars they donated. Refunded
// purchases don't count.
export async function owned(env, player) {
  const { results } = await q(env, 'SELECT item, SUM(stars) AS s FROM purchases WHERE player = ? AND refunded IS NULL GROUP BY item', player).all();
  const items = new Set(); let sup = false, tips = 0;
  for (const { item, s } of results) { const it = CATALOG[item]; if (!it) continue;
    if (it.cat) items.add(item); if (it.pack) it.pack.forEach(x => items.add(x)); if (it.sup) sup = true; if (it.tip) tips += s | 0 }
  return { items: [...items], sup: sup || tips >= SUP_TIPS, ...(tips ? { tips } : {}) };
}
// donations can always be given again; the Supporter item is "owned" once the badge came from donations too
const has = (own, id) => { const it = CATALOG[id]; return !!it && !it.test && !it.tip && (it.sup ? own.sup : it.pack ? it.pack.every(x => own.items.includes(x)) : own.items.includes(id)) };
// The shop is open to everyone only after an admin's /stars open (bot_kv 'xtr_open' = '1'); until then only admins see the shelf
// and can pay, for the test purchase. Looks already bought always show.
export const shopOpen = env => q(env, "SELECT v FROM bot_kv WHERE k = 'xtr_open'").first().then(r => !!r && r.v === '1').catch(() => false);
async function mine(env, player) {
  const own = await owned(env, player), admin = admins(env).has(player), live = await shopOpen(env);
  return { ...own, ...(admin ? { admin: true } : {}), ...(live ? { live: true } : {}) };
}
// for the session: only when there is something to say
export async function sessionStars(env, player) {
  const m = await mine(env, player);
  return m.items.length || m.sup || m.tips || m.admin || m.live ? m : null;
}
// /stars (admins): open or close the shop for everyone
export async function shopCommand(env, arg) {
  const a = String(arg || '').trim().toLowerCase();
  if (a === 'open' || a === 'close') await q(env, "INSERT INTO bot_kv (k, v) VALUES ('xtr_open', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", a === 'open' ? '1' : '0').run();
  const live = await shopOpen(env);
  return live ? '⭐ The Stars shop is OPEN: every player sees ⭐ Exclusive in the Store.\n/stars close hides it again (looks already bought stay).'
    : '⭐ The Stars shop is CLOSED: only admins see ⭐ Exclusive, for test purchases.\n/stars open shows it to every player.';
}
export const isSupporter = (env, player) => q(env, `SELECT 1 AS y FROM (${SUP_SQL}) WHERE player = ?`, player).first().then(r => !!r).catch(() => false);
// how many real players back the game (the Supporter item or any donation), for the Support window
const backers = env => q(env, "SELECT COUNT(DISTINCT player) AS n FROM purchases WHERE refunded IS NULL AND (item = 'supporter' OR item LIKE 'tip%')").first().then(r => r ? r.n | 0 : 0).catch(() => 0);

export async function handle(path, env, me, body, { now = Date.now(), post = false } = {}) {
  if (path === '/stars' && !post) return { ...await mine(env, me.id), backers: await backers(env) };
  if (path !== '/stars/invoice' || !post) return null;
  const id = String(body && body.item || ''), it = Object.hasOwn(CATALOG, id) ? CATALOG[id] : null;
  if (!it || (it.admin && !admins(env).has(me.id))) return { error: 'not on sale', code: 'bad', status: 404 };
  if (!admins(env).has(me.id) && !await shopOpen(env)) return { error: 'the shop is not open yet', code: 'closed', status: 403 };
  if (!onSale(it, now)) return { error: 'not on sale any more', code: 'gone', status: 410 };
  if (has(await owned(env, me.id), id)) return { error: 'already yours', code: 'owned', status: 409 };
  if (!env.BOT_TOKEN) return { error: 'payments are not set up', status: 503 };
  const r = await tg(env, 'createInvoiceLink', { title: it.title.slice(0, 32), description: (it.tip ? TIP_TEXT : it.text + (it.test ? '' : ' ' + LOOKS)).slice(0, 255), payload: payload(me.id, id),
    provider_token: '', currency: 'XTR', prices: [{ label: it.title.slice(0, 32), amount: it.stars }], photo_url: `${site(env)}/xtr/${it.img || id}.jpg`, photo_width: 512, photo_height: 512 });
  if (!r || !r.ok || !r.result) return { error: 'Telegram did not answer, try again', status: 502 };
  return { url: r.result };
}

// The webhook's pre_checkout_query: say yes only for an item that is on sale, at its price, for a player who doesn't own it yet.
export async function preCheckout(env, pq, now = Date.now()) {
  const p = parse(pq.invoice_payload), it = p && Object.hasOwn(CATALOG, p.item) ? CATALOG[p.item] : null;
  let why = null;
  if (!it || pq.currency !== 'XTR' || pq.total_amount !== it.stars) why = 'This item is not on sale. Open the game\'s Store and try again.';
  else if (!onSale(it, now)) why = `The ${it.title} is no longer on sale.`;
  else if (!await q(env, 'SELECT 1 AS y FROM players WHERE id = ?', p.player).first()) why = 'We could not find your game account. Open the game and try again.';
  else if (it.admin && !admins(env).has(p.player)) why = 'This item is not on sale.';
  else if (!admins(env).has(p.player) && !await shopOpen(env)) why = 'The shop is not open yet.';
  else if (has(await owned(env, p.player), p.item)) why = `The ${it.title} is already yours. Open the Store to wear it.`;
  await tg(env, 'answerPreCheckoutQuery', why ? { pre_checkout_query_id: pq.id, ok: false, error_message: why } : { pre_checkout_query_id: pq.id, ok: true });
  return !why;
}

// The webhook's successful_payment: keep it (once per Telegram charge id), thank the player, tell the admins.
export async function paid(env, m, now = Date.now()) {
  const sp = m.successful_payment, p = parse(sp.invoice_payload), it = p && CATALOG[p.item];
  const charge = String(sp.telegram_payment_charge_id || ''); if (!charge) return;
  const own0 = p && it ? await owned(env, p.player) : null, before = own0 ? has(own0, p.item) : false;
  const r = await q(env, 'INSERT OR IGNORE INTO purchases (charge, player, item, stars, tg_id, created) VALUES (?, ?, ?, ?, ?, ?)',
    charge, p ? p.player : 0, p ? p.item : String(sp.invoice_payload || '').slice(0, 40), sp.total_amount | 0, m.from ? m.from.id : null, now).run();
  if (!changed(r)) return;                                                             // Telegram sent it twice
  const name = p && await q(env, 'SELECT name FROM players WHERE id = ?', p.player).first().then(x => x && x.name).catch(() => null);
  const badge = it && it.tip && !own0.sup && (await owned(env, p.player)).sup;   // this donation brought the badge
  const text = !it ? '⭐ Payment received. If your item is missing, send /paysupport.'
    : it.test ? `⭐ Test purchase done: ${sp.total_amount} Star. Refund it with:\n/refund ${charge}`
    : it.tip ? `💚 Thank you for supporting Crypto Worm Wars with ${sp.total_amount} Stars! It helps us keep the game free and build what comes next.` +
      (badge ? '\n\nYour green 💚 Supporter badge now shows next to your name in the lobby and the ranking.' : '')
    : it.sup ? '💚 Thank you for supporting Crypto Worm Wars! Your green heart now shows next to your name in the lobby and the ranking.'
    : `⭐ Thank you! The ${it.title} is yours. Open the game: it's in Store › ⭐ Exclusive.`;
  await tg(env, 'sendMessage', { chat_id: m.chat.id, text, reply_markup: { inline_keyboard: [[{ text: '🎮 Open the game', url: gameLink(env, 'xstore') }]] } });
  await tellAdminsText(env, (it && it.tip ? `💚 Donation: ${sp.total_amount} Stars from` : `⭐ Sale: ${it ? it.title : 'unknown item'} for ${sp.total_amount} Stars by`) + ` ${name || '?'} (player ${p ? p.player : '?'}).` +
    (before ? '\n⚠️ They already owned it: refund it.' : '') + `\n/refund ${charge}`).catch(() => { });
}

// Telegram refunded a payment itself (a dispute): take the item back.
export async function refundedByTelegram(env, m, now = Date.now()) {
  const c = m.refunded_payment && m.refunded_payment.telegram_payment_charge_id; if (!c) return;
  await q(env, 'UPDATE purchases SET refunded = ? WHERE charge = ? AND refunded IS NULL', now, String(c)).run();
}

// /refund <charge id> (admins): the Stars go back to whoever paid and the item is taken away.
export async function refundCommand(env, arg, now = Date.now()) {
  const c = String(arg || '').trim().split(/\s+/)[0];
  if (!c) return 'Send /refund followed by the charge id. /sales lists the latest ones.';
  const p = await q(env, 'SELECT * FROM purchases WHERE charge = ?', c).first();
  if (!p) return 'No purchase with that charge id. /sales lists the latest ones.';
  if (p.refunded) return 'That purchase was already refunded.';
  if (p.tg_id == null) return 'That purchase has no Telegram user to refund.';
  const r = await tg(env, 'refundStarPayment', { user_id: p.tg_id, telegram_payment_charge_id: c });
  if (!r || !r.ok) return 'Telegram said no: ' + ((r && r.description) || 'no answer');
  await q(env, 'UPDATE purchases SET refunded = ? WHERE charge = ?', now, c).run();
  const it = CATALOG[p.item];
  await tg(env, 'sendMessage', { chat_id: p.tg_id, text: `⭐ Your ${p.stars} Stars for the ${it ? it.title : p.item} were refunded, and it was taken out of your Store.` }).catch(() => { });
  return `✅ Refunded ${p.stars} Stars to player ${p.player}. The ${it ? it.title : p.item} is gone from their account.`;
}

// /sales (admins): totals and the latest purchases, with the charge ids /refund needs.
export async function salesText(env, now = Date.now()) {
  const sum = async since => q(env, 'SELECT COUNT(*) AS n, COALESCE(SUM(stars), 0) AS s FROM purchases WHERE refunded IS NULL AND created >= ? AND item != ?', since, 'test1').first();
  const week = await sum(now - 7 * 864e5), all = await sum(0);
  const ref = await q(env, 'SELECT COUNT(*) AS n, COALESCE(SUM(stars), 0) AS s FROM purchases WHERE refunded IS NOT NULL').first();
  const { results: by } = await q(env, 'SELECT item, COUNT(*) AS n, SUM(stars) AS s FROM purchases WHERE refunded IS NULL GROUP BY item ORDER BY s DESC').all();
  const { results: last } = await q(env, 'SELECT u.*, p.name FROM purchases u LEFT JOIN players p ON p.id = u.player ORDER BY u.created DESC LIMIT 10').all();
  const t = x => new Date(x).toISOString().slice(0, 16).replace('T', ' '), title = id => (CATALOG[id] || {}).title || id;
  const tip = await q(env, "SELECT COUNT(*) AS n, COUNT(DISTINCT player) AS p, COALESCE(SUM(stars), 0) AS s FROM purchases WHERE refunded IS NULL AND item LIKE 'tip%'").first();
  return `⭐ <b>Telegram Stars sales</b>\nLast 7 days: ${week.n} sales, ${week.s} Stars\nAll time: ${all.n} sales, ${all.s} Stars` +
    (tip.n ? `\n💚 Donations (in the totals): ${tip.n} from ${tip.p} players, ${tip.s} Stars` : '') +
    (ref.n ? `\nRefunded: ${ref.n} (${ref.s} Stars)` : '') +
    (by.length ? '\n\n' + by.map(r => `${esc(title(r.item))}: ${r.n} · ${r.s} Stars`).join('\n') : '') +
    (last.length ? '\n\n<b>Latest</b>\n' + last.map(r => `${t(r.created)} · ${esc(title(r.item))} · ${r.stars} ⭐ · ${esc(r.name || '?')} (${r.player})${r.refunded ? ' · refunded' : ''}\n<code>${esc(r.charge)}</code>`).join('\n') : '\n\nNo sales yet.') +
    '\n\n/refund &lt;charge id&gt; gives the Stars back and takes the item away.';
}

export const PAYSUPPORT = '⭐ Help with a purchase\n\nSend /paysupport followed by what happened, for example:\n/paysupport I paid for the Founder pack but it is not in my Store\n\n' +
  'We answer here in the bot within 48 hours. Purchase terms: /terms';
export async function paySupport(env, from, text) {
  const p = await q(env, 'SELECT id, name FROM players WHERE tg_id = ?', from.id).first().catch(() => null);
  const { results } = p ? await q(env, 'SELECT * FROM purchases WHERE player = ? ORDER BY created DESC LIMIT 5', p.id).all() : { results: [] };
  await tellAdminsText(env, `⭐ /paysupport from ${from.first_name || '?'}${from.username ? ' @' + from.username : ''} (Telegram ${from.id}${p ? ', player ' + p.id + ' ' + p.name : ', no game account'}):\n${String(text).slice(0, 1500)}` +
    (results.length ? '\n\nTheir purchases:\n' + results.map(r => `${(CATALOG[r.item] || {}).title || r.item} · ${r.stars} ⭐${r.refunded ? ' · refunded' : ''}\n/refund ${r.charge}`).join('\n') : '\n\nNo purchases.') +
    `\n\nAnswer with /reply ${from.id} <your answer>`);
  return '✅ Thanks, we got it. We answer here in the bot within 48 hours.';
}
export const terms = env => '⭐ Purchase terms (Telegram Stars)\n\n' +
  '• What you buy: looks for your worms (hats, skins, trails, graves, packs of them) and the 💚 Supporter badge in Crypto Worm Wars. They are cosmetic only: no power in battles, no BP, no ranking points, no weekly prize entries, and never real tokens.\n' +
  '• Donations (💚 Support on Home) are gifts to help us build the game. They give nothing in the game except the 💚 Supporter badge once you have given 150 Stars in total.\n' +
  '• What you buy is kept on your game account and shows on every device where you play with it. It has no cash value and can\'t be traded or moved to another account.\n' +
  '• Delivery is instant. If something is missing or went wrong, send /paysupport within 14 days. A refunded item is taken back.\n' +
  '• The game is in beta: we may redraw a look, but we don\'t take away what you bought, except after a refund or for cheating.\n' +
  '• We keep the item, the price, the date and Telegram\'s payment id, to deliver it and handle refunds. Privacy policy: ' + site(env) + '/privacy.html';
