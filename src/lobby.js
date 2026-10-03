// The lobby: one Durable Object that every signed-in player on the game menu keeps a WebSocket open to. It is the pool of
// players around right now, and it carries challenges between them. A challenge is just a fresh match code: the
// challenger opens that match and waits in it, and the other player joins it by accepting. Players who are offline
// get the challenge as a Telegram message from the bot instead, when they are a friend and have a Telegram account.
//
//   client -> lobby   challenge {to: id | 'random'}    decline {code, from}    cancel {code, to}    busy {on}
//   lobby -> client   list {players}    sent {code, to, online, notified}    none    challenged {code, from}
//                     declined {code, by}    cancelled {code}
//
// It also keeps the one waiting spot for Quick match (plain HTTP, see quick()).

import { newCode } from './match.js';

const MAX_LIST = 100, MAX_MSG = 1024, CHALLENGE_GAP_MS = 1500, NOTIFY_GAP_MS = 5 * 60 * 1000;

export class Lobby {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.recent = new Map() }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get('Upgrade') === 'websocket') return this.enter(req);
    if (url.pathname === '/online') {
      const here = new Set(this.players().map(p => p.id));
      return Response.json({ online: (url.searchParams.get('ids') || '').split(',').map(Number).filter(id => here.has(id)) });
    }
    return this.quick(Number(url.searchParams.get('player')));
  }

  // Quick match: the first player gets a fresh match code and waits; the next player within 30 seconds gets the same code.
  async quick(player) {
    const w = await this.ctx.storage.get('waiting');
    if (w && w.player !== player && Date.now() - w.at < 30000) { await this.ctx.storage.delete('waiting'); return Response.json({ code: w.code, side: 1 }) }
    const code = newCode(); await this.ctx.storage.put('waiting', { code, player, at: Date.now() });
    return Response.json({ code, side: 0 });
  }

  enter(req) {
    const h = req.headers, id = Number(h.get('x-player'));
    const me = { id, name: decodeURIComponent(h.get('x-name') || 'Worm').slice(0, 40), wins: Number(h.get('x-wins')) || 0, losses: Number(h.get('x-losses')) || 0,
      hidden: new URL(req.url).searchParams.get('hidden') === '1', busy: false };
    for (const old of this.ctx.getWebSockets(String(id))) try { old.close(4000, 'opened elsewhere') } catch { }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [String(id)]);
    pair[1].serializeAttachment(me);
    this.broadcast();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Everyone connected and visible, one entry per player.
  players(except) {
    const seen = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const p = ws.deserializeAttachment(); if (p && !p.hidden && !seen.has(p.id)) seen.set(p.id, p);
    }
    return [...seen.values()];
  }
  sock(id) { return this.ctx.getWebSockets(String(id))[0] || null }
  tell(id, msg) { const ws = this.sock(id); if (ws) try { ws.send(JSON.stringify(msg)) } catch { } return !!ws }
  broadcast(except) {
    const list = this.players(except).slice(0, MAX_LIST).map(({ id, name, wins, losses, busy }) => ({ id, name, wins, losses, busy }));
    const out = JSON.stringify({ t: 'list', players: list });
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) try { ws.send(out) } catch { }
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    let msg; try { msg = JSON.parse(raw) } catch { return }
    const me = ws.deserializeAttachment(); if (!me || !msg || typeof msg.t !== 'string') return;
    const send = m => { try { ws.send(JSON.stringify(m)) } catch { } };
    const who = ({ id, name, wins, losses }) => ({ id, name, wins, losses });
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
