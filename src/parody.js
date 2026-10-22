// Daily worm parodies of viral X posts (Damian 2026-10-22: "find the most viral posts every day and make a worm parody, to post
// on X"). Once a UTC day at PARODY_HOUR, Grok searches X for the last day's most viral posts that are safe to joke about, writes a
// Crypto Worm parody of the best three and draws each one with Grok Imagine from the brand character. The bot sends them to the
// admins with the post text and a "Post on X" button that opens X with the text ready and the original post quoted; the picture
// is saved from Telegram and added by hand. Nothing is ever posted by itself. Admins: /parody makes a batch now, /parody off|on
// stops or restarts the daily one. About $0.90 of xAI a day (the X search is most of it).
import { xai } from './worms.js';

export const PARODY_HOUR = 12, PARODIES = 3;
const FIND_MODEL = 'grok-4.7', MODEL = 'grok-4.7', IMAGE_MODEL = 'grok-imagine-image-2.0', DAY = 864e5, KEEP_SEEN = 60;
export const X_FOOTER = '🪱 Play free 👉 t.me/CryptoWormWarsBot/play?startapp=s_x';
const site = env => (env.SITE_URL || env.MENU_URL || 'https://play.cryptoworm.io/').replace(/\/+$/, '');
const kv = {
  get: (env, k) => env.DB.prepare('SELECT v FROM bot_kv WHERE k = ?').bind(k).first().then(r => r && r.v),
  set: (env, k, v) => env.DB.prepare('INSERT INTO bot_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v)).run(),
};

const AVOID = 'politics, politicians, elections, governments, war, the military, terrorism, violence, weapons, crime, police, accidents, ' +
  'disasters, deaths, illness, religion, sex or nudity, anything about children, hate, harassment, scam or fraud accusations against a named ' +
  'person, and any sad or tragic news';
const FIND = (today, since) => `Today is ${today} (UTC). Use X search to find the most viral X posts posted since ${since}, the ones with the most ` +
  'likes, reposts and views. Search broadly with high-engagement filters (for example min_faves:5000) and Top results, across meme culture, ' +
  'crypto, AI and tech, gaming, internet trends, sports moments, movies, TV and music, animals and funny everyday moments. ' +
  `Keep only posts that are safe and fun to parody with a cartoon worm. Skip ${AVOID}. ` +
  'Prefer posts with a clear funny or iconic moment, a meme format anyone gets, or a big crypto or tech moment. ' +
  'Answer with JSON only: {"posts":[{"url":"https://x.com/<handle>/status/<id>","handle":"@...","text":"the post\'s own text, word for word ' +
  '(empty if it has none)","what":"what the post says or shows, one line",' +
  '"likes":0,"reposts":0,"views":0,"topic":"..."}]} with up to 12 posts, most viral first.';
const WRITE = n => 'You write parodies for Crypto Worm, the mascot of $CWORM, an honest community meme coin on Solana that never rugs, and of ' +
  'Crypto Worm Wars, a free Worms-style artillery game in Telegram. Crypto Worm is a pink cartoon worm in a green army helmet with a gold star ' +
  'coin badge, with no arms. His voice: a confident, cheeky teenager. Funny, never mean.\n\n' +
  `From the viral X posts below, pick the ${n} that make the funniest worm parodies, on different topics. For each one write:\n` +
  '- "idea": the joke in one line.\n' +
  '- "scene": a picture prompt where Crypto Worm recreates the moment or meme of the post as a worm. Only cartoon worms, cartoon animals and ' +
  'objects: never a real person, a real face or a look-alike of anyone famous, and no logos, brand names, words, letters or numbers in the picture. ' +
  'Describe the setting, the composition and his expression in 2 or 3 sentences.\n' +
  '- "caption": the X post: the original post\'s own text rewritten as a Crypto Worm parody, so it reads almost like the original. Keep its ' +
  'wording, sentence structure, length, line breaks, capital letters, punctuation and emojis, and change only the few words that turn it ' +
  'into a joke about Crypto Worm, worms, $CWORM or crypto, like a classic parody of a famous line. If the post has no text, write one short ' +
  'line in the style of its format. At most 200 characters. $CWORM at most once, no extra hashtags. No financial advice, price predictions or ' +
  '"buy" calls, never joke about a person\'s looks: punch at the situation.\n' +
  `Skip any post about ${AVOID}.\n` +
  'Answer with JSON only: {"parodies":[{"url":"<the post url, exactly as given>","idea":"...","scene":"...","caption":"..."}]}';
const LOOK = 'Use the cartoon character from this image exactly as he is: a pink worm in a green army helmet with a round gold star coin badge, ' +
  'thick brown eyebrows and big round eyes. He has NO arms and NO hands. Polished stylized 3D cartoon like a modern animated movie, bright colors. ' +
  'Do not copy the reference background. No text, no letters, no words, no numbers and no logos anywhere in the picture. New scene: ';

// An X post id is a snowflake: the time it was posted is in its top bits.
export const postTime = id => { try { return Number(BigInt(id) >> 22n) + 1288834974657 } catch (e) { return 0 } };
const statusId = url => (String(url).match(/\/status\/(\d{6,25})/) || [])[1] || null;
const json = s => { const m = String(s || '').match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null };
const num = v => Math.max(0, Math.round(Number(String(v ?? '').replace(/[, ]/g, '').replace(/k$/i, '000').replace(/m$/i, '000000')) || 0));

// 1. Grok's X search: the day's viral posts. Only posts X search really returned (their ids are in its citations), posted in the last
// 36 hours and not used before are kept.
export async function findPosts(env, now = Date.now(), seen = [], model = FIND_MODEL) {
  const today = new Date(now).toISOString().slice(0, 10), since = new Date(now - DAY).toISOString().slice(0, 10);
  const d = await xai(env, 'responses', { model, input: [{ role: 'user', content: FIND(today, since) }],
    tools: [{ type: 'x_search', from_date: since, to_date: today }], max_tool_calls: 8 });
  const msg = (d.output || []).filter(o => o.type === 'message').flatMap(o => o.content || []);
  const cited = new Set(msg.flatMap(c => c.annotations || []).map(a => statusId(a.url)).filter(Boolean));
  const r = json(msg.map(c => c.text || '').join('\n')) || {}, old = new Set(seen);
  const posts = (Array.isArray(r.posts) ? r.posts : []).map(p => ({ ...p, id: statusId(p.url) }))
    .filter(p => p.id && cited.has(p.id) && !old.has(p.id) && now - postTime(p.id) < 1.5 * DAY && postTime(p.id) < now + 6e5)
    .map(p => ({ id: p.id, url: 'https://x.com/' + String(p.handle || 'i').replace(/^@/, '').replace(/[^\w]/g, '') + '/status/' + p.id,
      handle: String(p.handle || '').slice(0, 40), text: String(p.text || '').trim().slice(0, 500), what: String(p.what || '').slice(0, 300), topic: String(p.topic || '').slice(0, 60),
      likes: num(p.likes), reposts: num(p.reposts), views: num(p.views) }));
  return { posts, cost: d.usage && d.usage.cost_in_usd_ticks || 0 };
}

// 2. The parodies: an idea, a picture prompt and the post text for the best few.
export async function writeParodies(env, posts, n = PARODIES) {
  const list = posts.map(p => `- ${p.url} (${p.handle}, ${p.likes} likes, ${p.views} views, ${p.topic}): ${p.what}\n  Its text: ${p.text ? JSON.stringify(p.text) : '(none)'}`).join('\n');
  const d = await xai(env, 'chat/completions', { model: MODEL, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: WRITE(n) }, { role: 'user', content: list }] });
  const r = json(d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || {}, by = new Map(posts.map(p => [p.id, p]));
  return (Array.isArray(r.parodies) ? r.parodies : []).map(x => ({ post: by.get(statusId(x.url)), idea: String(x.idea || '').slice(0, 300),
    scene: String(x.scene || '').slice(0, 1200), caption: String(x.caption || '').trim().slice(0, 240) }))
    .filter(x => x.post && x.scene && x.caption).slice(0, n);
}

