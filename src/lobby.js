// The lobby: one Durable Object that every signed-in player on the game menu keeps a WebSocket open to. It is the pool of
// players around right now, and it carries challenges between them. A challenge is just a fresh match code: the
// challenger opens that match and waits in it, and the other player joins it by accepting. Players who are offline
// get the challenge as a Telegram message from the bot instead, when they are a friend and have a Telegram account.
//
//   client -> lobby   challenge {to: id | 'random'}    decline {code, from}    cancel {code, to}    busy {on}
//   lobby -> client   list {players: [{id, name, wins, losses, busy, cc, tier, st}], online, playing, live: [{code, names, cc, viewers, at, ids}], royale: {n, left} | null}    sent {code, to, online, notified}    none    challenged {code, from}
//                     declined {code, by}    cancelled {code}    whale {name, tier}
//
// tier and st are the player's $CWORM holder tier (0-5) and hold stars (0-4), from the server (see holders.js). A Whale or Big
// Whale who opted in is announced to everyone else as they come online: once a UTC day per whale, one every WHALE_GAP_MS at most.
//
// It also keeps the Live now list: matches in progress, which each match adds itself to when it starts and takes itself
// off when it ends (see match.js). Entries older than LIVE_MAX_MS are dropped in case an end never arrived.
//
// It also keeps the one waiting spot for Quick match (plain HTTP, see quick()). Every open game sits in the lobby, so it
// also counts the players online: `online` is everyone connected (hidden players too), `playing` those in a match.
//
// And the one open Worm Royale room (royaleJoin): everyone who taps Drop in gets its code, so real players meet in the same
// match. A room opens with the first player and starts ROYALE_WAIT_MS later (see royale.js); its count of players waiting and
// time left go out with the list as royale {n, left}, for the Royale card on Home.

import { newCode } from './match.js';
import { ROYALE_WAIT_MS } from './royale.js';
import { announce } from './growth.js';

// Two-letter country from Cloudflare (by connection), for the flag next to a player's name; null when unknown.
const country = c => { c = String(c || '').toUpperCase(); return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null };
const LIVE_MAX = 50, LIVE_MAX_MS = 40 * 60 * 1000, MAX_LIST = 100, MAX_MSG = 1024, CHALLENGE_GAP_MS = 1500, NOTIFY_GAP_MS = 5 * 60 * 1000, WHALE_GAP_MS = 3 * 60 * 1000,
  BUSY_LOBBY = 40, LIST_GAP_MS = 1000, ROYALE_LATE_MS = 4000;   // with this many connected, list updates are bundled: at most one a second (else every join sends one to everyone)
const open = ws => ws.readyState == null || ws.readyState === 1;   // a closing socket can still be listed until its close event has run

