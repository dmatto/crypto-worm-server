import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encryptPush, pushApi, pushReminders, pushPlayer, pushHost } from '../src/push.js';

const b64u = buf => Buffer.from(buf).toString('base64url');
function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  return { DB: { prepare: q => stmt(q) }, sql, SITE_URL: 'https://play.test' };
}
// a browser's side of a subscription
async function browser() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { kp, p256dh: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), auth: b64u(auth), d: (await crypto.subtle.exportKey('jwk', kp.privateKey)).d };
}

test('push: the RFC 8291 example message comes out byte for byte', async () => {
  // Section 5 and Appendix A of RFC 8291: the application server's one-time key, the salt and the user agent's subscription
  const jwk = { kty: 'EC', crv: 'P-256', d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw' };
  const pub = Buffer.from('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', 'base64url');
  jwk.x = b64u(pub.subarray(1, 33)); jwk.y = b64u(pub.subarray(33));
  const priv = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pubKey = await crypto.subtle.importKey('raw', pub, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const out = await encryptPush('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg',
    'When I grow up, I want to be a watermelon', { kp: { privateKey: priv, publicKey: pubKey }, salt: new Uint8Array(Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url')) });
  assert.equal(b64u(out), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('push: subscribe, test message, daily reminder, and a dropped browser is forgotten', async () => {
  const env = makeEnv(), me = { id: 7 }, now = Date.UTC(2026, 10, 14, 12), H = 3600e3, br = await browser();
  const sent = []; const realFetch = globalThis.fetch; let status = 201;
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), headers: init.headers, body: new Uint8Array(init.body) }); return new Response(null, { status }) };
  try {
    const key = (await pushApi(env, me, '/push/key', {}, now)).key;
    assert.equal(Buffer.from(key, 'base64url').length, 65); assert.equal((await pushApi(env, me, '/push/key', {}, now)).key, key);   // made once, then kept
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: br.p256dh, auth: br.auth, lang: 'in' };
    assert.deepEqual(await pushApi(env, me, '/push/sub', { ...sub, endpoint: 'https://evil.example/x' }, now), { error: 'bad subscription' });
    assert.deepEqual(await pushApi(env, me, '/push/sub', { ...sub, auth: 'AAAA' }, now), { error: 'bad subscription' });
    assert.equal(pushHost('http://fcm.googleapis.com/x'), false); assert.equal(pushHost('https://updates.push.services.mozilla.com/wpush/v2/x'), true); assert.equal(pushHost('https://web.push.apple.com/x'), true);
    assert.deepEqual(await pushApi(env, me, '/push/sub', sub, now), { on: true });
    assert.deepEqual(await pushApi(env, me, '/push/sub', sub, now), { on: true });                         // again: still one row
    assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 1);
    assert.deepEqual(await pushApi(env, me, '/push/test', { endpoint: sub.endpoint }, now), { sent: 1 });
    assert.deepEqual(await pushApi(env, me, '/push/test', { endpoint: sub.endpoint }, now + 5e3), { sent: 0 });   // not twice in a minute
    const m = sent[0]; assert.equal(m.url, sub.endpoint); assert.equal(m.headers['Content-Encoding'], 'aes128gcm'); assert.equal(m.headers.TTL, '43200');
    // the signed token: our key, the push service as audience, good for 12 hours
    const [, t, k] = /^vapid t=([\w.-]+), k=([\w-]+)$/.exec(m.headers.Authorization); assert.equal(k, key);
    const [h, c, sig] = t.split('.'), claims = JSON.parse(Buffer.from(c, 'base64url'));
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
    assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: Math.floor(now / 1000) + 43200, sub: 'https://play.test' });
    const vk = await crypto.subtle.importKey('raw', Buffer.from(key, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vk, Buffer.from(sig, 'base64url'), Buffer.from(h + '.' + c)), true);
    // a second implementation (Python, the cryptography library) plays the browser and reads the message
    const dir = mkdtempSync(join(tmpdir(), 'push-')), f = join(dir, 'msg.bin'); writeFileSync(f, m.body);
    const plain = execFileSync('python3', [new URL('./push_decrypt.py', import.meta.url).pathname, f, br.d, br.p256dh, br.auth]).toString();
    assert.deepEqual(JSON.parse(plain), { title: 'Crypto Worm Wars', body: '🔔 Pengingat aktif. Seperti inilah tampilannya.', url: 'https://play.test/', tag: 'cww-test' });
    // the daily reminder: only 20 to 72 hours after the last visit, once per 20 hours
    const seen = h2 => env.sql.prepare('INSERT INTO player_meta (player, last_seen) VALUES (7, ?) ON CONFLICT(player) DO UPDATE SET last_seen = excluded.last_seen').run(now - h2 * H);
    sent.length = 0; seen(5); assert.equal(await pushReminders(env, now), 0);
    seen(80); assert.equal(await pushReminders(env, now), 0);
    seen(26); assert.equal(await pushReminders(env, now), 1); assert.equal(await pushReminders(env, now + H), 0);
    assert.equal(await pushReminders(env, now + 21 * H), 1); assert.equal(sent.length, 2);
    assert.equal(await pushPlayer(env, 7, { title: 'x', body: 'y' }, now, true), 1);                       // a land alert goes out whatever the reminder clock says
    status = 410; assert.equal(await pushPlayer(env, 7, { title: 'x', body: 'y' }, now, true), 0);         // the browser dropped it
    assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 0);
    status = 201; await pushApi(env, me, '/push/sub', sub, now); assert.deepEqual(await pushApi(env, { id: 8 }, '/push/unsub', { endpoint: sub.endpoint }, now), { on: false });
    assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 1);                       // someone else can't switch it off
    await pushApi(env, me, '/push/unsub', { endpoint: sub.endpoint }, now); assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 0);
  } finally { globalThis.fetch = realFetch }
});
