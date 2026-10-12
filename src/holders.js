// $CWORM holder rewards (Damian 2026-10-12, monetization/holder-rewards.md in the game folder). The real $CWORM in a
// player's linked Solana wallet sets a holder tier; days in a row at that tier or above give hold stars. The server reads
// every linked wallet once a day at a time nobody can predict (so tokens lent for a moment don't buy a tier), and when the
// player taps Refresh. Holding never pays out tokens: holders get a title and badge, a daily chest of play money, bonus play
// money and extra health in solo modes (the game applies those), and whales can be announced when they come online.
//
//   GET  /holder                -> status   (no wallet read)
//   POST /holder/refresh        -> status   reads the wallet now, at most every REFRESH_MS
//   POST /holder/chest          -> {amount, holder: status}   the daily holder chest: play money the game claims through /rewards
//   POST /holder/toast {on}     -> status   whales: tell everyone online when I come online (once a day at most)
// status: {wallet, tier, title, stars, days, grace, balance, next, tiers, toast, chest, checked}
//
// Tiers are whole-token amounts (1,000,000,000 supply). Big Whale is also any top-10 holder, not counting pools and other
// program accounts, the burn address and the wallets in HOLDER_EXCLUDE (team wallets, comma separated).
// Falling below your tier: after holding it GRACE_DAYS you keep it for GRACE_DAYS more, then the tier drops and the
// stars restart. A tier held less than GRACE_DAYS drops at once.

import { base58decode } from './auth.js';

export const MINT = '65V31DT6xGVXY8axRu2QzNf1U7u6ZuQ77sRoBGYYpump';
export const TIERS = [0, 100e3, 1e6, 5e6, 10e6, 20e6];
export const TITLES = ['', 'Holder', 'Dolphin', 'Shark', 'Whale', 'Big Whale'];
export const STAR_DAYS = [7, 30, 90, 180];
const CHEST = [0, 30, 50, 80, 120, 200], CHEST_STAR = 10;          // play money per day, by tier, plus per hold star
const GRACE_DAYS = 3, REFRESH_MS = 5 * 60 * 1000, TOP_N = 10, TOP_MS = 6 * 3600 * 1000, BATCH = 50, WHALE = 4;
const SYSTEM = '11111111111111111111111111111111', BURN = '1nc1nerator11111111111111111111111111111111';
export const PUBLIC_RPC = ['https://public.rpc.solanavibestation.com/', 'https://solana-rpc.publicnode.com'];   // the main public host blocks Cloudflare

export const today = (now = Date.now()) => Math.floor(now / 864e5);
export const starsFor = days => STAR_DAYS.filter(d => days >= d).length;
export function tierOf(balance, top) {
  if (!(balance >= TIERS[1])) return 0;
  if (top) return 5;
  let t = 0; while (t < 5 && balance >= TIERS[t + 1]) t++; return t;
}

// One reading of the wallet: the tier it holds now (`cur`) moves the saved tier, its day and the streak.
export function step(h, cur, day) {
  h = { tier: h && h.tier || 0, tier_day: h && h.tier_day != null ? h.tier_day : day, streak_day: h && h.streak_day != null ? h.streak_day : null, below_day: h && h.below_day != null ? h.below_day : null };
  if (cur >= h.tier) {
    if (cur > h.tier) { h.tier = cur; h.tier_day = day }
    h.below_day = null; if (h.tier > 0 && h.streak_day == null) h.streak_day = day;
  } else if (day - h.tier_day >= GRACE_DAYS && (h.below_day == null || day - h.below_day < GRACE_DAYS)) {
    if (h.below_day == null) h.below_day = day;                      // grace: the tier stays a few days
  } else { h.tier = cur; h.tier_day = day; h.below_day = null; h.streak_day = cur > 0 ? day : null }
  return h;
}

export function status(h, wallet, now = Date.now()) {
  const d = today(now), tier = h && h.tier || 0, days = tier && h.streak_day != null ? d - h.streak_day : 0, stars = tier ? starsFor(days) : 0;
  return { wallet: !!wallet, tier, title: TITLES[tier], stars, days, grace: tier && h.below_day != null ? Math.max(1, GRACE_DAYS - (d - h.below_day)) : null,
    balance: h && h.balance != null ? h.balance : null, next: tier < 5 ? TIERS[tier + 1] : null, tiers: TIERS, toast: toastOn(h),
    chest: tier > 0 && (h.chest_day || 0) < d ? CHEST[tier] + CHEST_STAR * stars : 0, checked: h && h.checked || 0 };
}
export const toastOn = h => !!h && h.tier >= WHALE && (h.toast == null ? h.tier >= 5 : !!h.toast);   // Big Whales are announced unless they turn it off

