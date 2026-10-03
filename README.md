# Crypto Worm Wars match server

Online 1v1 for [Crypto Worm Wars](https://t.me/CryptoWormWarsBot/play): sign-in with Telegram or a Solana wallet,
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
| `POST /auth/guest` | | `{token, player}` |
| `GET /me` | | `{player}` |
| `POST /match/new` | | `{code}` to share as `t.me/CryptoWormWarsBot/play?startapp=m_<code>` |
| `POST /match/quick` | | `{code, side}` |
| `GET /match/<code>/ws?token=…` | WebSocket | the match |

Signed-in calls send `Authorization: Bearer <token>`.

## Deploy

1. `npm install`
2. `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`)
3. `npx wrangler d1 create crypto-worm` and paste the id into `wrangler.toml`
4. `npx wrangler d1 execute crypto-worm --remote --file=schema.sql`
5. `npx wrangler secret put BOT_TOKEN` (the Telegram bot token) and `npx wrangler secret put SESSION_SECRET` (any long random string)
6. `npx wrangler deploy`

## Test

`npm test` runs the sign-in and match tests with Node 20+ (no install needed).
