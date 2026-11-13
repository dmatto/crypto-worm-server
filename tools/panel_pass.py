#!/usr/bin/env python3
"""Sets the control panel's user name and password (panel.js) as Worker secrets, through the Cloudflare API.

Reads PANEL_USER and PANEL_PASS from the environment, with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
Only a salted PBKDF2 hash of the password is sent to Cloudflare; the password itself is never stored or printed.
Run from the repo root: PANEL_USER=... PANEL_PASS=... python3 tools/panel_pass.py
"""
import base64, hashlib, json, os, secrets, urllib.request

NAME, ROUNDS = 'crypto-worm-server', 100000
user, pw = os.environ['PANEL_USER'].strip(), os.environ['PANEL_PASS']
assert user and len(pw) >= 10, 'a user name and a password of 10 characters or more'
b64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip('=')
salt = secrets.token_bytes(16)
value = f'pbkdf2${ROUNDS}${b64(salt)}${b64(hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, ROUNDS, 32))}'

def put(name, text):
    req = urllib.request.Request(f'https://api.cloudflare.com/client/v4/accounts/{os.environ["CLOUDFLARE_ACCOUNT_ID"]}/workers/scripts/{NAME}/secrets',
                                 data=json.dumps({'name': name, 'text': text, 'type': 'secret_text'}).encode(), method='PUT',
                                 headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as r: assert json.load(r)['success'], name

put('PANEL_USER', user); put('PANEL_PASS', value)
print('panel sign-in set for user', user)
