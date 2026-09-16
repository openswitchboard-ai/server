/**
 * The write-only half of the safety key.
 *
 * What is asserted here is the property the whole design leans on: what the
 * server holds lets it WRITE and nothing else, and a row that has been
 * tampered with in the database does not decrypt quietly into something else.
 */
import { describe, expect, it } from 'vitest';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import {
  fingerprintOf,
  generateSafetyKeypair,
  open,
  privateKeyFromRaw,
  publicKeyFromPem,
  seal,
  zeroize,
} from '../../../src/safety/keys.js';

const key = generateSafetyKeypair();
const pub = publicKeyFromPem(key.publicPem);
const priv = privateKeyFromRaw(key.privateRaw);

describe('a keypair the ceremony can carry', () => {
  it('is X25519, so the half people carry is 32 bytes', () => {
    expect(pub.asymmetricKeyType).toBe('x25519');
    expect(key.privateRaw.length).toBe(32);
    expect(key.publicPem).toContain('BEGIN PUBLIC KEY');
    expect(key.publicPem).not.toContain('PRIVATE');
  });

  it('names itself the same way from either half', () => {
    expect(fingerprintOf(priv)).toBe(key.fingerprint);
    expect(fingerprintOf(pub)).toBe(key.fingerprint);
    expect(key.fingerprint).toMatch(/^([0-9a-f]{2}:){7}[0-9a-f]{2}$/);
    expect(fingerprintOf(createPublicKey(generateSafetyKeypair().publicPem))).not.toBe(
      key.fingerprint,
    );
  });

  it('refuses a public key of the wrong kind rather than half-working', () => {
    const ed = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    expect(() => publicKeyFromPem(ed.toString())).toThrow(/expected x25519/);
    expect(() => publicKeyFromPem('nonsense')).toThrow();
    expect(() => privateKeyFromRaw(new Uint8Array(31))).toThrow(/expected 32/);
  });
});

describe('sealing', () => {
  const body = Buffer.from('the words somebody wrote to somebody else');

  it('round trips, and only under the private half', () => {
    const sealed = seal(pub, body);
    expect(open(priv, sealed).toString()).toBe(body.toString());
    const stranger = generateSafetyKeypair();
    expect(() => open(privateKeyFromRaw(stranger.privateRaw), sealed)).toThrow();
    zeroize(stranger.privateRaw);
  });

  it('gives away nothing about the words', () => {
    const sealed = seal(pub, body);
    expect(sealed.body_enc.toString('binary')).not.toContain('words');
    expect(sealed.wrapped_key.length).toBe(92);
    expect(sealed.nonce.length).toBe(12);
    // Same words, twice, are two different ciphertexts: the data key and the
    // ephemeral key are fresh every time.
    expect(seal(pub, body).body_enc.equals(sealed.body_enc)).toBe(false);
  });

  it('will not open a row that was altered in the database', () => {
    const sealed = seal(pub, body);
    const bend = (b: Buffer, i: number) => {
      const c = Buffer.from(b);
      c[i] = c[i]! ^ 0x01;
      return c;
    };
    expect(() => open(priv, { ...sealed, body_enc: bend(sealed.body_enc, 0) })).toThrow();
    expect(() => open(priv, { ...sealed, nonce: bend(sealed.nonce, 0) })).toThrow();
    // Both halves of the wrapped key: the ephemeral public and the key itself.
    expect(() => open(priv, { ...sealed, wrapped_key: bend(sealed.wrapped_key, 0) })).toThrow();
    expect(() => open(priv, { ...sealed, wrapped_key: bend(sealed.wrapped_key, 80) })).toThrow();
    expect(() =>
      open(priv, { ...sealed, wrapped_key: sealed.wrapped_key.subarray(0, 60) }),
    ).toThrow(/expected 92/);
  });

  it('zeroize actually overwrites', () => {
    const b = Buffer.from('secret');
    zeroize(b, undefined, null);
    expect(b.every((x) => x === 0)).toBe(true);
  });
});
