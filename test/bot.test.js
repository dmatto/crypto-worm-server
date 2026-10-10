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

test('bot: /feedback sends admins the spreadsheet and everyone else a pointer to the game', async () => {
  const rows = [];
  const DB = { prepare: q => ({ bind: () => ({ all: async () => ({ results: [{ tg_id: 77 }] }) }), all: async () => ({ results: rows }) }) };
  const env2 = { ...env, DB, ADMIN_PLAYERS: '1' };
  const fix = r => { r.message.chat.type = 'private'; return r };
  const req = id => new Request('https://w/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(fix({ message: { chat: { id }, from: { id }, text: '/feedback' } })) });
  calls.length = 0; await webhook(req(5), env2);
  assert.match(calls[0][1].text, /tap Feedback/);
  calls.length = 0; await webhook(req(77), env2);
  assert.equal(calls[0][1].text, 'No feedback yet.');
  rows.push({ created: 0, player: 3, name: 'Bo, "the" worm', tg_id: null, wallet: 'W1', wallet_ok: 1, rating: 4, text: 'fun\nbut hard', info: 'tg en' });
  const docs = []; const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { docs.push(init.body); return Response.json({ ok: true }) };
  try { await webhook(req(77), env2) } finally { globalThis.fetch = real }
  const csv = await docs[0].get('document').text();
  assert.match(docs[0].get('caption'), /1 messages from 1 testers, 1 with a wallet/);
  assert.match(csv, /"Bo, ""the"" worm"/); assert.match(csv, /"fun\nbut hard"/);
});
