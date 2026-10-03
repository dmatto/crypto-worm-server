// The Telegram bot's own chat: a welcome message with a Play button when someone starts the bot, plus /play and /help.
// Telegram posts updates to /telegram/webhook with a secret header. /telegram/setup (guarded by the SHA-256 of the bot
// token, so only someone holding the token can call it) shows the bot's settings, and with POST points the webhook here
// and sets the description, short description, commands and menu button.

const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))) }
function same(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0 }
const webhookSecret = env => sha256('webhook:' + env.SESSION_SECRET).then(h => h.slice(0, 48));

export const DESCRIPTION = 'Crypto Worm Wars 🪱 Bulls vs Bears in a Worms-style artillery game. Free to play right here in Telegram: ' +
  'battle the CPU, a friend or players online, smash Bear forts in the campaign, and unlock hats and special weapons. Tap Start, then Play!';
export const SHORT_DESCRIPTION = 'Bulls vs Bears worm battles 🪱 A free Worms-style game right inside Telegram. Tap Play!';
export const COMMANDS = [{ command: 'play', description: 'Open the game' }, { command: 'help', description: 'How to play' }, { command: 'start', description: 'Welcome message' }];

export const COMMUNITY = { group: 'https://t.me/CryptoWorm_Group', x: 'https://x.com/CryptoWorm72' };

export function welcomeText(name) {
  return `🪱 Welcome to Crypto Worm Wars${name ? ', ' + name : ''}!\n\n` +
    'Bulls 🐂 vs Bears 🐻 in a turn-based worm battle. Aim, fire and blow the island apart, Worms-style.\n\n' +
    '🎯 Play the CPU, a friend on the same phone, or people online\n' +
    '🏰 A 24-level campaign against Bear forts\n' +
    '🗺️ 100+ maps, special weapons, hats and daily missions\n\n' +
    'It\'s free. The $CWORM coins in the game are play money, not real tokens.\n\n' +
    '💬 Join the Crypto Worm group and follow us on X with the buttons below.\n\nTap Play to start!';
}
export const HELP_TEXT = '🎮 How to play\n\n' +
  '• Walk with the joystick, push it up to jump.\n' +
  '• Tap the map to aim, then hold FIRE to power up and let go to shoot. A double tap on the map aims and fires.\n' +
  '• Pick weapons from the bar at the bottom. Blast the coins in the dirt to buy bigger ones.\n' +
  '• The market chart sets the wind: green blows right, red blows left.\n' +
  '• Online: open Online in the menu to challenge players or add friends.\n\nLast team standing wins!\n\n' +
  `💬 Telegram group: ${COMMUNITY.group}\n𝕏 Follow on X: ${COMMUNITY.x}`;

function buttons(env) {
  const play = env.GAME_LINK || 'https://t.me/CryptoWormWarsBot/play';
  return { inline_keyboard: [[{ text: '🎮 Play now', url: play }],
    [{ text: '👥 Invite a friend', url: 'https://t.me/share/url?url=' + encodeURIComponent(play) + '&text=' + encodeURIComponent('Fight me in Crypto Worm Wars! 🪱') }],
    [{ text: '💬 Telegram group', url: COMMUNITY.group }, { text: '𝕏 Follow on X', url: COMMUNITY.x }]] };
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json().catch(() => ({ ok: false }));
}

export async function webhook(req, env) {
  if (!same(req.headers.get('X-Telegram-Bot-Api-Secret-Token') || '', await webhookSecret(env))) return new Response('forbidden', { status: 403 });
  const u = await req.json().catch(() => null), m = u && u.message;
  if (!m || !m.chat || m.chat.type !== 'private' || typeof m.text !== 'string') return new Response('ok');
  const cmd = m.text.trim().split(/[\s@]/)[0].toLowerCase(), chat_id = m.chat.id;
  if (cmd === '/start') {
    const caption = welcomeText(m.from && m.from.first_name ? String(m.from.first_name).slice(0, 40) : '');
    const sent = env.WELCOME_PHOTO ? await tg(env, 'sendPhoto', { chat_id, photo: env.WELCOME_PHOTO, caption, reply_markup: buttons(env) }) : { ok: false };
    if (!sent.ok) await tg(env, 'sendMessage', { chat_id, text: caption, reply_markup: buttons(env) });
  } else if (cmd === '/play') await tg(env, 'sendMessage', { chat_id, text: 'Tap to jump in! 🪱', reply_markup: buttons(env) });
  else if (cmd === '/help') await tg(env, 'sendMessage', { chat_id, text: HELP_TEXT, reply_markup: buttons(env) });
  return new Response('ok');
}

