// Custom photo worms (Damian 2026-10-17): a $CWORM holder turns a photo of themselves or their pet into their own Crypto
// Worm portrait, paid for with in-game play money for now (Telegram Stars or real $CWORM later: `pay` says how).
// The photo is checked by Grok vision (one adult or one pet, nobody famous, nothing unsafe), then Grok Imagine draws four
// portraits and the player keeps one. The photo itself is never stored. The kept portrait shows in the ranking, on Home and
// in battles (online too: index.js passes its id to the match), while the player holds; admins see each new one in
// Telegram and /wormoff removes one.
//   GET  /worm                      -> {on, price, pay, holder, worm, shown, offer, left, why}   what the Custom Worm page shows
//                                      why: holder | banned | off | today | busy (why a new one can't be made now)
//   POST /worm/make {photo}         -> {offer: {job, kind, opts: [id]}}   photo: a JPEG/PNG/WebP data URL (the game sends ~768 px);
//                                      turned down: {error, code} (a WHY key)
//   POST /worm/pick {id}            -> {worm}            keeps that portrait; the other options are deleted
//   POST /worm/remove               -> {worm: null}      back to the normal worm
//   POST /worm/report {id}          -> {ok}              someone else's portrait looks wrong: the admins get it
//   GET  /worm/img/<id>.jpg         the portrait (no sign-in: the ids are random)
// The price is play money the game takes from its own wallet once the portraits are made (the server never sees that
// wallet), so the limits here are what keep the cost of the pictures in check.
export const PRICE = 2500;                       // play $CWORM for four portraits
export const MAKES_PER_DAY = 1, TRIES_PER_DAY = 6, ADMIN_MAKES = 10, ALL_PER_DAY = 60, OFFER_DAYS = 3, REPORTS_PER_DAY = 10;
const MAX_PHOTO = 1_600_000, ID = /^[a-z0-9]{12,24}$/, OPTIONS = 4;
const IMAGE_MODEL = 'grok-imagine-image-2.0', VISION_MODEL = 'grok-4.20-0309-non-reasoning', XAI = 'https://api.x.ai/v1/';

const CHECK = 'You check photos that players upload to become a cartoon worm character in a PG-13 game. Look at the photo and answer with JSON only: ' +
  '{"subject":"person"|"pet"|"other","adult":true|false|null,"famous":true|false,"unsafe":true|false,"reason":"<short>"}. ' +
  'subject: the main subject is one real person, or one animal (pet), or anything else (drawings, memes, objects, several people, no clear subject). ' +
  'adult: for a person, true only if they clearly look 18 or older; null for pets and other. famous: true if the person looks like a celebrity, politician or other well-known public figure, ' +
  'or the photo is clearly a press, movie or event picture of someone famous. unsafe: nudity, sexual content, violence, gore, hate symbols, drugs or weapons as the focus.';
const LOOK = 'in a polished stylized 3D cartoon style like a modern animated movie, with no arms, no hands, no legs and no paws. Half-body portrait, centered, ' +
  'on a flat purple-blue gradient background with a few gold sparkles. No text, no letters, no logos.';
const DRAW = {
  person: 'Turn the person in this photo into a character that is clearly a WORM, not a human: the same smooth rounded pink worm head and segmented worm body as our mascot, ' +
    'no human nose, no ears, no neck, no shoulders. A cute pink cartoon worm character with big round expressive eyes and thick eyebrows, ' + LOOK +
    ' Keep only what makes them recognizable, as accessories on the worm: hair color and hairstyle as a little tuft on top, glasses, beard, a scarf or collar in their clothing colors.',
  pet: 'Turn the pet in this photo into a cute cartoon worm character: a smooth rounded segmented worm body in the colors of its fur, keeping its snout or beak, ears, ' +
    'fur color and markings, and any collar or bandana, with big round expressive eyes, ' + LOOK,
};
// Why a photo was turned down or a new portrait can't be made now (the game shows its own translated text for each code).
export const WHY = {
  other: 'We could not find one person or one pet in that photo. Try a clear photo of just you or just your pet.',
  famous: 'That looks like a famous person. Use a photo of yourself.',
  young: 'Use a photo of yourself (adults only) or of your pet.',
  unsafe: 'That photo can not be used. Try another one.',
  holder: 'Custom worms are for holders.', banned: 'Custom worms are turned off for this account.', off: 'Custom worms are resting right now. Try again later.',
  today: 'You can make a new one tomorrow.', busy: 'Lots of worms were drawn today. Try again tomorrow.',
  photo: 'Send a JPEG, PNG or WebP photo under 1 MB.', retry: 'Busy right now. Try again in a minute.', gone: 'That portrait is gone. Make a new one.',
};
const no = (code, status) => ({ error: WHY[code], code, status });

