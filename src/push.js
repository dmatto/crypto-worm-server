// Browser reminders (2026-11-13): a web player has no bot to message them, so the browser can. A player who switches them
// on in the game (crypto-worm.html PUSH, sw.js) gets a notification when the daily reward is waiting, or when their land is
// attacked. At most one reminder a day, none after three days away, and a browser that dropped its subscription is forgotten.
//
// This is the Web Push protocol done by hand, since a Worker can't load a library for it: the message is encrypted for that
// one browser (RFC 8291, aes128gcm) and signed with the server's own key pair (VAPID, RFC 8292). The key pair is made on
// first use and kept in bot_kv ('vapid'): it can do nothing except send notifications to these subscriptions.
import { DAY2 } from './growth.js';

const HOUR = 3600e3;
const REMIND_AFTER = 20 * HOUR, REMIND_UNTIL = 72 * HOUR, REMIND_GAP = 20 * HOUR, PUSH_BATCH = 20, MAX_SUBS = 5, MAX_FAILS = 5;
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length } return out };
const hkdf = async (salt, ikm, info, len) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info },
  await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), len * 8));

// Only real push services: the address comes from the player's browser, and the Worker will POST to it.
const HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
export const pushHost = u => { try { const x = new URL(u); return x.protocol === 'https:' && HOSTS.test(x.hostname) } catch (e) { return false } };

