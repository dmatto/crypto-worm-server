// One Fleet Durable Object runs a group of simulated players ("bots") against the real game server, through the
// service binding GAME, the way the game on a phone does: it signs up as a guest and picks a nickname, opens the game
// (/me, /stats, the weekly prize card...), sits in the lobby, plays offline games (/started, /played, /score), online
// matches against another bot of the same fleet (a real match server match: the phone running the turn streams ~20
// updates a second, then hands the turn over), and World Map battles for land (CPU land or other bots' land only).
//
// Two ways to run (set by the Control object, see control.js):
//   life   every bot is online 2 to 3 hours each UTC day, in one or two goes at random times that change every day,
//          playing game after game (so far more than 3 games a day)
//   rush   every bot comes online, spread over the ramp, and keeps playing until the rush ends; then back to life
// A bot's day plan is kept with its account, so a fleet with nobody online sleeps until an alarm.
// Answer times, errors and messages go to Control every 10 seconds.
import { TILES } from './world.js';
import { nameFor, countryFor, profileFor } from './names.js';
import { newWin, noteReq, noteWs, noteRelay, noteError as note, groupOf } from './stats.js';

const BASE = 'https://game', MIN = 6e4, HOUR = 36e5, DAY = 864e5, REPORT_MS = 10e3, WATCHDOG_MS = 30e3, FRAME_MS = 50;
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const weekStart = (t = Date.now()) => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); return d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY };
const THEMES = ['moon', 'mars', 'beach', 'city', 'jungle', 'ice', 'desert', 'candy'];
// the live feed on Home (src/feed.js): about half the games send a moment or two, the way the game reports its best moments
const WEAPONS = ['rocket', 'grenade', 'shotgun', 'cluster', 'fomo', 'lambo', 'mine', 'rugpull', 'whale', 'punch', 'fart', 'mole', 'geyser', 'quake', 'bugs', 'btcbomb', 'drill', 'blackhole'];
const FOES = ['Paper Hands', 'Miss FUD', 'Rekt', 'Bag Lady', 'Shorty', 'Dumper'], OWN = ['Moon Boy', 'Moon Girl', 'Lambo'];
export function moments(mode, won, r = Math.random) {
  if (r() < .5) return null;
  const out = [], wp = () => WEAPONS[Math.floor(r() * WEAPONS.length)], one = a => a[Math.floor(r() * a.length)];
  if (mode !== 'online' && r() < (won ? .5 : .25)) out.push(won ? { k: 'solo', m: mode, ...(mode === 'camp' ? { n: 1 + Math.floor(r() * 30) } : {}) } : { k: 'lost', m: mode });
  const x = r();
  if (x < .12) out.push({ k: 'multi', n: r() < .8 ? 2 : 3, wp: wp() });
  else if (x < .34) out.push({ k: 'big', n: Math.round(60 + r() * 50), wp: wp() });
  else if (x < .66) out.push({ k: 'kill', w: one(mode === 'online' ? [...FOES.slice(0, 3), ...OWN] : FOES), wp: wp(), how: r() < .25 ? 'drown' : 'blast' });
  else if (x < .71) out.push({ k: 'oops', w: one(OWN), wp: wp() });
  else if (x < .82 && mode !== 'online') out.push({ k: 'died', w: one(OWN), wp: wp() });
  return out.length ? out : null;
}
const OFFLINE = [['cpu', 'cpu'], ['cpu', 'cpu'], ['cpu', 'cpu'], ['cpu', 'camp'], ['cpu', 'daily'], ['mini', 'cpu'], ['team', 'cpu']];   // [started, played]

// World Map neighbours (the same hex grid as src/map.js)
let AT = null;
const key = (q, r) => q * 4096 + r, DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
function neighbours(i) {
  if (!AT) AT = new Map(TILES.map((t, k) => [key(t[0], t[1]), k]));
  return DIRS.map(([dq, dr]) => AT.get(key(TILES[i][0] + dq, TILES[i][1] + dr))).filter(n => n != null);
}

