// One Durable Object per match. It seats two players, passes each message on to the other phone, and keeps track of
// which phone is running the match (the "authority": the owner of the team whose turn it is). Only that phone may send
// match updates ('f') or hand the match over ('auth'). The last handed-over state is kept so a dropped phone can rejoin.
//
// Messages are the ones the game already speaks (see NET in crypto-worm.html):
//   host / join {hat}           a seat is ready            start {seed,theme,count,hats}   seat 0 starts the match
//   f {e,s}                     effects and state, ~20/s   auth {e,s}                      turn over, other phone takes over
//   bye                         a player left
// The server adds: seat {side}, resume {start,side,auth,s,carves}, back {side}, gone {side}, over {winner,reason},
// flags {cc:[country,country]} (two-letter codes from Cloudflare, null when unknown) to both phones whenever one connects.

const MAX_MSG = 64 * 1024, IDLE_MS = 90 * 1000;

export class Match {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.mem = null;                                                  // {players:[id,id], start, holder, state, last, done}
  }
  async load() {
    if (!this.mem) this.mem = (await this.ctx.storage.get('m')) || { players: [null, null], start: null, holder: 0, state: null, carves: [], last: Date.now(), done: null };
    return this.mem;
  }
  save() { return this.ctx.storage.put('m', this.mem) }
  sock(side) { return this.ctx.getWebSockets(String(side))[0] || null }
  tell(side, msg) { const ws = this.sock(side); if (ws) try { ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)) } catch { } }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 });
    const m = await this.load(), player = Number(req.headers.get('x-player'));
    if (m.done) return new Response('match is over', { status: 410 });
    let side = m.players.indexOf(player);
    if (side < 0) { side = m.players.indexOf(null); if (side < 0) return new Response('match is full', { status: 409 }); m.players[side] = player; await this.save() }
    const cc = String(req.headers.get('x-country') || '').toUpperCase(); m.cc = m.cc || [null, null];
    m.cc[side] = /^[A-Z]{2}$/.test(cc) && cc !== 'XX' ? cc : null; await this.save();
    const old = this.sock(side); if (old) try { old.close(4000, 'opened elsewhere') } catch { }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [String(side)]);
    pair[1].send(JSON.stringify(m.start ? { t: 'resume', side, start: m.start, auth: m.holder === side, s: m.state, carves: m.carves } : { t: 'seat', side }));
    if (m.start) this.tell(1 - side, { t: 'back', side });
    this.tell(0, { t: 'flags', cc: m.cc }); this.tell(1, { t: 'flags', cc: m.cc });
    m.last = Date.now(); await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    const m = await this.load(), side = Number(this.ctx.getTags(ws)[0]);
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    let msg; try { msg = JSON.parse(raw) } catch { return }
    if (!msg || typeof msg.t !== 'string') return;
    m.last = Date.now();
    switch (msg.t) {
      case 'host': case 'join': this.tell(1 - side, raw); break;
      case 'start':
        if (side !== 0 || m.start) return;
        m.start = { seed: msg.seed | 0, theme: String(msg.theme).slice(0, 20), count: Math.min(3, Math.max(1, msg.count | 0)), hats: (msg.hats || []).slice(0, 2).map(h => String(h).slice(0, 20)) };
        m.holder = 0; await this.save(); this.tell(1, { t: 'start', ...m.start }); break;
      case 'f':
        if (side !== m.holder || !m.start) return;
        this.tell(1 - side, raw); this.keepCarves(msg.e);
        const over = Array.isArray(msg.e) && msg.e.find(e => Array.isArray(e) && e[0] === 'gameOver');
        if (over) await this.finish(Array.isArray(over[1]) ? over[1][0] : -1, 'played');
        break;
      case 'auth':
        if (side !== m.holder || !m.start) return;
        this.keepCarves(msg.e); m.holder = 1 - side; m.state = msg.s || null; await this.save(); this.tell(1 - side, raw); break;
      case 'chat': {                                  // quick chat: only a line number from the game's fixed list, at most one every 1.5 s
        const id = msg.id, now = Date.now(); this.chatAt = this.chatAt || [0, 0];
        if (!m.start || !Number.isInteger(id) || id < 0 || id > 63 || now - this.chatAt[side] < 1500) return;
        this.chatAt[side] = now; this.tell(1 - side, { t: 'chat', id }); break;
      }
      case 'bye':
        this.tell(1 - side, raw);
        if (m.start && !m.done) await this.finish(1 - side, 'left');
        break;
    }
  }

  // Craters so far, so a phone that rejoins can rebuild the island: the match start plus every carve gives the terrain.
  keepCarves(events) {
    if (!Array.isArray(events)) return;
    for (const e of events) if (Array.isArray(e) && e[0] === 'carve' && Array.isArray(e[1]) && this.mem.carves.length < 20000) this.mem.carves.push(e[1].slice(0, 3).map(Number));
  }

  async webSocketClose(ws) { const side = Number(this.ctx.getTags(ws)[0]); this.tell(1 - side, { t: 'gone', side }) }
  async webSocketError(ws) { return this.webSocketClose(ws) }

  // Nobody has said anything for a while: the phone running the turn has gone quiet, so the other player wins.
  async alarm() {
    const m = await this.load(); if (m.done) return;
    if (Date.now() - m.last < IDLE_MS) { await this.ctx.storage.setAlarm(m.last + IDLE_MS); return }
    if (m.start) await this.finish(1 - m.holder, 'timeout');
  }

  async finish(winner, reason) {
    const m = this.mem; if (m.done) return;
    m.done = { winner, reason, at: Date.now() }; await this.save();
    for (const side of [0, 1]) this.tell(side, { t: 'over', winner, reason });
    if (this.env.DB && m.players[0] != null && m.players[1] != null && m.players[0] !== m.players[1]) {   // one account on both phones doesn't count
      const w = winner === 0 || winner === 1 ? m.players[winner] : null, l = w == null ? null : m.players[1 - winner];
      await this.env.DB.batch([
        this.env.DB.prepare('INSERT INTO matches (p0, p1, winner, reason, ended) VALUES (?, ?, ?, ?, ?)').bind(m.players[0], m.players[1], w, reason, Date.now()),
        ...(w != null ? [this.env.DB.prepare('UPDATE players SET wins = wins + 1 WHERE id = ?').bind(w), this.env.DB.prepare('UPDATE players SET losses = losses + 1 WHERE id = ?').bind(l)] : []),
      ]).catch(() => { });
    }
  }
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newCode() { const b = crypto.getRandomValues(new Uint8Array(6)); return [...b].map(x => CODE_CHARS[x % 32]).join('') }
