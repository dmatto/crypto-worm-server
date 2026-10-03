import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyTelegram, base58decode, makeNonce, signInMessage, verifySolana, makeToken, readToken } from '../src/auth.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n } for (const b of bytes) { if (b) break; s = '1' + s } return s }

const BOT = '123456:TEST-token';
function initData(fields, bot = BOT) {
  const check = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(bot).digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
}

test('telegram: accepts genuine initData and rejects forged or stale', async () => {
  const now = Math.floor(Date.now() / 1000), user = JSON.stringify({ id: 42, first_name: 'Dami' });
  const good = initData({ auth_date: String(now), query_id: 'Q1', user });
  assert.equal((await verifyTelegram(good, BOT)).id, 42);
  assert.equal(await verifyTelegram(good, '999:other'), null);
  assert.equal(await verifyTelegram(good.replace('42', '43'), BOT), null);
  assert.equal(await verifyTelegram(initData({ auth_date: String(now - 90000), user }), BOT), null);
});

test('base58 round trip', () => {
  const b = new Uint8Array([0, 0, 1, 2, 255, 7]);
  assert.deepEqual([...base58decode(b58(b))], [...b]);
  assert.equal(base58decode('0OIl'), null);
});

test('solana: verifies a wallet signature over the sign-in message', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const address = b58(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  const message = signInMessage('example.app', address, await makeNonce(address, 'S'));
  const signature = b58(new Uint8Array(await crypto.subtle.sign('Ed25519', kp.privateKey, new TextEncoder().encode(message))));
  assert.equal(await verifySolana({ address, message, signature }, 'example.app', 'S'), true);
  assert.equal(await verifySolana({ address, message, signature }, 'evil.app', 'S'), false);           // other domain
  assert.equal(await verifySolana({ address, message, signature }, 'example.app', 'X'), false);        // nonce not ours
  assert.equal(await verifySolana({ address, message, signature }, 'example.app', 'S', Date.now() + 700000), false); // expired
  const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const bad = b58(new Uint8Array(await crypto.subtle.sign('Ed25519', other.privateKey, new TextEncoder().encode(message))));
  assert.equal(await verifySolana({ address, message, signature: bad }, 'example.app', 'S'), false);
});

test('session tokens', async () => {
  const t = await makeToken(7, 'sec');
  assert.equal(await readToken(t, 'sec'), 7);
  assert.equal(await readToken(t, 'other'), null);
  assert.equal(await readToken(t.replace(/^7\./, '8.'), 'sec'), null);
  assert.equal(await readToken(t, 'sec', Date.now() / 1000 + 31 * 86400), null);
});
