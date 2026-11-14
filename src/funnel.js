// First-match counters (2026-11-13): how far new devices get, from opening the page to a second battle, so we can see
// where new players leave. Counts only: a row is the UTC day the device first opened the game, a platform, a game language
// and a step. No player, device or network is stored. The game sends each step once per new device (crypto-worm.html FUNNEL).
const DAY = 86400e3;
export const FUNNEL_STEPS = ['open', 'ready', 'start', 'shot', 'end', 'start2'];
const PLATS = ['tg', 'web', 'app'], LANGS = ['en', 'es', 'pt', 'fr', 'de', 'ru', 'tr', 'zh', 'id'];
const day = t => new Date(t).toISOString().slice(0, 10);

// {s: step, p: platform, l: language, d: the day of the device's first open, ms: time since that open}
export async function funnelHit(env, body, now = Date.now()) {
  const b = body || {}, step = String(b.s || ''), plat = String(b.p || ''), lang = LANGS.includes(b.l) ? b.l : 'en';
  if (!env.DB || !FUNNEL_STEPS.includes(step) || !PLATS.includes(plat)) return false;
  const first = [0, 1, 2].map(k => day(now - k * DAY)).includes(b.d) ? b.d : day(now);   // a step up to two days later still counts for the day they arrived
  const ms = Math.max(0, Math.min(3600e3, Math.floor(Number(b.ms)) || 0));              // the averages ignore anything past an hour
  await env.DB.prepare(`INSERT INTO funnel (day, plat, lang, step, n, ms) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(day, plat, lang, step) DO UPDATE SET n = n + 1, ms = ms + excluded.ms`).bind(first, plat, lang, step, ms).run();
  return true;
}

const NAMES = { open: 'Opened the page', ready: 'Game ready', start: 'Started a battle', shot: 'Fired a shot', end: 'Finished the battle', start2: 'Started a second one' };
const PLAT_NAMES = { tg: 'Telegram', web: 'Web', app: 'App' };
const secs = ms => ms < 90e3 ? (ms / 1000).toFixed(ms < 10e3 ? 1 : 0) + ' s' : Math.round(ms / 60e3) + ' min';
// admins: /funnel [days]
export async function funnelText(env, arg, now = Date.now()) {
  const days = Math.max(1, Math.min(60, parseInt(arg, 10) || 7)), from = day(now - (days - 1) * DAY);
  const { results } = await env.DB.prepare('SELECT plat, lang, step, SUM(n) AS n, SUM(ms) AS ms FROM funnel WHERE day >= ? GROUP BY plat, lang, step').bind(from).all();
  if (!results.length) return 'No first-match counts yet. They start with the first new device after the update.';
  const out = [`📊 <b>First match of new devices, last ${days} day${days > 1 ? 's' : ''}</b>`];
  for (const p of PLATS) {
    const rows = results.filter(r => r.plat === p), sum = s => rows.filter(r => r.step === s).reduce((a, r) => [a[0] + r.n, a[1] + r.ms], [0, 0]), open = sum('open')[0];
    if (!open) continue;
    out.push('', `<b>${PLAT_NAMES[p]}</b>`);
    FUNNEL_STEPS.forEach((s, i) => { const [n, ms] = sum(s);
      out.push(`${i + 1}. ${NAMES[s]}: <b>${n.toLocaleString('en-US')}</b>${i ? ` · ${Math.round(n / open * 100)}%` : ''}${i && n && s !== 'start2' ? ` · after ${secs(ms / n)}` : ''}`) });
    const langs = LANGS.map(l => { const o = rows.find(r => r.lang === l && r.step === 'open'), e = rows.find(r => r.lang === l && r.step === 'end'); return o && o.n >= 5 ? [l, o.n, Math.round((e ? e.n : 0) / o.n * 100)] : null })
      .filter(Boolean).sort((a, b) => b[1] - a[1]);
    if (langs.length > 1) out.push('Finished, by language: ' + langs.map(([l, n, pc]) => `${l} ${pc}% of ${n}`).join(' · '));
  }
  out.push('', 'Each device counts once, on the day it first opened the game. The times are averages since the page opened.');
  return out.join('\n');
}