const day0 = now => Math.floor(now / 864e5) * 864e5;
const newId = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4);
export const admins = env => new Set(String(env.ADMIN_PLAYERS || '').split(',').map(Number).filter(n => n > 0));
// The portrait a player shows right now: only while they hold (tier from holders.js), or always for an admin.
export const shows = (env, id, tier) => tier > 0 || admins(env).has(id);
export async function mine(env, id, tier) {
  if (!shows(env, id, tier)) return null;
  const r = await env.DB.prepare("SELECT id FROM custom_worms WHERE player = ? AND state = 'on'").bind(id).first().catch(() => null);
  return r ? r.id : null;
}
const mimeOf = b64 => b64.startsWith('iVBOR') ? 'image/png' : b64.startsWith('UklGR') ? 'image/webp' : 'image/jpeg';

async function xai(env, path, body) {
  const r = await fetch(XAI + path, { method: 'POST', headers: { authorization: 'Bearer ' + env.XAI_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('xai ' + r.status + ' ' + String(d.error && (d.error.message || d.error) || d.code || '').slice(0, 200));
  return d;
}
// Grok vision on the photo: what is in it, and is it fine to use.
export async function check(env, photo) {
  const d = await xai(env, 'chat/completions', { model: VISION_MODEL, temperature: 0, response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: photo } }, { type: 'text', text: CHECK }] }] });
  let v; try { v = JSON.parse(d.choices[0].message.content) } catch (e) { throw new Error('the photo check gave no answer') }
  const why = v.unsafe ? 'unsafe' : v.subject === 'pet' ? null : v.subject !== 'person' ? 'other' : v.famous ? 'famous' : v.adult !== true ? 'young' : null;
  return { kind: v.subject === 'pet' ? 'pet' : 'person', why, note: String(v.reason || '').slice(0, 200) };
}
const draw = (env, photo, kind) => xai(env, 'images/edits', { model: IMAGE_MODEL, prompt: DRAW[kind], image: { url: photo, type: 'image_url' }, n: 1, response_format: 'b64_json' })
  .then(d => d.data && d.data[0] && d.data[0].b64_json || null);

async function state(env, me, tier, now) {
  const isAdmin = admins(env).has(me.id), holder = tier > 0 || isAdmin, d = day0(now);
  const q = (s, ...v) => env.DB.prepare(s).bind(...v);
  const [worm, offer, made, tried, all, banned] = await Promise.all([
    q("SELECT id FROM custom_worms WHERE player = ? AND state = 'on'", me.id).first(),
    q("SELECT id, job, kind FROM custom_worms WHERE player = ? AND state = 'offer' ORDER BY rowid", me.id).all().then(r => r.results),
    q('SELECT COUNT(*) AS n FROM worm_makes WHERE player = ? AND at >= ? AND ok = 1', me.id, d).first(),
    q('SELECT COUNT(*) AS n FROM worm_makes WHERE player = ? AND at >= ? AND ok < 2', me.id, d).first(),
    q('SELECT COUNT(*) AS n FROM worm_makes WHERE at >= ? AND ok = 1', d).first(),
    q('SELECT 1 AS y FROM worm_makes WHERE player = ? AND ok = 2', me.id).first(),
  ]);
  const left = Math.max(0, (isAdmin ? ADMIN_MAKES : MAKES_PER_DAY) - made.n);
  const why = !holder ? 'holder' : banned ? 'banned' : !env.XAI_API_KEY ? 'off' : !left || tried.n >= (isAdmin ? ADMIN_MAKES * 2 : TRIES_PER_DAY) ? 'today' : all.n >= ALL_PER_DAY && !isAdmin ? 'busy' : null;
  const job = offer.length ? { job: offer[0].job, kind: offer[0].kind, opts: offer.filter(o => o.job === offer[0].job).map(o => o.id) } : null;
  return { on: true, price: PRICE, pay: 'cworm', holder, worm: worm ? worm.id : null, shown: !!worm && shows(env, me.id, tier), offer: job, left, why };
}

