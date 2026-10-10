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
CREATE TABLE IF NOT EXISTS player_meta (   -- growth tracking: where a player came from, how much they play, invites and bot reminders
  player     INTEGER PRIMARY KEY,
  source     TEXT,                         -- first-touch source tag: s_<tag> links, 'friend', 'telegram', 'web', ...
  invited_by INTEGER,                      -- the player whose friend link brought this brand-new account
  invite_paid INTEGER,                     -- when the invite reward was paid (or 0 when the inviter's daily cap was hit)
  played     INTEGER NOT NULL DEFAULT 0,   -- finished matches, any mode, as the game reports them
  last_played INTEGER NOT NULL DEFAULT 0,
  last_seen  INTEGER NOT NULL DEFAULT 0,
  daily      INTEGER NOT NULL DEFAULT 0,   -- 1 once they played a Daily island
  daily_day  INTEGER NOT NULL DEFAULT 0,   -- the UTC day number of their last Daily island
  cc         TEXT,                         -- country from Cloudflare, for the flag in the weekly top 10
  remind     INTEGER NOT NULL DEFAULT 1,   -- bot reminders on (Settings, /stop)
  no_dm      INTEGER NOT NULL DEFAULT 0,   -- 1 when Telegram refused a bot message (no write access); cleared by /start or the game
  reminded   INTEGER NOT NULL DEFAULT 0    -- last reminder sent
);
CREATE INDEX IF NOT EXISTS meta_invited ON player_meta (invited_by, invite_paid);
CREATE INDEX IF NOT EXISTS meta_source ON player_meta (source);
CREATE TABLE IF NOT EXISTS rewards (       -- play-money $CWORM the server owes a player's game (invite rewards); the game claims them
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  player  INTEGER NOT NULL,
  amount  INTEGER NOT NULL,
  reason  TEXT NOT NULL,
  note    TEXT,
  created INTEGER NOT NULL,
  claimed INTEGER
);
CREATE INDEX IF NOT EXISTS rewards_player ON rewards (player, claimed);
CREATE TABLE IF NOT EXISTS week_scores (   -- last week's play-money $CWORM gained, kept when a player's week rolls over (for the Monday top 10)
  week_start INTEGER NOT NULL,
  player     INTEGER NOT NULL,
  cworm      INTEGER NOT NULL,
  PRIMARY KEY (week_start, player)
);
CREATE TABLE IF NOT EXISTS bot_kv (        -- small bot settings: the community group's chat id, the last week posted
  k TEXT PRIMARY KEY,
  v TEXT
);
CREATE TABLE IF NOT EXISTS announcements ( -- "what's new" notes the bot sends to the community group and to every Telegram player (not those who sent /stop)
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT NOT NULL,
  created     INTEGER NOT NULL,
  group_done  INTEGER NOT NULL DEFAULT 0,
  last_player INTEGER NOT NULL DEFAULT 0,   -- players are messaged in id order, a batch per cron run
  sent        INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS land (          -- World Map: tiles players own (src/world.js ids); tiles not here are held by CPU worms
  tile    INTEGER PRIMARY KEY,
  owner   INTEGER NOT NULL,
  since   INTEGER NOT NULL,
  def     TEXT NOT NULL DEFAULT '0000',    -- defense levels, one digit each: mines, bunker, arsenal, garrison
  truce   INTEGER NOT NULL DEFAULT 0       -- just taken: nobody can attack it until then
);
CREATE INDEX IF NOT EXISTS land_owner ON land (owner);
CREATE TABLE IF NOT EXISTS landlords (     -- World Map players: home country, worm upgrades, daily attacks and battle stats
  player     INTEGER PRIMARY KEY,
  cc         TEXT,                         -- the country they play for
  home       INTEGER,                      -- first tile of their latest plot
  joined     INTEGER NOT NULL DEFAULT 0,
  shield     INTEGER NOT NULL DEFAULT 0,   -- new players can't be attacked until then (ends when they attack a player)
  acc        INTEGER NOT NULL DEFAULT 0,   -- worm accuracy level, 0-5: their CPU defenders aim better
  res        INTEGER NOT NULL DEFAULT 0,   -- worm resistance level, 0-5: +10 health per level on the map
  day        INTEGER NOT NULL DEFAULT 0,   -- UTC day number `attacks` counts
  attacks    INTEGER NOT NULL DEFAULT 0,
  buys       INTEGER NOT NULL DEFAULT 0,   -- plots bought after losing all land (the price rises)
  buy_day    INTEGER NOT NULL DEFAULT 0,
  buys_today INTEGER NOT NULL DEFAULT 0,
  won        INTEGER NOT NULL DEFAULT 0,   -- tiles taken
  lost       INTEGER NOT NULL DEFAULT 0,   -- attacks that failed
  held       INTEGER NOT NULL DEFAULT 0,   -- attacks their defenders beat
  notified   INTEGER NOT NULL DEFAULT 0    -- last "your land was taken" bot message
);
CREATE TABLE IF NOT EXISTS attacks (       -- World Map battles: a ticket from /map/attack, closed by /map/result
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket   TEXT NOT NULL UNIQUE,
  attacker INTEGER NOT NULL,
  tile     INTEGER NOT NULL,
  defender INTEGER,                        -- NULL: CPU land
  started  INTEGER NOT NULL,
  ended    INTEGER,
  result   TEXT                            -- won | lost | dropped | late
);
CREATE INDEX IF NOT EXISTS attacks_attacker ON attacks (attacker, ended);