export async function setup(req, env, origin) {
  if (!env.BOT_TOKEN || !same(req.headers.get('x-admin') || '', await sha256(env.BOT_TOKEN))) return Response.json({ error: 'forbidden' }, { status: 403 });
  const look = async () => ({ me: (await tg(env, 'getMe')).result, webhook: (await tg(env, 'getWebhookInfo')).result, description: (await tg(env, 'getMyDescription')).result,
    short: (await tg(env, 'getMyShortDescription')).result, commands: (await tg(env, 'getMyCommands')).result, menu: (await tg(env, 'getChatMenuButton')).result });
  if (req.method !== 'POST') return Response.json(await look());
  const opts = await req.json().catch(() => ({})), done = {};
  done.webhook = await tg(env, 'setWebhook', { url: origin + '/telegram/webhook', secret_token: await webhookSecret(env), allowed_updates: ['message'], drop_pending_updates: false });
  done.description = await tg(env, 'setMyDescription', { description: DESCRIPTION });
  done.short = await tg(env, 'setMyShortDescription', { short_description: SHORT_DESCRIPTION });
  done.commands = await tg(env, 'setMyCommands', { commands: COMMANDS });
  if (opts.menuUrl) done.menu = await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Play', web_app: { url: opts.menuUrl } } });
  return Response.json({ done, now: await look() });
}

// Cron: this sandbox can't call the Worker's URL, so the Worker sets the bot up itself on a schedule. It writes what it
// saw and did to the bot_log table. It never replaces a webhook that points somewhere else, and it only applies the
// settings when BOT_AUTOSETUP is "1".
export async function sync(env) {
  try { await syncNow(env) } catch (e) { await env.DB.prepare('INSERT INTO bot_log (at, note) VALUES (?, ?)').bind(Date.now(), 'error ' + (e && e.message)).run().catch(() => { }) }
}
async function syncNow(env) {
  const log = note => env.DB.prepare('INSERT INTO bot_log (at, note) VALUES (?, ?)').bind(Date.now(), String(note).slice(0, 4000)).run().catch(() => { });
  if (!env.BOT_TOKEN || !env.PUBLIC_URL) return log('no BOT_TOKEN or PUBLIC_URL');
  const info = (await tg(env, 'getWebhookInfo')).result || {}, menu = (await tg(env, 'getChatMenuButton')).result || {}, mine = env.PUBLIC_URL + '/telegram/webhook';
  await log('seen ' + JSON.stringify({ webhook: info.url || '', pending: info.pending_update_count, lastError: info.last_error_message || '', menu: menu.type }));
  if (env.BOT_AUTOSETUP !== '1') return;
  if (info.url && info.url !== mine) return log('left alone: the webhook points to another service');
  const r = { webhook: (await tg(env, 'setWebhook', { url: mine, secret_token: await webhookSecret(env), allowed_updates: ['message'] })).ok,
    description: (await tg(env, 'setMyDescription', { description: DESCRIPTION })).ok,
    short: (await tg(env, 'setMyShortDescription', { short_description: SHORT_DESCRIPTION })).ok,
    commands: (await tg(env, 'setMyCommands', { commands: COMMANDS })).ok };
  if (menu.type !== 'web_app' && env.MENU_URL) r.menu = (await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Play', web_app: { url: env.MENU_URL } } })).ok;
  return log('set ' + JSON.stringify(r));
}
