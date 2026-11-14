// The Crypto Worm sticker pack on Telegram. The 30 pictures live on the game site (stickers/telegram/ on play.cryptoworm.io,
// made in the project files' promo/stickers/). Setting bot_kv 'sticker_pack' makes the next cron run build the pack under
// the first admin's Telegram account: it creates it if needed, adds whatever is still missing in order, sets the icon,
// and sends the admins the add link. Running it again only fills gaps.
export const PACK_TITLE = 'Crypto Worm';
export const PACK_BASE = 'https://play.cryptoworm.io/stickers/';
export const STICKERS = [
  ['01-gm', '☀️'], ['02-gn', '😴'], ['03-wagmi', '🙌'], ['04-lfg', '🚀'], ['05-hodl', '🪙'], ['06-moon', '🌕'],
  ['07-neverrug', '🛡️'], ['08-lambo', '🏎️'], ['09-ser', '🧐'], ['10-bullish', '📈'], ['11-bearish', '📉'], ['12-diamond', '💎'],
  ['13-rugged', '🌀'], ['14-rekt', '🤕'], ['15-ngmi', '🙅'], ['16-lol', '😂'], ['17-bruh', '😑'], ['18-hmm', '🤔'],
  ['19-what', '😱'], ['20-love', '😍'], ['21-thanks', '🙏'], ['22-pain', '😭'], ['23-party', '🎉'], ['24-fud', '😡'],
  ['25-fine', '🔥'], ['26-building', '🛠️'], ['27-play', '🎮'], ['28-hi', '👋'], ['29-gg', '🏆'], ['30-pump', '💪'],
];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// call(method, body) is a Bot API call; owner is the Telegram id the pack belongs to. Returns what happened, for the log.
export async function makePack(call, owner) {
  const me = (await call('getMe')).result;
  if (!me || !me.username) return { error: 'getMe failed' };
  const name = 'CryptoWorm_by_' + me.username, input = ([file, emoji]) => ({ sticker: PACK_BASE + 'telegram/' + file + '.png', format: 'static', emoji_list: [emoji] });
  const send = async (method, body) => {                                      // Telegram slows down bursts of sticker calls: wait as asked, a few times
    for (let t = 0; ; t++) {
      const r = await call(method, body), wait = r.parameters && r.parameters.retry_after;
      if (r.ok || r.error_code !== 429 || t >= 4 || !(wait <= 60)) return r;
      await sleep(wait * 1000);
    }
  };
  let have = ((await call('getStickerSet', { name })).result || {}).stickers;
  if (!have) {
    const r = await send('createNewStickerSet', { user_id: owner, name, title: PACK_TITLE, stickers: [input(STICKERS[0])] });
    if (!r.ok) return { name, error: 'create: ' + r.description };
    have = [STICKERS[0]];
  }
  const start = have.length; let added = 0, error = null;
  for (const s of STICKERS.slice(start)) {
    const r = await send('addStickerToSet', { user_id: owner, name, sticker: input(s) });
    if (!r.ok) { error = s[0] + ': ' + r.description; break }
    added++;
  }
  const icon = (await send('setStickerSetThumbnail', { name, user_id: owner, thumbnail: PACK_BASE + 'telegram-pack-icon.png', format: 'static' })).ok;
  return { name, link: 'https://t.me/addstickers/' + name, count: start + added, added, icon, error };
}
