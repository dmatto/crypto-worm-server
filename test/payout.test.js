import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, createPublicKey, verify, createHash } from 'node:crypto';
import { b58, ata, MINT } from '../src/holders.js';
import { base58decode } from '../src/auth.js';
const P = await import('../src/payout.js');
const { webhook, cron: botCron } = await import('../src/bot.js');

// Throwaway keys made here: no real wallet, no real money. The fake Solana below checks every signature it is sent.
const pair = () => { const k = generateKeyPairSync('ed25519'); const seed = k.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), pub = k.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32); return { seed, pub, addr: b58(pub) } };
const PRIZE = pair(), A = pair(), B = pair(), C = pair();
const KEY = b58(Buffer.concat([PRIZE.seed, PRIZE.pub]));
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', HASH = b58(Buffer.alloc(32, 7)), hashes = new Set([HASH]);
let nHash = 0;

// ---- a fake Solana RPC ----
const sol = { lamports: 1_000_000_000n, cw: 50_000_000_000_000n, accounts: new Set(), sent: [], sims: 0, height: 100, status: new Map(), refuse: false, failOnChain: false };
function readTx(b64) {   // signatures, message, account keys and instructions of a legacy transaction
  const u = Buffer.from(b64, 'base64'); let o = 0; const c16 = () => { let v = 0, s = 0; for (; ;) { const b = u[o++]; v |= (b & 0x7f) << s; if (!(b & 0x80)) return v; s += 7 } };
  const ns = c16(), sigs = []; for (let i = 0; i < ns; i++) { sigs.push(u.subarray(o, o + 64)); o += 64 }
  const msg = u.subarray(o), head = [u[o], u[o + 1], u[o + 2]]; o += 3;
  const nk = c16(), keys = []; for (let i = 0; i < nk; i++) { keys.push(b58(u.subarray(o, o + 32))); o += 32 }
  const blockhash = b58(u.subarray(o, o + 32)); o += 32;
  const ni = c16(), ixs = []; for (let i = 0; i < ni; i++) { const p = u[o++], na = c16(), acc = [...u.subarray(o, o + na)]; o += na; const nd = c16(), d = [...u.subarray(o, o + nd)]; o += nd; ixs.push({ p: keys[p], acc: acc.map(a => keys[a]), d }) }
  return { sigs, msg, head, keys, blockhash, ixs };
}
const spki = pub => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]), format: 'der', type: 'spki' });
const sigOk = t => verify(null, t.msg, spki(base58decode(t.keys[0])), t.sigs[0]);
const u64 = d => d.reduce((a, b, i) => a + (BigInt(b) << BigInt(8 * i)), 0n);
const tgSent = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.telegram.org')) { tgSent.push({ method: String(url).split('/').pop(), ...JSON.parse(init.body) }); return Response.json({ ok: true, result: {} }) }
  const { method, params } = JSON.parse(init.body), ok = result => Response.json({ jsonrpc: '2.0', id: 1, result }), err = message => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32002, message } });
  if (method === 'getAccountInfo') return ok({ value: { owner: TOKEN } });
  if (method === 'getTokenSupply') return ok({ value: { decimals: 6 } });
  if (method === 'getBalance') return ok({ value: Number(sol.lamports) });
  if (method === 'getTokenAccountsByOwner') return ok({ value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(sol.cw) } } } } } }] });
  if (method === 'getMultipleAccounts') return ok({ value: params[0].map(a => sol.accounts.has(a) ? { lamports: 1 } : null) });
  if (method === 'getLatestBlockhash') { const h = b58(Buffer.alloc(32, 10 + (nHash++ % 200))); hashes.add(h); return ok({ value: { blockhash: h, lastValidBlockHeight: sol.height + 150 } }) }   // a new one each time, like Solana
  if (method === 'getBlockHeight') return ok(sol.height);
  if (method === 'getSignatureStatuses') return ok({ value: params[0].map(s => sol.status.get(s) || null) });
  const t = readTx(params[0]);
  if (method === 'simulateTransaction') { sol.sims++; return ok({ value: { err: sigOk(t) && hashes.has(t.blockhash) ? null : 'SignatureFailure' } }) }
  if (method === 'sendTransaction') {
    assert.ok(sigOk(t), 'every transaction sent is signed by the prize wallet');
    if (sol.refuse) return err('Transaction simulation failed: insufficient funds');
    const sig = b58(t.sigs[0]); if (!sol.sent.some(x => x.sig === sig)) sol.sent.push({ sig, t });
    sol.status.set(sig, sol.failOnChain ? { err: { InstructionError: [2, 'Custom'] }, confirmationStatus: 'confirmed' } : { err: null, confirmationStatus: 'confirmed' });
    return ok(sig);
  }
  return err('unknown method ' + method);
};