// 3. The picture: Grok Imagine from the brand character (the Crypto Worm avatar on the game site).
export async function drawParody(env, scene) {
  const d = await xai(env, 'images/edits', { model: IMAGE_MODEL, prompt: LOOK + scene, image: { url: site(env) + '/avatars/cworm.jpg', type: 'image_url' },
    aspect_ratio: '1:1', n: 1, response_format: 'b64_json' });
  const b = d.data && d.data[0] && d.data[0].b64_json; if (!b) return null;
  return Uint8Array.from(atob(b), c => c.charCodeAt(0));
}

export const xIntent = p => 'https://x.com/intent/post?text=' + encodeURIComponent(p.caption + '\n\n' + X_FOOTER + '\n' + p.post.url);
const short = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n);

// The whole batch: find, write, draw, then hand each finished parody to send(picture bytes, caption, buttons).
export async function makeParodies(env, send, now = Date.now(), seen = []) {
  const { posts } = await findPosts(env, now, seen);
  if (posts.length < 1) return { posts: 0, made: [] };
  const parodies = await writeParodies(env, posts);
  const pics = await Promise.all(parodies.map(p => drawParody(env, p.scene).catch(() => null)));
  const made = [];
  for (const [i, p] of parodies.entries()) {
    if (!pics[i]) continue;
    const s = p.post, stat = [s.likes && '❤️ ' + short(s.likes), s.views && '👁 ' + short(s.views)].filter(Boolean).join(' · ');
    const caption = `${p.caption}\n\n${X_FOOTER}\n\n— Parody of ${s.handle || 'a viral post'}${stat ? ' (' + stat + ')' : ''}: ${s.text ? '"' + s.text + '"' : s.what}`;
    const buttons = [[{ text: '𝕏 Post on X', url: xIntent(p) }], [{ text: '🔗 See the original', url: s.url }]];
    if (await send(pics[i], caption.slice(0, 1000), buttons)) made.push({ id: s.id, url: s.url, caption: p.caption, idea: p.idea });
  }
  return { posts: posts.length, made };
}

