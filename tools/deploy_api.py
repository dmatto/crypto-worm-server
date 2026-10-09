#!/usr/bin/env python3
"""Deploy without wrangler, straight through the Cloudflare API (for machines where npm is unavailable).

Reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, and optionally TELEGRAM_BOT_TOKEN, from the environment.
Creates the D1 database and its tables if needed, uploads the Worker with its Durable Objects, sets the secrets,
and turns on the workers.dev address. Run from the repo root: python3 tools/deploy_api.py
Secrets are sent to Cloudflare only and never printed.
"""
import json, os, secrets, sys, uuid, urllib.request, urllib.error

NAME, DB_NAME, COMPAT = 'crypto-worm-server', 'crypto-worm', '2025-09-01'
VARS = {'SIGNIN_DOMAIN': 'play.cryptoworm.io', 'ALLOWED_ORIGINS': 'https://rainbow-kitten-2ecc2a.netlify.app,https://play.cryptoworm.io,https://cryptoworm.io,https://www.cryptoworm.io',
        'GAME_LINK': 'https://t.me/CryptoWormWarsBot/play', 'WELCOME_PHOTO': 'https://play.cryptoworm.io/welcome.jpg',
        'MENU_URL': 'https://play.cryptoworm.io/', 'SITE_URL': 'https://play.cryptoworm.io', 'PUBLIC_URL': 'https://crypto-worm-server.cryptoworm.workers.dev',
        'BOT_AUTOSETUP': os.environ.get('BOT_AUTOSETUP', '0'), 'ADMIN_PLAYERS': os.environ.get('ADMIN_PLAYERS', '2')}
TOKEN, ACC = os.environ.get('CLOUDFLARE_API_TOKEN'), os.environ.get('CLOUDFLARE_ACCOUNT_ID')
if not TOKEN or not ACC: sys.exit('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set')
BASE = f'https://api.cloudflare.com/client/v4/accounts/{ACC}'


def call(method, path, body=None, raw=None, ctype='application/json'):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={'Authorization': f'Bearer {TOKEN}', **({'Content-Type': ctype} if data else {})})
    try:
        with urllib.request.urlopen(req) as r: return json.load(r)
    except urllib.error.HTTPError as e:
        out = json.load(e)
        sys.exit(f'{method} {path} failed: {out.get("errors")}')


# 1. database
dbs = call('GET', '/d1/database?name=' + DB_NAME)['result']
db = next((d for d in dbs if d['name'] == DB_NAME), None) or call('POST', '/d1/database', {'name': DB_NAME})['result']
call('POST', f'/d1/database/{db["uuid"]}/query', {'sql': open('schema.sql').read()})
print('database', DB_NAME, 'ready')

# 2. worker (first upload creates the Durable Object classes; later ones keep them)
existing = call('GET', '/workers/scripts')['result']
first = not any(s['id'] == NAME for s in existing)
meta = {
    'main_module': 'index.js', 'compatibility_date': COMPAT,
    'bindings': [{'type': 'd1', 'name': 'DB', 'id': db['uuid']},
                 {'type': 'durable_object_namespace', 'name': 'MATCH', 'class_name': 'Match'},
                 {'type': 'durable_object_namespace', 'name': 'LOBBY', 'class_name': 'Lobby'}]
                + [{'type': 'plain_text', 'name': k, 'text': v} for k, v in VARS.items()],
    'keep_bindings': ['secret_text'],
}
if first: meta['migrations'] = {'new_tag': 'v1', 'new_sqlite_classes': ['Match', 'Lobby']}
b = uuid.uuid4().hex
parts = [('metadata', 'metadata.json', 'application/json', json.dumps(meta).encode())]
for f in ('index.js', 'auth.js', 'match.js', 'lobby.js', 'bot.js', 'growth.js'): parts.append((f, f, 'application/javascript+module', open('src/' + f, 'rb').read()))
body = b''.join(f'--{b}\r\nContent-Disposition: form-data; name="{n}"; filename="{fn}"\r\nContent-Type: {ct}\r\n\r\n'.encode() + data + b'\r\n' for n, fn, ct, data in parts) + f'--{b}--\r\n'.encode()
call('PUT', f'/workers/scripts/{NAME}', raw=body, ctype=f'multipart/form-data; boundary={b}')
print('worker uploaded')
# every minute: update notes go out in small batches; every 15 minutes the Monday top 10 post, bot reminders and (with BOT_AUTOSETUP=1) the bot's settings
call('PUT', f'/workers/scripts/{NAME}/schedules', [{'cron': '* * * * *'}])
print('cron set')

# 3. secrets: a session secret made once, and the bot token when given
have = {s['name'] for s in call('GET', f'/workers/scripts/{NAME}/secrets')['result']}
if 'SESSION_SECRET' not in have:
    call('PUT', f'/workers/scripts/{NAME}/secrets', {'name': 'SESSION_SECRET', 'text': secrets.token_urlsafe(48), 'type': 'secret_text'})
if os.environ.get('TELEGRAM_BOT_TOKEN'):
    call('PUT', f'/workers/scripts/{NAME}/secrets', {'name': 'BOT_TOKEN', 'text': os.environ['TELEGRAM_BOT_TOKEN'], 'type': 'secret_text'})
print('secrets set' + ('' if os.environ.get('TELEGRAM_BOT_TOKEN') or 'BOT_TOKEN' in have else ' (no BOT_TOKEN yet: Telegram sign-in is off)'))

# 4. public address
call('POST', f'/workers/scripts/{NAME}/subdomain', {'enabled': True})
sub = call('GET', '/workers/subdomain')['result']['subdomain']
print(f'live at https://{NAME}.{sub}.workers.dev')
