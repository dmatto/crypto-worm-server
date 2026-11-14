# The browser's side of Web Push message encryption (RFC 8291), written separately from src/push.js with the
# `cryptography` library, so the test checks the Worker's encryption against a second implementation.
#   python3 push_decrypt.py <message file> <private key d, base64url> <public key, base64url> <auth secret, base64url>
import base64, sys
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

def unb(s): return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))
def hkdf(salt, ikm, info, n): return HKDF(algorithm=hashes.SHA256(), length=n, salt=salt, info=info).derive(ikm)

msg = open(sys.argv[1], 'rb').read()
priv = ec.derive_private_key(int.from_bytes(unb(sys.argv[2]), 'big'), ec.SECP256R1())
ua_public, auth = unb(sys.argv[3]), unb(sys.argv[4])
salt, rs, idlen = msg[:16], int.from_bytes(msg[16:20], 'big'), msg[20]
as_public, body = msg[21:21 + idlen], msg[21 + idlen:]
assert rs == 4096 and idlen == 65, (rs, idlen)
shared = priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public))
ikm = hkdf(auth, shared, b'WebPush: info\x00' + ua_public + as_public, 32)
cek, nonce = hkdf(salt, ikm, b'Content-Encoding: aes128gcm\x00', 16), hkdf(salt, ikm, b'Content-Encoding: nonce\x00', 12)
plain = AESGCM(cek).decrypt(nonce, body, None)
assert plain[-1] == 2, plain[-1]          # the last-record mark
sys.stdout.write(plain[:-1].decode())
