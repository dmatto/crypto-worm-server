// Prize payouts from the server (Damian 2026-11-03: "If I give you a wallet with SOL, can you send the rewards?"). The server holds
// the key of a wallet made only for prizes (PRIZE_WALLET_KEY, a Cloudflare secret Damian adds himself; it never goes through a chat
// or this repo) and sends SOL or $CWORM to a list of wallets. Nothing moves without an admin's typed OK:
//   /pay                         the prize wallet, its balances and the last batches
//   /pay new <label>             then one line per payment: <wallet> <amount> [SOL|CWORM] [note]   (or "wallet,amount" as /prize gives
//                                them; no unit = CWORM). Saves a batch and shows it.
//   /pay prize                   a batch from last week's weekly prize winners (adminList in prize.js, paid in SOL)
//   /pay show <id>               the batch, what it needs (amounts, fees, new token accounts), a dry run of every transfer on Solana
//                                (simulateTransaction with signatures checked) and the code to send it
//   /pay send <id> <code>        the OK: the minute cron sends every line not sent yet, one transaction each, and answers with the
//                                Solscan links
//   /pay cancel <id>
// Safe to retry: a line's signature is saved before it is sent; a line whose transaction may still land is checked on Solana and
// only sent again once its blockhash has expired. A batch can't pass PAY_MAX_SOL / PAY_MAX_CWORM (env, defaults below).
import { base58decode } from './auth.js';
import { b58, ata, rpc, tokenProgram, onCurve, MINT } from './holders.js';

const SYSTEM = '11111111111111111111111111111111', COMPUTE = 'ComputeBudget111111111111111111111111111111', ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SOL_DEC = 9, CU_LIMIT = 80000, CU_PRICE = 100000n;                // priority fee: 80,000 units x 0.1 lamport = 8,000 lamports a transfer
export const FEE = 5000n + BigInt(CU_LIMIT) * CU_PRICE / 1000000n, ATA_RENT = 2039280n;   // lamports a transaction; rent of a new token account
export const MAX_SOL = '2', MAX_CWORM = '30000000', MAX_LINES = 25;
const SOLSCAN = s => 'https://solscan.io/tx/' + s;

// ---- amounts: whole-number base units (lamports, token units) as BigInt, never floats ----
export function units(s, dec) {
  const m = String(s).trim().match(/^(\d+)(?:\.(\d+))?$/); if (!m) return null;
  const frac = m[2] || ''; if (frac.length > dec) return null;
  return BigInt(m[1]) * 10n ** BigInt(dec) + BigInt((frac + '0'.repeat(dec)).slice(0, dec) || '0');
}
export function show(v, dec) {
  const n = BigInt(v), w = (n / 10n ** BigInt(dec)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','), f = (n % 10n ** BigInt(dec)).toString().padStart(dec, '0').replace(/0+$/, '');
  return f ? w + '.' + f : w;
}

// ---- the prize wallet ----
// PRIZE_WALLET_KEY: the 64-byte secret key, base58 (what Phantom or Solflare export) or a keypair file's JSON array.
export function parseKey(s) {
  s = String(s || '').trim(); let b = null;
  try { b = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : base58decode(s) } catch (e) { b = null }
  if (!b || b.length !== 64) throw new Error('PRIZE_WALLET_KEY is missing or is not a 64-byte Solana secret key');
  return { seed: b.slice(0, 32), pub: b.slice(32) };
}
const ED = [{ name: 'Ed25519' }, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }];
async function importEd(fmt, data, use) { let err; for (const a of ED) try { return [await crypto.subtle.importKey(fmt, data, a, false, use), a] } catch (e) { err = e } throw err }
export async function signer(env) {
  const { seed, pub } = parseKey(env.PRIZE_WALLET_KEY);
  const [key, alg] = await importEd('pkcs8', new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]), ['sign']);
  const sign = async m => new Uint8Array(await crypto.subtle.sign(alg, key, m));
  const [vk] = await importEd('raw', pub, ['verify']), probe = new TextEncoder().encode('crypto worm prize wallet');   // the two halves must belong together
  if (!await crypto.subtle.verify(alg, vk, await sign(probe), probe)) throw new Error('PRIZE_WALLET_KEY does not match its own public key');
  return { address: b58(pub), sign };
}

