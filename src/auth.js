// Sign-in helpers: Telegram Mini App initData, Sign-In with Solana, and the session tokens the game keeps.
// Everything here uses WebCrypto only, so it runs the same in Cloudflare Workers and in Node 20+ (tests).

const enc = new TextEncoder();

async function hmacKey(raw) {
  return crypto.subtle.importKey('raw', typeof raw === 'string' ? enc.encode(raw) : raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
async function hmac(key, data) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', typeof key === 'string' || key instanceof Uint8Array ? await hmacKey(key) : key, enc.encode(data)));
}
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const b64url = b => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sameHex(a, b) {                                              // constant-time compare of two strings
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Telegram: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Returns the Telegram user ({id, first_name, username, ...}) or null when the data is forged or older than maxAge seconds.
export async function verifyTelegram(initData, botToken, maxAge = 86400, now = Date.now() / 1000) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData), hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac('WebAppData', botToken);
  if (!sameHex(hex(await hmac(secret, check)), hash)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || now - authDate > maxAge) return null;
  try { const user = JSON.parse(params.get('user') || 'null'); return user && user.id ? user : null } catch { return null }
}

// Solana addresses and signatures are base58.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58decode(s) {
  if (typeof s !== 'string' || !s.length) return null;
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i) }
  const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n }
  for (const c of s) { if (c !== '1') break; out.unshift(0) }
  return new Uint8Array(out);
}

// Sign-In with Solana: the server hands out a nonce, the wallet signs a plain text message holding it, the server checks
// the ed25519 signature. Nonces are stateless: "<issued ms>.<hmac>" bound to the address, valid for 10 minutes.
export async function makeNonce(address, secret, now = Date.now()) {
  return `${now}.${hex(await hmac(secret, `nonce:${address}:${now}`)).slice(0, 32)}`;
}
export function signInMessage(domain, address, nonce) {
  return `${domain} wants you to sign in with your Solana account:\n${address}\n\n` +
    `Sign in to Crypto Worm Wars. This is not a transaction and costs nothing.\n\nNonce: ${nonce}`;
}
export async function verifySolana({ address, message, signature }, domain, secret, now = Date.now()) {
  const pub = base58decode(address), sig = base58decode(signature);
  if (!pub || pub.length !== 32 || !sig || sig.length !== 64 || typeof message !== 'string') return false;
  const m = message.match(/\nNonce: (\d+)\.([0-9a-f]{32})$/);
  if (!m || message !== signInMessage(domain, address, `${m[1]}.${m[2]}`)) return false;
  const issued = Number(m[1]);
  if (!(now - issued < 600000 && issued <= now + 60000)) return false;
  if (!sameHex(await makeNonce(address, secret, issued), `${m[1]}.${m[2]}`)) return false;
  const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, sig, enc.encode(message));
}

// Session tokens: "<playerId>.<expires s>.<sig>", signed with SESSION_SECRET. Good for 30 days.
export async function makeToken(playerId, secret, now = Date.now() / 1000) {
  const body = `${playerId}.${Math.floor(now + 30 * 86400)}`;
  return `${body}.${b64url(await hmac(secret, body))}`;
}
export async function readToken(token, secret, now = Date.now() / 1000) {
  if (typeof token !== 'string') return null;
  const [id, exp, sig] = token.split('.');
  if (!id || !exp || !sig || Number(exp) < now) return null;
  return sameHex(sig, b64url(await hmac(secret, `${id}.${exp}`))) ? Number(id) : null;
}
