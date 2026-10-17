import test from 'node:test';
import assert from 'node:assert/strict';
import { makePack, STICKERS, PACK_BASE } from '../src/stickers.js';

// A fake Bot API: a sticker set that exists once created, and one 429 on the third add.
const fake = (start = null) => {
  let set = start, calls = [], slowed = false;
  const call = async (m, b) => {
    calls.push([m, b]);
    if (m === 'getMe') return { ok: true, result: { username: 'TestBot' } };
    if (m === 'getStickerSet') return set ? { ok: true, result: { stickers: set } } : { ok: false, description: 'Bad Request: STICKERSET_INVALID' };
    if (m === 'createNewStickerSet') { set = [b.stickers[0]]; return { ok: true, result: true } }
    if (m === 'addStickerToSet') { if (set.length === 3 && !slowed) { slowed = true; return { ok: false, error_code: 429, parameters: { retry_after: 0 } } } set.push(b.sticker); return { ok: true, result: true } }
    if (m === 'setStickerSetThumbnail') return { ok: true, result: true };
    return { ok: false };
  };
  return { call, calls, set: () => set };
};

test('stickers: builds the whole pack under the owner, in order, waiting out a 429', async () => {
  const f = fake(), r = await makePack(f.call, 42);
  assert.equal(r.name, 'CryptoWorm_by_TestBot'); assert.equal(r.link, 'https://t.me/addstickers/CryptoWorm_by_TestBot');
  assert.equal(r.count, STICKERS.length); assert.equal(r.error, null); assert.equal(r.icon, true);
  const create = f.calls.find(c => c[0] === 'createNewStickerSet')[1];
  assert.equal(create.user_id, 42); assert.equal(create.title, 'Crypto Worm');
  assert.deepEqual(create.stickers[0], { sticker: PACK_BASE + 'telegram/01-gm.png', format: 'static', emoji_list: ['☀️'] });
  assert.deepEqual(f.set().map(s => s.sticker.split('/').pop()), STICKERS.map(s => s[0] + '.png'));
});

test('stickers: a second run only adds what is missing and stops at the first refusal', async () => {
  const done = STICKERS.slice(0, 28).map(s => ({ sticker: s[0] })), f = fake(done);
  const r = await makePack(f.call, 42);
  assert.equal(f.calls.filter(c => c[0] === 'createNewStickerSet').length, 0);
  assert.equal(r.added, 2); assert.equal(r.count, 30);
  const bad = fake(); const call = async (m, b) => m === 'addStickerToSet' ? { ok: false, description: 'Bad Request: STICKER_PNG_DIMENSIONS' } : bad.call(m, b);
  const r2 = await makePack(call, 42);
  assert.equal(r2.count, 1); assert.match(r2.error, /^02-gn: .*DIMENSIONS/);
});
