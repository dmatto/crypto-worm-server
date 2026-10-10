// One Durable Object per match. It seats two players, passes each message on to the other phone, and keeps track of
// which phone is running the match (the "authority": the owner of the team whose turn it is). Only that phone may send
// match updates ('f') or hand the match over ('auth'). The last handed-over state is kept so a dropped phone can rejoin.
//
// Messages are the ones the game already speaks (see NET in crypto-worm.html):
//   host / join {hat}           a seat is ready            start {seed,theme,count,hats}   seat 0 starts the match
//   start {..., bot:{name,cc,team}}  a match against one of the game's bots: seat 0's phone runs both teams and streams
//                               it so it can be watched; no second seat, nothing is recorded
//   f {e,s}                     effects and state, ~20/s   auth {e,s}                      turn over, other phone takes over
//   bye                         a player left
//   skip                        the waiting phone asks to take over because the phone running the turn went quiet
//                               (closed or minimised app): allowed after SKIP_MS of silence from it
// The server adds: took {} to the phone that took over and lost {} to the quiet one, seat {side}, resume {start,side,auth,s,carves}, back {side}, gone {side}, over {winner,reason},
// flags {cc:[country,country]} (two-letter codes from Cloudflare, null when unknown) to both phones whenever one connects.
//
// Viewers (GET /match/<code>/watch) watch a match live without playing. They get watch {start,s,carves,names,cc,viewers}
// (or wait {} until the match starts, then watch), every f and auth the players send, chat {id,side}, over, and
// viewers {n} whenever someone starts or stops watching (the players get viewers {n} too). The only thing a viewer can send
// is cheer {id}: one of the game's six cheer emojis, at most one every 0.7 s, shown to everyone in the match.
// A started match is listed in the lobby's Live now list until it ends.