function makeEnv(extra = {}) {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { const r = []; for (const s of l) r.push(await s.run()); return r } };
  return { DB, sql, SOLANA_RPC: 'https://rpc.test/', PRIZE_WALLET_KEY: KEY, _payPoll: 0, _payWait: 50, ...extra };
}
const codeOf = t => t.match(/\/pay send (\d+) (\d{4})/).slice(1);
const told = [], tell = async (chat, text) => { told.push({ chat, text }) };
const reset = () => { Object.assign(sol, { lamports: 1_000_000_000n, cw: 50_000_000_000_000n, sims: 0, refuse: false, failOnChain: false }); sol.accounts.clear(); sol.sent.length = 0; sol.status.clear(); told.length = 0 };

test('payout: the key reads in both export formats, and a key whose halves do not match is refused', async () => {
  const k = P.parseKey(KEY), j = P.parseKey(JSON.stringify([...PRIZE.seed, ...PRIZE.pub]));
  assert.deepEqual([...k.pub], [...PRIZE.pub]); assert.deepEqual([...j.seed], [...PRIZE.seed]);
  assert.throws(() => P.parseKey(''), /missing/); assert.throws(() => P.parseKey('abc'), /64-byte/);
  assert.equal((await P.signer({ PRIZE_WALLET_KEY: KEY })).address, PRIZE.addr);
  await assert.rejects(P.signer({ PRIZE_WALLET_KEY: b58(Buffer.concat([PRIZE.seed, A.pub])) }), /does not match/);
  assert.equal(P.units('0.2', 9), 200_000_000n); assert.equal(P.units('1.5', 6), 1_500_000n); assert.equal(P.units('0.0000000001', 9), null); assert.equal(P.units('-1', 9), null);
  assert.equal(P.show(1_234_567_890_000n, 6), '1,234,567.89'); assert.equal(P.show(200_000_000n, 9), '0.2');
});

test('payout: a SOL transfer is a valid signed Solana transaction with the accounts in the right order', async () => {
  const w = await P.signer({ PRIZE_WALLET_KEY: KEY });
  const { sig, tx } = await P.signTx(w, [P.ix.limit(), P.ix.price(), P.ix.sol(w.address, A.addr, 200_000_000n)], HASH), t = readTx(tx);
  assert.ok(sigOk(t)); assert.equal(b58(t.sigs[0]), sig);
  assert.deepEqual(t.head, [1, 0, 2]);                                       // one signer, two read-only programs
  assert.deepEqual(t.keys, [PRIZE.addr, A.addr, 'ComputeBudget111111111111111111111111111111', '11111111111111111111111111111111']);
  assert.deepEqual(t.ixs[2].acc, [PRIZE.addr, A.addr]); assert.deepEqual(t.ixs[2].d.slice(0, 4), [2, 0, 0, 0]); assert.equal(u64(t.ixs[2].d.slice(4)), 200_000_000n);
  assert.deepEqual(t.ixs[0].d, [2, 0x80, 0x38, 0x01, 0x00]);                 // 80,000 compute units
});

test('payout: list lines are checked before anything is saved', async () => {
  const r = P.parseLines(`${A.addr} 0.2 SOL MARKOKUCA\n${B.addr},150000\n\n${C.addr} 2500 $CWORM Pop Corn`, 6);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.lines.map(l => [l.wallet, l.asset, l.amount, l.note]), [[A.addr, 'SOL', '200000000', 'MARKOKUCA'], [B.addr, 'CWORM', '150000000000', ''], [C.addr, 'CWORM', '2500000000', 'Pop Corn']]);
  assert.match(P.parseLines(`${A.addr} 1,000 CWORM`, 6).errors[0], /without commas/);   // never read as 1
  assert.match(P.parseLines(`${A.addr} 0,2 SOL`, 6).errors[0], /without commas/);
  assert.match(P.parseLines('hello 1 SOL', 6).errors[0], /not a Solana address/);
  assert.match(P.parseLines(`${await ata(A.addr, TOKEN)} 1 SOL`, 6).errors[0], /program address/);   // a token account, not a wallet
  assert.match(P.parseLines(`${A.addr} zero SOL`, 6).errors[0], /bad amount/);
  assert.match(P.parseLines(`${A.addr} 0 SOL`, 6).errors[0], /bad amount/);
  assert.match(P.parseLines(`${A.addr} 0.1 SOL\n${A.addr} 0.2 SOL`, 6).errors[0], /twice/);
  assert.match(P.parseLines(Array.from({ length: 26 }, () => `${pair().addr} 0.01 SOL`).join('\n'), 6).errors[0], /at most 25/);
});

