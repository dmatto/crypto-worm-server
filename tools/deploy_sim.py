#!/usr/bin/env python3
"""Deploy the load-test Worker (sim/) through the Cloudflare API: python3 tools/deploy_sim.py

It is a separate Worker, crypto-worm-sim, that reaches the game server through a service binding (GAME), keeps its orders
and numbers in two Durable Objects and writes a summary row a minute to the game's D1 database (sim_stats). It also makes
sure both Workers share the secret SIM_KEY that marks simulated players (made once here, sent only to Cloudflare, never
printed). Reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment. Deploy the game server first.
"""
import json, os, secrets, sys, uuid, urllib.request, urllib.error

NAME, GAME, DB_NAME, COMPAT = 'crypto-worm-sim', 'crypto-worm-server', 'crypto-worm', '2025-09-01'
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


db = next(d for d in call('GET', '/d1/database?name=' + DB_NAME)['result'] if d['name'] == DB_NAME)
first = not any(s['id'] == NAME for s in call('GET', '/workers/scripts')['result'])
meta = {
    'main_module': 'index.js', 'compatibility_date': COMPAT,
    'bindings': [{'type': 'd1', 'name': 'DB', 'id': db['uuid']},
                 {'type': 'service', 'name': 'GAME', 'service': GAME},
                 {'type': 'durable_object_namespace', 'name': 'FLEET', 'class_name': 'Fleet'},
                 {'type': 'durable_object_namespace', 'name': 'CONTROL', 'class_name': 'Control'}],
    'keep_bindings': ['secret_text'],
}
if first: meta['migrations'] = {'new_tag': 'v1', 'new_sqlite_classes': ['Fleet', 'Control']}
b = uuid.uuid4().hex
parts = [('metadata', 'metadata.json', 'application/json', json.dumps(meta).encode())]
for f in ('index.js', 'fleet.js', 'control.js', 'names.js', 'stats.js'): parts.append((f, f, 'application/javascript+module', open('sim/' + f, 'rb').read()))
parts.append(('world.js', 'world.js', 'application/javascript+module', open('src/world.js', 'rb').read()))   # the map's tiles, for picking land next to a bot's own
body = b''.join(f'--{b}\r\nContent-Disposition: form-data; name="{n}"; filename="{fn}"\r\nContent-Type: {ct}\r\n\r\n'.encode() + data + b'\r\n' for n, fn, ct, data in parts) + f'--{b}--\r\n'.encode()
call('PUT', f'/workers/scripts/{NAME}', raw=body, ctype=f'multipart/form-data; boundary={b}')
print('worker uploaded')
call('PUT', f'/workers/scripts/{NAME}/schedules', [{'cron': '* * * * *'}])   # every minute: new orders, wake the fleets, a summary row
print('cron set')

# the shared key: when either Worker lacks it, a new one goes to both
have = lambda w: {s['name'] for s in call('GET', f'/workers/scripts/{w}/secrets')['result']}
if 'SIM_KEY' not in have(NAME) or 'SIM_KEY' not in have(GAME):
    key = secrets.token_urlsafe(48)
    for w in (GAME, NAME): call('PUT', f'/workers/scripts/{w}/secrets', {'name': 'SIM_KEY', 'text': key, 'type': 'secret_text'})
    print('SIM_KEY set on both Workers')
else: print('SIM_KEY already on both Workers')

call('POST', f'/workers/scripts/{NAME}/subdomain', {'enabled': True})
sub = call('GET', '/workers/subdomain')['result']['subdomain']
print(f'live at https://{NAME}.{sub}.workers.dev')