// Solana JSON-RPC: SOLANA_RPC when set (a URL with a private key, e.g. Helius, kept as a secret), else free public hosts in turn.
const hosts = env => [env.SOLANA_RPC, ...PUBLIC_RPC].filter(Boolean);
async function rpc(env, body) {
  const errs = [];
  for (const url of hosts(env)) {
    let why;
    for (let k = 0; k < 3; k++) try {                                 // public hosts allow about one call a second: wait and retry on 429
      if (k) await new Promise(r => setTimeout(r, 1500 * k));
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 429) { why = '429'; continue }
      if (r.ok) { const d = await r.json(); if (Array.isArray(d) || (d && !d.error)) return d; why = JSON.stringify(d.error).slice(0, 120) } else why = r.status + ' ' + (await r.text()).slice(0, 80);
      break;
    } catch (e) { why = e && e.message; break }
    errs.push(new URL(url).host + ' ' + why);
  }
  throw new Error('solana rpc failed (' + (Array.isArray(body) ? 'batch' : body.method) + '): ' + errs.join('; '));
}

// Each wallet's $CWORM sits in its associated token account (ATA), an address worked out from the wallet, the token program
// and the mint, so one getMultipleAccounts call reads up to 100 wallets. The token program is whichever owns the mint.
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58(bytes) { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n } for (const b of bytes) { if (b) break; s = '1' + s } return s }
const P = 2n ** 255n - 19n, mod = a => ((a % P) + P) % P;
const pow = (b, e) => { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n } return r };
const ED_D = mod(-121665n * pow(121666n, P - 2n)), SQRT_M1 = pow(2n, (P - 1n) / 4n);
export function onCurve(b) {                                         // an ed25519 point? (program addresses must not be)
  let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? b[i] & 0x7f : b[i]);
  if (y >= P) return false;
  const u = mod(y * y - 1n), v = mod(ED_D * y * y + 1n), x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (P - 5n) / 8n)), vx2 = mod(v * x * x);
  return vx2 === u || vx2 === mod(-u) || (u === 0n);
}
export async function programAddress(seeds, program) {
  const tail = [...base58decode(program), ...new TextEncoder().encode('ProgramDerivedAddress')];
  for (let bump = 255; bump >= 0; bump--) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...seeds.flatMap(s => [...s]), bump, ...tail])));
    if (!onCurve(h)) return b58(h);
  }
  return null;
}
export const ata = (wallet, tokenProgram, mint = MINT) => programAddress([base58decode(wallet), base58decode(tokenProgram), base58decode(mint)], ATA_PROGRAM);
async function tokenProgram(env) {
  if (!env._tokenProgram) { const r = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [MINT, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }] });
    const o = r.result && r.result.value && r.result.value.owner; if (!o) throw new Error('mint not found'); env._tokenProgram = o }
  return env._tokenProgram;
}

// $CWORM held by each wallet, in whole tokens; a wallet the RPC didn't answer for is left out (an empty one reads 0).
export async function balances(env, wallets) {
  const out = new Map(); if (!wallets.length) return out;
  const prog = await tokenProgram(env), addrs = [];
  for (const w of wallets) { const a = base58decode(w); addrs.push(a && a.length === 32 ? await ata(w, prog) : null) }
  for (let k = 0; k < wallets.length; k += 100) {
    const part = addrs.slice(k, k + 100), ask = part.filter(Boolean); if (!ask.length) continue;
    const r = await rpc(env, { jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [ask, { encoding: 'jsonParsed', commitment: 'confirmed' }] });
    const got = r.result && r.result.value; if (!Array.isArray(got) || got.length !== ask.length) continue;
    let n = 0; part.forEach((a, i) => { if (!a) return; const acc = got[n++], t = acc && acc.data && acc.data.parsed && acc.data.parsed.info && acc.data.parsed.info.tokenAmount;
      out.set(wallets[k + i], t ? Number(t.uiAmountString || t.uiAmount || 0) || 0 : 0) });
  }
  return out;
}

