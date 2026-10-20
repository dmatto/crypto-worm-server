// Worm Royale rooms (Damian 2026-10-19: "a waiting lobby and if not fully populated within 2 minutes with real players
// complete the 50 with CPUs"). The lobby keeps one open room at a time (lobby.js royaleJoin), so everyone who taps Drop in
// lands in the same one. A room is one Durable Object: it seats players for WAIT_MS from the moment it opens (or until
// SEATS real players are in), then starts the match and the phones fill the empty seats with CPU worms. One phone runs the
// match, the host (the first player still connected), and sends frames ~15 times a second; the room passes them on to the
// other phones, and passes their orders (their own worm's moves and aim, the shot they lock) to the host. When the host
// leaves or goes quiet, the next phone takes over from what it already has.
//
//   client -> room   hi {hat}                  my look (hat|skin|trail|grave), sent when the socket opens
//                    cheer {id}                one of the game's six cheer emojis, at most one every 0.7 s
//                    f {n,e,s,k}               host only: a frame of the match; k marks a keyframe, kept for phones that come back
//                    o {...}                   anyone else: an order for the host (the room adds the sender's seat)
//                    out {place,kills}         my own worm is out (every phone reports its own place, checked against the host's)
//                    over {places,winner}      host only: the match is over, places = [[seat, place, kills], ...]
//                    handoff                   host only: I am leaving, give the match to the next phone
//                    bye                       I am leaving
//   room -> client   room {code,map,left,seats,me}       the waiting room (left = ms until the start)
//                    start {seed,map,seats,me,host,live} the match starts; {solo:true,map} when nobody else came
//                    resume {..start, key, ops}          back after a dropped connection: the last keyframe and the craters so far
//                    host {seat,live}                    this phone runs the match now
//                    f, o {seat,...}, cheer {id,seat}, gone {seat}, back {seat}, over {winner,places}
// A seat is {id, name, cc, tier, cw, av, hat}; in the match a seat's number is its worm's id on every phone (CPU worms
// take the numbers after the real players).
import { teamClash } from './teams.js';

const SEATS = 50, WAIT_MS = 120e3, MAX_MSG = 128 * 1024, HOST_QUIET_MS = 6000, IDLE_MS = 3 * 60e3, OPS_MAX = 20000, CHEERS = 6, CHEER_GAP_MS = 700, TICK_MS = 3000;
export const ROYALE_WAIT_MS = WAIT_MS;
const MAPS = ['01-sunset', '02-moonrise', '03-neon-city', '04-volcano', '05-aurora', '06-storm', '07-bull-run', '08-to-the-moon', '09-pirate-cove', '10-whale-bay'];
const country = c => { c = String(c || '').toUpperCase(); return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null };
const lobbyOf = env => env.LOBBY.get(env.LOBBY.idFromName('lobby'));

