// Crypto Worm Wars load test (Cloudflare Worker "crypto-worm-sim"). Simulated players play the live game through the
// service binding GAME (see fleet.js), Control (control.js) holds the orders and the numbers, and this page shows them:
//   GET /             the live dashboard (anyone with the link; it only shows totals)
//   GET /api/state    the same numbers as JSON
// Orders come from the game bot's admin /sim (rows in D1 sim_cmd), read by the cron every minute. Deploy with
// python3 tools/deploy_sim.py. The game server marks these accounts in sim_players (they never get the weekly prize).
import { Fleet } from './fleet.js';
import { Control } from './control.js';
export { Fleet, Control };

const control = env => env.CONTROL.get(env.CONTROL.idFromName('control'));
const same = (a, b) => { a = String(a || ''); b = String(b || ''); if (!a || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0 };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/state') {
      const r = await control(env).fetch('https://control/state');
      return new Response(r.body, { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/tick' && req.method === 'POST') {                         // the game server's cron starts the minute too
      if (!env.SIM_KEY || !same(req.headers.get('x-sim-key'), env.SIM_KEY)) return new Response('no', { status: 403 });
      const r = await control(env).fetch('https://control/tick'), d = await r.json().catch(() => ({}));
      return Response.json({ mode: d.mode, online: d.online, rpm: d.rpm, p95: d.p95, errPct: d.errPct, errors: d.errors, fleets: d.fleetErrors, diag: d.diag });
    }
    if (url.pathname === '/' || url.pathname === '/index.html') return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    return new Response('not found', { status: 404 });
  },
  async scheduled(ev, env, ctx) {                                                  // row at = 0: the last minute's tick, or what went wrong
    const note = d => env.DB.prepare('INSERT OR REPLACE INTO sim_stats (at, data) VALUES (0, ?)').bind(JSON.stringify({ tick: Date.now(), ...d })).run().catch(() => { });
    ctx.waitUntil(control(env).fetch('https://control/tick').then(async r => note({ status: r.status, mode: r.ok ? (await r.json()).mode : await r.text() })).catch(e => note({ error: String(e && e.stack || e).slice(0, 500) })));
  },
};

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crypto Worm Wars load test</title>
<style>
:root{--bg:#0a1426;--card:#111f3a;--line:#22365e;--text:#e8eefc;--dim:#a9b6d3;--gold:#ffc940;--ice:#7fd8ff;--ok:#2fe38a;--bad:#ff5a6e;--warn:#ffb340}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1080px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:24px;margin:0;line-height:1.2}.sub{color:var(--dim);font-size:14px;margin:4px 0 16px}
.mode{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;background:var(--card);border:1px solid var(--line);font-weight:700;font-size:14px;margin-bottom:16px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--dim)}.dot.on{background:var(--ok);box-shadow:0 0 10px var(--ok)}.dot.rush{background:var(--gold);box-shadow:0 0 10px var(--gold)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;min-width:0}
.tile .k{color:var(--dim);font-size:13px}.tile .v{font-size:30px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.15;margin-top:2px}.tile .s{color:var(--dim);font-size:13px;margin-top:2px}
.tile.big{grid-column:span 2;border-color:rgba(255,201,64,.55);background:linear-gradient(135deg,rgba(255,201,64,.16),rgba(255,120,40,.06))}.tile.big .v{font-size:44px;color:var(--gold)}
.good{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.chart{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-top:12px}
.chart h2{font-size:15px;margin:0 0 6px}.legend{display:flex;flex-wrap:wrap;gap:14px;color:var(--dim);font-size:13px;margin-bottom:6px}.legend i{display:inline-block;width:12px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}
canvas{width:100%;height:220px;display:block}
.note{color:var(--dim);font-size:13px;margin-top:18px;max-width:760px}
@media (max-width:520px){.tile.big{grid-column:span 1}.tile .v{font-size:26px}.tile.big .v{font-size:36px}}
</style></head><body><main>
<h1>🪱 Crypto Worm Wars: live load test</h1>
<div class="sub">The live game server on Cloudflare, with simulated players on top of the real ones. Updates every 5 seconds.</div>
<div class="mode"><span class="dot" id="dot"></span><span id="mode">Loading…</span></div>
<div class="grid">
  <div class="tile big"><div class="k">Players online now (game server count)</div><div class="v" id="online">–</div><div class="s" id="online2"></div></div>
  <div class="tile"><div class="k">Simulated players online</div><div class="v" id="bots">–</div><div class="s" id="bots2"></div></div>
  <div class="tile"><div class="k">Server requests per minute</div><div class="v" id="rpm">–</div><div class="s" id="rpm2"></div></div>
  <div class="tile"><div class="k">Answer time</div><div class="v" id="p50">–</div><div class="s" id="p95"></div></div>
  <div class="tile"><div class="k">Errors</div><div class="v" id="err">–</div><div class="s" id="err2"></div></div>
  <div class="tile"><div class="k">Live match messages</div><div class="v" id="msgs">–</div><div class="s" id="msgs2"></div></div>
  <div class="tile"><div class="k">Match message delivery</div><div class="v" id="relay">–</div><div class="s" id="relay2"></div></div>
  <div class="tile"><div class="k">Online matches started</div><div class="v" id="mpm">–</div><div class="s">per minute</div></div>
  <div class="tile"><div class="k">World Map battles started</div><div class="v" id="apm">–</div><div class="s">per minute</div></div>
  <div class="tile"><div class="k">Players in all</div><div class="v" id="players">–</div><div class="s">everyone who has played</div></div>
</div>
<div class="chart"><h2>Last hour</h2>
  <div class="legend"><span><i style="background:var(--gold)"></i>players online</span><span><i style="background:var(--ice)"></i>requests per minute</span><span><i style="background:var(--bad)"></i>slowest 5% answer time (ms)</span></div>
  <canvas id="c"></canvas></div>
<p class="note">Simulated players are test accounts the Crypto Worm team runs on Cloudflare to load-test the live game. They sign in, sit in the lobby, play offline and online matches (about 20 updates a second while a turn runs) and fight World Map battles, like the game on a phone does. They count in the game's numbers, but never in the weekly prize, never attack real players' land, and their matches aren't in Live now. Answer times are measured inside Cloudflare, without the phone's own internet.</p>
</main>
<script>
const $=id=>document.getElementById(id), fmt=n=>n==null?'–':Number(n).toLocaleString('en-US');
const ms=n=>n==null?'–':n>=1000?(n/1000).toFixed(1)+' s':Math.round(n)+' ms';
function tone(el,v,good,warn){el.classList.remove('good','warn','bad');el.classList.add(v<=good?'good':v<=warn?'warn':'bad')}
async function load(){
  let d; try{ d=await (await fetch('/api/state',{cache:'no-store'})).json() }catch(e){ $('mode').textContent='Can\\'t reach the load test right now'; return }
  const n=d.now, c=d.cfg, t=new Date(c.rushUntil);
  $('dot').className='dot'+(c.mode==='rush'?' rush':c.mode==='life'?' on':'');
  $('mode').textContent=c.mode==='rush'?'Rush: all '+fmt(c.bots)+' simulated players online until '+t.toUTCString().slice(17,22)+' UTC':c.mode==='life'?'Normal days: '+fmt(c.bots)+' simulated players, each online 2 to 3 hours a day at changing times':'Off: no simulated players playing';
  if(c.brake) $('mode').textContent+=' · safety brake: '+c.brake.why;
  $('online').textContent=fmt(n.serverOnline); $('online2').textContent=n.serverPlaying!=null?fmt(n.serverPlaying)+' of them in a game':'';
  $('bots').textContent=fmt(n.online); $('bots2').textContent=fmt(n.inMatch)+' in online matches · '+fmt(n.inBattle)+' in map battles · '+fmt(n.inGame)+' in offline games';
  $('rpm').textContent=fmt(n.rpm); $('rpm2').textContent=fmt(Math.round(n.rpm/60))+' a second';
  $('p50').textContent=ms(n.p50); $('p95').textContent='typical; slowest 5%: '+ms(n.p95); tone($('p50'),n.p50,150,500);
  $('err').textContent=(n.errPct||0)+'%'; $('err2').textContent=fmt(n.rpm?Math.round(n.rpm*n.errPct/100):0)+' in the last minute'; tone($('err'),n.errPct,0.5,2);
  $('msgs').textContent=fmt(n.msgsPerSec)+'/s'; $('msgs2').textContent=fmt(n.kbPerSec)+' KB a second';
  $('relay').textContent=ms(n.relay50); $('relay2').textContent='typical; slowest 5%: '+ms(n.relay95); tone($('relay'),n.relay50,100,300);
  $('mpm').textContent=fmt(n.matchesPerMin); $('apm').textContent=fmt(n.attacksPerMin); $('players').textContent=fmt(n.players);
  draw(d.hist);
}
function draw(h){
  const cv=$('c'), r=window.devicePixelRatio||1, W=cv.clientWidth, H=cv.clientHeight; cv.width=W*r; cv.height=H*r;
  const x=cv.getContext('2d'); x.scale(r,r); x.clearRect(0,0,W,H); if(!h||h.length<2) return;
  const t0=h[0].t, t1=h[h.length-1].t||t0+1, X=t=>8+(W-16)*(t-t0)/Math.max(1,t1-t0);
  const css=v=>getComputedStyle(document.documentElement).getPropertyValue(v);
  const line=(get,col)=>{ const v=h.map(get), mx=Math.max(1,...v)*1.15; x.strokeStyle=css(col); x.lineWidth=2; x.beginPath();
    h.forEach((p,i)=>{ const y=H-10-(H-24)*(v[i]/mx); i?x.lineTo(X(p.t),y):x.moveTo(X(p.t),y) }); x.stroke(); return mx };
  x.strokeStyle=css('--line'); x.lineWidth=1; for(let i=1;i<4;i++){ x.beginPath(); x.moveTo(8,H*i/4); x.lineTo(W-8,H*i/4); x.stroke() }
  line(p=>p.server??p.online,'--gold'); line(p=>p.req*6,'--ice'); line(p=>p.p95,'--bad');
  x.fillStyle=css('--dim'); x.font='12px system-ui'; x.fillText(new Date(t0).toUTCString().slice(17,22)+' UTC',8,H-1); const s=new Date(t1).toUTCString().slice(17,22)+' UTC'; x.fillText(s,W-8-x.measureText(s).width,H-1);
}
load(); setInterval(load,5000); addEventListener('resize',load);
</script></body></html>`;