// The top-10 holders' wallets: the 20 biggest token accounts, by owner, without program-owned accounts (pools, bonding
// curve), the burn address and HOLDER_EXCLUDE. Linked players' wallets always count as people. Cached in bot_kv for TOP_MS.
export async function topHolders(env, now = Date.now(), fresh = false) {
  const kv = await env.DB.prepare("SELECT v FROM bot_kv WHERE k = 'holders_top'").first().catch(() => null);
  let old = null; try { old = kv && JSON.parse(kv.v) } catch { }
  if (old && !fresh && now - old.at < TOP_MS) return new Set(old.owners);
  try {
    const big = ((await rpc(env, { jsonrpc: '2.0', id: 1, method: 'getTokenLargestAccounts', params: [MINT, { commitment: 'confirmed' }] })).result || {}).value || [];
    if (!big.length) return new Set();
    const accs = ((await rpc(env, { jsonrpc: '2.0', id: 2, method: 'getMultipleAccounts', params: [big.map(b => b.address), { encoding: 'jsonParsed' }] })).result || {}).value || [];
    const held = new Map();
    accs.forEach((a, i) => { const o = a && a.data && a.data.parsed && a.data.parsed.info && a.data.parsed.info.owner; if (o) held.set(o, (held.get(o) || 0) + (Number(big[i].uiAmountString || big[i].uiAmount) || 0)) });
    const owners = [...held.keys()], info = owners.length ? ((await rpc(env, { jsonrpc: '2.0', id: 3, method: 'getMultipleAccounts', params: [owners, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }] })).result || {}).value || [] : [];
    const linked = new Set(owners.length ? (await env.DB.prepare(`SELECT wallet FROM players WHERE wallet IN (${owners.map(() => '?').join(',')})`).bind(...owners).all()).results.map(r => r.wallet) : []);
    const skip = new Set([BURN, ...String(env.HOLDER_EXCLUDE || '').split(',').map(s => s.trim()).filter(Boolean)]);
    const people = owners.filter((o, i) => !skip.has(o) && (linked.has(o) || (info[i] && info[i].owner === SYSTEM && !info[i].executable)));
    const top = people.sort((a, b) => held.get(b) - held.get(a)).slice(0, TOP_N);
    await env.DB.prepare("INSERT INTO bot_kv (k, v) VALUES ('holders_top', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify({ at: now, owners: top })).run();
    return new Set(top);
  } catch (e) { if (old) return new Set(old.owners); throw e }
}

const ROW = 'SELECT p.id AS pid, p.wallet AS pw, h.wallet AS hw, h.balance, h.tier, h.tier_day, h.streak_day, h.below_day, h.checked, h.snap_day, h.toast, h.chest_day FROM players p LEFT JOIN holders h ON h.player = p.id';
async function save(env, r, h, bal, now, snap) {
  await env.DB.prepare(`INSERT INTO holders (player, wallet, balance, tier, tier_day, streak_day, below_day, checked, snap_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player) DO UPDATE SET wallet = excluded.wallet, balance = excluded.balance, tier = excluded.tier, tier_day = excluded.tier_day, streak_day = excluded.streak_day,
    below_day = excluded.below_day, checked = excluded.checked, snap_day = CASE WHEN ? THEN excluded.snap_day ELSE holders.snap_day END`)
    .bind(r.pid, r.pw, bal, h.tier, h.tier_day, h.streak_day, h.below_day, now, snap ? today(now) : 0, snap ? 1 : 0).run();
}
const fresh = r => (r.hw && r.hw !== r.pw ? {} : r);                  // a different wallet on the account starts over

export async function get(env, me, now = Date.now()) {
  const r = me.wallet ? await env.DB.prepare(ROW + ' WHERE p.id = ?').bind(me.id).first() : null;
  return status(r && fresh(r).tier != null ? fresh(r) : null, me.wallet, now);
}

export async function refresh(env, me, now = Date.now()) {
  if (!me.wallet) return { ...(await get(env, me, now)), error: 'link a wallet first' };
  const r = await env.DB.prepare(ROW + ' WHERE p.id = ?').bind(me.id).first(), h0 = fresh(r);
  if (h0.checked && now - h0.checked < REFRESH_MS) return get(env, me, now);
  const bal = (await balances(env, [me.wallet])).get(me.wallet);
  if (bal == null) throw new Error('could not read the wallet, try again in a minute');
  const top = bal >= TIERS[1] ? (await topHolders(env, now).catch(() => new Set())).has(me.wallet) : false;
  await save(env, r, step(h0, tierOf(bal, top), today(now)), bal, now, false);
  return get(env, me, now);
}

