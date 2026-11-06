import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) } };
const { default: worker } = await import('../src/index.js');
const W = await import('../src/worms.js');

// A fake Grok (the photo check says what the test asks; the drawer returns a tiny JPEG) and a fake Telegram that keeps the photos sent.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]).toString('base64');
const grok = { verdict: { subject: 'person', adult: true, famous: false, unsafe: false, reason: 'one adult' }, draws: 0, fail: 0 }, sent = [];
globalThis.fetch = async (url, init) => {
  const u = String(url), body = init && init.body ? JSON.parse(init.body) : {};
  if (u.endsWith('/chat/completions')) return RealResponse.json({ choices: [{ message: { content: JSON.stringify(grok.verdict) } }] });
  if (u.endsWith('/images/edits')) { grok.draws++; grok.prompt = body.prompt; (grok.bodies ||= []).push(body); if (grok.fail-- > 0) return RealResponse.json({ error: 'busy' }, { status: grok.failStatus || 503 }); return RealResponse.json({ data: [{ b64_json: JPEG }] }) }
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
const PHOTO = 'data:image/jpeg;base64,' + Buffer.from('a photo').toString('base64');
async function player(env, tier) {                       // a guest; with a tier, a holder of that tier through a linked wallet
  const s = await call(env, '/auth/guest', {}), id = s.player.id;
  if (tier) { env.sql.prepare('UPDATE players SET wallet = ?, tg_id = ? WHERE id = ?').run('W' + id, 1000 + id, id); env.sql.prepare('INSERT INTO holders (player, wallet, tier, streak_day) VALUES (?, ?, ?, ?)').run(id, 'W' + id, tier, Math.floor(Date.now() / 864e5)) }
  return { token: s.token, id };
}

test('custom worms: holders only; a checked photo gives four portraits, one a day, and the kept one shows everywhere', async () => {
  const env = makeEnv(), fan = await player(env), h = await player(env, 1), admin = await player(env);
  env.ADMIN_PLAYERS = String(admin.id); env.sql.prepare('UPDATE players SET tg_id = 777 WHERE id = ?').run(admin.id);
  let s = await call(env, '/worm', undefined, fan.token);
  assert.equal(s.holder, false); assert.equal(s.why, 'holder'); assert.equal(s.price, W.PRICE);
  assert.equal((await call(env, '/worm/make', { photo: PHOTO }, fan.token)).status, 403);
  s = await call(env, '/worm', undefined, h.token); assert.equal(s.holder, true); assert.equal(s.why, null); assert.equal(s.left, 1);
  assert.equal((await call(env, '/worm/make', { photo: 'https://example.com/me.jpg' }, h.token)).status, 400);   // a data URL only

  const m = await call(env, '/worm/make', { photo: PHOTO }, h.token);
  assert.equal(m.status, 200); assert.equal(m.offer.kind, 'person'); assert.equal(m.offer.opts.length, 4); assert.match(grok.prompt, /clearly a WORM/);
  const refs = grok.bodies.map(b => b.images && b.images[1].url).sort();                      // drawn like four of the game's avatars, square
  assert.deepEqual(refs, W.STYLES.map(s => 'https://play.cryptoworm.io/avatars/' + s + '.jpg').sort());
  assert.ok(grok.bodies.every(b => b.images[0].url === PHOTO && b.aspect_ratio === '1:1' && /same art style as image 2/.test(b.prompt) && /Full body/.test(b.prompt)));
  const img = await worker.fetch(new Request('https://api.test/worm/img/' + m.offer.opts[2] + '.jpg'), env);
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/jpeg'); assert.equal(img.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), Buffer.from(JPEG, 'base64'));
  s = await call(env, '/worm', undefined, h.token); assert.deepEqual(s.offer.opts, m.offer.opts); assert.equal(s.why, 'today'); assert.equal(s.left, 0);
  assert.equal((await call(env, '/worm/make', { photo: PHOTO }, h.token)).code, 'today');            // one set a day

  assert.equal((await call(env, '/worm/pick', { id: 'nope' }, h.token)).status, 404);
  assert.equal((await call(env, '/worm/pick', { id: m.offer.opts[1] }, fan.token)).status, 404);   // someone else's
  const p = await call(env, '/worm/pick', { id: m.offer.opts[1] }, h.token);
  assert.equal(p.worm, m.offer.opts[1]);
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM custom_worms WHERE player = ?').get(h.id).n, 1);   // the other three are gone
  assert.equal((await worker.fetch(new Request('https://api.test/worm/img/' + m.offer.opts[0]), env)).status, 404);
  const note = sent.find(x => x.method === 'sendPhoto' && x.caption.includes('New custom worm'));
  assert.equal(note.chat_id, 777); assert.equal(note.photo, 'https://api.test/worm/img/' + p.worm + '.jpg'); assert.match(note.caption, new RegExp('/wormoff ' + p.worm));

  assert.equal((await call(env, '/me', undefined, h.token)).player.cw, p.worm);               // the session, the ranking
  env.sql.prepare('INSERT INTO cworm_scores (player, total, week_start, week, day_start, day, last) VALUES (?, 500, 0, 0, 0, 0, 0)').run(h.id);
  assert.equal((await call(env, '/ranking?period=all', undefined, fan.token)).top[0].cw, p.worm);
  env.sql.prepare('UPDATE holders SET tier = 0 WHERE player = ?').run(h.id);                     // sold: it stays theirs but hides
  assert.equal((await call(env, '/me', undefined, h.token)).player.cw, null);
  assert.equal((await call(env, '/ranking?period=all', undefined, fan.token)).top[0].cw, undefined);
  s = await call(env, '/worm', undefined, h.token); assert.equal(s.worm, p.worm); assert.equal(s.shown, false); assert.equal(s.why, 'holder');
  env.sql.prepare('UPDATE holders SET tier = 2 WHERE player = ?').run(h.id);

  // a report reaches the admins once; /wormoff removes it and stops new ones until /wormon
  const before = sent.length;
  assert.equal((await call(env, '/worm/report', { id: p.worm }, fan.token)).ok, true);
  assert.equal((await call(env, '/worm/report', { id: p.worm }, fan.token)).ok, true);
  assert.equal(sent.length, before + 1); assert.match(sent.at(-1).caption, /reported by/);
  const gone = await W.wormOff(env, p.worm); assert.equal(gone.id, h.id);
  assert.equal((await call(env, '/me', undefined, h.token)).player.cw, null);
  env.sql.prepare('DELETE FROM worm_makes WHERE ok = 1').run();                                 // a new day
  assert.equal((await call(env, '/worm', undefined, h.token)).why, 'banned');
  assert.equal(await W.wormOn(env, h.id), true);
  assert.equal((await call(env, '/worm', undefined, h.token)).why, null);

  // admins can make and show one without holding, a few a day
  const a = await call(env, '/worm', undefined, admin.token); assert.equal(a.holder, true); assert.equal(a.left, W.ADMIN_MAKES);
});

test('custom worms: photos turned down say why and only use up tries; pets get the pet drawing; a busy drawer costs nothing', async () => {
  const env = makeEnv(), h = await player(env, 3);
  for (const [v, why] of [[{ subject: 'person', adult: true, famous: true }, 'famous'], [{ subject: 'person', adult: false }, 'young'], [{ subject: 'person', adult: null }, 'young'],
    [{ subject: 'other' }, 'other'], [{ subject: 'pet', unsafe: true }, 'unsafe']]) {
    grok.verdict = v; const r = await call(env, '/worm/make', { photo: PHOTO }, h.token);
    assert.equal(r.status, 422); assert.equal(r.code, why); assert.equal(r.error, W.WHY[why]);
  }
  assert.equal((await call(env, '/worm', undefined, h.token)).left, 1);
  grok.verdict = { subject: 'pet', adult: null, famous: false, unsafe: false }; grok.fail = 8;
  assert.equal((await call(env, '/worm/make', { photo: PHOTO }, h.token)).status, 502);         // nothing drawn: still one left today
  assert.equal((await call(env, '/worm', undefined, h.token)).why, 'today');                    // ...but that was the sixth try
  env.sql.prepare('DELETE FROM worm_makes').run();
  grok.fail = 3; const r = await call(env, '/worm/make', { photo: PHOTO }, h.token);                // three fail, then get one more go each
  assert.equal(r.offer.kind, 'pet'); assert.equal(r.offer.opts.length, 4); assert.match(grok.prompt, /photo of a pet/); assert.ok(grok.bodies.slice(-3).every(b => b.images));          // a busy drawer: the retries keep the avatar picture
  assert.match(env.sql.prepare('SELECT why FROM worm_makes WHERE ok = 1').get().why, /^pet 4 · 3 failed/);
  env.sql.prepare('DELETE FROM worm_makes').run(); env.sql.prepare("DELETE FROM custom_worms").run();
  grok.fail = 2; grok.failStatus = 400; grok.bodies = [];                                          // refused (the avatar picture could not be fetched): retried without it
  assert.equal((await call(env, '/worm/make', { photo: PHOTO }, h.token)).offer.opts.length, 4); grok.failStatus = 0;
  assert.equal(grok.bodies.length, 6); assert.ok(grok.bodies.slice(-2).every(b => b.image && !b.images && /art style of our game/.test(b.prompt)));
  grok.verdict = { subject: 'person', adult: true, famous: false, unsafe: false };
});

test('custom worms: the match passes both portraits to the phones, and old unpicked sets are cleaned up', async () => {
  const env = makeEnv(), h = await player(env, 1);
  const m = await call(env, '/worm/make', { photo: PHOTO }, h.token); await call(env, '/worm/pick', { id: m.offer.opts[0] }, h.token);
  let seen = null; env.MATCH = { idFromName: n => n, get: () => ({ fetch: async req => { seen = req.headers.get('x-cw'); return new RealResponse('ok') } }) };
  await worker.fetch(new Request('https://api.test/match/ABCDEF/ws?token=' + h.token), env);
  assert.equal(seen, m.offer.opts[0]);
  env.sql.prepare("INSERT INTO custom_worms (id, player, job, kind, state, img, created) VALUES ('oldoffer12345', ?, 'j', 'pet', 'offer', ?, 0)").run(h.id, JPEG);
  await W.wormCleanup(env);
  assert.deepEqual(env.sql.prepare('SELECT id FROM custom_worms').all().map(r => r.id), [m.offer.opts[0]]);
});
