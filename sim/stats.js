// Counters for the load test: what the simulated players did in a 10-second window, and answer times as histograms
// (so windows from many fleets add up and still give a typical and a slowest-5% time).

export const EDGES = [5, 10, 20, 35, 50, 75, 100, 150, 250, 400, 700, 1200, 2000, 3500, 6000, 10000];
const slot = ms => { let i = 0; while (i < EDGES.length && ms > EDGES[i]) i++; return i };
export const hist = () => new Array(EDGES.length + 1).fill(0);
export function addHist(a, b) { for (let i = 0; i < a.length; i++) a[i] += b[i] || 0; return a }
// the time below which share p of the answers came (linear inside a bucket)
export function pct(h, p) {
  const n = h.reduce((s, x) => s + x, 0); if (!n) return 0;
  let want = n * p, lo = 0;
  for (let i = 0; i < h.length; i++) {
    const hi = i < EDGES.length ? EDGES[i] : EDGES[EDGES.length - 1] * 2;
    if (want <= h[i]) return Math.round(lo + (hi - lo) * (h[i] ? want / h[i] : 0));
    want -= h[i]; lo = hi;
  }
  return lo;
}

export const GROUPS = ['auth', 'me', 'map', 'match', 'game', 'score', 'rank', 'other'];
export function groupOf(path) {
  if (path.startsWith('/auth')) return 'auth';
  if (path === '/me' || path.startsWith('/me/') || path === '/stats' || path === '/online' || path === '/rewards') return 'me';
  if (path.startsWith('/map')) return 'map';
  if (path.startsWith('/match')) return 'match';
  if (path === '/started' || path === '/played') return 'game';
  if (path === '/score') return 'score';
  if (path.startsWith('/ranking') || path.startsWith('/prize')) return 'rank';
  return 'other';
}

export function newWin() {
  return { req: 0, err: 0, rej: 0, lim: 0, h: hist(), by: Object.fromEntries(GROUPS.map(g => [g, [0, 0, 0]])),   // by group: [requests, errors, total ms]
    ws: 0, wsErr: 0, wsH: hist(), relayH: hist(), msgsOut: 0, msgsIn: 0, bytesOut: 0, bytesIn: 0, matches: 0, matchesDone: 0, attacks: 0, taken: 0,
    games: 0, signups: 0, errors: [] };
}
export function noteReq(w, group, status, ms) {
  w.req++; w.h[slot(ms)]++; const g = w.by[group] || w.by.other; g[0]++; g[2] += ms;
  if (status === 429) w.lim++;                                       // the server's own limits (too soon, too many attacks): expected
  else if (status === 0 || status >= 500) { w.err++; g[1]++ }
  else if (status >= 400) w.rej++;                                    // refused for a game reason (that land was just taken...)
}
export function noteWs(w, ok, ms) { w.ws++; if (!ok) w.wsErr++; else w.wsH[slot(ms)]++ }
export function noteRelay(w, ms) { w.relayH[slot(Math.max(0, ms))]++ }
export function noteError(w, text) { if (w.errors.length < 5) w.errors.push(String(text).slice(0, 160)) }

export function addWin(a, b) {
  for (const k of ['req', 'err', 'rej', 'lim', 'ws', 'wsErr', 'msgsOut', 'msgsIn', 'bytesOut', 'bytesIn', 'matches', 'matchesDone', 'attacks', 'taken', 'games', 'signups']) a[k] += b[k] || 0;
  addHist(a.h, b.h); addHist(a.wsH, b.wsH); addHist(a.relayH, b.relayH);
  for (const g of GROUPS) if (b.by && b.by[g]) for (let i = 0; i < 3; i++) a.by[g][i] += b.by[g][i];
  for (const e of b.errors || []) if (a.errors.length < 8) a.errors.push(e);
  return a;
}