// tell(photoUrl, caption) sends the admins a picture through the bot. origin is this server's address, for those links.
export async function handle(path, req, env, me, body, { tier = 0, tell = async () => { }, origin = env.PUBLIC_URL || '', now = Date.now() } = {}) {
  const q = (s, ...v) => env.DB.prepare(s).bind(...v);
  if (path === '/worm' && req.method === 'GET') return state(env, me, tier, now);
  if (req.method !== 'POST') return null;
  if (path === '/worm/make') {
    const s = await state(env, me, tier, now); if (s.why) return no(s.why, 403);
    const photo = String(body.photo || '');
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > MAX_PHOTO) return no('photo', 400);
    const log = (ok, why) => q('INSERT INTO worm_makes (player, at, ok, why) VALUES (?, ?, ?, ?)', me.id, now, ok, why ? String(why).slice(0, 300) : null).run();
    let c; try { c = await check(env, photo) } catch (e) { return no('retry', 502) }
    if (c.why) { await log(0, c.why + ': ' + c.note); return no(c.why, 422) }
    const errs = [], one = () => draw(env, photo, c.kind).catch(e => { errs.push(String(e && e.message || e).slice(0, 120)); return null });
    let pics = (await Promise.all(Array.from({ length: OPTIONS }, one))).filter(Boolean);
    if (pics.length < OPTIONS) pics = pics.concat((await Promise.all(Array.from({ length: OPTIONS - pics.length }, one))).filter(Boolean));   // one more go for the ones that failed
    if (!pics.length) { await log(0, 'no pictures: ' + errs[0]); return no('retry', 502) }
    const job = newId(), ids = pics.map(() => newId());
    await env.DB.batch([
      q("DELETE FROM custom_worms WHERE player = ? AND state = 'offer'", me.id),          // an older set nobody picked from
      ...pics.map((b64, i) => q("INSERT INTO custom_worms (id, player, job, kind, state, img, pay, created) VALUES (?, ?, ?, ?, 'offer', ?, 'cworm', ?)", ids[i], me.id, job, c.kind, b64, now)),
      q('INSERT INTO worm_makes (player, at, ok, why) VALUES (?, ?, 1, ?)', me.id, now, c.kind + ' ' + pics.length + (errs.length ? ' · ' + errs.length + ' failed: ' + errs[0] : '')),
    ]);
    return { offer: { job, kind: c.kind, opts: ids }, price: PRICE, pay: 'cworm' };
  }
  if (path === '/worm/pick') {
    const id = String(body.id || ''), row = ID.test(id) && await q("SELECT id, job FROM custom_worms WHERE id = ? AND player = ? AND state = 'offer'", id, me.id).first();
    if (!row) return no('gone', 404);
    await env.DB.batch([q('DELETE FROM custom_worms WHERE player = ? AND id != ?', me.id, id), q("UPDATE custom_worms SET state = 'on', created = ? WHERE id = ?", now, id)]);
    await tell(origin + '/worm/img/' + id + '.jpg', `🎨 New custom worm: ${me.name} (player ${me.id}).\n/wormoff ${id} removes it and stops them making more.`).catch(() => { });
    return { worm: id };
  }
  if (path === '/worm/remove') { await q("DELETE FROM custom_worms WHERE player = ? AND state = 'on'", me.id).run(); return { worm: null } }
  if (path === '/worm/report') {
    const id = String(body.id || ''), row = ID.test(id) && await q("SELECT c.id, c.player, p.name FROM custom_worms c JOIN players p ON p.id = c.player WHERE c.id = ? AND c.state = 'on'", id).first();
    if (!row || row.player === me.id) return { ok: true };
    const n = await q('SELECT COUNT(*) AS n FROM worm_reports WHERE reporter = ? AND at >= ?', me.id, day0(now)).first();
    if (n.n >= REPORTS_PER_DAY) return { ok: true };
    const r = await q('INSERT OR IGNORE INTO worm_reports (worm, reporter, at) VALUES (?, ?, ?)', id, me.id, now).run();
    if (r.meta ? r.meta.changes : r.changes) await tell(origin + '/worm/img/' + id + '.jpg', `🚩 Custom worm reported by ${me.name} (player ${me.id}). It belongs to ${row.name} (player ${row.player}).\n/wormoff ${id} removes it and stops them making more.`).catch(() => { });
    return { ok: true };
  }
  return null;
}

// The picture itself, for anyone (img tags, canvases with crossOrigin, and the bot's photo messages).
export async function image(env, id) {
  const row = ID.test(id) && await env.DB.prepare("SELECT img FROM custom_worms WHERE id = ? AND state IN ('on', 'offer')").bind(id).first().catch(() => null);
  if (!row) return new Response('not found', { status: 404, headers: { 'access-control-allow-origin': '*' } });
  const bin = atob(row.img), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: { 'content-type': mimeOf(row.img), 'cache-control': 'public, max-age=604800', 'access-control-allow-origin': '*' } });
}

// Admins (/wormoff in bot.js): remove a portrait and stop its owner making new ones; /wormon <player> lets them again.
export async function wormOff(env, id, now = Date.now()) {
  const row = ID.test(String(id)) && await env.DB.prepare('DELETE FROM custom_worms WHERE id = ? RETURNING player').bind(String(id)).first();
  if (!row) return null;
  await env.DB.prepare("INSERT INTO worm_makes (player, at, ok, why) VALUES (?, ?, 2, 'removed by an admin')").bind(row.player, now).run();
  return env.DB.prepare('SELECT id, name FROM players WHERE id = ?').bind(row.player).first();
}
export async function wormOn(env, player) {
  const r = await env.DB.prepare('DELETE FROM worm_makes WHERE player = ? AND ok = 2').bind(Number(player)).run();
  return (r.meta ? r.meta.changes : r.changes) > 0;
}
// Every 15 minutes (bot.js cron): portraits nobody picked go after a few days, the make log after a month (bans stay).
export async function wormCleanup(env, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM custom_worms WHERE state = 'offer' AND created < ?").bind(now - OFFER_DAYS * 864e5),
    env.DB.prepare('DELETE FROM worm_makes WHERE ok < 2 AND at < ?').bind(now - 30 * 864e5),
    env.DB.prepare('DELETE FROM worm_reports WHERE at < ?').bind(now - 30 * 864e5),
  ]);
}