test('payout: /pay new shows a dry run and a code; only the right code sends; the cron pays and answers with Solscan links', async () => {
  reset(); const env = makeEnv(); sol.accounts.add(await ata(B.addr, TOKEN));   // B already has a $CWORM account, C does not
  const shown = await P.command(env, `new Beta giveaway\n${A.addr} 0.2 SOL MARKOKUCA\n${B.addr} 150000 CWORM Harry\n${C.addr} 2500`, 77, null, 9);
  assert.match(shown, /Batch 1: Beta giveaway {2}\(ready\)/); assert.match(shown, new RegExp('From the prize wallet ' + PRIZE.addr));
  assert.match(shown, /To send: 3 transfers, 0\.2 SOL, 152,500 \$CWORM/);
  assert.match(shown, /incl\. 1 new token account/); assert.match(shown, /Dry run on Solana passed/);
  assert.equal(sol.sims, 3); assert.equal(sol.sent.length, 0);                // shown, simulated, nothing sent
  const [id, code] = codeOf(shown);
  assert.match(await P.command(env, `send ${id} ${code === '1234' ? '4321' : '1234'}`, 77, null, 9), /Wrong code/);
  await P.cron(env, tell); assert.equal(sol.sent.length, 0);                 // not approved: the cron does nothing
  assert.match(await P.command(env, `send ${id} ${code}`, 77, null, 9), /approved/);
  assert.match(await P.command(env, `send ${id} ${code}`, 77, null, 9), /approved|nothing to approve/);
  await P.cron(env, tell);
  assert.equal(sol.sent.length, 3); assert.equal(told.length, 1); assert.equal(told[0].chat, 9);
  assert.match(told[0].text, /✅ all sent/); assert.equal(told[0].text.match(/https:\/\/solscan\.io\/tx\/\w+/g).length, 3);
  const [s1, s2, s3] = sol.sent.map(x => x.t);
  assert.deepEqual(s1.ixs[2].acc, [PRIZE.addr, A.addr]); assert.equal(u64(s1.ixs[2].d.slice(4)), 200_000_000n);
  const from = await ata(PRIZE.addr, TOKEN), toB = await ata(B.addr, TOKEN), toC = await ata(C.addr, TOKEN);
  assert.equal(s2.ixs[2].p, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'); assert.deepEqual(s2.ixs[2].d, [1]);   // create-if-missing, harmless when it exists
  assert.deepEqual(s2.ixs[3].acc, [from, MINT, toB, PRIZE.addr]); assert.equal(s2.ixs[3].d[0], 12); assert.equal(u64(s2.ixs[3].d.slice(1, 9)), 150_000_000_000n); assert.equal(s2.ixs[3].d[9], 6);
  assert.deepEqual(s3.ixs[2].acc.slice(0, 4), [PRIZE.addr, toC, C.addr, MINT]); assert.equal(u64(s3.ixs[3].d.slice(1, 9)), 2_500_000_000n);
  assert.equal(env.sql.prepare('SELECT status FROM pay_batch WHERE id = ?').get(id).status, 'done');
  assert.equal(env.sql.prepare("SELECT COUNT(*) AS n FROM pay_line WHERE batch = ? AND status = 'sent' AND sig IS NOT NULL").get(id).n, 3);
  await P.cron(env, tell); assert.equal(sol.sent.length, 3);                 // done: never sent twice
  assert.match(await P.command(env, `send ${id} ${code}`, 77, null, 9), /is done/);
  assert.match(await P.command(env, '', 77, null, 9), /#1 Beta giveaway · 3 payments · done/);
});

test('payout: a batch the wallet cannot cover, or over the limit, is not ready and is never sent', async () => {
  reset(); sol.lamports = 100_000_000n; const env = makeEnv();
  const t = await P.command(env, `new Too big\n${A.addr} 0.2 SOL`, 77, null, 9);
  assert.match(t, /Not ready/); assert.match(t, /has 0\.1 SOL and needs 0\.200013/); assert.doesNotMatch(t, /\/pay send/);
  const code = env.sql.prepare('SELECT code FROM pay_batch WHERE id = 1').get().code;
  assert.match(await P.command(env, `send 1 ${code}`, 77, null, 9), /approved/);   // even approved by hand
  await P.cron(env, tell); assert.equal(sol.sent.length, 0); assert.match(told[0].text, /Nothing more sent/);
  assert.equal(env.sql.prepare('SELECT status FROM pay_batch WHERE id = 1').get().status, 'ready');
  reset(); const env2 = makeEnv({ PAY_MAX_SOL: '0.5' });
  assert.match(await P.command(env2, `new Limit\n${A.addr} 0.3 SOL\n${B.addr} 0.3 SOL`, 77, null, 9), /more than the 0\.5 SOL a batch may send/);
  assert.match(await P.command(env2, 'cancel 1', 77, null, 9), /cancelled/);
  assert.match(await P.command(env2, 'send 1 0000', 77, null, 9), /Wrong code|cancelled/);
});

test('payout: a retry checks Solana first and sends only what never went out', async () => {
  reset(); const env = makeEnv();
  const [id, code] = codeOf(await P.command(env, `new Retry\n${A.addr} 0.1 SOL\n${B.addr} 0.1 SOL\n${C.addr} 0.1 SOL`, 77, null, 9));
  await P.approve(env, id, code, 9); await P.cron(env, tell); assert.equal(sol.sent.length, 3);
  // as if the run had died: line 1 landed, line 2's transaction never did and its blockhash expired, line 3 refused before it went out
  const lines = env.sql.prepare('SELECT * FROM pay_line WHERE batch = ? ORDER BY n').all(id);
  sol.status.delete(lines[1].sig); env.sql.prepare("UPDATE pay_line SET status = 'sending' WHERE batch = ? AND n IN (0, 1)").run(id);
  env.sql.prepare("UPDATE pay_line SET status = 'failed', err = 'x' WHERE batch = ? AND n = 2").run(id);
  env.sql.prepare("UPDATE pay_batch SET status = 'partial' WHERE id = ?").run(id); sol.height = lines[1].lvbh + 1;
  const before = sol.sent.length; await P.approve(env, id, code, 9); await P.cron(env, tell);
  assert.equal(sol.sent.length - before, 2);                                 // lines 2 and 3 again, line 1 not
  assert.deepEqual(sol.sent.slice(before).map(x => x.t.ixs[2].acc[1]), [B.addr, C.addr]);
  assert.match(told.at(-1).text, /✅ all sent/);
  // a long run stops between lines and the next minute's cron carries on with the same OK, never sending a line twice
  reset(); const env3 = makeEnv({ _payBudget: -1 });
  const [id3, code3] = codeOf(await P.command(env3, `new Long\n${A.addr} 0.1 SOL\n${B.addr} 0.1 SOL`, 77, null, 9));
  await P.approve(env3, id3, code3, 9); await P.cron(env3, tell);
  assert.equal(sol.sent.length, 0); assert.equal(told.length, 0); assert.equal(env3.sql.prepare('SELECT status FROM pay_batch WHERE id = ?').get(id3).status, 'approved');
  env3._payBudget = 60e3; await P.cron(env3, tell); assert.equal(sol.sent.length, 2); assert.match(told[0].text, /✅ all sent/);
  // a line still in flight (blockhash not expired, not seen yet) is held, never sent twice
  reset(); sol.height = 100; const env2 = makeEnv();
  const [id2, code2] = codeOf(await P.command(env2, `new Hold\n${A.addr} 0.1 SOL`, 77, null, 9));
  env2.sql.prepare("UPDATE pay_line SET status = 'sending', sig = ?, lvbh = 250 WHERE batch = ?").run(b58(Buffer.alloc(64, 3)), id2);
  await P.approve(env2, id2, code2, 9); await P.cron(env2, tell);
  assert.equal(sol.sent.length, 0); assert.match(told[0].text, /1 not confirmed yet/);
  assert.equal(env2.sql.prepare('SELECT status FROM pay_batch WHERE id = ?').get(id2).status, 'partial');
});

test('payout: a transfer refused by Solana or failed on chain is marked failed, not sent', async () => {
  reset(); const env = makeEnv();
  let [id, code] = codeOf(await P.command(env, `new Refused\n${A.addr} 0.1 SOL`, 77, null, 9));
  sol.refuse = true; await P.approve(env, id, code, 9); await P.cron(env, tell);
  assert.match(told[0].text, /❌ Transaction simulation failed: insufficient funds\n/); assert.match(told[0].text, /1 failed \(nothing moved\)/); assert.equal(sol.sent.length, 0);
  reset(); const env2 = makeEnv();
  [id, code] = codeOf(await P.command(env2, `new On chain\n${A.addr} 0.1 SOL`, 77, null, 9));
  sol.failOnChain = true; await P.approve(env2, id, code, 9); await P.cron(env2, tell);
  assert.equal(env2.sql.prepare('SELECT status FROM pay_line WHERE batch = ?').get(id).status, 'failed');
  assert.match(told[0].text, /❌ \{"InstructionError"/);
});

test('payout: without the key nothing runs, and /pay says the wallet is not set up', async () => {
  reset(); const env = makeEnv({ PRIZE_WALLET_KEY: '' });
  assert.match(await P.command(env, '', 77, null, 9), /not set up/);
  const t = await P.command(env, `new No key\n${A.addr} 0.1 SOL`, 77, null, 9);
  assert.match(t, /can't be read/);
  env.sql.prepare("UPDATE pay_batch SET status = 'approved'").run();
  await P.cron(env, tell); assert.equal(sol.sent.length, 0); assert.equal(told.length, 0);
});

test('payout: /pay prize makes a batch from last week\'s winners at today\'s price', async () => {
  reset(); const env = makeEnv(); sol.accounts.add(await ata(A.addr, TOKEN)); sol.accounts.add(await ata(B.addr, TOKEN));
  const list = async () => ({ week: Date.UTC(2026, 10, 2), winners: [{ wallet: A.addr, cworm: 2_100_000, place: 1, name: 'Harry' }, { wallet: B.addr, cworm: 1_400_000, place: 2, name: 'Pop Corn' }] });
  const t = await P.command(env, 'prize', 77, list, 9);
  assert.match(t, /Weekly prize, week of 2026-11-02/); assert.match(t, /2,100,000 \$CWORM  · #1 Harry/); assert.match(t, /To send: 2 transfers, 3,500,000 \$CWORM/);
  assert.match(await P.command(env, 'prize', 77, async () => ({ week: 0, winners: [] }), 9), /No weekly prize winners/);
  assert.match(await P.command(env, 'prize', 77, async () => ({ week: 0, winners: [{ wallet: A.addr, cworm: null }] }), 9), /price could not be read/);
});

test('payout: the bot answers /pay only for admins in a private chat, keeps the list lines, and the minute cron sends', async () => {
  reset(); const env = makeEnv({ BOT_TOKEN: '1:B', SESSION_SECRET: 's', ADMIN_PLAYERS: '1' });
  env.sql.prepare("INSERT INTO players (id, name, created, tg_id) VALUES (1, 'Damian', 0, 500), (2, 'Bo', 0, 600)").run();
  const secret = createHash('sha256').update('webhook:s').digest('hex').slice(0, 48);
  const say = (from, text, type = 'private') => webhook(new Request('https://w/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ message: { chat: { id: from, type }, from: { id: from, first_name: 'X' }, text } }) }), env);
  tgSent.length = 0; await say(600, `/pay new Sneaky\n${A.addr} 1 SOL`);
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM pay_batch').get().n, 0); assert.doesNotMatch(tgSent.map(m => m.text).join(), /Batch/);
  await say(500, `/pay new Beta giveaway\n${A.addr} 0.2 SOL MARKOKUCA\n${B.addr} 0.2 SOL Harry`, 'group');
  assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM pay_batch').get().n, 0);
  tgSent.length = 0; await say(500, `/pay new Beta giveaway\n${A.addr} 0.2 SOL MARKOKUCA\n${B.addr} 0.2 SOL Harry`);
  const shown = tgSent.at(-1); assert.equal(shown.chat_id, 500); assert.equal(shown.disable_web_page_preview, true);
  assert.match(shown.text, /Batch 1: Beta giveaway/); assert.match(shown.text, /1\. .* 0\.2 SOL  · MARKOKUCA\n2\. .* 0\.2 SOL  · Harry/);
  const [id, code] = codeOf(shown.text);
  tgSent.length = 0; await say(500, `/pay send ${id} ${code}`); assert.match(tgSent.at(-1).text, /approved/);
  tgSent.length = 0; await botCron(env, Date.UTC(2026, 10, 3, 12, 1));
  assert.equal(sol.sent.length, 2); const receipt = tgSent.find(m => /all sent/.test(m.text || ''));
  assert.equal(receipt.chat_id, 500); assert.equal(receipt.text.match(/solscan\.io\/tx\//g).length, 2);
});
