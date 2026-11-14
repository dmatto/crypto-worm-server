import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { funnelHit, funnelText } from '../src/funnel.js';

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  return { DB: { prepare: q => stmt(q) }, sql };
}

test('funnel: counts steps per arrival day, platform and language, and nothing else', async () => {
  const env = makeEnv(), now = Date.UTC(2026, 10, 14, 12), d = '2026-11-14';
  for (let i = 0; i < 10; i++) await funnelHit(env, { s: 'open', p: 'tg', l: 'id', d, ms: 900 }, now);
  for (let i = 0; i < 8; i++) await funnelHit(env, { s: 'ready', p: 'tg', l: 'id', d, ms: 4000 }, now);
  for (let i = 0; i < 4; i++) await funnelHit(env, { s: 'end', p: 'tg', l: 'id', d, ms: 240e3 }, now);
  for (let i = 0; i < 6; i++) await funnelHit(env, { s: 'open', p: 'tg', l: 'en', d, ms: 500 }, now);
  await funnelHit(env, { s: 'start2', p: 'tg', l: 'id', d, ms: 9e9 }, now + 86400e3);              // the next day still counts for the day they arrived; a huge time is capped
  assert.equal(await funnelHit(env, { s: 'hack', p: 'tg' }, now), false);
  assert.equal(await funnelHit(env, { s: 'open', p: 'console' }, now), false);
  await funnelHit(env, { s: 'open', p: 'web', l: 'xx', d: '2020-01-01' }, now);                     // an unknown language is English, an old day is today
  const rows = env.sql.prepare('SELECT * FROM funnel ORDER BY plat, lang, step').all().map(r => ({ ...r }));
  assert.deepEqual(rows.find(r => r.step === 'start2'), { day: d, plat: 'tg', lang: 'id', step: 'start2', n: 1, ms: 3600e3 });
  assert.deepEqual(rows.find(r => r.plat === 'web'), { day: d, plat: 'web', lang: 'en', step: 'open', n: 1, ms: 0 });
  assert.deepEqual(Object.keys(rows[0]).sort(), ['day', 'lang', 'ms', 'n', 'plat', 'step']);       // no player, device or network
  const t = await funnelText(env, '7', now);
  assert.match(t, /<b>Telegram<\/b>\n1\. Opened the page: <b>16<\/b>\n2\. Game ready: <b>8<\/b> · 50% · after 4\.0 s/);
  assert.match(t, /5\. Finished the battle: <b>4<\/b> · 25% · after 4 min/);
  assert.match(t, /Finished, by language: id 40% of 10 · en 0% of 6/);
  assert.match(await funnelText(makeEnv(), '', now), /No first-match counts yet/);
});
