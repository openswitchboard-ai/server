/**
 * The safety key: write-only encryption for the thirty-day ledger.
 *
 * THE RULE THIS FILE EXISTS TO KEEP. The server can write into the ledger and
 * can never read it back. It holds one thing, the PUBLIC half of the safety
 * key; the private half is split between keyholders and is never on a server,
 * in an image, in an environment variable or in a backup. A machine that is
 * fully compromised gives an attacker the ability to add entries, and nothing
 * else.
 *
 * WHY X25519 AND NOT RSA. The half that gets split and carried by people is
 * 32 bytes, so a 2-of-3 share is one short line a keyholder can print, read
 * back over a phone, or keep on paper in a safe. The RSA alternative splits a
 * three-kilobyte private key into three kilobyte-long blobs nobody can check
 * by eye, takes seconds to generate, and offers a dozen ways to get the
 * padding wrong. Node has X25519 in the standard library, HKDF beside it, and
 * no parameters to choose. The shape is ordinary sealed-box / ECIES:
 *
 *   per entry:  data key    = 32 random bytes
 *               body_enc    = AES-256-GCM(data key, nonce, body) || tag
 *               ephemeral   = a fresh X25519 keypair, used once
 *               KEK         = HKDF-SHA256(X25519(ephemeral, safety public),
 *                                         salt = both public keys,
 *                                         info = "osb-safety-ledger-v1")
 *               wrapped_key = ephemeral public || nonce || AES-256-GCM(KEK, data key)
 *
 * Nothing in the wrapped key or the body can be turned back into words without
 * the private half, which takes two keyholders to reconstitute.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

const INFO = Buffer.from('osb-safety-ledger-v1');
/** SPKI wrapper around a raw 32-byte X25519 public key. */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
/** PKCS#8 wrapper around a raw 32-byte X25519 private key. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export interface SafetyKeypair {
  /** What goes to the server, as PEM. */
  publicPem: string;
  /** The 32 bytes that get split. Zero this as soon as the shares are written. */
  privateRaw: Buffer;
  fingerprint: string;
}

/** A fresh safety keypair. Only the ceremony script calls this. */
export function generateSafetyKeypair(): SafetyKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  return {
    publicPem,
    privateRaw: Buffer.from(pkcs8.subarray(pkcs8.length - 32)),
    fingerprint: fingerprintOf(publicKey),
  };
}

/**
 * Read the public half out of PEM, refusing anything that is not an X25519
 * public key. A configuration mistake here must be loud at boot, not a ledger
 * that silently keeps nothing.
 */
export function publicKeyFromPem(pem: string): KeyObject {
  const key = createPublicKey(pem.includes('BEGIN') ? pem : Buffer.from(pem, 'base64'));
  if (key.asymmetricKeyType !== 'x25519') {
    throw new Error(`SAFETY_PUBLIC_KEY is ${key.asymmetricKeyType ?? 'unknown'}, expected x25519`);
  }
  return key;
}

/** The private half, back from the 32 bytes two keyholders reconstructed. */
export function privateKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new Error(`safety private key is ${raw.length} bytes, expected 32`);
  const der = Buffer.concat([PKCS8_PREFIX, Buffer.from(raw)]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/**
 * A short name for a key, so a keyholder can tell at a glance that their share
 * belongs to the ledger they are being asked to open. SHA-256 over the public
 * key's DER, first eight bytes, in pairs.
 */
export function fingerprintOf(key: KeyObject): string {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  const der = pub.export({ type: 'spki', format: 'der' }) as Buffer;
  const h = createHash('sha256').update(der).digest('hex').slice(0, 16);
  return (h.match(/.{2}/g) ?? []).join(':');
}

function rawPublic(key: KeyObject): Buffer {
  const der = key.export({ type: 'spki', format: 'der' }) as Buffer;
  return Buffer.from(der.subarray(der.length - 32));
}

/** One entry's ciphertext, in the three columns the table keeps it in. */
export interface Sealed {
  /** ephemeral public (32) || wrap nonce (12) || wrapped data key (32) || tag (16). */
  wrapped_key: Buffer;
  /** AES-256-GCM ciphertext of the body, with its tag on the end. */
  body_enc: Buffer;
  /** The body's nonce. Kept in its own column so it is plainly not a secret. */
  nonce: Buffer;
}

/** Encrypt one body to the safety public key. This is the only write path. */
export function seal(publicKey: KeyObject, body: Buffer): Sealed {
  const dataKey = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
  const body_enc = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);

  const eph = generateKeyPairSync('x25519');
  const ephRaw = rawPublic(eph.publicKey);
  const recipientRaw = rawPublic(publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey });
  const kek = Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([ephRaw, recipientRaw]), INFO, 32),
  );
  const wrapNonce = randomBytes(12);
  const wrap = createCipheriv('aes-256-gcm', kek, wrapNonce);
  const wrapped = Buffer.concat([wrap.update(dataKey), wrap.final(), wrap.getAuthTag()]);

  dataKey.fill(0);
  shared.fill(0);
  kek.fill(0);
  return { wrapped_key: Buffer.concat([ephRaw, wrapNonce, wrapped]), body_enc, nonce };
}

/**
 * Decrypt one entry. Reachable only from the export ceremony, holding a
 * private key that two people put back together minutes earlier and that is in
 * memory and nowhere else.
 */
export function open(privateKey: KeyObject, sealed: Sealed): Buffer {
  const { wrapped_key, body_enc, nonce } = sealed;
  if (wrapped_key.length !== 32 + 12 + 32 + 16) {
    throw new Error(`wrapped key is ${wrapped_key.length} bytes, expected 92`);
  }
  const ephRaw = wrapped_key.subarray(0, 32);
  const wrapNonce = wrapped_key.subarray(32, 44);
  const wrapped = wrapped_key.subarray(44);
  const ephPublic = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, ephRaw]),
    format: 'der',
    type: 'spki',
  });
  const recipientRaw = rawPublic(createPublicKey(privateKey));
  const shared = diffieHellman({ privateKey, publicKey: ephPublic });
  const kek = Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([ephRaw, recipientRaw]), INFO, 32),
  );
  const unwrap = createDecipheriv('aes-256-gcm', kek, wrapNonce);
  unwrap.setAuthTag(wrapped.subarray(wrapped.length - 16));
  const dataKey = Buffer.concat([
    unwrap.update(wrapped.subarray(0, wrapped.length - 16)),
    unwrap.final(),
  ]);

  const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce);
  decipher.setAuthTag(body_enc.subarray(body_enc.length - 16));
  const body = Buffer.concat([
    decipher.update(body_enc.subarray(0, body_enc.length - 16)),
    decipher.final(),
  ]);

  dataKey.fill(0);
  shared.fill(0);
  kek.fill(0);
  return body;
}

/** Overwrite key material once it is spent. Cheap, and the habit is the point. */
export function zeroize(...buffers: Array<Uint8Array | undefined | null>): void {
  for (const b of buffers) b?.fill(0);
}
