# Crypto Worm Wars match server

Online 1v1 for [Crypto Worm Wars](https://t.me/CryptoWormWarsBot/play): one account across Telegram, the web and
apps (Telegram, Solana wallet, or a login code from another device), a lobby of players online to challenge, friends,
challenge links, quick match, and the live match relay. It runs on Cloudflare Workers with Durable Objects
(one per match) and a D1 database for player profiles and results.

## How a match works

One phone runs the match at a time: the owner of the team whose turn it is. It streams effects and the match state
to the other phone, and when the turn passes it hands the whole state over. The server seats the two players,
passes messages along, only accepts updates from the phone whose turn it is, keeps the last handed-over state so a
dropped phone can rejoin, and calls the match for the other player after 90 seconds of silence.

Scores are just for fun. Signing in with a wallet only signs a text message: no transaction, no fees, and the
server never sends tokens or anything of value.

## API

| Call | Body | Returns |
| --- | --- | --- |
| `POST /auth/telegram` | `{initData}` from the Mini App | `{token, player}` |
| `POST /auth/solana/nonce` | `{address}` | `{message}` for the wallet to sign |
| `POST /auth/solana` | `{address, message, signature}` (base58) | `{token, player}`; links the wallet if already signed in |
| `POST /auth/telegram/web` | Telegram Login Widget fields | `{token, player}`; needs the bot's domain set with BotFather `/setdomain` |
| `POST /auth/guest` | | `{token, player}` |
| `POST /auth/code` | | `{code, expires}`: a 10 minute login code for another device |
| `POST /auth/code/redeem` | `{code}` | `{token, player}` for that account |
| `GET /me` | | `{player, friendCode}` |
| `GET /friends` | | `{friends}` with `online` |
| `POST /friends/add` | `{code}` (both ways) or `{id}` (one way) | `{friend}` |
| `POST /friends/remove` | `{id}` | |
| `GET /lobby/ws?token=…` | WebSocket | the lobby: who is online, challenges (see `src/lobby.js`) |
| `POST /match/new` | | `{code}` to share as `t.me/CryptoWormWarsBot/play?startapp=m_<code>` |
| `POST /match/quick` | | `{code, side}` |
| `GET /match/<code>/ws?token=…` | WebSocket | the match |

Signed-in calls send `Authorization: Bearer <token>`. Signing in with Telegram, a wallet or a login code while
already signed in links it to the same account; two accounts are merged when they don't both have a Telegram account
or both have a wallet. Offline friends get challenges as a Telegram message from the bot.

## Deploy

Without npm: `python3 tools/deploy_api.py` (needs `CLOUDFLARE_API_TOKEN` with Workers Scripts Edit and D1 Edit,
`CLOUDFLARE_ACCOUNT_ID`, and optionally `TELEGRAM_BOT_TOKEN`). With npm:


1. `npm install`
2. `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`)
3. `npx wrangler d1 create crypto-worm` and paste the id into `wrangler.toml`
4. `npx wrangler d1 execute crypto-worm --remote --file=schema.sql`
5. `npx wrangler secret put BOT_TOKEN` (the Telegram bot token) and `npx wrangler secret put SESSION_SECRET` (any long random string)
6. `npx wrangler deploy`

## Test

`npm test` runs the sign-in and match tests with Node 20+ (no install needed).

`node tools/local-server.mjs` runs the whole server on your computer without Cloudflare (Node 22+). Open the game
twice, in two different browsers or profiles: the first with `?server=http://127.0.0.1:8787&match=NEW`, which shows
a match code, and the second with `?server=http://127.0.0.1:8787&match=<code>`.