const MAX_MSG = 64 * 1024, IDLE_MS = 90 * 1000, SKIP_MS = 7000, MAX_VIEWERS = 500, CHEERS = 6, CHEER_GAP_MS = 700;

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
  viewers() { return this.ctx.getWebSockets('v') }
  spread(msg, players) {                                              // to every viewer (and both players when asked)
    const out = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const ws of [...this.viewers(), ...(players ? [this.sock(0), this.sock(1)] : [])]) if (ws) try { ws.send(out) } catch { }
  }
  watchMsg(m) { return { t: 'watch', start: m.start, s: m.state, carves: m.carves, names: m.names || [null, null], cc: m.cc || [null, null], viewers: this.viewers().length } }
  countViewers(gone) {                                                // tell everyone, and keep the Live now list roughly up to date
    const n = this.viewers().filter(w => w !== gone).length; this.spread({ t: 'viewers', n }, true);
    const m = this.mem; if (m && m.start && !m.done && Date.now() - (this.liveAt || 0) > 5000) { this.liveAt = Date.now(); this.live({ viewers: n }) }
  }
  // The lobby's Live now list: add (or update) this match when it starts, take it off when it ends.
  live(extra, gone) {
    const m = this.mem, code = this.code || (m && m.code); if (!this.env.LOBBY || !code) return;
    const body = gone ? { code, gone: true } : { code, names: m.names || [null, null], cc: m.cc || [null, null], ids: m.players, at: m.start && m.start.at, ...extra };
    const p = this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby')).fetch('https://lobby/live', { method: 'POST', body: JSON.stringify(body) }).catch(() => { });
    if (this.ctx.waitUntil) this.ctx.waitUntil(p); return p;
  }
  async watch(m) {
    if (this.viewers().length >= MAX_VIEWERS) return new Response('too many viewers', { status: 503 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ['v']);
    pair[1].send(JSON.stringify(m.start ? this.watchMsg(m) : { t: 'wait' }));
    this.countViewers();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async names(m) {                                                    // the players' nicknames, for viewers and the Live now list
    if (!this.env.DB || m.players[0] == null) return;
    try { const r = await this.env.DB.prepare('SELECT id, name FROM players WHERE id IN (?, ?)').bind(m.players[0], m.players[1]).all();
      const by = new Map((r.results || []).map(p => [p.id, p.name])); m.names = m.players.map(id => id == null ? null : by.get(id) || null) } catch { }
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 });
    const m = await this.load(), url = new URL(req.url), player = Number(req.headers.get('x-player'));
    const code = url.pathname.split('/')[2]; if (code && !m.code) { m.code = code; await this.save() } this.code = m.code;
    if (m.done) return new Response('match is over', { status: 410 });
    if (url.pathname.endsWith('/watch')) return this.watch(m);
    let side = m.players.indexOf(player);
    if (side < 0 && m.bot) return new Response('match is full', { status: 409 });   // a match against a bot has one seat
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
    const m = await this.load(), tag = this.ctx.getTags(ws)[0], side = Number(tag); this.code = m.code;
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    let msg; try { msg = JSON.parse(raw) } catch { return }
    if (!msg || typeof msg.t !== 'string') return;
    if (tag === 'v') {                                                // a viewer: cheers only
      const id = msg.id, now = Date.now(); this.cheerAt = this.cheerAt || new WeakMap();
      if (msg.t !== 'cheer' || !m.start || m.done || !Number.isInteger(id) || id < 0 || id >= CHEERS || now - (this.cheerAt.get(ws) || 0) < CHEER_GAP_MS) return;
      this.cheerAt.set(ws, now); this.spread({ t: 'cheer', id }, true); return;
    }
    m.last = Date.now(); this.heard = this.heard || [0, 0];
    if (side === m.holder) this.heard[side] = m.last;
    switch (msg.t) {
      case 'host': case 'join': this.tell(1 - side, raw); break;
      case 'start':
        if (side !== 0 || m.start) return;
        m.start = { seed: msg.seed | 0, theme: String(msg.theme).slice(0, 20), count: Math.min(3, Math.max(1, msg.count | 0)), hats: (msg.hats || []).slice(0, 2).map(h => String(h).slice(0, 20)) };
        m.holder = 0; await this.names(m);
        if (msg.bot && typeof msg.bot === 'object') {                 // vs a bot: the bot's name and country, on the team it plays
          const bt = msg.bot.team === 0 ? 0 : 1, cc = String(msg.bot.cc || '').toUpperCase(); m.bot = true;
          m.names = m.names || [null, null]; m.cc = m.cc || [null, null];
          if (bt === 0) { m.names = [m.names[1], m.names[0]]; m.cc = [m.cc[1], m.cc[0]] }
          m.names[bt] = String(msg.bot.name || 'Worm').slice(0, 24); m.cc[bt] = /^[A-Z]{2}$/.test(cc) ? cc : null;
        }
        m.start.at = Date.now(); await this.save(); this.tell(1, { t: 'start', ...m.start });
        this.spread(this.watchMsg(m)); await this.live({ viewers: this.viewers().length }); break;
      case 'f':
        if (side !== m.holder || !m.start) return;
        this.tell(1 - side, raw); this.spread(raw); this.keepCarves(msg.e);
        const over = Array.isArray(msg.e) && msg.e.find(e => Array.isArray(e) && e[0] === 'gameOver');
        if (over) await this.finish(Array.isArray(over[1]) ? over[1][0] : -1, 'played');
        break;
      case 'auth':
        if (side !== m.holder || !m.start) return;
        this.keepCarves(msg.e); m.holder = 1 - side; this.heard[m.holder] = Date.now(); m.state = msg.s || null; await this.save(); this.tell(1 - side, raw); this.spread(raw); break;
      case 'skip': {                                  // the game never waits for a player who left the app: the other phone takes the turn over
        if (!m.start || m.done || side === m.holder) return;
        const quiet = this.heard[m.holder]; if (!quiet) { this.heard[m.holder] = Date.now(); return }   // just woke up: start counting now
        if (Date.now() - quiet < SKIP_MS) return;
        const away = m.holder; m.holder = side; this.heard[side] = Date.now(); await this.save();
        this.tell(away, { t: 'lost' }); this.tell(side, { t: 'took' }); break;
      }
      case 'chat': {                                  // quick chat: only a line number from the game's fixed list, at most one every 1.5 s
        const id = msg.id, now = Date.now(); this.chatAt = this.chatAt || [0, 0];
        if (!m.start || !Number.isInteger(id) || id < 0 || id > 63 || now - this.chatAt[side] < 1500) return;
        this.chatAt[side] = now; this.tell(1 - side, { t: 'chat', id }); this.spread({ t: 'chat', id, side }); break;
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

  async webSocketClose(ws) { const tag = this.ctx.getTags(ws)[0]; await this.load(); this.code = this.mem.code;
    if (tag === 'v') return this.countViewers(ws);
    const side = Number(tag); this.tell(1 - side, { t: 'gone', side }) }
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
    this.spread({ t: 'over', winner, reason }); await this.live(null, true);
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