// A match update about the size the game sends (~3 KB): the match state with six worms, two teams and their weapons.
function fakeSnap() {
  const worm = (i) => ({ id: i, team: i % 2, name: 'Worm ' + (i + 1), x: 200 + i * 160, y: 400, vx: 0, vy: 0, hp: 100, facing: i % 2 ? -1 : 1, grounded: true, dead: false,
    aim: 0.6, jumps: 0, onRope: false, ropeLen: 0, poison: 0, frozen: 0, shield: 0, hat: 'cap', skin: 'green', voice: 2, kills: 0, dmg: 0, lastHit: 0, drown: false, dig: 0, bounce: 0 });
  const ammo = {}; for (const w of ['bazooka', 'grenade', 'shotgun', 'uzi', 'airstrike', 'dynamite', 'mine', 'sheep', 'banana', 'holy', 'rope', 'teleport', 'baseball', 'blowtorch',
    'drill', 'girder', 'cluster', 'napalm', 'homing', 'mortar', 'freeze', 'laser', 'moonshot', 'pump', 'rug', 'whalefall', 'gas', 'magnet']) ammo[w] = w === 'bazooka' ? -1 : 1 + (w.length % 3);
  return {
    g: { state: 'aim', turnTeam: 0, timer: 1800, retreat: 0, wind: 0.3, weapon: 'bazooka', charging: false, power: 0, targetX: null, mi: 0, mod: null, turnCount: 1, bear: null,
      waterTarget: 520, firstTurn: true, fired: false, skipEvent: false, firstBlood: false, settleT: 0, eventT: 0, whale: null, vortex: null, thrust: 0, maxHp: 100, moved: 0,
      bird: null, tremor: 0, blimp: null, blimpBack: 0 },
    water: 520, active: 0, worms: [0, 1, 2, 3, 4, 5].map(worm), proj: [], pets: [], crates: [{ x: 640, y: 120, kind: 'weapon', vy: 0 }], mines: [[300, 410], [900, 380]],
    barrels: [[500, 400, 30]], graves: [], tracers: [], buried: [], builds: [], blocks: [],
    teams: [0, 1].map(idx => ({ idx, last: 0, worm: 0, earned: 0, ammo: { ...ammo } })),
  };
}
function moveSnap(s, side, frame, end, shooting) {
  const w = s.worms[side + 2 * (s.g.turnCount % 3)] || s.worms[side]; s.active = s.worms.indexOf(w); s.g.turnTeam = side;
  s.g.timer = Math.max(0, Math.round((end - Date.now()) / 1000 * 60)); s.g.state = shooting ? 'fly' : 'aim';
  w.x += Math.sin(frame / 9) * 2; w.aim = 0.5 + Math.sin(frame / 23) / 3; s.g.power = shooting ? 0 : (frame % 60) / 60;
  s.proj = shooting ? [{ x: w.x + (frame % 40) * 12, y: 300 - (frame % 40) * 4, vx: 6, vy: -2, kind: s.g.weapon, owner: s.active, t: frame % 40 }] : [];
}

let recent = [], slow = [];                                                                   // the last few errors, shown in the fleet's numbers
const noteError = (w, text) => { note(w, text); recent = [...recent.slice(-4), new Date().toISOString().slice(11, 19) + ' ' + String(text).slice(0, 160)] };