// ---- Solana transactions (legacy messages) ----
const cu16 = n => { const o = []; for (; ;) { const b = n & 0x7f; n >>= 7; if (n) o.push(b | 0x80); else { o.push(b); return o } } };
const le = (v, bytes) => { const o = []; let x = BigInt(v); for (let i = 0; i < bytes; i++) { o.push(Number(x & 255n)); x >>= 8n } return o };
const key32 = k => { const b = base58decode(k); if (!b || b.length !== 32) throw new Error('bad address ' + k); return [...b] };
export const ix = {
  limit: () => ({ p: COMPUTE, keys: [], d: [2, ...le(CU_LIMIT, 4)] }),
  price: () => ({ p: COMPUTE, keys: [], d: [3, ...le(CU_PRICE, 8)] }),
  sol: (from, to, lamports) => ({ p: SYSTEM, keys: [{ k: from, s: 1, w: 1 }, { k: to, w: 1 }], d: [...le(2, 4), ...le(lamports, 8)] }),
  ata: (payer, acct, owner, mint, prog) => ({ p: ATA_PROGRAM, keys: [{ k: payer, s: 1, w: 1 }, { k: acct, w: 1 }, { k: owner }, { k: mint }, { k: SYSTEM }, { k: prog }], d: [1] }),   // CreateIdempotent
  token: (src, mint, dst, owner, amount, dec, prog) => ({ p: prog, keys: [{ k: src, w: 1 }, { k: mint }, { k: dst, w: 1 }, { k: owner, s: 1 }], d: [12, ...le(amount, 8), dec] }),   // TransferChecked
};
// Accounts in the order Solana wants: the fee payer, other signers (writable first), then the rest (writable first); programs at the end.
export function compile(payer, ixs, blockhash) {
  const meta = new Map(), add = (k, s, w) => { const m = meta.get(k) || { s: false, w: false }; m.s = m.s || !!s; m.w = m.w || !!w; meta.set(k, m) };
  add(payer, 1, 1); for (const i of ixs) { for (const a of i.keys) add(a.k, a.s, a.w) } for (const i of ixs) add(i.p, 0, 0);
  const rank = k => { const m = meta.get(k); return k === payer ? 0 : m.s ? (m.w ? 1 : 2) : (m.w ? 3 : 4) };
  const keys = [...meta.keys()].sort((a, b) => rank(a) - rank(b)), M = k => meta.get(k);
  const out = [keys.filter(k => M(k).s).length, keys.filter(k => M(k).s && !M(k).w).length, keys.filter(k => !M(k).s && !M(k).w).length, ...cu16(keys.length)];
  for (const k of keys) out.push(...key32(k));
  out.push(...key32(blockhash), ...cu16(ixs.length));
  for (const i of ixs) out.push(keys.indexOf(i.p), ...cu16(i.keys.length), ...i.keys.map(a => keys.indexOf(a.k)), ...cu16(i.d.length), ...i.d);
  return new Uint8Array(out);
}
const b64 = u => { let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s) };
export async function signTx(w, ixs, blockhash) {
  const msg = compile(w.address, ixs, blockhash), sig = await w.sign(msg);
  return { sig: b58(sig), tx: b64(new Uint8Array([...cu16(1), ...sig, ...msg])) };
}

