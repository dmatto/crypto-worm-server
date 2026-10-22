import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Stand-ins: node:sqlite for D1, Grok (X search, the writer and Grok Imagine) and Telegram's Bot API recorded in `calls`.
const calls = [], NOW = Date.UTC(2026, 9, 22, 12, 1);
const sid = t => (BigInt(t - 1288834974657) << 22n).toString();                 // an X post id posted at time t
const POSTS = [
  { id: sid(NOW - 3600e3), handle: '@cats', what: 'A cat at a desk, captioned working', likes: '126K', views: 1193307, topic: 'animals' },
  { id: sid(NOW - 7200e3), handle: '@film', what: 'Two actors do the Spider-Man pointing meme', likes: 71043, views: 876045, topic: 'movies' },
  { id: sid(NOW - 9000e3), handle: '@neighbor', what: 'Cats named Maximus, Mediumus and Minimus', likes: 50000, views: 303000, topic: 'animals' },
  { id: sid(NOW - 5 * 864e5), handle: '@old', what: 'Last week', likes: 99999, views: 1, topic: 'old' },                  // too old
  { id: sid(NOW - 3600e3 + 1), handle: '@madeup', what: 'Not in the search results', likes: 1, views: 1, topic: 'x' },   // not cited
  { id: sid(NOW - 1800e3), handle: '@seen', what: 'Used yesterday', likes: 1, views: 1, topic: 'x' },
];
const cited = POSTS.filter(p => p.handle !== '@madeup').map(p => ({ type: 'url_citation', url: 'https://x.com/i/status/' + p.id }));
let xai = { find: 0, write: 0, draw: 0 };
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url.startsWith('https://api.x.ai/v1/')) {
    const path = url.slice(20), body = JSON.parse(init.body);
    calls.push(['xai ' + path, body]);
    if (path === 'responses') { xai.find++; return Response.json({ output: [{ type: 'custom_tool_call' }, { type: 'message', content: [{ type: 'output_text', annotations: cited,
      text: 'Here:\n```json\n' + JSON.stringify({ posts: POSTS.map(p => ({ ...p, url: `https://x.com/${p.handle.slice(1)}/status/${p.id}` })) }) + '\n```' }] }], usage: { cost_in_usd_ticks: 6e9 } }) }
    if (path === 'chat/completions') { xai.write++; const urls = body.messages[1].content.match(/https:\/\/x\.com\/\S+/g);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ parodies: urls.slice(0, 3).map((u, i) => ({ url: u, idea: 'joke ' + i, scene: 'scene ' + i, caption: 'caption ' + i })) }) } }] }) }
    if (path === 'images/edits') { xai.draw++; return Response.json({ data: [{ b64_json: Buffer.from('JPEG' + xai.draw).toString('base64') }] }) }
  }
  const method = url.split('/').pop();
  if (init.body instanceof FormData) {
    const f = init.body, photo = f.get('photo');
    calls.push([method, { chat_id: Number(f.get('chat_id')), caption: f.get('caption'), reply_markup: JSON.parse(f.get('reply_markup')), upload: Buffer.from(await photo.arrayBuffer()).toString() }]);
    return Response.json({ ok: true, result: { photo: [{ file_id: 'small' }, { file_id: 'FILE' + calls.length }] } });
  }
  calls.push([method, JSON.parse(init.body)]);
  return Response.json({ ok: true, result: {} });
};
const { findPosts, postTime, parodyCron, parodyCommand, X_FOOTER } = await import('../src/parody.js');
const { cron } = await import('../src/bot.js');

function makeEnv() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, a = []) => ({ bind: (...b) => stmt(q, b), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => sql.prepare(q).run(...a), all: async () => ({ results: sql.prepare(q).all(...a) }) });
  const DB = { prepare: q => stmt(q), batch: async l => { const r = []; for (const s of l) r.push(await s.run()); return r } };
  sql.prepare('INSERT INTO players (id, name, tg_id, created) VALUES (1, ?, 501, 0), (2, ?, 502, 0)').run('Damian', 'Other');
  sql.prepare("INSERT INTO bot_kv (k, v) VALUES ('parody_seen', ?)").run(JSON.stringify([POSTS[5].id]));
  return { DB, sql, BOT_TOKEN: '123:BOT', XAI_API_KEY: 'xai-test', SESSION_SECRET: 's', SITE_URL: 'https://play.test', ADMIN_PLAYERS: '1,2' };
}
const sent = () => calls.filter(c => c[0] === 'sendPhoto' || c[0] === 'sendMessage');

