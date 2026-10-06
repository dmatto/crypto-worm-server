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
CREATE TABLE IF NOT EXISTS bot_log (       -- what the scheduled bot setup saw and did
  at      INTEGER NOT NULL,
  note    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (      -- what beta testers tell us from the game's Feedback page
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  player   INTEGER NOT NULL,
  name     TEXT NOT NULL,                  -- the player's name when they sent it
  tg_id    INTEGER,                        -- their Telegram id, when signed in through Telegram
  wallet   TEXT,                           -- Solana address: the linked one, or one they typed
  wallet_ok INTEGER NOT NULL DEFAULT 0,    -- 1 when that address is the wallet they signed in with
  rating   INTEGER,                        -- 1-5 stars, NULL when skipped
  text     TEXT NOT NULL,
  info     TEXT,                           -- platform, language and level, for context
  created  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_player ON feedback (player, created);
CREATE TABLE IF NOT EXISTS nicknames (     -- names players picked themselves; Telegram sign-in then keeps them
  player  INTEGER PRIMARY KEY,
  nick    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  changed INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cworm_scores (  -- play-money $CWORM each player gained, for the ranking (the game reports it after each match)
  player     INTEGER PRIMARY KEY,
  total      INTEGER NOT NULL DEFAULT 0,   -- all time
  week_start INTEGER NOT NULL DEFAULT 0,   -- Monday 00:00 UTC of the week `week` counts
  week       INTEGER NOT NULL DEFAULT 0,
  day_start  INTEGER NOT NULL DEFAULT 0,   -- for the daily cap
  day        INTEGER NOT NULL DEFAULT 0,
  last       INTEGER NOT NULL DEFAULT 0,   -- last report, for the minimum gap
  imported   INTEGER NOT NULL DEFAULT 0    -- 1 once the wallet total from before the ranking was brought in
);
CREATE INDEX IF NOT EXISTS cworm_week ON cworm_scores (week_start, week);
CREATE INDEX IF NOT EXISTS cworm_total ON cworm_scores (total);
