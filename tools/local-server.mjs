// Runs the match server on this computer without Cloudflare, for trying online play with two browser tabs:
//   node tools/local-server.mjs            (then open the game with ?server=http://127.0.0.1:8787&match=NEW)
// Stand-ins: node:sqlite for D1, in-memory Durable Objects, and a tiny WebSocket server. Needs Node 22+.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT || 8787);

// ---- D1 stand-in
const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const stmt = (q, args = []) => ({
  bind: (...a) => stmt(q, a),
  first: async () => sql.prepare(q).get(...args) ?? null,
  run: async () => sql.prepare(q).run(...args),
  all: async () => ({ results: sql.prepare(q).all(...args) }),
});
const DB = { prepare: q => stmt(q), batch: async list => Promise.all(list.map(s => s.run())) };

// ---- Workers runtime stand-ins
// The match greets a socket before the upgrade finishes, so messages wait in `early` until the socket is wired up.
class ServerSide {
  constructor() { this.tags = []; this.sock = null; this.early = [] }
  send(m) { if (this.sock) wsSend(this.sock, m); else this.early.push(m) }
  close() { this.closed = true; if (this.sock) this.sock.end() }
}
globalThis.WebSocketPair = class { constructor() { const s = new ServerSide(); this[0] = { peer: s }; this[1] = s } };
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse {
  constructor(body, init = {}) { super(body, init.status === 101 ? { status: 200 } : init); this.ws = init.webSocket; this.upgraded = init.status === 101 }
  static json(b, i) { return new globalThis.Response(JSON.stringify(b), { ...i, headers: { 'content-type': 'application/json' } }) }
};
function namespace(Cls, env) {
  const live = new Map();
  return {
    idFromName: n => n,
    get(name) {
      if (!live.has(name)) {
        const socks = [], store = new Map();
        const ctx = {
          acceptWebSocket(ws, tags) { ws.tags = tags; ws.obj = obj; socks.push(ws) },
          getWebSockets: tag => socks.filter(w => w.sock && !w.closed && w.tags.includes(tag)),
          getTags: ws => ws.tags,
          storage: { get: async k => store.get(k), put: async (k, v) => void store.set(k, structuredClone(v)), delete: async k => void store.delete(k), setAlarm: async () => { } },
        };
        const obj = new Cls(ctx, env); live.set(name, obj);
      }
      const obj = live.get(name);
      return { fetch: (url, init) => obj.fetch(typeof url === 'string' ? new Request(url, init) : url) };
    },
  };
}

const { default: worker, Match, Lobby } = await import('../src/index.js');
const env = { DB, SESSION_SECRET: 'local-dev-secret', BOT_TOKEN: process.env.BOT_TOKEN || '', SIGNIN_DOMAIN: 'localhost', ALLOWED_ORIGINS: '*' };
env.MATCH = namespace(Match, env); env.LOBBY = namespace(Lobby, env);

// ---- tiny WebSocket server (text frames only)
function wsSend(sock, text) {
  const data = Buffer.from(text), n = data.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b })()]);
  sock.write(Buffer.concat([head, data]));
}
function wsFrames(sock, onText, onClose) {
  let buf = Buffer.alloc(0), parts = [];
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 15; let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), body = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { sock.end(); return }
      if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, body.length]), body])); continue }
      if (op === 1 || op === 0) { parts.push(body); if (fin) { onText(Buffer.concat(parts).toString()); parts = [] } }
    }
  });
  sock.on('close', onClose); sock.on('error', () => { });
}

const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request(`http://127.0.0.1:${PORT}${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
server.on('upgrade', async (req, sock) => {
  const r = await worker.fetch(new Request(`http://127.0.0.1:${PORT}${req.url}`, { headers: req.headers }), env);
  if (!r.upgraded) { sock.end(`HTTP/1.1 ${r.status} No\r\n\r\n`); return }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const side = r.ws.peer;
  side.sock = sock;
  for (const m of side.early) wsSend(sock, m);
  wsFrames(sock, text => side.obj.webSocketMessage(side, text), () => { side.closed = true; side.obj.webSocketClose(side) });
});

server.listen(PORT, '127.0.0.1', () => console.log(`match server on http://127.0.0.1:${PORT}`));