// The daily reading, from the cron (every minute): from an unpredictable time each day, BATCH wallets per run until all
// linked wallets are read.
export async function snapshotAt(env, day) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET || 'x'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const b = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('holders:' + day)));
  return day * 864e5 + ((b[0] * 256 + b[1]) % (22 * 60)) * 60000;  // before 22:00 UTC, so a big batch still ends the same day
}
export async function snapshot(env, now = Date.now()) {
  const day = today(now); if (now < await snapshotAt(env, day)) return 0;
  const rows = (await env.DB.prepare(ROW + ' WHERE p.wallet IS NOT NULL AND (h.player IS NULL OR h.snap_day < ? OR h.wallet != p.wallet) LIMIT ?').bind(day, BATCH).all()).results;
  if (!rows.length) return 0;
  const bal = await balances(env, rows.map(r => r.pw)), top = await topHolders(env, now).catch(() => new Set());
  for (const r of rows) {
    const b = bal.get(r.pw), h0 = fresh(r);
    if (b == null) { await env.DB.prepare('INSERT INTO holders (player, wallet, snap_day) VALUES (?, ?, ?) ON CONFLICT(player) DO UPDATE SET snap_day = excluded.snap_day').bind(r.pid, r.pw, day).run(); continue }   // no answer: try again tomorrow
    await save(env, r, step(h0, tierOf(b, top.has(r.pw)), day), b, now, true);
  }
  return rows.length;
}

export async function chest(env, me, now = Date.now()) {
  const s = await get(env, me, now);
  if (!s.chest) return { error: s.tier ? 'come back tomorrow for the next chest' : 'holders only', holder: s };
  const r = await env.DB.prepare('UPDATE holders SET chest_day = ? WHERE player = ? AND chest_day < ? RETURNING player').bind(today(now), me.id, today(now)).first();
  if (!r) return { error: 'come back tomorrow for the next chest', holder: s };
  await env.DB.prepare('INSERT INTO rewards (player, amount, reason, note, created) VALUES (?, ?, ?, ?, ?)').bind(me.id, s.chest, 'holder', s.title, now).run();
  return { amount: s.chest, holder: await get(env, me, now) };
}

export async function setToast(env, me, on, now = Date.now()) {
  await env.DB.prepare('UPDATE holders SET toast = ? WHERE player = ?').bind(on ? 1 : 0, me.id).run();
  return get(env, me, now);
}

// For the lobby and matches: the tier and stars the server vouches for, and whether to announce this whale.
export async function badge(env, id, now = Date.now()) {
  const h = await env.DB.prepare('SELECT h.tier, h.streak_day, h.toast, h.wallet, p.wallet AS pw FROM holders h JOIN players p ON p.id = h.player WHERE h.player = ?').bind(id).first().catch(() => null);
  if (!h || !h.tier || h.wallet !== h.pw) return { tier: 0, stars: 0, toast: false };
  return { tier: h.tier, stars: starsFor(h.streak_day != null ? today(now) - h.streak_day : 0), toast: toastOn(h) };
}

export async function handle(path, req, env, me, body, now = Date.now()) {
  if (path === '/holder' && req.method === 'GET') return get(env, me, now);
  if (path === '/holder/refresh' && req.method === 'POST') return refresh(env, me, now);
  if (path === '/holder/chest' && req.method === 'POST') return chest(env, me, now);
  if (path === '/holder/toast' && req.method === 'POST') return setToast(env, me, !!body.on, now);
  return null;
}

