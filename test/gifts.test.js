import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac } from 'node:crypto';

const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const { default: worker } = await import('../src/index.js');
const G = await import('../src/gifts.js');
const W = await import('../src/worms.js');

// A fake Grok (every photo passes, every drawing is a tiny JPEG) and a fake Telegram that keeps what the bot sends.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]).toString('base64'), sent = [];
globalThis.fetch = async (url, init) => {
  const u = String(url), body = init && init.body ? JSON.parse(init.body) : {};
  if (u.endsWith('/chat/completions')) return RealResponse.json({ choices: [{ message: { content: JSON.stringify({ subject: 'pet', adult: null, famous: false, unsafe: false }) } }] });
  if (u.endsWith('/images/edits')) return RealResponse.json({ data: [{ b64_json: JPEG }] });
  if (u.includes('api.telegram.org')) { sent.push({ method: u.split('/').pop(), ...body }); return RealResponse.json({ ok: true, result: {} }) }
  return RealResponse.json({}, { status: 404 });
};

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { sql.exec('BEGIN'); try { const r = []; for (const s of l) r.push(await s.run()); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } };
  const LOBBY = { idFromName: n => n, get: () => ({ fetch: async () => Response.json({ online: [] }) }) };
  return { DB, sql, LOBBY, SESSION_SECRET: 'test-secret', SIGNIN_DOMAIN: 'example.test', XAI_API_KEY: 'x', BOT_TOKEN: 'bot', PUBLIC_URL: 'https://api.test' };
}
const call = async (env, path, body, token) => {
  const r = await worker.fetch(new Request('https://api.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { status: r.status, ...(await r.json()) };
};
const guest = async (env, src) => { const s = await call(env, '/auth/guest', src ? { src } : {}); return { token: s.token, id: s.player.id } };
const PHOTO = 'data:image/jpeg;base64,' + Buffer.from('a photo').toString('base64');
const codeOf = text => text.match(/Code: ([A-Z0-9]+)/)[1];

test('gift codes: /gift reads what a code holds; mistakes get a clear answer', () => {
  assert.deepEqual(G.parse('2,000 gold worm rockets x100 7d s_fomo HALLOWEEN').make,
    { cworm: 2000, items: ['gold', 'rockets'], worm: 1, max: 100, days: 7, src: 'fomo', name: 'HALLOWEEN', count: 1 });
  assert.deepEqual(G.parse('Lucky worm2 0d *5').make, { cworm: 0, items: ['lucky'], worm: 2, max: 1, days: 0, src: null, name: null, count: 5 });
  assert.deepEqual([G.parse('GOLD 100').make.name, G.parse('GOLD 100').make.items], ['GOLD', []]);                                        // capitals: a code name, not the skin
  assert.match(G.parse('x5').error, /needs something inside/);
  assert.match(G.parse('1000 banana').error, /don't know "banana"/);
  assert.match(G.parse('5000000').error, /At most 1,000,000/);
  assert.match(G.parse('1000 *3 PROMO').error, /one code only/);
  assert.equal(G.clean(' cw-ab cd '), 'CWABCD');
  assert.match(G.randomCode(), /^[A-HJ-NP-Z2-9]{8}$/);
});

test('gift codes: an admin makes one in the bot; players redeem it once each until it runs out', async () => {
  const env = makeEnv(), a = await guest(env), b = await guest(env), c = await guest(env);
  env.ADMIN_PLAYERS = '999'; env.sql.prepare("INSERT INTO players (id, tg_id, name, created) VALUES (999, 777, 'Damian', 0)").run();
  const tgMsg = async (text, from = 777) => { sent.length = 0;
    await worker.fetch(new Request('https://api.test/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': await secret(env) },
      body: JSON.stringify({ message: { chat: { id: from, type: 'private' }, from: { id: from }, text } }) }), env);
    return sent.map(x => x.text).join('\n') };
  assert.match(await tgMsg('/gift'), /Gift codes[\s\S]*No gift codes yet/);
  assert.match(await tgMsg('/gift 1000 x5', 555), /Open the game, tap More/);           // not an admin: where to type a code
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM gift_codes').get().n, 0);
  const made = await tgMsg('/gift 1500 gold lucky x2 HALLOWEEN');
  assert.match(made, /New gift code: \+1,500 BP \+ gold skin \+ lucky skin/);
  assert.match(made, /Up to 2 players each · works until/);
  assert.match(made, /t\.me\/CryptoWormWarsBot\/play\?startapp=g_HALLOWEEN/); assert.match(made, /play\.cryptoworm\.io\/\?gift=HALLOWEEN/);
  assert.equal(codeOf(made), 'HALLOWEEN');
  assert.match(await tgMsg('/gift 10 HALLOWEEN'), /already exists/);

  const r = await call(env, '/gift/redeem', { code: 'halloween' }, a.token);             // any case, spaces and dashes fine
  assert.equal(r.status, 200); assert.equal(r.cworm, 1500); assert.deepEqual(r.items, ['gold', 'lucky']); assert.equal(r.worm, 0);
  assert.deepEqual(r.rewards.map(x => [x.amount, x.reason, x.note]), [[1500, 'gift', 'HALLOWEEN']]);   // claimed right away
  assert.equal((await call(env, '/rewards', {}, a.token)).rewards.length, 0);
  assert.deepEqual((await call(env, '/me', undefined, a.token)).player.gifts, ['gold', 'lucky']);   // the looks come back on any device
  assert.equal((await call(env, '/me', undefined, b.token)).player.gifts, undefined);
  assert.equal((await call(env, '/gift/redeem', { code: 'HALLOWEEN' }, a.token)).code, 'used');
  assert.equal((await call(env, '/gift/redeem', { code: 'HAL-LOW-EEN' }, b.token)).status, 200);
  const full = await call(env, '/gift/redeem', { code: 'HALLOWEEN' }, c.token);
  assert.equal(full.status, 410); assert.equal(full.code, 'full'); assert.match(full.error, /used up/);
  assert.equal(env.sql.prepare("SELECT uses FROM gift_codes WHERE code = 'HALLOWEEN'").get().uses, 2);
  assert.equal(env.sql.prepare("SELECT COUNT(*) AS n FROM rewards WHERE reason = 'gift'").get().n, 2);
  assert.match(await tgMsg('/gift HALLOWEEN'), /2\/2 used[\s\S]*Used by/);
  assert.match(await tgMsg('/gift list'), /HALLOWEEN: \+1,500 BP/);

  // off, expired, wrong
  const one = codeOf(await tgMsg('/gift 100'));
  assert.match(await tgMsg('/gift off ' + one), /is off/);
  assert.equal((await call(env, '/gift/redeem', { code: one }, c.token)).code, 'gone');
  await tgMsg('/gift on ' + one); assert.equal((await call(env, '/gift/redeem', { code: one }, c.token)).status, 200);
  const old = codeOf(await tgMsg('/gift 100 1d'));
  env.sql.prepare('UPDATE gift_codes SET expires = 1 WHERE code = ?').run(old);
  assert.equal((await call(env, '/gift/redeem', { code: old }, c.token)).code, 'gone');
  for (let i = 0; i < G.FAILS_PER_HOUR; i++) assert.equal((await call(env, '/gift/redeem', { code: 'NOPE' + i }, c.token)).code, 'bad');
  const w = await call(env, '/gift/redeem', { code: old }, c.token); assert.equal(w.status, 429); assert.equal(w.code, 'wait');   // guessing stops for an hour
});

test('gift codes: a batch of codes with numbered source tags; a new player from the link gets the tag', async () => {
  const env = makeEnv();
  const text = await G.command(env, '1000 coral *3 s_fomo', 777);
  assert.match(text, /3 new gift codes: \+1,000 BP \+ coral skin/);
  const rows = env.sql.prepare('SELECT code, src, max_uses FROM gift_codes ORDER BY src').all();
  assert.deepEqual(rows.map(r => [r.src, r.max_uses]), [['fomo1', 1], ['fomo2', 1], ['fomo3', 1]]);
  const fresh = await guest(env, 'gift'), old = await guest(env, 'x');
  await call(env, '/gift/redeem', { code: rows[1].code }, fresh.token); await call(env, '/gift/redeem', { code: rows[2].code }, old.token);
  assert.equal(env.sql.prepare('SELECT source FROM player_meta WHERE player = ?').get(fresh.id).source, 'fomo2');
  assert.equal(env.sql.prepare('SELECT source FROM player_meta WHERE player = ?').get(old.id).source, 'x');   // first touch stays
  assert.deepEqual((await call(env, '/me', undefined, old.token)).player.gifts, ['coral']);
});

test('gift codes: a free Custom Worm needs no holder tier or price, and shows while not holding', async () => {
  const env = makeEnv(), p = await guest(env), other = await guest(env);
  let s = await call(env, '/worm', undefined, p.token); assert.equal(s.why, 'holder'); assert.equal(s.free, 0);
  const code = codeOf(await G.command(env, 'worm', 777));
  const r = await call(env, '/gift/redeem', { code }, p.token); assert.equal(r.worm, 1); assert.deepEqual(r.rewards, []);
  s = await call(env, '/worm', undefined, p.token); assert.equal(s.why, null); assert.equal(s.free, 1); assert.equal(s.price, 0); assert.equal(s.pay, 'gift');
  const m = await call(env, '/worm/make', { photo: PHOTO }, p.token);
  assert.equal(m.status, 200); assert.equal(m.price, 0); assert.equal(m.offer.price, 0);
  s = await call(env, '/worm', undefined, p.token); assert.equal(s.free, 0); assert.equal(s.offer.price, 0);   // the set it made stays free when the game charges
  assert.equal(s.price, W.PRICE);
  await call(env, '/worm/pick', { id: m.offer.opts[0] }, p.token);
  assert.equal((await call(env, '/me', undefined, p.token)).player.cw, m.offer.opts[0]);   // shows without holding
  env.sql.prepare('INSERT INTO cworm_scores (player, total, week_start, week, day_start, day, last) VALUES (?, 500, 0, 0, 0, 0, 0)').run(p.id);
  assert.equal((await call(env, '/ranking?period=all', undefined, other.token)).top[0].cw, m.offer.opts[0]);
  s = await call(env, '/worm', undefined, p.token); assert.equal(s.shown, true); assert.equal(s.why, 'holder');   // a new one needs a holder tier or another code
});

test('gift codes: a guest folded into a Telegram account brings the codes used and free Custom Worms left', async () => {
  const env = makeEnv(); env.BOT_TOKEN = '123:BOT';
  const g = await guest(env), t = await call(env, '/auth/telegram', { initData: tgInit(42, 'Ana') });
  const code = codeOf(await G.command(env, 'worm2 sakura x5', 777)), two = codeOf(await G.command(env, 'worm', 777));
  await call(env, '/gift/redeem', { code }, g.token); await call(env, '/gift/redeem', { code: two }, t.token);
  const merged = await call(env, '/auth/telegram', { initData: tgInit(42, 'Ana') }, g.token);
  assert.equal(merged.player.id, t.player.id); assert.deepEqual(merged.player.gifts, ['sakura']);
  assert.equal((await call(env, '/worm', undefined, merged.token)).free, 3);
  assert.equal((await call(env, '/gift/redeem', { code }, merged.token)).code, 'used');
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM gift_credits WHERE player = ?').get(g.id).n, 0);
});

const secret = env => createHash('sha256').update('webhook:' + env.SESSION_SECRET).digest('hex').slice(0, 48);
function tgInit(id, name) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: name }) };
  const check = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n'), key = createHmac('sha256', 'WebAppData').update('123:BOT').digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', key).update(check).digest('hex') }).toString();
}
