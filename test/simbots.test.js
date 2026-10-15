import test from 'node:test';
import assert from 'node:assert/strict';
import { nameFor, countryFor, profileFor } from '../sim/names.js';
import { hist, pct, newWin, noteReq, addWin, EDGES } from '../sim/stats.js';
import { Control } from '../sim/control.js';

// The load test's own pieces (sim/): names the server accepts, the numbers, and the safety brake.
const NICK = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{1,14}[\p{L}\p{N}]$/u;
const BLOCK = /(fuck|shit|bitch|cunt|nigg|fag|rape|nazi|hitler|porn|whore|slut|dick|pussy|admin|moderator|official|cryptoworm|crypto worm|whale|cwormteam|support)/i;

test('sim names: every bot gets a nickname the server accepts, a country and a play style of 4+ games a day', () => {
  for (let n = 0; n < 1000; n++) for (const again of [0, 1, 2]) {
    const s = nameFor(n, again);
    assert.ok(NICK.test(s) && !BLOCK.test(s.replace(/[\s_.\-]/g, '')) && !/^guest\b/i.test(s), s);
  }
  assert.equal(nameFor(7), nameFor(7)); assert.notEqual(nameFor(7), nameFor(7, 1));
  assert.match(countryFor(3), /^[A-Z]{2}$/);
  for (let n = 0; n < 500; n++) { const p = profileFor(n); assert.ok(p.sessions * p.gmin >= 4 && p.budget <= 1400 && p.budget >= 120) }
});

test('sim stats: windows add up, and the typical and slowest-5% times come out of the histogram', () => {
  const a = newWin(), b = newWin();
  for (let i = 0; i < 95; i++) noteReq(a, 'me', 200, 30);
  for (let i = 0; i < 5; i++) noteReq(b, 'map', 503, 900);
  noteReq(b, 'score', 429, 10); noteReq(b, 'map', 409, 10);
  const w = addWin(addWin(newWin(), a), b);
  assert.equal(w.req, 102); assert.equal(w.err, 5); assert.equal(w.lim, 1); assert.equal(w.rej, 1); assert.equal(w.by.map[1], 5);
  const p50 = pct(w.h, .5), p99 = pct(w.h, .99);
  assert.ok(p50 > 20 && p50 <= 35, p50); assert.ok(p99 > 700 && p99 <= 1200, p99);
  assert.equal(pct(hist(), .5), 0); assert.equal(EDGES.length + 1, hist().length);
});

test('sim control: orders, and the safety brake ends a rush when errors pass 5%', async () => {
  const store = new Map(), ctx = { storage: { get: async k => store.get(k), put: async (k, v) => void store.set(k, v) } };
  const c = new Control(ctx, {}); await c.load();
  assert.equal(c.cfg.mode, 'off');
  c.order('rush', 45); assert.equal(c.cfg.mode, 'rush'); assert.ok(Math.abs(c.cfg.rushUntil - Date.now() - 45 * 60e3) < 1000);
  c.order('rush', 9999); assert.ok(c.cfg.rushUntil - Date.now() <= 180 * 60e3);
  const now = Date.now(), pt = (t, req, err) => ({ t, req, err, wsErr: 0, p95: 100 });
  c.hist = [pt(now - 30e3, 400, 1), pt(now - 20e3, 400, 2), pt(now - 10e3, 400, 1)]; c.brake(now);
  assert.equal(c.cfg.mode, 'rush');                                                      // under 1%: keeps going
  c.hist = [pt(now - 30e3, 400, 30), pt(now - 20e3, 400, 30), pt(now - 10e3, 400, 30)]; c.brake(now);
  assert.equal(c.cfg.mode, 'life'); assert.match(c.cfg.brake.why, /8% errors/);
  c.order('life', 40); assert.equal(c.cfg.bots, 40); assert.equal(c.cfg.brake, null);
  c.order('off'); assert.equal(c.cfg.mode, 'off');
  const v = c.cfg.v; c.order('nonsense'); assert.equal(c.cfg.v, v);
});
