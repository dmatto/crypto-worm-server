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
  started    INTEGER NOT NULL DEFAULT 0,   -- when the game first reported a started match or mini game (the players count on Home)
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
CREATE TABLE IF NOT EXISTS score_log (     -- every score report (play-money $CWORM a match banked), for the weekly prize chart and its fair-play review; kept 5 weeks
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  player  INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  amount  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS score_log_at ON score_log (at);
CREATE INDEX IF NOT EXISTS score_log_player ON score_log (player, at);
CREATE TABLE IF NOT EXISTS play_days (     -- UTC days a player finished a match (the prize's "play on 3 days")
  player  INTEGER NOT NULL,
  day     INTEGER NOT NULL,                -- UTC day number
  PRIMARY KEY (player, day)
);
CREATE TABLE IF NOT EXISTS hold_dips (     -- days a wallet reading found less than 100K $CWORM (the prize's "hold all week")
  player  INTEGER NOT NULL,
  day     INTEGER NOT NULL,
  PRIMARY KEY (player, day)
);
CREATE TABLE IF NOT EXISTS prize_entry (   -- the weekly prize steps a player did: X username typed, Telegram group membership as Telegram last said
  player   INTEGER PRIMARY KEY,
  x        TEXT,                           -- X username without @
  x_at     INTEGER NOT NULL DEFAULT 0,
  group_ok INTEGER NOT NULL DEFAULT 0,
  group_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS prize_run (     -- the match a player has open now: /started opens it, /played closes it (the prize's match check)
  player INTEGER PRIMARY KEY,
  mode   TEXT,
  at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS run_log (       -- matches the server saw start and finish, and the prize points each can carry (kept 5 weeks)
  player INTEGER NOT NULL,
  at     INTEGER NOT NULL,                 -- when it finished
  secs   INTEGER NOT NULL,
  credit INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS run_log_player ON run_log (player, at);
CREATE INDEX IF NOT EXISTS run_log_at ON run_log (at);
CREATE TABLE IF NOT EXISTS prize_skip (    -- players an admin took out of the weekly prize (/prize skip): scripts, shared or bought accounts
  player INTEGER PRIMARY KEY,
  at     INTEGER NOT NULL,
  by     INTEGER
);
CREATE INDEX IF NOT EXISTS prize_entry_x ON prize_entry (x COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS reward_once (   -- invite bonuses paid at most once: 'loyal:<friend id>', 'mile:<friends>', 'share:<UTC day>'
  player  INTEGER NOT NULL,
  k       TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (player, k)
);
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
CREATE INDEX IF NOT EXISTS attacks_defender ON attacks (defender, ended);
CREATE TABLE IF NOT EXISTS live_fights (   -- World Map: an owner who answered the alert and plays the defense, or '' when the CPU took it
  attack   INTEGER PRIMARY KEY,            -- attacks.id
  code     TEXT NOT NULL,                  -- online match code both players join; '' = the CPU defends
  at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS map_alerts (    -- last "you are under attack" bot message per owner
  player   INTEGER PRIMARY KEY,
  at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS holders (       -- $CWORM holder rewards: what each linked wallet held at the last reading (see holders.js)
  player     INTEGER PRIMARY KEY,
  wallet     TEXT NOT NULL,                -- the wallet read; a different one on the account starts over
  balance    REAL,                         -- whole $CWORM tokens
  tier       INTEGER NOT NULL DEFAULT 0,   -- 0 none, 1 Holder, 2 Dolphin, 3 Shark, 4 Whale, 5 Big Whale
  tier_day   INTEGER,                      -- UTC day number the tier was reached
  streak_day INTEGER,                      -- first day of the current hold streak (hold stars)
  below_day  INTEGER,                      -- first day below the tier (grace), NULL when not below
  checked    INTEGER NOT NULL DEFAULT 0,   -- last reading (ms)
  snap_day   INTEGER NOT NULL DEFAULT 0,   -- last daily reading
  toast      INTEGER,                      -- whales: announce when online (NULL = default: on for Big Whales)
  chest_day  INTEGER NOT NULL DEFAULT 0    -- last daily chest
);
-- Simulated players for load tests (Damian 2026-10-15): accounts the load-test Worker (sim/) signs up with SIM_KEY. They play
-- like everyone else and count as players, but never in the weekly prize, never attack real players' land, and their
-- matches stay out of Live now. The list also tells the clean-up which accounts to delete (tools/sim_cleanup.py).
CREATE TABLE IF NOT EXISTS sim_players (
  player   INTEGER PRIMARY KEY,
  created  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sim_cmd (       -- start / stop orders for the load test, from the bot's admin /sim (the load-test Worker reads them)
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  cmd      TEXT NOT NULL,                  -- off | life | rush
  arg      INTEGER,                        -- rush: minutes
  at       INTEGER NOT NULL,
  done     INTEGER                         -- when the load-test Worker took it
);
CREATE TABLE IF NOT EXISTS sim_stats (     -- the load test's numbers, one row a minute (kept 3 days)
  at       INTEGER PRIMARY KEY,
  data     TEXT NOT NULL                   -- JSON
);
-- The live feed on Home (feed.js): online wins, land taken, and moments the game reports with /played. Kept 2 days.
CREATE TABLE IF NOT EXISTS feed (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  at   INTEGER NOT NULL,
  k    TEXT NOT NULL,                      -- win | land | solo | lost | kill | died | oops | multi | big
  p    INTEGER NOT NULL,                   -- the player
  a    TEXT NOT NULL,                      -- their name and country at the time
  ac   TEXT,
  b    TEXT,                               -- the other side's name and country, when there is one
  bc   TEXT,
  w    TEXT,                               -- a worm's name
  wp   TEXT,                               -- weapon id
  n    INTEGER,                            -- damage, worms hit or campaign mission
  how  TEXT,                               -- blast | drown | off | bird
  m    TEXT                                -- mode, why an online match ended, or the land's country
);
CREATE INDEX IF NOT EXISTS feed_p ON feed (p, at);
CREATE INDEX IF NOT EXISTS feed_at ON feed (at);
-- Custom photo worms (worms.js, Damian 2026-10-17): portraits Grok draws from a holder's photo. The photo is never kept.
CREATE TABLE IF NOT EXISTS custom_worms (
  id       TEXT PRIMARY KEY,               -- random, in the picture's address
  player   INTEGER NOT NULL,
  job      TEXT NOT NULL,                  -- the make call it came from (its options share one)
  kind     TEXT NOT NULL,                  -- person | pet
  state    TEXT NOT NULL,                  -- offer (one of the options to pick from) | on (the one kept)
  img      TEXT NOT NULL,                  -- the picture, base64
  pay      TEXT,                           -- how it was paid: cworm (play money in the game); stars or token later
  created  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS custom_worms_player ON custom_worms (player, state);
CREATE TABLE IF NOT EXISTS worm_makes (    -- every make call, for the daily limits; ok 2 = not allowed to make more (an admin's /wormoff)
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  player   INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  ok       INTEGER NOT NULL,               -- 1 portraits made, 0 photo turned down or nothing drawn
  why      TEXT
);
CREATE INDEX IF NOT EXISTS worm_makes_player ON worm_makes (player, at);
CREATE INDEX IF NOT EXISTS worm_makes_at ON worm_makes (at);
CREATE TABLE IF NOT EXISTS worm_reports (  -- players who reported someone's portrait (one report each)
  worm     TEXT NOT NULL,
  reporter INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (worm, reporter)
);
-- The avatar each player picked (Damian 2026-10-17): an id from the game's list (avatars/<id>.jpg on the site), shown in the
-- ranking and in the battle's corners. A custom worm (custom_worms) shows instead while its owner holds.
CREATE TABLE IF NOT EXISTS player_avatar (
  player   INTEGER PRIMARY KEY,
  av       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS royale_log (    -- Worm Royale online (royale.js): each real player's place in each room, kept 5 weeks. ok 0: the host's
  code   TEXT NOT NULL,                    -- places and the player's own phone disagreed (on the host's row: some other row disagreed)
  player INTEGER NOT NULL,
  place  INTEGER,
  kills  INTEGER NOT NULL DEFAULT 0,
  host   INTEGER NOT NULL DEFAULT 0,       -- 1 = this player's phone ran the match
  ok     INTEGER NOT NULL DEFAULT 1,
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS royale_log_player ON royale_log (player, at);
CREATE INDEX IF NOT EXISTS royale_log_at ON royale_log (at);
CREATE TABLE IF NOT EXISTS royale_ping (   -- players who asked the bot for a message when the daily Royale hour starts
  player INTEGER PRIMARY KEY,
  at     INTEGER NOT NULL
);
