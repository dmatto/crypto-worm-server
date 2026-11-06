// Tries the load test on this computer: starts the match server (tools/local-server.mjs) and runs the simulated players
// against it with in-memory Durable Objects, faster than real time.
//   node tools/sim-local.mjs [bots=12] [seconds=90] [speed=10] [life|rush]
// Prints the load test's numbers every 10 seconds, then what the match server stored. Needs Node 22+.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [BOTS = 12, SECS = 90, SPEED = 10] = process.argv.slice(2, 5).map(Number), MODE = process.argv[5] || 'life', PORT = 8799, KEY = 'local-sim-key-' + Math.random().toString(36).slice(2);
const server = spawn(process.execPath, [new URL('./local-server.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: String(PORT), SIM_KEY: KEY }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => server.stdout.once('data', r));
process.on('exit', () => server.kill());

const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
const DB = { prepare: q => stmt(q), batch: async l => Promise.all(l.map(s => s.run())) };

// the service binding: HTTP straight to the local server, WebSockets through Node's own client
function socket(url) {
  const ws = new WebSocket(url), q = []; let open = false;
  ws.addEventListener('open', () => { open = true; for (const m of q) ws.send(m); q.length = 0 });
  return { accept() { }, send(m) { if (open) ws.send(m); else q.push(m) }, close(c, r) { try { ws.close(c, r) } catch (e) { } }, addEventListener: (t, f) => ws.addEventListener(t, f) };
}
const GAME = { fetch: async (u, init = {}) => {
  const url = new URL(u); url.host = '127.0.0.1:' + PORT; url.protocol = 'http:';
  if ((init.headers || {}).Upgrade === 'websocket') { url.protocol = 'ws:'; return { status: 101, webSocket: socket(url.toString()) } }
  return fetch(url, init);
} };
function ns(Cls, env) {
  const live = new Map();
  return { idFromName: n => n, get(name) {
    if (!live.has(name)) {
      const store = new Map(); let alarm = null;
      const ctx = { storage: { get: async k => store.has(k) ? structuredClone(store.get(k)) : undefined, put: async (k, v) => void store.set(k, structuredClone(v)), delete: async k => void store.delete(k),
        setAlarm: async t => { clearTimeout(alarm); alarm = setTimeout(() => obj.alarm(), Math.max(0, t - Date.now())) }, getAlarm: async () => null } };
      const obj = new Cls(ctx, env); live.set(name, obj);
    }
    const obj = live.get(name); return { fetch: (u, i) => obj.fetch(new Request(u, i)) };
  } };
}
const { Fleet, Control } = await import('../sim/index.js');
const env = { DB, GAME, SIM_KEY: KEY, SIM_SPEED: String(SPEED) };
env.FLEET = ns(Fleet, env); env.CONTROL = ns(Control, env);
const control = env.CONTROL.get('control');

await DB.prepare('INSERT INTO sim_cmd (cmd, arg, at) VALUES (?, ?, ?)').bind('life', BOTS, Date.now()).run();
const t0 = Date.now(), show = r => console.log(`${Math.round((Date.now() - t0) / 1000)}s  bots online ${r.online} (match ${r.inMatch}, map ${r.inBattle}, offline ${r.inGame})  server online ${r.serverOnline}  req/min ${r.rpm}  p50 ${r.p50} p95 ${r.p95} ms  err ${r.errPct}%  rejected ${r.rej}  limited ${r.lim}  msgs/s ${r.msgsPerSec}  relay ${r.relay50}/${r.relay95} ms  matches ${r.matchesPerMin}  attacks ${r.attacksPerMin}  signups ${r.signups}${r.errors.length ? '\n    ' + r.errors.join('\n    ') : ''}`);
const first = await (await control.fetch('https://control/tick')).json(); show(first);
// a faster "life": sessions start within a few seconds instead of half an hour
await control.fetch('https://control/order', { method: 'POST', body: JSON.stringify({ cmd: 'life', arg: BOTS }) });
if (MODE === 'rush') await control.fetch('https://control/order', { method: 'POST', body: JSON.stringify({ cmd: 'rush', arg: 5 }) });
for (let s = 10; s <= SECS; s += 10) { await new Promise(r => setTimeout(r, 10000)); show(await (await control.fetch('https://control/tick')).json()) }
await control.fetch('https://control/order', { method: 'POST', body: JSON.stringify({ cmd: 'off' }) });
await new Promise(r => setTimeout(r, 3000));
const st = await (await control.fetch('https://control/state')).json();
console.log('history points', st.hist.length, 'last', JSON.stringify(st.hist.at(-1)).slice(0, 400));
const g = async p => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
console.log('server /online', JSON.stringify(await g('/online')), '/stats', JSON.stringify(await g('/stats')));
process.exit(0);
