import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const { default: worker } = await import('../src/index.js');
const S = await import('../src/stars.js');

const sent = [];
globalThis.fetch = async (url, init) => {
  const u = String(url), body = init && init.body ? JSON.parse(init.body) : {};
  if (u.includes('api.telegram.org')) { const method = u.split('/').pop(); sent.push({ method, ...body });
    return RealResponse.json({ ok: true, result: method === 'createInvoiceLink' ? 'https://t.me/$invoice' : { status: 'left' } }) }
  return RealResponse.json({}, { status: 404 });
};
function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const LOBBY = { idFromName: n => n, get: () => ({ fetch: async () => Response.json({ online: [] }) }) };
  return { DB, sql, LOBBY, SESSION_SECRET: 'test-secret', SIGNIN_DOMAIN: 'example.test', BOT_TOKEN: 'bot', PUBLIC_URL: 'https://api.test', ADMIN_PLAYERS: '99' };
}
const call = async (env, path, body, token) => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { status: r.status, ...(await r.json()) };
};
let charges = 0;
const pay = async (env, player, item, stars = S.CATALOG[item].stars) => {     // Telegram's checkout, then the payment
  sent.length = 0;
  const ok = await S.preCheckout(env, { id: 'pq', invoice_payload: `x1:${player}:${item}`, currency: 'XTR', total_amount: stars });
  if (ok) await S.paid(env, { chat: { id: 500 + player }, from: { id: 500 + player }, successful_payment: { invoice_payload: `x1:${player}:${item}`, total_amount: stars, telegram_payment_charge_id: 'c' + (++charges) } });
  return { ok, text: sent.filter(x => x.method === 'sendMessage').map(x => x.text).join('\n'), why: (sent.find(x => x.method === 'answerPreCheckoutQuery') || {}).error_message };
};

test('stars: donations can be given again and again, 150 Stars of them bring the Supporter badge, refunds take it away', async () => {
  const env = makeEnv();
  for (const id of [1, 2, 99]) env.sql.prepare("INSERT INTO players (id, name, tg_id, created) VALUES (?, ?, ?, 0)").run(id, 'p' + id, 500 + id);
  const me = { id: 1 };

  // the shop is closed: only admins can pay
  let r = await S.handle('/stars/invoice', env, me, { item: 'tip50' }, { post: true }); assert.equal(r.status, 403);
  await S.shopCommand(env, 'open');
  sent.length = 0;
  r = await S.handle('/stars/invoice', env, me, { item: 'tip50' }, { post: true });
  assert.equal(r.url, 'https://t.me/$invoice');
  const inv = sent.find(x => x.method === 'createInvoiceLink');
  assert.equal(inv.prices[0].amount, 50); assert.match(inv.photo_url, /\/xtr\/supporter\.jpg$/);
  assert.match(inv.description, /no play \$CWORM, points, prize entries or tokens/); assert.ok(inv.description.length <= 255);

  let p = await pay(env, 1, 'tip50');
  assert.equal(p.ok, true); assert.match(p.text, /Thank you for supporting Crypto Worm Wars with 50 Stars/); assert.doesNotMatch(p.text, /badge now shows/);
  assert.match(p.text, /💚 Donation: 50 Stars from p1 \(player 1\)/);                                     // the admins hear about it
  p = await pay(env, 1, 'tip50'); assert.equal(p.ok, true);                                                // again: a donation is never "already yours"
  assert.deepEqual(await S.owned(env, 1), { items: [], sup: false, tips: 100 });
  assert.equal(await S.isSupporter(env, 1), false);

  p = await pay(env, 1, 'tip50');                                                                          // 150 in total: the badge
  assert.match(p.text, /Your green 💚 Supporter badge now shows/);
  assert.deepEqual(await S.owned(env, 1), { items: [], sup: true, tips: 150 });
  assert.equal(await S.isSupporter(env, 1), true);
  p = await pay(env, 1, 'tip500'); assert.doesNotMatch(p.text, /badge now shows/);                         // had it already
  p = await pay(env, 1, 'supporter'); assert.equal(p.ok, false); assert.match(p.why, /already yours/);     // no need to buy the badge now

  // a wrong price never goes through
  p = await pay(env, 2, 'tip150', 15); assert.equal(p.ok, false);
  p = await pay(env, 2, 'tip150'); assert.match(p.text, /badge now shows/);                                // one 150 gift is enough

  // the ranking and GET /stars show it
  for (const id of [1, 2]) env.sql.prepare('INSERT INTO cworm_scores (player, total) VALUES (?, ?)').run(id, 300 - id * 100);
  const g = await S.handle('/stars', env, me, {}, { post: false });
  assert.equal(g.sup, true); assert.equal(g.tips, 650); assert.equal(g.backers, 2); assert.equal(g.live, true);
  const tok = (await call(env, '/auth/guest', {})).token;
  const rk = await call(env, '/ranking?period=all', undefined, tok);
  assert.deepEqual(rk.top.map(x => [x.id, !!x.sup]), [[1, true], [2, true]]);

  // a refund lowers the total: below 150 the badge goes
  const c = env.sql.prepare("SELECT charge FROM purchases WHERE player = 2").get().charge;
  assert.match(await S.refundCommand(env, c), /Refunded 150 Stars/);
  assert.equal(await S.isSupporter(env, 2), false);
  assert.deepEqual((await call(env, '/ranking?period=all', undefined, tok)).top.map(x => [x.id, !!x.sup]), [[1, true], [2, false]]);
  assert.equal((await S.handle('/stars', env, { id: 2 }, {}, { post: false })).backers, 1);

  // /sales counts them apart
  const sales = await S.salesText(env);
  assert.match(sales, /💚 Donations \(in the totals\): 4 from 1 players, 650 Stars/);
  assert.match(sales, /Support: 500 Stars: 1 · 500 Stars/);
  assert.match(S.terms(env), /Donations \(💚 Support on Home\) are gifts/);
});