export class Royale {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.m = null; this.cheerAt = new Map(); this.seen = new Map(); this.heard = Date.now() }

  async load() {
    if (this.m) return this.m;
    const m = await this.ctx.storage.get('m'); if (!m) return null;
    m.key = (await this.ctx.storage.get('key')) || null; m.ops = (await this.ctx.storage.get('ops')) || [];
    return this.m = m;
  }
  save() { const { key, ops, ...m } = this.m; return this.ctx.storage.put('m', m) }
  saveKey() { return this.ctx.storage.put({ key: this.m.key, ops: this.m.ops }) }
  socks(id) { return this.ctx.getWebSockets('p' + id).filter(ws => ws.readyState == null || ws.readyState === 1) }
  sock(id) { return this.socks(id)[0] || null }
  tell(id, msg) { const ws = this.sock(id); if (ws) try { ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)) } catch { } return !!ws }
  all(msg, except) { const out = typeof msg === 'string' ? msg : JSON.stringify(msg); for (const ws of this.ctx.getWebSockets()) if (ws !== except) try { ws.send(out) } catch { } }
  seatOf(ws) { const t = (this.ctx.getTags(ws) || [])[0] || ''; return this.m ? this.m.seats.findIndex(s => 'p' + s.id === t) : -1 }
  live() { return this.m.seats.map((s, i) => this.sock(s.id) ? i : -1).filter(i => i >= 0) }
  pub() { return this.m.seats.map(({ id, name, cc, tier, cw, av, hat }) => ({ id, name, cc, tier, cw, av, hat })) }
  roomMsg(me) { const m = this.m; return { t: 'room', code: m.code, map: m.map, left: Math.max(0, m.startAt - Date.now()), seats: this.pub(), me } }
  sendRoom() { this.m.seats.forEach((s, i) => this.tell(s.id, this.roomMsg(i))) }
  startMsg(me) { const m = this.m; return { t: 'start', seed: m.seed, map: m.map, seats: this.pub(), me, host: m.host, live: this.live() } }
  // the lobby shows the open room on Home (players waiting, time left) and opens a new one once this one starts
  note() {
    const m = this.m; if (!this.env.LOBBY) return;
    const p = lobbyOf(this.env).fetch('https://lobby/royale/note', { method: 'POST', body: JSON.stringify({ code: m.code, n: m.seats.length, started: !!m.started || !!m.done }) }).catch(() => { });
    if (this.ctx.waitUntil) this.ctx.waitUntil(p);
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/open' && req.method === 'POST') {                   // the lobby opens this room
      const b = await req.json().catch(() => ({})); if (await this.load()) return Response.json({ ok: true });
      const code = String(b.code || '').slice(0, 6), startAt = Number(b.startAt) || Date.now() + WAIT_MS;
      this.m = { code, opened: Date.now(), startAt, map: MAPS[Math.floor(Math.random() * MAPS.length)], seed: crypto.getRandomValues(new Uint32Array(1))[0] >>> 1,
        seats: [], started: false, host: -1, done: null, places: {}, key: null, ops: [], last: Date.now() };
      await this.save(); await this.ctx.storage.setAlarm(startAt);
      return Response.json({ ok: true });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 });
    const m = await this.load(); if (!m) return new Response('no such room', { status: 404 });
    if (m.done) return new Response('that match is over', { status: 410 });
    const h = req.headers, id = Number(h.get('x-player'));
    if (!id) return new Response('sign in first', { status: 401 });
    if (h.get('x-sim') === '1') return new Response('not for test players', { status: 403 });   // load-test players never join a room
    let seat = m.seats.findIndex(s => s.id === id);
    if (m.started && seat < 0) return new Response('that match has started', { status: 409 });
    if (!m.started && seat < 0 && m.seats.length >= SEATS) return new Response('the room is full', { status: 409 });
    const info = { id, name: decodeURIComponent(h.get('x-name') || 'Worm').slice(0, 24), cc: country(h.get('x-country')), tier: Math.max(0, Math.min(5, Number(h.get('x-tier')) || 0)),
      cw: /^[a-z0-9]{12,24}$/.test(h.get('x-cw') || '') ? h.get('x-cw') : null, av: /^[a-z0-9]{2,16}$/.test(h.get('x-av') || '') ? h.get('x-av') : null };
    if (seat < 0) { m.seats.push({ ...info, hat: '' }); seat = m.seats.length - 1 } else Object.assign(m.seats[seat], m.started ? {} : info);
    for (const old of this.socks(id)) try { old.close(4000, 'opened elsewhere') } catch { }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ['p' + id]);
    m.last = Date.now(); await this.save();
    if (m.started) {                                                          // back during the match: the island so far, then the live frames
      pair[1].send(JSON.stringify({ ...this.startMsg(seat), t: 'resume', key: m.key, ops: m.ops }));
      if (seat !== m.host) this.tell(m.seats[m.host] && m.seats[m.host].id, { t: 'back', seat });
      if (m.host < 0 || !this.sock(m.seats[m.host].id)) await this.newHost();
    } else {
      this.sendRoom(); this.note();
      if (m.seats.length >= SEATS) await this.start();
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    const m = await this.load(); if (!m || typeof raw !== 'string' || raw.length > MAX_MSG) return;
    const seat = this.seatOf(ws); if (seat < 0) return;
    let msg; try { msg = JSON.parse(raw) } catch { return }
    if (!msg || typeof msg.t !== 'string') return;
    const now = Date.now(); m.last = now; this.seen.set(seat, now);
    switch (msg.t) {
      case 'hi': if (!m.started) { m.seats[seat].hat = String(msg.hat || '').slice(0, 120); await this.save(); this.sendRoom() } break;
      case 'cheer': {
        const id = msg.id; if (!Number.isInteger(id) || id < 0 || id >= CHEERS || now - (this.cheerAt.get(seat) || 0) < CHEER_GAP_MS) return;
        this.cheerAt.set(seat, now); this.all({ t: 'cheer', id, seat }); break;
      }
      case 'f':
        if (!m.started || m.done || seat !== m.host) return;
        this.heard = now; this.all(raw, ws);
        if (Array.isArray(msg.e)) for (const e of msg.e) if (Array.isArray(e) && (e[0] === 'carve' || e[0] === 'r.cut') && Array.isArray(e[1]) && m.ops.length < OPS_MAX) m.ops.push([e[0], e[1].slice(0, 3).map(Number)]);
        if (msg.k && msg.s) { m.key = msg.s; await this.saveKey() }
        break;
      case 'o':
        if (!m.started || m.done || seat === m.host || m.host < 0) return;
        this.tell(m.seats[m.host].id, { ...msg, seat }); break;
      case 'out': {
        const place = msg.place | 0, kills = msg.kills | 0; if (place < 1 || place > SEATS) return;
        m.places[seat] = { place, kills: Math.max(0, Math.min(SEATS, kills)) }; await this.save(); break;
      }
      case 'over': if (m.started && !m.done && seat === m.host) await this.finish(msg); break;
      case 'handoff': if (m.started && !m.done && seat === m.host) { try { ws.close(1000, 'handoff') } catch { } await this.newHost(seat) } break;
      case 'bye': try { ws.close(1000, 'bye') } catch { } await this.left(ws, seat); break;
    }
  }

  async webSocketClose(ws) { const m = await this.load(); if (!m) return; const seat = this.seatOf(ws); if (seat >= 0) await this.left(ws, seat) }
  async webSocketError(ws) { return this.webSocketClose(ws) }
  async left(ws, seat) {
    const m = this.m, id = m.seats[seat] && m.seats[seat].id; if (id == null || this.socks(id).some(s => s !== ws)) return;   // still there on another socket
    if (!m.started && !m.done) { m.seats.splice(seat, 1); await this.save(); this.sendRoom(); this.note(); return }
    if (m.done) return;
    if (seat === m.host) await this.newHost(seat);
    else if (m.host >= 0) this.tell(m.seats[m.host].id, { t: 'gone', seat });
  }

  // The clock: the start, then a check every few seconds that the host is still sending.
  async alarm() {
    const m = await this.load(); if (!m || m.done) return;
    const now = Date.now();
    if (!m.started) { if (now >= m.startAt - 50) await this.start(); else await this.ctx.storage.setAlarm(m.startAt); if (!this.m.started) return }
    if (!this.live().length) { if (now - m.last > IDLE_MS) { m.done = { at: now, gone: true }; await this.save(); this.note(); return } }
    else if (m.host < 0 || !this.sock(m.seats[m.host].id) || now - this.heard > HOST_QUIET_MS) await this.newHost(m.host);
    await this.ctx.storage.setAlarm(now + TICK_MS);
  }

  async start() {
    const m = this.m; if (m.started || m.done) return;
    const live = m.seats.filter(s => this.sock(s.id));
    if (live.length <= 1) {                                                  // nobody else came: the phone plays the CPU-only match
      for (const s of live) this.tell(s.id, { t: 'start', solo: true, map: m.map, seed: m.seed });
      m.done = { at: Date.now(), solo: true }; await this.save(); this.note(); return;
    }
    m.seats = live; m.started = Date.now(); m.host = 0; this.heard = Date.now() + HOST_QUIET_MS; await this.save();   // the first frame may wait for the map pictures
    m.seats.forEach((s, i) => this.tell(s.id, this.startMsg(i)));
    this.note(); await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  // The host left or went quiet: the next phone still connected runs the match from what it has. Phones that sent
  // something lately come first (a phone left open in the background stays connected but sends nothing), and the turn
  // goes round the seats after the old host, so two quiet phones never pass the match back and forth.
  async newHost(old) {
    const m = this.m, now = Date.now(), n = m.seats.length, next = i => (i - (old ?? -1) + n) % n;
    const live = this.live().filter(i => i !== old).sort((a, b) => next(a) - next(b));
    const awake = live.filter(i => now - (this.seen.get(i) || 0) < HOST_QUIET_MS);
    m.host = awake.length ? awake[0] : live.length ? live[0] : -1; this.heard = now; await this.save();
    if (m.host >= 0) this.all({ t: 'host', seat: m.host, live });
  }

  async finish(msg) {
    const m = this.m, places = Array.isArray(msg.places) ? msg.places.filter(p => Array.isArray(p) && p[0] >= 0 && p[0] < m.seats.length).map(p => [p[0] | 0, p[1] | 0, p[2] | 0]) : [];
    const winner = Number.isInteger(msg.winner) && msg.winner >= 0 && msg.winner < m.seats.length ? msg.winner : -1;
    m.done = { at: Date.now(), winner, places }; await this.save();
    this.all({ t: 'over', winner, places }); this.note();
    const p = this.record(winner, places).catch(() => { }); if (this.ctx.waitUntil) this.ctx.waitUntil(p); else await p;
  }
  // Each real player's place, checked against the place their own phone reported (a host that lies about the others shows up
  // in the admins' /prize list), and the winner's win: one online win, counted against the best-placed other real player.
  async record(winner, places) {
    const m = this.m, db = this.env.DB; if (!db) return;
    const by = new Map(places.map(p => [p[0], p])), now = Date.now();
    const rows = m.seats.map((s, i) => { const h = by.get(i), own = m.places[i]; return { s, i, place: own ? own.place : h ? h[1] : null, kills: own ? own.kills : h ? h[2] : 0, ok: !(own && h && Math.abs(own.place - h[1]) > 1) } });
    const fair = rows.every(r => r.ok), host = m.seats[m.host] || m.seats[0];
    const q = [...rows.map(r => db.prepare('INSERT INTO royale_log (code, player, place, kills, host, ok, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(m.code, r.s.id, r.place, r.kills, r.s === host ? 1 : 0, r.s === host ? (fair ? 1 : 0) : r.ok ? 1 : 0, now))];
    if (fair && winner >= 0) {                                               // one online win, like a 1-on-1 match: no losses for the other 49
      const w = m.seats[winner].id, next = rows.filter(r => r.i !== winner && r.s.id !== w && r.place).sort((a, b) => a.place - b.place)[0];
      q.push(db.prepare('UPDATE players SET wins = wins + 1 WHERE id = ?').bind(w));
      if (next) q.push(db.prepare('INSERT INTO matches (p0, p1, winner, reason, ended) VALUES (?, ?, ?, ?, ?)').bind(w, next.s.id, w, 'royale', now));   // against the runner-up, for the prize tie-break
    }
    await db.batch(q);
    if (fair && winner >= 0) for (const r of rows) if (r.place && r.s.id !== m.seats[winner].id) await teamClash(this.env, m.seats[winner].id, r.s.id, now).catch(() => { });   // rival teams' worms in the room
  }
}