export class Fleet {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.cfg = null; this.bots = null; this.win = newWin(); this.queue = []; this.timer = null; this.open = 0; this.lag = 0 }
  speed() { return Math.max(1, Number(this.env.SIM_SPEED) || 1) }   // local tries run faster
  t(ms) { return ms / this.speed() }

  async boot() {
    if (this.bots) return;
    this.cfg = (await this.ctx.storage.get('cfg')) || null; this.born = Date.now();
    const alive = await this.ctx.storage.get('alive'); this.gap = alive ? this.born - alive : null;
    if (!this.env.SIM_SPEED) fetch('https://www.cloudflare.com/cdn-cgi/trace').then(r => r.text()).then(t => { this.colo = (t.match(/colo=(\w+)/) || [])[1] }).catch(() => { });   // where this fleet runs
    this.saved = (await this.ctx.storage.get('bots')) || {};
    this.bots = new Map(); if (this.cfg) this.fill();
  }
  fill() {
    const c = this.cfg; if (!c || c.per == null) return;
    for (let n = c.first; n < c.first + c.per; n++) if (!this.bots.has(n)) {
      const s = this.saved[n] || {};
      this.bots.set(n, { n, token: s.token || null, id: s.id || null, name: s.name || nameFor(n), cc: countryFor(n), prof: profileFor(n), next: 0, plan: s.plan || null,
        wk: s.wk || 0, week: s.week || 0, ad: s.ad || 0, attacks: s.attacks || 0, land: !!s.land, run: false, lobby: null });
    }
    for (const n of this.bots.keys()) if (n < c.first || n >= c.first + c.per) this.bots.delete(n);   // now another fleet's (a running one stops: see active)
    if (this.fillPer !== c.per) { this.fillPer = c.per; this.idsChanged = true }   // tell Control which accounts are ours
  }
  persist() {
    const out = {}; for (const b of this.bots.values()) out[b.n] = { token: b.token, id: b.id, name: b.name, cc: b.cc, next: b.next, plan: b.plan, wk: b.wk, week: b.week, ad: b.ad, attacks: b.attacks, land: b.land };
    this.saved = out; return this.ctx.storage.put('bots', out);
  }

  async fetch(req) {
    await this.boot();
    const url = new URL(req.url), body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    if (url.pathname === '/cfg') { this.take(body); return Response.json(this.snap()) }
    if (url.pathname === '/probe') return Response.json(await this.probe(body));
    return new Response('not found', { status: 404 });
  }
  async alarm() { await this.boot(); this.alarmAt = 0; this.wake() }
  take(c) {
    if (!c || c.v == null) return;
    const was = this.cfg; this.cfg = c; if (!was || was.v !== c.v) this.ctx.storage.put('cfg', c).catch(() => { });
    this.fill(); this.wake();
  }
  rushing(now = Date.now()) { const c = this.cfg; return !!c && c.mode === 'rush' && now >= c.rushFrom && now < c.rushUntil }
  active(b) { const c = this.cfg; return !!c && c.mode !== 'off' && b.n < c.bots && b.n >= c.first && b.n < c.first + c.per }
  keep(b) { return this.active(b) && (!b.rush || this.rushing()) }
  wake() { if (!this.timer) { this.lastStep = Date.now(); this.timer = setInterval(() => this.step(), 1000) } this.step() }

  // Once a second: start the bots whose time has come, report every 10 s, and go to sleep when nobody is online.
  step() {
    const now = Date.now(), c = this.cfg; this.steps = (this.steps || 0) + 1; this.lag = Math.max(this.lag, now - this.lastStep - 1000); this.lastStep = now;
    if (!c) return;
    let running = 0, soonest = Infinity;
    for (const b of this.bots.values()) {
      if (b.run) { running++; continue }
      if (!this.active(b)) continue;
      const go = this.slot(b, now); let due = go[0];
      if (this.rushing(now)) due = Math.min(due, c.rushFrom + this.t(c.ramp * (b.n / Math.max(1, c.bots)) + (b.n % 7) * 300));   // a rush brings everyone in over the ramp
      due = Math.max(due, b.next || 0);                                                // a short wait after something went wrong
      if (due <= now) { running++; this.start(b, go[1]) } else soonest = Math.min(soonest, due);
    }
    if (now - (this.reported || 0) >= REPORT_MS && (this.bots.size || this.open)) this.report(now);
    if (!running && !this.open) {                                                   // nobody online: sleep until the next session
      clearInterval(this.timer); this.timer = null;
      if (this.dirty) { this.dirty = false; this.persist().catch(() => { }) }
      if (soonest < Infinity) this.alarm2(soonest - now < 2 * MIN ? soonest : soonest - 30e3);
      return;
    }
    if (!this.alarmAt || this.alarmAt < now || this.alarmAt > now + WATCHDOG_MS * 2) this.alarm2(now + WATCHDOG_MS);   // wakes the fleet again if it was shut down
  }
  // The bot's time online now or next, [from, until]. Each UTC day: 2 to 3 hours, in one go or two (at least an hour
  // apart), at random times, so the same bot comes at different times every day.
  slot(b, now) {
    const D = this.t(DAY), day = Math.floor(now / D);
    if (!b.plan || b.plan.day < day) b.plan = this.planDay(day);
    let s = b.plan.slots.find(s => s[1] > now);
    if (!s) { b.plan = this.planDay(day + 1); s = b.plan.slots[0] }
    return s;
  }
  planDay(day) {
    const D = this.t(DAY), H = this.t(HOUR), t0 = day * D, all = rnd(2, 3) * H; let s;
    if (Math.random() < .5) { const a = rnd(0, D - all); s = [[a, a + all]] }
    else { const one = all * rnd(.35, .65), two = all - one, a = rnd(0, D - all - H), b = rnd(a + one + H, D - two); s = [[a, a + one], [b, b + two]] }
    this.dirty = true;
    return { day, slots: s.map(([a, b]) => [Math.round(t0 + a), Math.round(t0 + b)]) };
  }
  alarm2(at) { this.alarmAt = at; this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, at)).catch(() => { }) }

  start(b, until) {
    b.run = true; b.rush = this.rushing(); b.until = b.rush ? this.cfg.rushUntil : until;
    this.session(b).catch(e => { noteError(this.win, 'session: ' + (e && e.message || e)); b.next = Date.now() + this.t(rnd(1, 4) * MIN) })
      .finally(() => { b.run = false; b.rush = false; b.inMatch = b.inBattle = b.inGame = b.inMenu = false; b.invite = null; this.closeLobby(b); this.dirty = true });
  }

  // ---- talking to the game server
  async api(b, method, path, body, extra = {}) {
    const t0 = Date.now(); let status = 0, data = null, took = null;
    try {
      const r = await this.env.GAME.fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(b && b.token ? { authorization: 'Bearer ' + b.token } : {}), ...this.who(b), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      status = r.status; took = r.headers.get('x-took'); data = await r.json().catch(() => null);
    } catch (e) { noteError(this.win, path + ': ' + (e && e.message || e)) }
    // the server's own time when it says (a Durable Object's clock only moves at some events, so its own count can be off by seconds)
    const ms = took != null && took !== '' && Number.isFinite(Number(took)) ? Number(took) : Date.now() - t0; noteReq(this.win, groupOf(path), status, ms);
    if (ms > 1000) slow = [...slow.slice(-4), new Date(t0).toISOString().slice(14, 19) + ' ' + method + ' ' + path.split('?')[0].slice(0, 30) + ' ' + ms];   // which answers are slow, and when
    if (status >= 500) noteError(this.win, path + ' ' + status + ' ' + JSON.stringify(data || '').slice(0, 80));
    return { status, data };
  }
  who(b) { return b && this.env.SIM_KEY ? { 'x-sim-key': this.env.SIM_KEY, 'x-sim-cc': b.cc } : {} }   // the bot's own country, for its flag
  async socket(path, onMsg, b) {
    const t0 = Date.now(); let r;
    try { r = await this.env.GAME.fetch(BASE + path, { headers: { Upgrade: 'websocket', ...this.who(b) } }) } catch (e) { noteWs(this.win, false); noteError(this.win, 'socket: ' + (e && e.message || e)); return null }
    const ws = r.webSocket;
    if (!ws) { noteWs(this.win, false); noteError(this.win, 'socket ' + path.split('?')[0] + ' ' + r.status); return null }
    ws.accept(); noteWs(this.win, true, Date.now() - t0); this.open++;
    ws.addEventListener('message', ev => { const d = typeof ev.data === 'string' ? ev.data : ''; this.win.msgsIn++; this.win.bytesIn += d.length; try { onMsg(d) } catch (e) { } });
    const gone = () => { if (!ws.gone) { ws.gone = true; this.open-- } };
    ws.addEventListener('close', gone); ws.addEventListener('error', gone);
    return ws;
  }
  send(ws, obj) { if (!ws || ws.gone) return; const s = JSON.stringify(obj); try { ws.send(s); this.win.msgsOut++; this.win.bytesOut += s.length } catch (e) { } }
  shut(ws) { if (ws && !ws.gone) { try { ws.close(1000, 'bye') } catch (e) { } ws.gone = true; this.open-- } }

  // ---- one session: open the game, sit in the lobby, play game after game until its time is up, leave
  async session(b) {
    if (!b.token && !(await this.signup(b))) { b.next = Date.now() + this.t(rnd(2, 6) * MIN); return }
    const me = await this.api(b, 'GET', '/me');
    if (me.status === 401) { b.token = null; b.id = null; b.next = Date.now() + 5000; return }   // the account is gone: sign up again
    await Promise.all([this.api(b, 'GET', '/stats'), this.api(b, 'GET', '/prize'), this.api(b, 'POST', '/rewards', {})]);
    if (Math.random() < .3) await this.api(b, 'GET', '/ranking?period=week');
    if (Math.random() < .15) await this.api(b, 'GET', '/invites');
    if (Math.random() < .2) await this.api(b, 'GET', '/friends');
    await this.openLobby(b);
    while (this.keep(b) && Date.now() < b.until) {
      await this.menu(b, rnd(8, 60) * 1000);
      if (b.invite) { const m = b.invite; await m.done.catch(() => { }); b.invite = null; continue }   // another bot challenged this one
      if (!this.keep(b) || Date.now() >= b.until) break;
      await this.game(b);
    }
    this.closeLobby(b);
    b.next = Date.now() + this.t(5000);
  }
  async signup(b) {
    const r = await this.api(null, 'POST', '/auth/guest', { src: 'loadtest' }, { 'x-sim-key': this.env.SIM_KEY || '' });
    if (r.status !== 200 || !r.data || !r.data.token) return false;
    b.token = r.data.token; b.id = r.data.player.id; this.win.signups++; this.idsChanged = true;
    await this.persist().catch(() => { });                                           // never lose an account we made
    for (let i = 0; i < 4; i++) {
      const name = i ? nameFor(b.n, i) : b.name, s = await this.api(b, 'POST', '/me/name', { name });
      if (s.status === 200) { b.name = name; break }
      if (s.status === 429) break;
    }
    this.dirty = true; return true;
  }
  async openLobby(b) {
    if (b.lobby && !b.lobby.gone) return;
    b.lobbyAt = Date.now();
    b.lobby = await this.socket(`/lobby/ws?token=${encodeURIComponent(b.token)}&hidden=1`, raw => {
      if (raw.startsWith('{"t":"challenged"')) { try { const m = JSON.parse(raw); this.send(b.lobby, { t: 'decline', code: m.code, from: m.from && m.from.id, busy: true }) } catch (e) { } }
    }, b);
  }
  closeLobby(b) { if (b.lobby) { this.shut(b.lobby); b.lobby = null } }
  busy(b, on) { if (b.lobby && !b.lobby.gone) this.send(b.lobby, { t: 'busy', on }) }
  async menu(b, ms) {                                                               // on the menu: the game checks for attacks on its land every 12 s
    const end = Math.min(Date.now() + this.t(ms), b.until); b.inMenu = true;
    while (Date.now() < end && this.keep(b) && !b.invite) {
      if ((!b.lobby || b.lobby.gone) && Date.now() - (b.lobbyAt || 0) > 5000) await this.openLobby(b);
      if (b.land && Date.now() - (b.alertAt || 0) >= this.t(12e3)) { b.alertAt = Date.now(); await this.api(b, 'GET', '/map/alert') }
      await sleep(Math.min(1000, end - Date.now()));
    }
    b.inMenu = false;
  }
  async wait(b, ms) { const end = Date.now() + this.t(ms); while (Date.now() < end && this.keep(b)) await sleep(Math.min(1000, end - Date.now())) }

  async game(b) {
    const today = Math.floor(Date.now() / DAY); if (b.ad !== today) { b.ad = today; b.attacks = 0 }
    const r = Math.random(), pMap = b.attacks < 10 ? (b.rush ? .12 : .22) : 0, pOnline = b.rush ? .65 : b.prof.online;
    this.win.games++;
    if (r < pMap) return this.battle(b);
    if (r < pMap + pOnline && await this.duel(b)) return;
    return this.offline(b);
  }
  async offline(b) {
    const [start, played] = pick(OFFLINE);
    b.inGame = true; this.busy(b, true);
    try {
      await this.api(b, 'POST', '/started', { mode: start });
      await this.wait(b, rnd(1.5, 6) * MIN);
      if (this.keep(b)) await this.done(b, played, Math.random() < .55);
    } finally { b.inGame = false; this.busy(b, false) }
  }
  async done(b, mode, won) {
    const feed = moments(mode, won); await this.api(b, 'POST', '/played', feed ? { mode, feed } : { mode });
    const wk = weekStart(); if (b.wk !== wk) { b.wk = wk; b.week = 0 }
    const left = b.prof.budget - b.week; if (left <= 0) return;
    const amount = Math.max(5, Math.min(600, left, Math.round(rnd(.5, 1.5) * b.prof.per * (won ? 1 : .35))));
    const s = await this.api(b, 'POST', '/score', { amount });
    if (s.status === 200) { b.week += amount; this.dirty = true }
  }

  // ---- an online match against another bot of this fleet that is online too: the first one waiting; else, like a
  // friend's challenge, one on the menu; else wait up to 20 s for one
  async duel(b) {
    const peer = this.queue.shift();
    if (peer) { peer.taken = true; const m = { host: b, guest: peer.b }; m.done = this.play(m); peer.go(m); await m.done.catch(e => noteError(this.win, 'match: ' + (e && e.message || e))); return true }
    const free = [...this.bots.values()].filter(x => x !== b && x.run && x.inMenu && !x.invite && x.token && this.keep(x));
    if (free.length && Math.random() < .8) {
      const x = pick(free), m = { host: b, guest: x }; x.invite = m; m.done = this.play(m);
      await m.done.catch(e => noteError(this.win, 'match: ' + (e && e.message || e))); return true;
    }
    const e = { b }, m = await new Promise(res => { e.go = res; this.queue.push(e); setTimeout(() => { if (e.taken) return; const i = this.queue.indexOf(e); if (i >= 0) this.queue.splice(i, 1); res(null) }, this.t(20e3)) });
    if (!m) return false;
    await m.done.catch(() => { }); return true;
  }
  async play(m) {
    const A = m.host, B = m.guest, seen = [new Map(), new Map()], ws = [null, null];
    const until = (side, t, ms = 10e3) => seen[side].has(t) ? Promise.resolve(seen[side].get(t)) : new Promise((res, rej) => {
      const h = setTimeout(() => rej(new Error('no ' + t + ' in ' + Math.round(ms / 1000) + ' s')), ms); (m.wait = m.wait || []).push({ side, t, res: v => { clearTimeout(h); res(v) } }) });
    const on = side => raw => {
      if (raw.startsWith('{"t":"f"') || raw.startsWith('{"t":"auth"')) { const k = raw.indexOf('"ts":'); if (k > 0 && k < 24) noteRelay(this.win, Date.now() - Number(raw.slice(k + 5, k + 18))); return }
      let msg; try { msg = JSON.parse(raw) } catch (e) { return }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'over') m.over = true;
      seen[side].set(msg.t, msg); for (const w of (m.wait || []).filter(w => w.side === side && w.t === msg.t)) { m.wait.splice(m.wait.indexOf(w), 1); w.res(msg) }
    };
    try {
      const code = (await this.api(A, 'POST', '/match/new', {})).data; if (!code || !code.code) throw new Error('no match code');
      ws[0] = await this.socket(`/match/${code.code}/ws?token=${encodeURIComponent(A.token)}`, on(0), A); if (!ws[0]) throw new Error('host could not join');
      await until(0, 'seat'); this.send(ws[0], { t: 'host', hat: A.prof.hat });
      ws[1] = await this.socket(`/match/${code.code}/ws?token=${encodeURIComponent(B.token)}`, on(1), B); if (!ws[1]) throw new Error('guest could not join');
      await until(1, 'seat'); this.send(ws[1], { t: 'join', hat: B.prof.hat });
      await until(0, 'join');
      A.inMatch = B.inMatch = true; this.busy(A, true); this.busy(B, true);
      await Promise.all([this.api(A, 'POST', '/started', { mode: 'online' }), this.api(B, 'POST', '/started', { mode: 'online' })]);
      this.send(ws[0], { t: 'start', seed: Math.floor(Math.random() * 1e9), theme: pick(THEMES), count: 2, hats: [A.prof.hat, B.prof.hat] });
      await until(1, 'start'); this.win.matches++;
      const s = fakeSnap(), turns = Math.round(rnd(8, 14)); let holder = 0, frame = 0;
      for (let t = 0; t < turns && !m.over && this.keep(A) && this.keep(B); t++) {
        s.g.turnCount = t + 1;
        const end = Date.now() + this.t(rnd(8, 24) * 1000), shot = end - Math.min(3000, this.t(3000));
        while (Date.now() < end && !m.over && !ws[holder].gone) {
          frame += 3; const firing = Date.now() >= shot; moveSnap(s, holder, frame, end, firing);
          const e = firing && !s.hit ? (s.hit = true, [['carve', [Math.round(rnd(100, 1100)), Math.round(rnd(250, 500)), 38]], ['boom', [Math.round(rnd(100, 1100)), 400, 38]], ['sfx', 'boom']]) : [];
          this.send(ws[holder], { t: 'f', ts: Date.now(), n: frame, e, s });
          if (Math.random() < .003) this.send(ws[holder], { t: 'chat', id: Math.floor(Math.random() * 40) });
          await sleep(FRAME_MS);
        }
        s.hit = false;
        this.send(ws[holder], { t: 'auth', ts: Date.now(), n: frame, e: [], s }); holder = 1 - holder;
        await sleep(this.t(rnd(300, 900)));
      }
      const winner = Math.random() < .5 ? 0 : 1;
      if (!m.over) { this.send(ws[holder], { t: 'f', ts: Date.now(), n: frame + 3, e: [['gameOver', [winner]]], s }); await until(0, 'over').catch(() => { }) }
      this.win.matchesDone++;
      this.shut(ws[0]); this.shut(ws[1]); A.inMatch = B.inMatch = false; this.busy(A, false); this.busy(B, false);
      await Promise.all([this.done(A, 'online', winner === 0), this.done(B, 'online', winner === 1)]);
    } finally {
      if (ws[0] && !ws[0].gone && !m.over) this.send(ws[0], { t: 'bye' });
      this.shut(ws[0]); this.shut(ws[1]); A.inMatch = B.inMatch = false;
    }
  }

  // ---- a World Map battle: CPU land next to theirs (now and then another bot's), never a real player's
  async battle(b) {
    let st = (await this.api(b, 'GET', '/map')).data;
    if (!st || !st.me) return this.offline(b);
    if (!st.me.joined) { st = (await this.api(b, 'POST', '/map/join', { cc: b.cc })).data; if (!st || !st.me) return this.offline(b) }
    if (!st.me.tiles) { const r = await this.api(b, 'POST', '/map/buy', {}); if (r.status !== 200) return this.offline(b); st = r.data }
    b.land = st.me.tiles > 0; this.dirty = true;
    if (st.me.attacksLeft <= 0) { b.attacks = 10; return this.offline(b) }
    const owner = new Map(st.tiles.map(t => [t[0], t[1]])), mine = st.tiles.filter(t => t[1] === b.id).map(t => t[0]), bots = new Set(this.cfg.ids || []);
    const near = [...new Set(mine.flatMap(neighbours))].filter(t => !owner.has(t) || (owner.get(t) !== b.id && bots.has(owner.get(t)) && Math.random() < .3));
    if (!near.length) return this.offline(b);
    const tile = pick(near), a = await this.api(b, 'POST', '/map/attack', { tile });
    if (a.status === 429) { b.attacks = 10; return this.offline(b) }
    if (a.status !== 200 || !a.data || !a.data.ticket) return this.offline(b);
    b.attacks++; this.win.attacks++; b.inBattle = true; this.busy(b, true);
    try {
      if (a.data.wait) {                                                              // another bot's land: wait a little for its owner, then let the CPU defend
        for (let i = 0; i < 3; i++) { await sleep(this.t(3000)); const s = await this.api(b, 'GET', '/map/attack/' + a.data.ticket); if (s.data && s.data.state !== 'wait') break }
        await this.api(b, 'POST', '/map/cpu', { ticket: a.data.ticket });
      }
      await this.wait(b, rnd(50, 150) * 1000);
      if (!this.keep(b)) return;
      const win = Math.random() < .55, r = await this.api(b, 'POST', '/map/result', { ticket: a.data.ticket, win });
      if (r.status === 200 && win) {
        this.win.taken++;
        if (Math.random() < .3) await this.api(b, 'POST', '/map/defend', { tile, item: pick(['mines', 'bunker', 'arsenal', 'garrison']) });
      }
      if (Math.random() < .08) await this.api(b, 'POST', '/map/upgrade', { stat: pick(['acc', 'res']) });
      await this.done(b, 'map', win);
    } finally { b.inBattle = false; this.busy(b, false) }
  }

  // ---- numbers for Control
  snap() {
    const s = { bots: 0, accounts: 0, online: 0, inMatch: 0, inBattle: 0, inGame: 0, sockets: this.open, lag: this.lag, recent, slow, reports: this.reports || 0, reportErr: this.reportErr || null, steps: this.steps || 0, reportAt: this.reported || 0, age: this.born ? Date.now() - this.born : 0, gap: this.gap, colo: this.colo };
    if (!this.bots || !this.cfg) return s;
    for (const b of this.bots.values()) {
      if (this.active(b)) s.bots++; if (b.token) s.accounts++; if (b.lobby && !b.lobby.gone) s.online++;
      if (b.inMatch) s.inMatch++; if (b.inBattle) s.inBattle++; if (b.inGame) s.inGame++;
    }
    return s;
  }
  async report(now) {
    this.reported = now; const win = this.win; this.win = newWin();
    const snap = this.snap(); this.lag = 0;
    const ids = this.idsChanged ? [...this.bots.values()].filter(b => b.id).map(b => b.id) : undefined; this.idsChanged = false;
    if (this.dirty) { this.dirty = false; this.persist().catch(() => { }) }
    this.ctx.storage.put('alive', now).catch(() => { });
    try {
      const r = await this.env.CONTROL.get(this.env.CONTROL.idFromName('control')).fetch('https://control/report', { method: 'POST', body: JSON.stringify({ k: this.cfg.k, at: now, win, snap, ids }) });
      const c = await r.json().catch(() => null); if (c && c.v != null && (!this.cfg || c.v !== this.cfg.v || c.ids)) this.take(c);
      this.reports = (this.reports || 0) + 1; if (!r.ok) this.reportErr = 'report ' + r.status;
    } catch (e) { this.reportErr = 'report: ' + String(e && e.message || e).slice(0, 160) }
  }

  // ---- what slows the fleet's own requests: plain, with storage writes in between, with sockets open, or a POST
  async timing(mode) {
    const socks = [], out = [];
    if (mode === 2) for (let i = 0; i < 20; i++) { const w = await this.socket('/match/SIMTS2/watch', () => { }); if (w) socks.push(w) }
    for (let i = 0; i < 12; i++) {
      if (mode === 1) this.ctx.storage.put('t', i).catch(() => { });
      const t0 = Date.now(), r = await this.env.GAME.fetch(BASE + (mode === 3 ? '/match/new' : '/stats'), mode === 3 ? { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } } : {});
      await r.text(); out.push(Date.now() - t0); await sleep(300);
    }
    for (const w of socks) this.shut(w);
    return { mode, socks: socks.length, ms: out };
  }

  // ---- how many sockets one Durable Object can hold open through the service binding (a one-off check before the real thing)
  async probe({ n = 20, check = false, time = null }) {
    if (time != null) return this.timing(time);
    if (check) { const s = this.probeSocks || []; const open = s.filter(w => !w.gone).length, heard = s.filter(w => w.box.heard).length; for (const w of s) this.shut(w); this.probeSocks = []; return { check: true, kept: open, heard } }
    const t0 = Date.now(), socks = [];
    await Promise.all([...Array(Math.min(200, n))].map(async () => { const box = {}, w = await this.socket('/match/SIMTST/watch', () => { box.heard = true }); if (w) { w.box = box; socks.push(w) } }));
    const opened = socks.length; await sleep(8000); for (const w of socks) w.heard = w.box.heard;
    this.probeSocks = socks;
    return { asked: n, opened, heard: socks.filter(w => w.heard).length, ms: Date.now() - t0 };
  }
}
