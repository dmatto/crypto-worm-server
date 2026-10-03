import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { webhook, setup } from '../src/bot.js';

const env = { BOT_TOKEN: '123:BOT', SESSION_SECRET: 's', GAME_LINK: 'https://t.me/Bot/play', WELCOME_PHOTO: 'https://x.test/welcome.jpg' };
const secret = createHash('sha256').update('webhook:s').digest('hex').slice(0, 48);
const calls = [];
globalThis.fetch = async (url, init) => { const m = url.split('/').pop(), b = JSON.parse(init.body); calls.push([m, b]); return Response.json({ ok: m !== 'sendPhoto' || b.photo !== 'broken', result: {} }) };
const update = (text, head = secret) => new Request('https://w/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': head }, body: JSON.stringify({ message: { chat: { id: 9, type: 'private' }, from: { first_name: 'Ana' }, text } }) });

test('bot: /start sends the welcome picture with a Play button, falls back to text, ignores forged updates', async () => {
  calls.length = 0;
  assert.equal((await webhook(update('/start', 'wrong'), env)).status, 403); assert.equal(calls.length, 0);
  await webhook(update('/start m_ABCDEF'), env);
  assert.equal(calls[0][0], 'sendPhoto'); assert.match(calls[0][1].caption, /Welcome to Crypto Worm Wars, Ana!/);
  assert.equal(calls[0][1].reply_markup.inline_keyboard[0][0].url, 'https://t.me/Bot/play');
  calls.length = 0; await webhook(update('/start'), { ...env, WELCOME_PHOTO: 'broken' });
  assert.deepEqual(calls.map(c => c[0]), ['sendPhoto', 'sendMessage']);
  calls.length = 0; await webhook(update('/help'), env); await webhook(update('hello'), env);
  assert.deepEqual(calls.map(c => c[0]), ['sendMessage']);
});

test('bot: setup needs the token hash', async () => {
  assert.equal((await setup(new Request('https://w/telegram/setup'), env, 'https://w')).status, 403);
  const ok = await setup(new Request('https://w/telegram/setup', { headers: { 'x-admin': createHash('sha256').update('123:BOT').digest('hex') } }), env, 'https://w');
  assert.equal(ok.status, 200);
});
