// Who each simulated player is: a nickname, a country and a play style, the same every time for bot number n.

export function rng(seed) {                                         // mulberry32: a small seeded random number generator
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];

const FIRST = ['Budi', 'Rizky', 'Dewi', 'Agus', 'Putri', 'Andi', 'Siti', 'Fajar', 'Rina', 'Dimas', 'Ayu', 'Bayu', 'Eko', 'Indah', 'Joko', 'Wahyu', 'Yusuf', 'Nanda',
  'Rudi', 'Tika', 'Arif', 'Lina', 'Hendra', 'Sari', 'Gilang', 'Reza', 'Juan', 'Mark', 'Jhon', 'Angel', 'Paolo', 'Kyle', 'Rhea', 'Migs', 'Chidi', 'Tunde', 'Emeka',
  'Ngozi', 'Bola', 'Ife', 'Kemi', 'Arjun', 'Rahul', 'Priya', 'Vikram', 'Sai', 'Ravi', 'Neha', 'Minh', 'Huy', 'Linh', 'Tuan', 'Nam', 'Mateo', 'Lucas', 'Sofia',
  'Diego', 'Juli', 'Nico', 'Valen', 'Santi', 'Facu', 'Caro', 'Jake', 'Emma', 'Leo', 'Max', 'Mia', 'Alex', 'Sam', 'Noah', 'Emre', 'Mert', 'Elif', 'Can', 'Omar',
  'Ali', 'Sara', 'Yuki', 'Ken', 'Jin', 'Ivan', 'Olek', 'Tomas', 'Hugo', 'Luca', 'Nina', 'Zara', 'Kofi', 'Ama', 'Pedro', 'Bruno', 'Thiago', 'Ana'];
const WORD = ['Sol', 'Moon', 'Pump', 'Degen', 'Ape', 'Hodl', 'Gem', 'Lambo', 'Rekt', 'Wagmi', 'Chad', 'Based', 'Bonk', 'Satoshi', 'Diamond', 'Rocket', 'Bull',
  'Bear', 'Doge', 'Pepe', 'Mint', 'Block', 'Chain', 'Stack', 'Laser', 'Turbo', 'Mega', 'Ultra', 'Ninja', 'Shadow', 'Storm', 'Frost', 'Blaze', 'Pixel', 'Cyber'];
const NOUN = ['Worm', 'Digger', 'Wiggle', 'Hunter', 'King', 'Queen', 'Lord', 'Boss', 'Sniper', 'Bomber', 'Gamer', 'Hero', 'Rider', 'Shark', 'Tiger', 'Wolf',
  'Fox', 'Panda', 'Eagle', 'Viper', 'Dragon', 'Knight', 'Pirate', 'Monk', 'Chef', 'Miner', 'Trader', 'Farmer', 'Slayer', 'Master'];
const TAIL = ['', '', '', '7', '9', '21', '69', '77', '88', '99', '007', '123', '2k', 'x', 'X', 'ID', 'PH', 'gg', 'pro', 'jr'];

// A nickname the server accepts (3 to 16 letters or numbers, _ - . or a space inside). `again` gives another one when it was taken.
export function nameFor(n, again = 0) {
  const r = rng(n * 7919 + 104729 + again * 15485863), style = r();
  let s;
  if (style < .3) s = pick(r, FIRST) + pick(r, TAIL);
  else if (style < .55) s = pick(r, WORD) + pick(r, NOUN);
  else if (style < .7) s = pick(r, FIRST).toLowerCase() + pick(r, ['_', '.', '']) + pick(r, WORD).toLowerCase();
  else if (style < .85) s = pick(r, WORD) + pick(r, NOUN) + Math.floor(r() * 100);
  else s = pick(r, FIRST) + pick(r, ['_', '']) + pick(r, NOUN);
  if (again) s = s.slice(0, 12) + Math.floor(1 + r() * 999);
  s = s.slice(0, 16).replace(/[_.\-\s]+$/, ''); if (s.length < 3) s += 'Worm';
  return BLOCK.test(s.replace(/[\s_.\-]/g, '')) && again < 20 ? nameFor(n, again + 7) : s;   // the server's word list, letters run together ("sara.pepe")
}
const BLOCK = /(fuck|shit|bitch|cunt|nigg|fag|rape|nazi|hitler|porn|whore|slut|dick|pussy|admin|moderator|official|cryptoworm|crypto worm|whale|cwormteam|support)/i;

// Countries roughly like the real players' (most from Indonesia), and a spread of others.
const CC = [['ID', 30], ['PH', 8], ['NG', 7], ['IN', 7], ['VN', 5], ['US', 5], ['BR', 5], ['TR', 4], ['UY', 3], ['AR', 3], ['MX', 3], ['TH', 3], ['MY', 3], ['PK', 2],
  ['DE', 2], ['GB', 2], ['FR', 2], ['SG', 2], ['KE', 2], ['CA', 2], ['ES', 1], ['IT', 1], ['PL', 1], ['UA', 1], ['EG', 1], ['BD', 1], ['ZA', 1], ['CO', 1], ['VE', 1],
  ['PE', 1], ['CL', 1], ['JP', 1], ['KR', 1], ['AU', 1]];
const CC_SUM = CC.reduce((s, c) => s + c[1], 0);
export function countryFor(n) {
  let x = rng(n * 31337 + 7)() * CC_SUM;
  for (const [cc, w] of CC) { if ((x -= w) < 0) return cc }
  return 'ID';
}

// How a player plays: sessions a day, games a session, how often online, and what a game usually banks (play money).
// The weekly budget keeps their ranking like real players': most bank a few hundred a week, a few over a thousand.
export function profileFor(n) {
  const r = rng(n * 104723 + 3);
  const keen = r();                                                   // 0 casual .. 1 keen
  return {
    sessions: 2 + Math.floor(keen * 3),                               // 2-4 a day
    gmin: 2, gmax: 3 + Math.floor(keen * 2),                          // 2-5 games a session: always more than 3 games a day
    online: .25 + r() * .25,                                          // share of games played online
    per: Math.round(40 + r() * 80),                                   // play money a won game banks
    budget: Math.round(Math.min(1400, 120 * Math.exp(r() * 2.3))),    // play money a week at most (120 to 1,400)
    hat: pick(r, ['none', 'cap', 'crown', 'helmet', 'pirate', 'party', 'wizard', 'cowboy']),
  };
}
