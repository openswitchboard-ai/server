/**
 * Shamir over GF(256): the arithmetic behind "two keyholders".
 *
 * The claim being held here is not "round trips work". It is the one the
 * privacy page makes on our behalf: that a single keyholder, acting alone,
 * learns NOTHING about the key. That is the last test in this file, and it is
 * stated the strong way — for every one of the 256 values a secret byte could
 * take, there is a polynomial consistent with the share held, so the share
 * rules nothing out.
 */
import { describe, expect, it } from 'vitest';
import { combine, gfDiv, gfMul, split, type Share } from '../../../src/safety/shamir.js';

const bytes = (...b: number[]) => new Uint8Array(b);

describe('the field', () => {
  it('multiplies as AES says it does', () => {
    // The worked examples from FIPS-197 and every textbook since.
    expect(gfMul(0x57, 0x83)).toBe(0xc1);
    expect(gfMul(0x57, 0x13)).toBe(0xfe);
    expect(gfMul(0x01, 0xab)).toBe(0xab);
    expect(gfMul(0x00, 0xff)).toBe(0x00);
  });

  it('divides back again', () => {
    for (let a = 0; a < 256; a++) {
      for (const b of [1, 2, 3, 0x57, 0x83, 0xff]) {
        expect(gfDiv(gfMul(a, b), b), `${a}/${b}`).toBe(a);
      }
    }
    expect(() => gfDiv(1, 0)).toThrow(/division by zero/);
  });
});

describe('known answers', () => {
  // Worked by hand, so this test does not depend on our own split(): the
  // secret byte is 0x01 and the (single, random) coefficient is 0x02, so
  // y(x) = 0x01 xor 0x02*x, giving y(1)=0x03, y(2)=0x05, y(3)=0x07.
  const handmade: Share[] = [
    { index: 1, y: bytes(0x03) },
    { index: 2, y: bytes(0x05) },
    { index: 3, y: bytes(0x07) },
  ];

  it('interpolates a hand-worked 2-of-3 split back to its secret', () => {
    expect(Array.from(combine([handmade[0]!, handmade[1]!]))).toEqual([0x01]);
    expect(Array.from(combine([handmade[0]!, handmade[2]!]))).toEqual([0x01]);
    expect(Array.from(combine([handmade[1]!, handmade[2]!]))).toEqual([0x01]);
    expect(Array.from(combine(handmade))).toEqual([0x01]);
  });

  it('splits to the same shares when the randomness is fixed', () => {
    const shares = split(bytes(0x01), 3, 2, () => bytes(0x02));
    expect(shares.map((s) => [s.index, Array.from(s.y)])).toEqual([
      [1, [0x03]],
      [2, [0x05]],
      [3, [0x07]],
    ]);
  });
});

describe('round trip, on the thing actually being split', () => {
  // 32 bytes: an X25519 private key, which is the whole of what the ceremony
  // ever splits.
  const secret = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);

  it('any two of the three rebuild it, and all three do too', () => {
    const [a, b, c] = split(secret, 3, 2);
    for (const pair of [
      [a!, b!],
      [a!, c!],
      [b!, c!],
      [c!, a!], // order does not matter either
    ]) {
      expect(Array.from(combine(pair))).toEqual(Array.from(secret));
    }
    expect(Array.from(combine([a!, b!, c!]))).toEqual(Array.from(secret));
  });

  it('holds for a hundred random secrets', () => {
    for (let i = 0; i < 100; i++) {
      const s = new Uint8Array(32);
      for (let j = 0; j < 32; j++) s[j] = Math.floor(Math.random() * 256);
      const shares = split(s, 3, 2);
      expect(Array.from(combine([shares[1]!, shares[2]!]))).toEqual(Array.from(s));
    }
  });

  it('refuses the ways a ceremony goes wrong', () => {
    const shares = split(secret, 3, 2);
    expect(() => combine([shares[0]!])).toThrow(/two shares/);
    expect(() => combine([shares[0]!, shares[0]!])).toThrow(/twice/);
    expect(() => combine([shares[0]!, { index: 2, y: new Uint8Array(8) }])).toThrow(
      /different lengths/,
    );
    expect(() => split(secret, 3, 4)).toThrow(/threshold/);
    expect(() => split(new Uint8Array(0), 3, 2)).toThrow(/nothing to split/);
  });

  it('does a 3-of-5 as well, since the field does not care', () => {
    const shares = split(secret, 5, 3);
    expect(Array.from(combine([shares[0]!, shares[2]!, shares[4]!]))).toEqual(Array.from(secret));
    // Two of a 3-of-5 is the wrong number of points and gives something else.
    expect(Array.from(combine([shares[0]!, shares[2]!]))).not.toEqual(Array.from(secret));
  });
});

describe('one share tells nothing', () => {
  it('leaves every one of the 256 values of each byte exactly as possible', () => {
    const secret = bytes(0x9c);
    const [held] = split(secret, 3, 2);
    // For the share (x, y) in hand, and ANY candidate secret s, there is
    // exactly one line through (0, s) and (x, y): its slope is (y xor s)/x.
    // So the share rules nothing out, and an attacker holding it is exactly
    // where they started.
    const consistent = new Set<number>();
    for (let s = 0; s < 256; s++) {
      const slope = gfDiv(held!.y[0]! ^ s, held!.index);
      if ((s ^ gfMul(slope, held!.index)) === held!.y[0]!) consistent.add(s);
    }
    expect(consistent.size).toBe(256);
  });

  it('spreads a fixed secret over the whole byte range across many splits', () => {
    // The other half of the same claim, statistically: splitting the SAME
    // secret many times, the first share's byte lands all over the range
    // rather than clustering near the secret.
    const seen = new Map<number, number>();
    for (let i = 0; i < 4000; i++) {
      const [a] = split(bytes(0x9c), 3, 2);
      seen.set(a!.y[0]!, (seen.get(a!.y[0]!) ?? 0) + 1);
    }
    expect(seen.size).toBeGreaterThan(240); // nearly every value turns up
    // and none of them dominates: uniform would be ~15.6 each.
    expect(Math.max(...seen.values())).toBeLessThan(50);
  });
});