export class Lobby {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.recent = new Map() }

  async fetch(req) {
    const url = new URL(req.url);
    if (!this.liveList) this.liveList = await this.live();
    if (this.royale === undefined) this.royale = (await this.ctx.storage.get('royale')) || null;
    if (req.headers.get('Upgrade') === 'websocket') return this.enter(req);
    if (url.pathname === '/online') {
      const here = new Set(this.players().map(p => p.id));
      return Response.json({ online: (url.searchParams.get('ids') || '').split(',').map(Number).filter(id => here.has(id)) });
    }
    if (url.pathname === '/announce') { if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 100); return Response.json({ ok: true }) }
    if (url.pathname === '/count') return Response.json(this.count());
    if (url.pathname === '/ids') return Response.json({ ids: this.players().map(p => p.id) });   // visible players, for the bot's "friend is online" reminders
    if (url.pathname === '/live') return req.method === 'POST' ? this.setLive(await req.json().catch(() => ({}))) : Response.json({ live: await this.live() });
    if (url.pathname === '/royale/join') return this.royaleJoin();
    if (url.pathname === '/royale/note' && req.method === 'POST') return this.royaleNote(await req.json().catch(() => ({})));
    return this.quick(Number(url.searchParams.get('player')));
  }

  // update notes: one batch per alarm (each alarm is a fresh run with its own call limit), again 1.5 s later while players remain
  async alarm() {
    let more = false;
    try { more = await announce(this.env) } catch (e) { await this.env.DB.prepare('INSERT INTO bot_log (at, note) VALUES (?, ?)').bind(Date.now(), 'announce error ' + (e && e.message)).run().catch(() => { }) }
    if (more) await this.ctx.storage.setAlarm(Date.now() + 1500);
  }

  async live() {
    const all = (await this.ctx.storage.get('live')) || {}, now = Date.now();
    return Object.values(all).filter(l => now - l.at < LIVE_MAX_MS).sort((a, b) => b.viewers - a.viewers || b.at - a.at).slice(0, LIVE_MAX);
  }
  async setLive(b) {
    const code = String(b.code || ''); if (!/^[A-Z2-9]{6}$/.test(code)) return Response.json({ ok: false }, { status: 400 });
    const all = (await this.ctx.storage.get('live')) || {}, now = Date.now();
    for (const k in all) if (now - all[k].at > LIVE_MAX_MS) delete all[k];
    if (b.gone) delete all[code];
    else { const old = all[code] || {}, s = v => (v == null ? null : String(v).slice(0, 40));
      all[code] = { code, names: (Array.isArray(b.names) ? b.names : [null, null]).slice(0, 2).map(s), cc: (Array.isArray(b.cc) ? b.cc : [null, null]).slice(0, 2).map(country),
        viewers: Math.max(0, Number(b.viewers) || 0), at: Number(b.at) || old.at || now,
        ids: (Array.isArray(b.ids) ? b.ids : old.ids || []).slice(0, 2).map(v => (Number.isInteger(v) ? v : null)) } }   // who is playing, so the player list can offer Watch
    await this.ctx.storage.put('live', all);
    const was = (this.liveList || []).length, codes = new Set((this.liveList || []).map(l => l.code));
    this.liveList = await this.live();
    if (b.gone || !codes.has(code) || was !== this.liveList.length) this.broadcast();   // starts and ends go out at once; viewer counts ride along later
    return Response.json({ ok: true });
  }

  // Worm Royale: the open room's code, or a new room when there is none, it has started, or it starts too soon to get in.
  async royaleJoin() {
    const now = Date.now(); let r = this.royale || (this.royale = await this.ctx.storage.get('royale'));
    if (!r || r.started || now > r.startAt - this.royaleLate()) {
      r = this.royale = { code: newCode(), startAt: now + this.royaleWait(), n: 0, started: false }; await this.ctx.storage.put('royale', r);
      await this.env.ROYALE.get(this.env.ROYALE.idFromName(r.code)).fetch('https://room/open', { method: 'POST', body: JSON.stringify({ code: r.code, startAt: r.startAt }) });
    }
    return Response.json({ code: r.code, left: r.startAt - now });
  }
  async royaleNote(b) {                                               // a room's players came or went, or it started
    const r = this.royale || (this.royale = await this.ctx.storage.get('royale'));
    if (!r || r.code !== b.code) return Response.json({ ok: false });
    r.n = Math.max(0, Number(b.n) || 0); r.started = !!b.started; await this.ctx.storage.put('royale', r); this.broadcast();
    return Response.json({ ok: true });
  }
  royaleOpen() { const r = this.royale, left = r ? r.startAt - Date.now() : 0; return r && !r.started && r.n > 0 && left > this.royaleLate() ? { n: r.n, left } : null }
  royaleWait() { return Number(this.env.ROYALE_WAIT_MS) || ROYALE_WAIT_MS }                  // ROYALE_WAIT_MS in the env: a shorter wait for tests
  royaleLate() { return Math.min(ROYALE_LATE_MS, this.royaleWait() / 4) }

  // Quick match: the first player gets a fresh match code and waits; the next player within 30 seconds gets the same code.
  async quick(player) {
    const w = await this.ctx.storage.get('waiting');
    if (w && w.player !== player && Date.now() - w.at < 30000) { await this.ctx.storage.delete('waiting'); return Response.json({ code: w.code, side: 1 }) }
    const code = newCode(); await this.ctx.storage.put('waiting', { code, player, at: Date.now() });
    return Response.json({ code, side: 0 });
  }

  async enter(req) {
    const h = req.headers, id = Number(h.get('x-player')), n = (k, max) => Math.max(0, Math.min(max, Number(h.get(k)) || 0));
    const me = { id, name: decodeURIComponent(h.get('x-name') || 'Worm').slice(0, 40), wins: Number(h.get('x-wins')) || 0, losses: Number(h.get('x-losses')) || 0,
      hidden: new URL(req.url).searchParams.get('hidden') === '1', busy: false, cc: country(h.get('x-country')), tier: n('x-tier', 5), st: n('x-stars', 4) };
    for (const old of this.ctx.getWebSockets(String(id))) try { old.close(4000, 'opened elsewhere') } catch { }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [String(id)]);
    pair[1].serializeAttachment(me);
    this.broadcast();
    if (me.tier >= 4 && h.get('x-toast') === '1' && !me.hidden) await this.whale(me, pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async whale(me, mine) {
    const now = Date.now(), day = Math.floor(now / 864e5), seen = (await this.ctx.storage.get('whales')) || {};
    if (seen.day !== day) { seen.day = day; seen.ids = {} }
    if (seen.ids[me.id] || now - (seen.at || 0) < WHALE_GAP_MS) return;
    seen.ids[me.id] = 1; seen.at = now; await this.ctx.storage.put('whales', seen);
    const out = JSON.stringify({ t: 'whale', name: me.name, tier: me.tier });   // never the wallet or the amount
    for (const ws of this.ctx.getWebSockets()) if (ws !== mine) try { ws.send(out) } catch { }
  }

  // Everyone connected and visible, one entry per player.
  players(except) {
    const seen = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || !open(ws)) continue;
      const p = ws.deserializeAttachment(); if (p && !p.hidden && !seen.has(p.id)) seen.set(p.id, p);
    }
    return [...seen.values()];
  }
  // How many players are connected, and how many of them are in a match. One per player, hidden ones included.
  count(except) {
    const seen = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || !open(ws)) continue;
      const p = ws.deserializeAttachment(); if (p) seen.set(p.id, seen.get(p.id) || p.busy);
    }
    let playing = 0; for (const b of seen.values()) if (b) playing++;
    return { online: seen.size, playing };
  }
  sock(id) { return this.ctx.getWebSockets(String(id))[0] || null }
  tell(id, msg) { const ws = this.sock(id); if (ws) try { ws.send(JSON.stringify(msg)) } catch { } return !!ws }
  broadcast(except) {
    if (this.ctx.getWebSockets().length < BUSY_LOBBY) return this.sendList(except);
    if (this.listTimer) return;                                   // one is on its way: it will carry this change too
    this.listTimer = setTimeout(() => { this.listTimer = null; this.listAt = Date.now(); this.sendList() }, Math.max(0, (this.listAt || 0) + LIST_GAP_MS - Date.now()));
  }
  sendList(except) {
    const list = this.players(except).slice(0, MAX_LIST).map(({ id, name, wins, losses, busy, cc, tier, st }) => ({ id, name, wins, losses, busy, cc, tier: tier || 0, st: st || 0 }));
    const out = JSON.stringify({ t: 'list', players: list, ...this.count(except), live: this.liveList || [], royale: this.royaleOpen() });
    for (const ws of this.ctx.getWebSockets()) if (ws !== except && open(ws)) try { ws.send(out) } catch { }
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    let msg; try { msg = JSON.parse(raw) } catch { return }
    const me = ws.deserializeAttachment(); if (!me || !msg || typeof msg.t !== 'string') return;
    const send = m => { try { ws.send(JSON.stringify(m)) } catch { } };
    const who = ({ id, name, wins, losses, cc, tier }) => ({ id, name, wins, losses, cc, tier: tier || 0 });
    switch (msg.t) {
      case 'busy':
        if (me.busy !== !!msg.on) { me.busy = !!msg.on; ws.serializeAttachment(me); this.broadcast() }
        break;
      case 'challenge': {
        const now = Date.now(); if (now - (this.recent.get(me.id) || 0) < CHALLENGE_GAP_MS) return; this.recent.set(me.id, now);
        let to;
        if (msg.to === 'random') {
          const free = this.players().filter(p => p.id !== me.id && !p.busy);
          if (!free.length) return send({ t: 'none' });
          to = free[Math.floor(Math.random() * free.length)];
        } else {
          const id = Number(msg.to); if (!id || id === me.id) return;
          const s = this.sock(id); to = s && s.deserializeAttachment();
          if (to && to.hidden) to = null;                              // hidden players only get friends' Telegram messages
          if (to && to.busy) return send({ t: 'none', busy: true });
          if (!to) {                                                  // not around: a Telegram message, for friends only
            const code = newCode(), friend = await this.notify(me, id, code);
            if (!friend) return send({ t: 'none' });
            return send({ t: 'sent', code, to: { id, name: friend.name }, online: false, notified: friend.notified });
          }
        }
        const code = newCode();
        this.tell(to.id, { t: 'challenged', code, from: who(me) });
        send({ t: 'sent', code, to: { id: to.id, name: to.name }, online: true });
        break;
      }
      case 'decline': if (typeof msg.code === 'string') this.tell(Number(msg.from), { t: 'declined', code: msg.code.slice(0, 6), by: { id: me.id, name: me.name }, busy: !!msg.busy }); break;
      case 'cancel': if (typeof msg.code === 'string') this.tell(Number(msg.to), { t: 'cancelled', code: msg.code.slice(0, 6) }); break;
    }
  }

  // Tell an offline friend through the Telegram bot. Only players the challenger has added as a friend, at most once
  // every 5 minutes per pair. Returns null when they aren't a friend, else {name, notified}.
  async notify(me, id, code) {
    if (!this.env.DB) return null;
    const f = await this.env.DB.prepare('SELECT p.name, p.tg_id FROM friends f JOIN players p ON p.id = f.friend WHERE f.player = ? AND f.friend = ?').bind(me.id, id).first();
    if (!f) return null;
    const key = me.id + ':' + id, now = Date.now();
    if (f.tg_id == null || !this.env.BOT_TOKEN || !this.env.GAME_LINK || now - (this.recent.get(key) || 0) < NOTIFY_GAP_MS) return { name: f.name, notified: false };
    this.recent.set(key, now);
    const link = this.env.GAME_LINK + (this.env.GAME_LINK.includes('?') ? '&' : '?') + 'startapp=m_' + code;
    const r = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: f.tg_id, text: `🪱 ${me.name} challenges you to a match in Crypto Worm Wars!`, reply_markup: { inline_keyboard: [[{ text: 'Accept the challenge', url: link }]] } }),
    }).catch(() => null);
    return { name: f.name, notified: !!(r && r.ok) };
  }

  async webSocketClose(ws) { this.broadcast(ws) }
  async webSocketError(ws) { this.broadcast(ws) }
}