test('an X post id carries the time it was posted', () => {
  assert.equal(postTime(sid(NOW)), NOW);
  assert.equal(postTime('2113069802650787850') > Date.UTC(2026, 9, 21), true);
});

test('only posts X search really returned, from the last day and not used before, are kept', async () => {
  const env = makeEnv(); const { posts, cost } = await findPosts(env, NOW, [POSTS[5].id]);
  assert.deepEqual(posts.map(p => p.handle), ['@cats', '@film', '@neighbor']);
  assert.equal(posts[0].url, 'https://x.com/cats/status/' + POSTS[0].id);
  assert.equal(posts[0].likes, 126000);
  assert.equal(cost, 6e9);
  const q = calls.findLast(c => c[0] === 'xai responses')[1];
  assert.equal(q.tools[0].type, 'x_search'); assert.equal(q.tools[0].from_date, '2026-10-21'); assert.match(q.input[0].content, /Today is 2026-10-22/);
  assert.match(q.input[0].content, /Skip politics/);
});

test('once a day from 12:00 UTC the admins get three parodies ready to post on X', async () => {
  const env = makeEnv(); calls.length = 0; xai = { find: 0, write: 0, draw: 0 };
  await parodyCron(env, NOW - 3 * 3600e3, async () => [501, 502], (e, m, b) => { calls.push([m, b]); return { ok: true } });
  assert.equal(xai.find, 0, 'nothing before 12:00 UTC');
  await cron(env, NOW);
  assert.deepEqual(xai, { find: 1, write: 1, draw: 3 });
  const photos = calls.filter(c => c[0] === 'sendPhoto');
  assert.equal(photos.length, 6, 'three parodies to each of the two admins');
  const first = photos[0][1];
  assert.equal(first.chat_id, 501); assert.equal(first.upload, 'JPEG1');
  assert.match(first.caption, /^caption 0\n\n🪱 Play free 👉 t\.me\/CryptoWormWarsBot\/play\?startapp=s_x\n\n— Parody of @cats \(❤️ 126K · 👁 1\.2M\): A cat at a desk/);
  const post = new URL(first.reply_markup.inline_keyboard[0][0].url);
  assert.equal(post.origin + post.pathname, 'https://x.com/intent/post');
  assert.equal(post.searchParams.get('text'), 'caption 0\n\n' + X_FOOTER + '\nhttps://x.com/cats/status/' + POSTS[0].id);
  assert.equal(first.reply_markup.inline_keyboard[1][0].url, 'https://x.com/cats/status/' + POSTS[0].id);
  assert.equal(photos[1][1].chat_id, 502); assert.equal(photos[1][1].photo, 'FILE' + (calls.indexOf(photos[0]) + 1), 'the second admin gets the uploaded photo by its file id');
  const seen = JSON.parse(env.sql.prepare("SELECT v FROM bot_kv WHERE k = 'parody_seen'").get().v);
  assert.deepEqual(seen.slice(0, 4), [POSTS[0].id, POSTS[1].id, POSTS[2].id, POSTS[5].id]);
  await cron(env, NOW + 60e3); await cron(env, NOW + 3600e3);
  assert.equal(xai.find, 1, 'one batch a day');
  await cron(env, NOW + 864e5);
  assert.equal(xai.find, 2, 'the next day makes a new one');
});

test('/parody makes a batch now; /parody off stops the daily one', async () => {
  const env = makeEnv(); calls.length = 0; xai = { find: 0, write: 0, draw: 0 };
  assert.match(await parodyCommand(env, ''), /about 2 minutes/);
  await cron(env, NOW - 6 * 3600e3);                                              // 06:01 UTC, asked: it runs now
  assert.equal(xai.find, 1);
  assert.match(await parodyCommand(env, 'off'), /off/);
  await cron(env, NOW + 864e5);
  assert.equal(xai.find, 1, 'off: no daily batch');
  await parodyCommand(env, ''); await cron(env, NOW + 864e5 + 60e3);
  assert.equal(xai.find, 2, 'but /parody still works');
  assert.match(await parodyCommand(env, 'on'), /12:00 UTC/);
  await cron(env, NOW + 2 * 864e5);
  assert.equal(xai.find, 3);
});

test('when nothing is safe to joke about, the admins are told', async () => {
  const env = makeEnv(); calls.length = 0;
  env.sql.prepare("UPDATE bot_kv SET v = ? WHERE k = 'parody_seen'").run(JSON.stringify(POSTS.map(p => p.id)));
  await cron(env, NOW);
  assert.equal(calls.filter(c => c[0] === 'sendPhoto').length, 0);
  assert.match(sent().at(-1)[1].text, /No worm parodies this time: nothing viral/);
});