// From the cron: the daily reading, and a one-off check of the Solana hosts when bot_kv 'holders_probe' is set (results in bot_log).
export async function holderCron(env, now = Date.now()) {
  const log = note => env.DB.prepare('INSERT INTO bot_log (at, note) VALUES (?, ?)').bind(Date.now(), String(note).slice(0, 4000)).run().catch(() => { });
  try {
    const probe = await env.DB.prepare("DELETE FROM bot_kv WHERE k = 'holders_probe' RETURNING v").first();
    let list = null; try { list = probe && JSON.parse(probe.v) } catch { }
    if (list && list.owner) {                                         // v: {"owner": wallet}: every $CWORM account of one wallet, and its ATA
      const out = [], prog = await tokenProgram(env).catch(e => 'error ' + e.message), mine = await ata(list.owner, prog).catch(e => 'error ' + e.message);
      for (const body of [{ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [list.owner, { mint: MINT }, { encoding: 'jsonParsed' }] },
        { jsonrpc: '2.0', id: 2, method: 'getMultipleAccounts', params: [[mine], { encoding: 'jsonParsed', commitment: 'confirmed' }] }])
        try { out.push(JSON.stringify((await rpc(env, body)).result).slice(0, 1500)) } catch (e) { out.push('error ' + e.message) }
      for (const programId of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'])     // which classic tokens it does hold ($CWORM is one)
        try { out.push(programId.slice(0, 6) + ' ' + (await rpc(env, { jsonrpc: '2.0', id: 3, method: 'getTokenAccountsByOwner', params: [list.owner, { programId }, { encoding: 'jsonParsed' }] })).result.value
          .map(a => { const i = a.account.data.parsed.info; return i.mint + ':' + i.tokenAmount.uiAmountString }).join(',').slice(0, 1500)) } catch (e) { out.push('error ' + e.message) }
      await log('holders owner ' + list.owner.slice(0, 6) + ' ata ' + mine + ' | ' + out.join(' | ') + ' | read ' + (await balances(env, [list.owner]).then(m => m.get(list.owner), e => 'error ' + e.message)));
    } else if (probe) {                                               // v: '1' for the usual hosts, or a JSON list of hosts to try
      const out = [];
      for (const url of Array.isArray(list) ? list : hosts(env)) {
        const w = (await env.DB.prepare('SELECT wallet FROM players WHERE wallet IS NOT NULL ORDER BY id LIMIT 1').first() || {}).wallet || BURN;
        for (const body of [{ jsonrpc: '2.0', id: 0, method: 'getTokenSupply', params: [MINT] }, { jsonrpc: '2.0', id: 1, method: 'getTokenLargestAccounts', params: [MINT] },
          [{ jsonrpc: '2.0', id: 2, method: 'getTokenAccountsByOwner', params: [w, { mint: MINT }, { encoding: 'jsonParsed' }] }, { jsonrpc: '2.0', id: 3, method: 'getMultipleAccounts', params: [[w], { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }] }]])
          try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            out.push(new URL(url).host + ' ' + r.status + ' ' + (await r.text()).slice(0, 300)) } catch (e) { out.push(new URL(url).host + ' ' + (e && e.message)) }
      }
      await log('holders probe ' + out.join(' | '));
      try {                                                           // the ATA worked out here must match a real token account
        const big = (await rpc(env, { jsonrpc: '2.0', id: 1, method: 'getTokenLargestAccounts', params: [MINT] })).result.value.slice(0, 3).map(b => b.address);
        const own = (await rpc(env, { jsonrpc: '2.0', id: 2, method: 'getMultipleAccounts', params: [big, { encoding: 'jsonParsed' }] })).result.value.map(a => a.data.parsed.info.owner);
        const prog = await tokenProgram(env), mine = await Promise.all(own.map(o => ata(o, prog)));
        await log('holders ata ' + prog.slice(0, 6) + ' ' + big.map((b, i) => b === mine[i] ? 'ok' : 'MISMATCH').join(','));
        const ws = (await env.DB.prepare('SELECT wallet FROM players WHERE wallet IS NOT NULL').all()).results.map(r => r.wallet), bal = await balances(env, ws), n = [0, 0, 0, 0, 0, 0];
        for (const v of bal.values()) n[tierOf(v, false)]++;
        await log('holders read ' + bal.size + '/' + ws.length + ' wallets, by tier ' + n.join('/'));
      } catch (e) { await log('holders ata error ' + (e && e.message)) }
      try { const top = await topHolders(env, now, true); await log('holders top ' + [...top].map(w => w.slice(0, 4) + '…').join(',')) } catch (e) { await log('holders top error ' + (e && e.message)) }
    }
    const wait = await env.DB.prepare("SELECT v FROM bot_kv WHERE k = 'holders_wait'").first();
    if (wait && Number(wait.v) > now) return;                         // the Solana hosts failed a moment ago: give them a break
    const n = await snapshot(env, now); if (n) await log('holders snapshot ' + n);
  } catch (e) {
    await env.DB.prepare("INSERT INTO bot_kv (k, v) VALUES ('holders_wait', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(String(now + 30 * 60000)).run().catch(() => { });
    await log('holders error ' + (e && e.message));
  }
}