// ---- reading Solana ----
const call = (env, method, params) => rpc(env, { jsonrpc: '2.0', id: 1, method, params }).then(d => d.result);
async function decimals(env) { if (env._cwDec == null) env._cwDec = (await call(env, 'getTokenSupply', [MINT])).value.decimals; return env._cwDec }
async function tokenBalance(env, owner, prog) {
  const r = await call(env, 'getTokenAccountsByOwner', [owner, { mint: MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  return (r.value || []).reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
}
export async function wallet(env) {
  const w = await signer(env), prog = await tokenProgram(env);
  const [sol, cw, dec] = await Promise.all([call(env, 'getBalance', [w.address, { commitment: 'confirmed' }]).then(r => BigInt(r.value)), tokenBalance(env, w.address, prog), decimals(env)]);
  return { w, prog, sol, cw, dec };
}

// ---- batches ----
const DEC = (asset, dec) => asset === 'SOL' ? SOL_DEC : dec;
const code = () => String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000));
// One payment a line: "<wallet> <amount> [SOL|CWORM] [note]" or "wallet,amount[ SOL]". Amounts with a dot, never commas. Returns {lines, errors}.
export function parseLines(text, cwDec) {
  const lines = [], errors = [];
  for (const raw of String(text).split('\n').map(s => s.trim()).filter(Boolean)) {
    const [, w = '', rest = ''] = raw.match(/^([^\s,;]*)[\s,;]*(.*)$/), t = rest.split(/\s+/), amt = t[0], unit = (t[1] || '').toUpperCase().replace(/^\$/, ''), asset = unit === 'SOL' ? 'SOL' : 'CWORM';
    const note = (unit === 'SOL' || unit === 'CWORM' ? t.slice(2) : t.slice(1)).join(' ').slice(0, 60);
    if (/[,']/.test(amt || '')) { errors.push(`write amounts without commas (0.2, 150000): ${raw.slice(0, 60)}`); continue }   // "0,200" or "1,000": never guess
    const k = base58decode(w);
    if (!k || k.length !== 32) { errors.push(`not a Solana address: ${raw.slice(0, 60)}`); continue }
    if (!onCurve(k)) { errors.push(`${w} is a program address, not a wallet`); continue }
    const v = units(amt || '', DEC(asset, cwDec));
    if (v == null || v <= 0n) { errors.push(`bad amount on: ${raw.slice(0, 60)}`); continue }
    lines.push({ wallet: w, asset, amount: v.toString(), note });
  }
  if (lines.length > MAX_LINES) errors.push(`at most ${MAX_LINES} payments a batch`);
  const seen = new Set(); for (const l of lines) { const k = l.wallet + l.asset; if (seen.has(k)) errors.push(`${l.wallet} is in the list twice`); seen.add(k) }
  return { lines, errors };
}
export async function create(env, label, lines, byTg, now = Date.now()) {
  const b = await env.DB.prepare('INSERT INTO pay_batch (label, created, by_tg, code, status) VALUES (?, ?, ?, ?, ?) RETURNING id').bind(String(label || 'Payout').slice(0, 80), now, byTg || null, code(), 'ready').first();
  await env.DB.batch(lines.map((l, n) => env.DB.prepare('INSERT INTO pay_line (batch, n, wallet, asset, amount, note) VALUES (?, ?, ?, ?, ?, ?)').bind(b.id, n, l.wallet, l.asset, l.amount, l.note || null)));
  return b.id;
}
const load = async (env, id) => {
  const b = await env.DB.prepare('SELECT * FROM pay_batch WHERE id = ?').bind(id).first(); if (!b) return null;
  b.lines = (await env.DB.prepare('SELECT * FROM pay_line WHERE batch = ? ORDER BY n').bind(id).all()).results; return b;
};
const totals = lines => lines.reduce((t, l) => (t[l.asset] = (t[l.asset] || 0n) + BigInt(l.amount), t), {});
function limits(env, t, dec) {
  const ms = units(env.PAY_MAX_SOL || MAX_SOL, SOL_DEC), mc = units(env.PAY_MAX_CWORM || MAX_CWORM, dec), out = [];
  if ((t.SOL || 0n) > ms) out.push(`more than the ${show(ms, SOL_DEC)} SOL a batch may send (PAY_MAX_SOL)`);
  if ((t.CWORM || 0n) > mc) out.push(`more than the ${show(mc, dec)} $CWORM a batch may send (PAY_MAX_CWORM)`);
  return out;
}
// The transaction for one line; a $CWORM line also creates the receiver's token account if it has none (CreateIdempotent).
async function build(env, s, l, blockhash) {
  const i = [ix.limit(), ix.price()];
  if (l.asset === 'SOL') i.push(ix.sol(s.w.address, l.wallet, BigInt(l.amount)));
  else { const from = await ata(s.w.address, s.prog), to = await ata(l.wallet, s.prog);
    i.push(ix.ata(s.w.address, to, l.wallet, MINT, s.prog), ix.token(from, MINT, to, s.w.address, BigInt(l.amount), s.dec, s.prog)) }
  return signTx(s.w, i, blockhash);
}
// What the batch needs and whether the wallet has it, plus a dry run of every line still to send.
async function check(env, b, s) {
  const todo = b.lines.filter(l => l.status !== 'sent'), t = totals(todo), cwLines = todo.filter(l => l.asset === 'CWORM');
  let newAccts = 0;
  if (cwLines.length) { const addrs = await Promise.all(cwLines.map(l => ata(l.wallet, s.prog)));
    const r = await call(env, 'getMultipleAccounts', [addrs, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }]); newAccts = r.value.filter(v => !v).length }
  const needSol = (t.SOL || 0n) + FEE * BigInt(todo.length) + ATA_RENT * BigInt(newAccts), needCw = t.CWORM || 0n, problems = limits(env, totals(b.lines), s.dec);
  if (s.sol < needSol) problems.push(`the prize wallet has ${show(s.sol, SOL_DEC)} SOL and needs ${show(needSol, SOL_DEC)}`);
  if (s.cw < needCw) problems.push(`the prize wallet has ${show(s.cw, s.dec)} $CWORM and needs ${show(needCw, s.dec)}`);
  const sim = [];
  if (!problems.length && todo.length) {
    const { value: bh } = await call(env, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
    for (const l of todo) {
      const { tx } = await build(env, s, l, bh.blockhash);
      const r = await call(env, 'simulateTransaction', [tx, { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]).catch(e => ({ value: { err: e.message } }));
      if (r.value && r.value.err) sim.push(`line ${l.n + 1}: ${JSON.stringify(r.value.err).slice(0, 140)}`);
    }
  }
  return { todo, t, newAccts, needSol, needCw, problems: problems.concat(sim), simOk: !problems.length && !sim.length };
}
const lineText = (l, dec) => `${l.n + 1}. ${l.wallet.slice(0, 4)}…${l.wallet.slice(-4)}  ${show(l.amount, DEC(l.asset, dec))} ${l.asset === 'SOL' ? 'SOL' : '$CWORM'}${l.note ? '  · ' + l.note : ''}`
  + (l.status === 'sent' ? `  ✅ ${SOLSCAN(l.sig)}` : l.status === 'failed' ? `  ❌ ${l.err || ''}` : l.status === 'sending' ? `  ⏳ ${SOLSCAN(l.sig)}` : '');
export async function showText(env, id) {
  const b = await load(env, id); if (!b) return `No payout batch ${id}.`;
  let s; try { s = await wallet(env) } catch (e) { return `💸 Batch ${id}: ${b.label}\n\nThe prize wallet can't be read: ${e.message}` }
  const head = `💸 Batch ${id}: ${b.label}  (${b.status})\nFrom the prize wallet ${s.w.address}\n\n${b.lines.map(l => lineText(l, s.dec)).join('\n')}`;
  if (b.status === 'done' || b.status === 'cancelled') return head;
  const c = await check(env, b, s);
  const need = `\n\nTo send: ${c.todo.length} transfer${c.todo.length === 1 ? '' : 's'}` + (c.t.SOL ? `, ${show(c.t.SOL, SOL_DEC)} SOL` : '') + (c.t.CWORM ? `, ${show(c.t.CWORM, s.dec)} $CWORM` : '')
    + `\nFees about ${show(FEE * BigInt(c.todo.length) + ATA_RENT * BigInt(c.newAccts), SOL_DEC)} SOL` + (c.newAccts ? ` (incl. ${c.newAccts} new token account${c.newAccts === 1 ? '' : 's'})` : '')
    + `\nWallet now: ${show(s.sol, SOL_DEC)} SOL, ${show(s.cw, s.dec)} $CWORM`;
  if (!c.simOk) return head + need + `\n\n⛔ Not ready:\n- ${c.problems.join('\n- ')}`;
  return head + need + `\n\n✅ Dry run on Solana passed. Payments can't be undone: check every wallet and amount, then send with:\n/pay send ${id} ${b.code}`;
}
// /pay send <id> <code>: the admin's OK. The minute cron sends it (a cron run may take minutes; a bot reply can't) and answers in this chat.
export async function approve(env, id, given, chat, now = Date.now()) {
  const r = await env.DB.prepare("UPDATE pay_batch SET status = 'approved', chat = ?, claimed = ? WHERE id = ? AND code = ? AND status IN ('ready', 'partial') RETURNING id").bind(chat, now, id, String(given || '')).first();
  if (r) return `✅ Batch ${id} approved. Sending within a minute; the receipts come here.`;
  const b = await env.DB.prepare('SELECT status, code FROM pay_batch WHERE id = ?').bind(id).first();
  return !b ? `No payout batch ${id}.` : b.code !== String(given || '') ? `Wrong code for batch ${id}. /pay show ${id} gives it.` : `Batch ${id} is ${b.status}: nothing to approve.`;
}
// Every minute: the next approved batch (or one whose run died over 15 minutes ago) is sent; the answer goes to the approver.
export async function cron(env, tell, now = Date.now()) {
  if (!env.PRIZE_WALLET_KEY) return;
  const b = await env.DB.prepare("UPDATE pay_batch SET status = 'sending', claimed = ? WHERE id = (SELECT id FROM pay_batch WHERE status = 'approved' OR (status = 'sending' AND claimed < ?) ORDER BY id LIMIT 1) RETURNING id, chat")
    .bind(now, now - 15 * 60e3).first().catch(() => null);
  if (!b) return;
  const text = await run(env, b.id).catch(async e => { await env.DB.prepare("UPDATE pay_batch SET status = 'partial' WHERE id = ?").bind(b.id).run(); return `⚠️ Batch ${b.id} stopped: ${e.message}\n/pay show ${b.id} shows what went out.` });
  if (text && b.chat && tell) await tell(b.chat, text);
}
// Sends the lines of a claimed batch not sent yet. Returns the receipt text.
export async function run(env, id) {
  const b = await load(env, id), s = await wallet(env).catch(e => ({ err: e.message }));
  const release = st => env.DB.prepare('UPDATE pay_batch SET status = ?, done = ? WHERE id = ?').bind(st, st === 'done' ? Date.now() : null, id).run();
  if (s.err) { await release(b.lines.some(l => l.status === 'sent') ? 'partial' : 'ready'); return `Nothing sent: the prize wallet can't be read (${s.err}).` }
  const set = l => env.DB.prepare('UPDATE pay_line SET sig = ?, lvbh = ?, status = ?, err = ?, at = ? WHERE batch = ? AND n = ?').bind(l.sig ?? null, l.lvbh ?? null, l.status, (l.err ?? null) && String(l.err).slice(0, 200), Date.now(), id, l.n).run();
  const status = async sig => { const r = await call(env, 'getSignatureStatuses', [[sig], { searchTransactionHistory: true }]); return r.value[0] };
  const wait = async (sig, ms = 30e3) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { const v = await status(sig).catch(() => null); if (v && (v.err || ['confirmed', 'finalized'].includes(v.confirmationStatus))) return v; await new Promise(r => setTimeout(r, env._payPoll ?? 1500)) } return null };
  // 1. lines sent before (a retry): did they land? A line goes out again only once its old transaction never can (blockhash expired)
  const hold = new Set();
  for (const l of b.lines.filter(l => l.status === 'sending' && l.sig)) {
    const v = await status(l.sig).catch(() => null);
    if (v && !v.err) { l.status = 'sent'; await set(l); continue }
    if (v && v.err) continue;                                        // failed on chain: nothing moved, send again
    const h = await call(env, 'getBlockHeight', [{ commitment: 'confirmed' }]).catch(() => null);
    if (h != null && h > l.lvbh) continue;                           // expired without landing: send again
    const v2 = await wait(l.sig, env._payWait ?? 20e3); if (v2 && !v2.err) { l.status = 'sent'; await set(l) } else if (!v2) hold.add(l.n);
  }
  // 2. what the rest needs, and a dry run of each line; 3. each line sent, its signature saved first
  const c = await check(env, { ...b, lines: b.lines.filter(l => !hold.has(l.n)) }, s);
  if (!c.simOk) { await release(b.lines.some(l => l.status === 'sent') ? 'partial' : 'ready'); return `Nothing more sent for batch ${id}:\n- ${c.problems.join('\n- ')}` }
  const t0 = Date.now();
  for (const l of b.lines) {
    if (l.status === 'sent' || hold.has(l.n)) continue;
    if (Date.now() - t0 > (env._payBudget ?? 8 * 60e3)) { await release('approved'); return null }   // a long run hands the rest to the next minute's cron (still approved)
    await env.DB.prepare('UPDATE pay_batch SET claimed = ? WHERE id = ?').bind(Date.now(), id).run();   // alive: no other cron run takes this batch over
    const { value: bh } = await call(env, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const { sig, tx } = await build(env, s, l, bh.blockhash);
    Object.assign(l, { sig, lvbh: bh.lastValidBlockHeight, status: 'sending', err: null }); await set(l);   // saved before it goes out
    try { await call(env, 'sendTransaction', [tx, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]) }
    catch (e) { if (/simulation failed|-32002|insufficient funds/i.test(e.message)) { l.status = 'failed'; l.err = (e.message.match(/"message":"([^"]+)"/) || [, e.message])[1]; await set(l) } continue }   // refused before it went out
    const v = await wait(sig, env._payWait ?? 30e3);
    if (v && !v.err) { l.status = 'sent'; await set(l) } else if (v && v.err) { l.status = 'failed'; l.err = JSON.stringify(v.err); await set(l) }
  }
  const after = await load(env, id), done = after.lines.every(l => l.status === 'sent');
  await release(done ? 'done' : 'partial');
  const failed = after.lines.filter(l => l.status === 'failed').length, left = after.lines.filter(l => l.status !== 'sent' && l.status !== 'failed').length;
  return `💸 Batch ${id}: ${after.label}  ${done ? '✅ all sent' : '⚠️ ' + [failed && `${failed} failed (nothing moved)`, left && `${left} not confirmed yet`].filter(Boolean).join(', ')}\n\n${after.lines.map(l => lineText(l, s.dec)).join('\n')}`
    + (done ? '' : `\n\n/pay send ${id} ${after.code} checks those again on Solana and sends only what never went out.`);
}
export async function listText(env) {
  let head; try { const s = await wallet(env); head = `💸 Prize wallet ${s.w.address}\n${show(s.sol, SOL_DEC)} SOL · ${show(s.cw, s.dec)} $CWORM` }
  catch (e) { head = `💸 Prize wallet: not set up (${e.message}).` }
  const rows = (await env.DB.prepare('SELECT b.id, b.label, b.status, COUNT(l.n) AS n FROM pay_batch b LEFT JOIN pay_line l ON l.batch = b.id GROUP BY b.id ORDER BY b.id DESC LIMIT 6').all()).results;
  return head + '\n\n' + (rows.length ? rows.map(r => `#${r.id} ${r.label} · ${r.n} payment${r.n === 1 ? '' : 's'} · ${r.status}`).join('\n') : 'No batches yet.')
    + '\n\n/pay new <label> (then one line each: wallet amount SOL|CWORM)\n/pay prize · /pay show <id> · /pay send <id> <code> · /pay cancel <id>';
}
export async function command(env, arg, byTg, prizeList, chat) {
  const [first, ...rest] = String(arg || '').split('\n'), [sub, ...words] = first.trim().split(/\s+/), id = Number(words[0]);
  if (!sub) return listText(env);
  if (/^show$/i.test(sub)) return showText(env, id);
  if (/^send$/i.test(sub)) return approve(env, id, words[1], chat);
  if (/^cancel$/i.test(sub)) { const r = await env.DB.prepare("UPDATE pay_batch SET status = 'cancelled' WHERE id = ? AND status IN ('ready', 'partial') RETURNING id").bind(id).first(); return r ? `Batch ${id} cancelled.` : `Batch ${id} can't be cancelled (not found, sending or done).` }
  if (/^new$/i.test(sub) || /^prize$/i.test(sub)) {
    let dec; try { dec = await decimals(env) } catch (e) { return `Solana can't be read right now (${e.message.slice(0, 120)}). Nothing saved; try again in a minute.` }   // amounts are saved in token units: never guess the decimals
    let label = words.join(' '), text = rest.join('\n');
    if (/^prize$/i.test(sub)) { const p = await prizeList(); if (!p.winners.length) return 'No weekly prize winners for last week.';
      label = 'Weekly prize, week of ' + new Date(p.week).toISOString().slice(0, 10); text = p.winners.map(r => `${r.wallet} ${r.prize} SOL #${r.place} ${r.name}`).join('\n') }
    const { lines, errors } = parseLines(text, dec);
    if (!lines.length) return 'No payments found. After "/pay new <label>", put one line per payment: <wallet> <amount> SOL (or CWORM).';
    if (errors.length) return `Not saved:\n- ${errors.join('\n- ')}`;
    const nid = await create(env, label, lines, byTg);
    return showText(env, nid);
  }
  return 'Use /pay, /pay new <label>, /pay prize, /pay show <id>, /pay send <id> <code> or /pay cancel <id>.';
}
