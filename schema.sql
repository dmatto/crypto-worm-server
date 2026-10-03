-- D1 database for Crypto Worm Wars. Apply with: npx wrangler d1 execute crypto-worm --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS players (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id   INTEGER UNIQUE,          -- Telegram user id, when signed in through Telegram
  wallet  TEXT UNIQUE,             -- Solana address, when a wallet is linked
  name    TEXT NOT NULL,
  wins    INTEGER NOT NULL DEFAULT 0,
  losses  INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  p0      INTEGER NOT NULL,
  p1      INTEGER NOT NULL,
  winner  INTEGER,                 -- player id, NULL for a draw
  reason  TEXT NOT NULL,           -- played | left | timeout
  ended   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_ended ON matches (ended);
CREATE TABLE IF NOT EXISTS friends (
  player  INTEGER NOT NULL,        -- who added the friend
  friend  INTEGER NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (player, friend)
);
CREATE INDEX IF NOT EXISTS friends_friend ON friends (friend);
CREATE TABLE IF NOT EXISTS login_codes (   -- short codes that sign another device into the same account
  code    TEXT PRIMARY KEY,
  player  INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