async function vapid(env) {
  const get = () => env.DB.prepare("SELECT v FROM bot_kv WHERE k = 'vapid'").first().then(r => r && r.v);
  let v = await get();
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const made = JSON.stringify({ pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) });
    await env.DB.prepare("INSERT OR IGNORE INTO bot_kv (k, v) VALUES ('vapid', ?)").bind(made).run();   // two first calls at once: the first one in wins
    v = await get();
  }
  const o = JSON.parse(v);
  return { pub: o.pub, key: await crypto.subtle.importKey('jwk', o.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
}
// "Authorization: vapid t=<signed token>, k=<our public key>": tells the push service who is sending, for 12 hours
async function vapidAuth(env, endpoint, now) {
  const { pub, key } = await vapid(env);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: env.SITE_URL || 'https://play.cryptoworm.io' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + claims));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${pub}`;
}
// RFC 8291: a one-time key pair and salt per message; only the browser holding the subscription's private key can read it.
// `fixed` ({kp, salt}) is for the tests, which check the result against a second implementation.
export async function encryptPush(p256dh, auth, text, fixed) {
  const ua = unb64u(p256dh), secret = unb64u(auth);
  const kp = fixed ? fixed.kp : await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const mine = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const theirs = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, kp.privateKey, 256));
  const ikm = await hkdf(secret, shared, cat(enc.encode('WebPush: info\0'), ua, mine), 32);
  const salt = fixed ? fixed.salt : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16), nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']),
    cat(enc.encode(text), new Uint8Array([2]))));                                        // 2 marks the last (only) record
  return cat(salt, new Uint8Array([0, 0, 16, 0, mine.length]), mine, sealed);           // header: salt, record size 4096, our one-time public key
}

// one notification to one browser; true when the push service took it. `quiet` leaves the daily-reminder clock alone.
export async function sendPush(env, sub, msg, now = Date.now(), quiet = false) {
  let st = 0;
  try {
    const r = await fetch(sub.endpoint, { method: 'POST', body: await encryptPush(sub.p256dh, sub.auth, JSON.stringify(msg)),
      headers: { Authorization: await vapidAuth(env, sub.endpoint, now), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(msg.ttl || 12 * 3600), Urgency: 'normal' } });
    st = r.status;
  } catch (e) { }
  const ok = st >= 200 && st < 300;
  if (st === 404 || st === 410) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();   // the browser dropped the subscription
  else if (!ok) await env.DB.prepare('UPDATE push_subs SET fails = fails + 1, last_sent = ? WHERE endpoint = ?').bind(now, sub.endpoint).run();   // tried: not again before the next reminder is due
  else if (!quiet) await env.DB.prepare('UPDATE push_subs SET last_sent = ?, fails = 0 WHERE endpoint = ?').bind(now, sub.endpoint).run();
  return ok;
}
// every browser a player switched reminders on in; how many took the message
export async function pushPlayer(env, player, msg, now = Date.now(), quiet = false) {
  const { results } = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE player = ? AND fails < ?').bind(player, MAX_FAILS).all().catch(() => ({ results: [] }));
  let n = 0; for (const s of results) if (await sendPush(env, s, msg, now, quiet)) n++;
  return n;
}

const SITE = env => (env.SITE_URL || 'https://play.cryptoworm.io').replace(/\/+$/, '') + '/';
const TEST = { en: '🔔 Reminders are on. This is what they look like.', es: '🔔 Recordatorios activados. Así se ven.', pt: '🔔 Lembretes ativados. É assim que eles aparecem.',
  fr: '🔔 Rappels activés. Voilà à quoi ils ressemblent.', de: '🔔 Erinnerungen sind an. So sehen sie aus.', ru: '🔔 Напоминания включены. Вот так они выглядят.',
  tr: '🔔 Hatırlatmalar açık. İşte böyle görünüyorlar.', zh: '🔔 提醒已开启。它们就是这个样子。', id: '🔔 Pengingat aktif. Seperti inilah tampilannya.' };
const lang2 = l => { const x = String(l || '').slice(0, 2).toLowerCase(); return x === 'in' ? 'id' : TEST[x] ? x : 'en' };

// The game's calls (signed-in players): GET /push/key, POST /push/sub {endpoint, p256dh, auth, lang}, /push/unsub {endpoint}, /push/test
export async function pushApi(env, me, path, body, now = Date.now()) {
  if (path === '/push/key') return { key: (await vapid(env)).pub };
  if (path === '/push/sub') {
    const ep = String(body.endpoint || ''); let k = [], a = [];
    try { k = unb64u(body.p256dh); a = unb64u(body.auth) } catch (e) { }
    if (ep.length > 1000 || !pushHost(ep) || k.length !== 65 || k[0] !== 4 || a.length !== 16) return { error: 'bad subscription' };
    await env.DB.prepare(`INSERT INTO push_subs (player, endpoint, p256dh, auth, lang, created) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET player = excluded.player, p256dh = excluded.p256dh, auth = excluded.auth, lang = excluded.lang, fails = 0`)
      .bind(me.id, ep, String(body.p256dh), String(body.auth), lang2(body.lang), now).run();
    await env.DB.prepare('DELETE FROM push_subs WHERE player = ? AND id NOT IN (SELECT id FROM push_subs WHERE player = ? ORDER BY id DESC LIMIT ?)').bind(me.id, me.id, MAX_SUBS).run();   // a few devices at most
    return { on: true };
  }
  if (path === '/push/unsub') { await env.DB.prepare('DELETE FROM push_subs WHERE player = ? AND endpoint = ?').bind(me.id, String(body.endpoint || '')).run(); return { on: false } }
  if (path === '/push/test') {                                                           // right after switching on: the player sees one arrive
    const s = await env.DB.prepare('SELECT endpoint, p256dh, auth, lang, tested FROM push_subs WHERE player = ? AND endpoint = ?').bind(me.id, String(body.endpoint || '')).first();
    if (!s || now - s.tested < 60e3) return { sent: 0 };
    await env.DB.prepare('UPDATE push_subs SET tested = ? WHERE endpoint = ?').bind(now, s.endpoint).run();
    return { sent: await sendPush(env, s, { title: 'Crypto Worm Wars', body: TEST[lang2(s.lang)], url: SITE(env), tag: 'cww-test' }, now, true) ? 1 : 0 };
  }
  return null;
}

// The cron's reminder: the daily reward is waiting. For a player who last played 20 to 72 hours ago (so three at most after
// a visit, each about the hour they usually play), never two to one browser within 20 hours, a batch per run.
export async function pushReminders(env, now = Date.now()) {
  if (!env.DB) return 0;
  const { results } = await env.DB.prepare(`SELECT s.endpoint, s.p256dh, s.auth, s.lang FROM push_subs s JOIN player_meta m ON m.player = s.player
      WHERE m.last_seen < ? AND m.last_seen > ? AND s.fails < ? AND s.last_sent < ?
      ORDER BY m.last_seen LIMIT ?`).bind(now - REMIND_AFTER, now - REMIND_UNTIL, MAX_FAILS, now - REMIND_GAP, PUSH_BATCH).all();
  let sent = 0;
  for (const s of results) if (await sendPush(env, s, { title: 'Crypto Worm Wars', body: (DAY2[lang2(s.lang)] || DAY2.en)[0], url: SITE(env) + '?src=push', tag: 'cww-daily' }, now)) sent++;
  return sent;
}