async function upload(env, chat_id, bytes, caption, buttons) {
  const form = new FormData();
  form.append('chat_id', String(chat_id)); form.append('caption', caption); form.append('reply_markup', JSON.stringify({ inline_keyboard: buttons }));
  form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'crypto-worm-parody.jpg');
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
  return r.json().catch(() => ({ ok: false }));
}

// Once a UTC day from PARODY_HOUR (the cron runs every minute), or right away after an admin's /parody. A claim in bot_kv makes
// sure two cron runs never make the same batch.
export async function parodyCron(env, now, admins, tg) {
  if (!env.XAI_API_KEY || !env.DB || !env.BOT_TOKEN) return;
  const day = new Date(now).toISOString().slice(0, 10), asked = await kv.get(env, 'parody_now');
  if (!asked && (new Date(now).getUTCHours() < PARODY_HOUR || await kv.get(env, 'parody_off') === '1')) return;
  const claim = asked ? await env.DB.prepare("DELETE FROM bot_kv WHERE k = 'parody_now' RETURNING v").first()
    : await env.DB.prepare("INSERT INTO bot_kv (k, v) VALUES ('parody_day', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE bot_kv.v < excluded.v RETURNING v").bind(day).first();
  if (!claim) return;
  const to = await admins(env); if (!to.length) return;
  let seen = []; try { seen = JSON.parse(await kv.get(env, 'parody_seen') || '[]') } catch (e) { }
  // the picture is uploaded once; the other admins get the same photo by its Telegram file id
  const send = async (bytes, caption, buttons) => { let photo = null, ok = false;
    for (const chat_id of to) {
      const r = photo ? await tg(env, 'sendPhoto', { chat_id, photo, caption, reply_markup: { inline_keyboard: buttons } }) : await upload(env, chat_id, bytes, caption, buttons);
      if (r && r.ok) { ok = true; const ph = r.result && r.result.photo; if (!photo && ph && ph.length) photo = ph[ph.length - 1].file_id } }
    return ok };
  for (const chat_id of to) await tg(env, 'sendMessage', { chat_id, text: '🪱 Today\'s worm parodies of viral X posts are on their way. For each: save the picture, tap Post on X and add it there.' });
  let r; try { r = await makeParodies(env, send, now, seen) } catch (e) { r = { error: String(e && e.message || e) } }
  if (r.made && r.made.length) await kv.set(env, 'parody_seen', JSON.stringify([...r.made.map(m => m.id), ...seen].slice(0, KEEP_SEEN)));
  else for (const chat_id of to) await tg(env, 'sendMessage', { chat_id, text: '🪱 No worm parodies this time' + (r.error ? ' (Grok: ' + r.error.slice(0, 200) + ')' : ': nothing viral was safe to joke about.') + ' Send /parody to try again.' });
  await env.DB.prepare('INSERT INTO bot_log (at, note) VALUES (?, ?)').bind(Date.now(), 'parody ' + JSON.stringify({ posts: r.posts, made: (r.made || []).length, error: r.error })).run().catch(() => { });
}
// /parody (admins): now | off | on
export async function parodyCommand(env, arg) {
  const a = String(arg || '').trim().toLowerCase();
  if (a === 'off') { await kv.set(env, 'parody_off', '1'); return '🪱 Daily worm parodies are off. /parody on starts them again.' }
  if (a === 'on') { await kv.set(env, 'parody_off', '0'); return `🪱 Daily worm parodies are on: every day at ${PARODY_HOUR}:00 UTC.` }
  if (!env.XAI_API_KEY) return 'Grok is not set up on the server (XAI_API_KEY).';
  await kv.set(env, 'parody_now', String(Date.now()));
  return '🪱 Making worm parodies of today\'s viral X posts. They arrive here in about 2 minutes.';
}
