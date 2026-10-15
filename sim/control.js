// The Control Durable Object: the load test's orders and numbers. It holds what the bots should do (off, life, rush),
// hands it to every Fleet, adds up the fleets' 10-second reports into a 3-hour history for the dashboard, asks the
// game server how many are online, and once a minute (from the cron) takes new orders from D1 (sim_cmd, written by the
// bot's admin /sim) and writes a summary row to D1 (sim_stats) that the team and /sim can read.
//
// Safety brake, to protect real players: during a rush, more than 5% errors or a slowest-5% answer time over 3 s for
// 30 seconds sends the bots back to normal days; in normal days, more than 15% errors stops them.
import { newWin, addWin, pct, GROUPS } from './stats.js';

export const TOTAL = 500, PER = 100, MIN = 6e4;
const OLD_FLEETS = 10;                                                             // the first fleets (fleet-0 to 9, far from the database): told to stop
const HIST = 1080, PART = 60, PARTS = 6, POINT = 10e3, RAMP = 5 * MIN, KEEP_ROWS = 3 * 864e5;

export class Control {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.cfg = null; this.fleets = {}; this.open = new Map(); this.hist = null; this.ids = null; this.server = {} }
  async load() {
    if (this.cfg) return;
    this.cfg = (await this.ctx.storage.get('cfg')) || { v: 1, mode: 'off', bots: TOTAL, per: PER, rushFrom: 0, rushUntil: 0, ramp: RAMP, brake: null, since: Date.now() };
    this.hist = (await Promise.all([...Array(PARTS)].map((_, i) => this.ctx.storage.get('hist' + i)))).flatMap(h => h || []); this.ids = (await this.ctx.storage.get('ids')) || {};
    const live = (await this.ctx.storage.get('live')) || {}; this.open = new Map(live.open || []); this.fleets = live.fleets || {}; this.server = live.server || {};   // as it was if the object restarted
    this.bootGap = live.at ? Date.now() - live.at : null; this.born = Date.now();
    this.boots = ((await this.ctx.storage.get('boots')) || 0) + 1; this.ctx.storage.put('boots', this.boots).catch(() => { });
    if (this.cfg.per !== PER) { this.cfg.per = PER; this.cfg.v++; this.ids = {}; this.idsDirty = true }
  }
  fleetsN() { return Math.ceil(TOTAL / this.cfg.per) }                          // all of them, so fewer bots also reaches the fleets that stop
  fleetCfg(k) { return k < 0 ? { ...this.cfg, k, first: 0, per: 0, ids: [] } : { ...this.cfg, k, first: k * this.cfg.per, ids: Object.values(this.ids).flat() } }
  // the fleets run next to the game's database (eastern North America), so answer times are the server's own work
  stub(name) { return this.env.FLEET.get(this.env.FLEET.idFromName(name), { locationHint: 'enam' }) }

  async fetch(req) {
    await this.load();
    const url = new URL(req.url), body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    if (url.pathname === '/report') { const closed = this.take(body); await this.keepLive(closed); return Response.json(this.fleetCfg(body.k | 0)) }
    if (url.pathname === '/tick') return Response.json(await this.tick());
    if (url.pathname === '/state') { await this.peek(); return Response.json(this.state()) }
    if (url.pathname === '/order') { this.order(String(body.cmd || ''), body.arg); await this.push(); await this.save(); return Response.json(this.cfg) }
    return new Response('not found', { status: 404 });
  }

  // a fleet's 10 seconds: into the open point for that time; points older than 20 s close into the history
  take(r) {
    const k = r.k | 0, now = Date.now(); if (k < 0) return false; this.fleets[k] = { at: r.at || now, snap: r.snap || {} }; this.got = (this.got || 0) + 1; this.gotAt = now;
    if (r.ids) { this.ids[k] = r.ids; this.idsDirty = true }
    const t = Math.floor((r.at || now) / POINT) * POINT; if (!this.open.has(t)) this.open.set(t, newWin());
    addWin(this.open.get(t), r.win || {});
    let closed = false;
    for (const [pt, w] of [...this.open].sort((a, b) => a[0] - b[0])) {
      if (pt > now - 2 * POINT) break;
      this.open.delete(pt); this.hist.push(this.point(pt, w)); if (this.hist.length > HIST) this.hist.splice(0, this.hist.length - HIST);
      this.brake(now); closed = true;
    }
    if (this.cfg.mode === 'rush' && now >= this.cfg.rushUntil) { this.order('life', null, 'rush over'); closed = true }
    return closed;
  }
  // what is in memory goes to storage on every report, so a restarted object carries on with the same numbers
  async keepLive(closed) {
    await this.ctx.storage.put('live', { at: Date.now(), open: [...this.open], fleets: this.fleets, server: this.server }).catch(() => { });
    if (closed) await this.save().catch(() => { });
  }
  gauges(now = Date.now()) {
    const g = { bots: 0, accounts: 0, online: 0, inMatch: 0, inBattle: 0, inGame: 0, sockets: 0, lag: 0, fleets: 0 };
    for (const f of Object.values(this.fleets)) if (now - f.at < 3 * POINT) { g.fleets++; for (const k in g) if (k !== 'fleets' && k !== 'lag') g[k] += f.snap[k] || 0; g.lag = Math.max(g.lag, f.snap.lag || 0) }
    return g;
  }
  point(t, w) {
    const g = this.gauges();
    return { t, req: w.req, err: w.err, rej: w.rej, lim: w.lim, p50: pct(w.h, .5), p95: pct(w.h, .95), ws: w.ws, wsErr: w.wsErr, wsP95: pct(w.wsH, .95),
      relay50: pct(w.relayH, .5), relay95: pct(w.relayH, .95), msgs: w.msgsOut + w.msgsIn, kb: Math.round((w.bytesOut + w.bytesIn) / 1024), matches: w.matches, done: w.matchesDone,
      attacks: w.attacks, taken: w.taken, games: w.games, signups: w.signups, by: Object.fromEntries(GROUPS.map(k => [k, w.by[k][0] ? [w.by[k][0], w.by[k][1], Math.round(w.by[k][2] / w.by[k][0])] : [0, 0, 0]])),
      online: g.online, inMatch: g.inMatch, inBattle: g.inBattle, inGame: g.inGame, bots: g.bots, lag: g.lag, server: this.server.online ?? null, errors: w.errors.slice(0, 3) };
  }
  brake(now) {
    const last = this.hist.slice(-3); if (last.length < 3 || last[0].t < now - 60e3) return;
    const req = last.reduce((s, p) => s + p.req, 0), err = last.reduce((s, p) => s + p.err + p.wsErr, 0), slow = last.every(p => p.p95 > 3000);
    if (req < 100) return;
    if (this.cfg.mode === 'rush' && (err / req > .05 || slow)) this.order('life', null, err / req > .05 ? `${Math.round(err / req * 100)}% errors` : 'answers slower than 3 s');
    else if (this.cfg.mode === 'life' && err / req > .15) this.order('off', null, `${Math.round(err / req * 100)}% errors`);
  }
  order(cmd, arg, brake = null) {
    const c = this.cfg, now = Date.now(), n = Math.round(Number(arg));
    if (cmd === 'off') c.mode = 'off';
    else if (cmd === 'life') { c.mode = 'life'; if (n > 0) c.bots = Math.min(TOTAL, n) }
    else if (cmd === 'rush') { c.mode = 'rush'; c.rushFrom = now; c.rushUntil = now + Math.max(5, Math.min(180, n || 30)) * MIN }
    else if (cmd === 'bots') { if (n > 0) c.bots = Math.min(TOTAL, n) }
    else if (cmd === 'probe' || cmd === 'check') { this.probe = { cmd, n: n || 20 }; return }
    else return;
    c.brake = brake ? { why: brake, at: now } : null; c.v++; c.since = now;
  }
  async push() {
    const send = (name, cfg) => this.stub(name).fetch('https://fleet/cfg', { method: 'POST', body: JSON.stringify(cfg) }).then(r => r.json());
    const old = this.pushedV === this.cfg.v ? [] : [...Array(OLD_FLEETS)].map((_, k) => send('fleet-' + k, this.fleetCfg(-1)).catch(() => { }));
    this.pushedV = this.cfg.v;
    await Promise.all([...old, ...[...Array(this.fleetsN())].map((_, k) => send('f-' + k, this.fleetCfg(k)).then(s => { this.fleets[k] = { at: Date.now(), snap: s } }).catch(() => { }))]) }
  async peek(force) {                                                              // the game server's own count, at most every 10 s
    const now = Date.now(); if (!force && now - (this.server.at || 0) < 10e3) return;
    this.server.at = now;
    try { const o = await (await this.env.GAME.fetch('https://game/online')).json(); this.server.online = o.online; this.server.playing = o.playing } catch (e) { }
    try { const s = await (await this.env.GAME.fetch('https://game/stats')).json(); this.server.players = s.players } catch (e) { }
  }
  summary(now = Date.now()) {
    const last = this.hist.filter(p => p.t >= now - 70e3), sum = k => last.reduce((s, p) => s + (p[k] || 0), 0);
    const g = this.gauges(now), req = sum('req'), by = {};
    for (const k of GROUPS) { const n = last.reduce((s, p) => s + p.by[k][0], 0), ms = last.reduce((s, p) => s + p.by[k][0] * p.by[k][2], 0); if (n) by[k] = { n, err: last.reduce((s, p) => s + p.by[k][1], 0), ms: Math.round(ms / n) } }
    const max = k => last.reduce((m, p) => Math.max(m, p[k] || 0), 0), avg = k => last.length ? Math.round(sum(k) / last.length) : 0;
    return { mode: this.cfg.mode, bots: this.cfg.bots, rushUntil: this.cfg.mode === 'rush' ? this.cfg.rushUntil : null, brake: this.cfg.brake && this.cfg.brake.why,
      online: g.online, inMatch: g.inMatch, inBattle: g.inBattle, inGame: g.inGame, accounts: g.accounts, fleets: g.fleets, lag: g.lag,
      serverOnline: this.server.online ?? null, serverPlaying: this.server.playing ?? null, players: this.server.players ?? null,
      rpm: req, errPct: req ? Math.round(sum('err') / req * 1000) / 10 : 0, rej: sum('rej'), lim: sum('lim'), p50: avg('p50'), p95: max('p95'), wsP95: max('wsP95'), wsErr: sum('wsErr'),
      relay50: avg('relay50'), relay95: max('relay95'), msgsPerSec: Math.round(sum('msgs') / 60), kbPerSec: Math.round(sum('kb') / 60),
      matchesPerMin: sum('matches'), attacksPerMin: sum('attacks'), signups: sum('signups'), by, errors: last.flatMap(p => p.errors || []).slice(-3),
      diag: { boots: this.boots, age: now - this.born, gap: this.bootGap, got: this.got || 0, gotAgo: this.gotAt ? now - this.gotAt : null, hist: this.hist.length, histAgo: this.hist.length ? now - this.hist[this.hist.length - 1].t : null, open: this.open.size,
        f: Object.entries(this.fleets).filter(([k, f]) => f.snap && f.snap.bots).slice(0, 3).map(([k, f]) => [k, f.snap.reports, f.snap.steps, f.snap.reportAt ? now - f.snap.reportAt : null, f.snap.age, f.snap.gap, (f.snap.slow || []).slice(-3)]) },
      fleetErrors: Object.entries(this.fleets).filter(([k, f]) => f.snap && (f.snap.reportErr || (f.snap.recent || []).length)).slice(0, 3).map(([k, f]) => ({ k, reports: f.snap.reports, reportErr: f.snap.reportErr, recent: (f.snap.recent || []).slice(-2) })) };
  }
  state() { return { at: Date.now(), cfg: { mode: this.cfg.mode, bots: this.cfg.bots, rushUntil: this.cfg.rushUntil, ramp: this.cfg.ramp, brake: this.cfg.brake, since: this.cfg.since }, now: this.summary(), hist: this.hist.slice(-360) } }

  // every minute, from the cron: new orders, wake the fleets, the game server's counts, a row in D1
  async tick() {
    const env = this.env, now = Date.now(); let changed = false;
    try {
      const { results } = await env.DB.prepare('SELECT id, cmd, arg FROM sim_cmd WHERE done IS NULL ORDER BY id').all();
      for (const r of results) { this.order(r.cmd, r.arg); await env.DB.prepare('UPDATE sim_cmd SET done = ? WHERE id = ?').bind(now, r.id).run(); changed = true }
    } catch (e) { }
    if (this.cfg.mode === 'rush' && now >= this.cfg.rushUntil) { this.order('life', null, 'rush over'); changed = true }
    if (this.cfg.mode !== 'off' || changed || Object.values(this.fleets).some(f => now - f.at < 3 * POINT && (f.snap.online || f.snap.sockets))) await this.push();
    if (this.probe) { const p = this.probe; this.probe = null; const r = await this.stub('probe').fetch('https://fleet/probe', { method: 'POST', body: JSON.stringify({ n: p.n, check: p.cmd === 'check' }) }).then(r => r.json()).catch(e => ({ error: String(e) })); this.lastProbe = r;
      await env.DB.prepare('INSERT OR REPLACE INTO sim_stats (at, data) VALUES (?, ?)').bind(now - 1, JSON.stringify({ probe: r })).run().catch(() => { }) }
    await this.peek(true);
    const row = this.summary(now);
    if (this.cfg.mode !== 'off' || row.online || row.rpm) {
      await env.DB.batch([env.DB.prepare('INSERT OR REPLACE INTO sim_stats (at, data) VALUES (?, ?)').bind(now, JSON.stringify(row)), env.DB.prepare('DELETE FROM sim_stats WHERE at < ?').bind(now - KEEP_ROWS)]).catch(() => { });
    }
    await this.save(); await this.keepLive(false);
    return row;
  }
  async save() {                                                                   // the last hour, in parts (a stored value has a size limit)
    const h = this.hist.slice(-PARTS * PART); await this.ctx.storage.put('cfg', this.cfg);
    await Promise.all([...Array(PARTS)].map((_, i) => this.ctx.storage.put('hist' + i, h.slice(i * PART, (i + 1) * PART)))); if (this.idsDirty) { this.idsDirty = false; await this.ctx.storage.put('ids', this.ids) } }
}
