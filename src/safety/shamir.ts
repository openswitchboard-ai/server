/**
 * Shamir secret sharing over GF(256), so that reading anything out of the
 * ledger takes two people (docs/trust-and-safety.md, "two keyholders").
 *
 * WHY THIS IS HERE AND NOT A DEPENDENCY. The whole promise is that no single
 * person, and no single machine, can turn the ledger back into words. A
 * dependency in that position is a dependency that can be swapped under us in
 * a release we did not read. It is sixty lines of table lookups; we own them,
 * and the suite holds them.
 *
 * THE SHAPE. A secret is split byte by byte. For each byte of the secret a
 * polynomial is drawn whose constant term is that byte and whose other k-1
 * coefficients are random; every share is that polynomial evaluated at its own
 * non-zero x. Any k shares interpolate back to the constant term. Fewer than k
 * say nothing at all: for every candidate secret there is exactly one
 * polynomial through the shares you hold, so holding one share of a 2-of-3
 * split leaves all 256 values of each byte equally possible.
 *
 * The field is the AES field, x^8 + x^4 + x^3 + x + 1 (0x11b), which is the
 * one every other implementation of this uses, so a share of ours interpolates
 * under someone else's code in an emergency.
 */
import { randomBytes } from 'node:crypto';

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // x *= 3 (the generator), reduced by 0x11b.
    let next = x << 1;
    if (next & 0x100) next ^= 0x11b;
    x = next ^ x; // 3x = 2x + x
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  LOG[0] = 0; // never read: mul short-circuits on zero.
}

/** Multiply in GF(256). */
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Divide in GF(256). Dividing by zero is a programming error, not a value. */
export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero in GF(256)');
  if (a === 0) return 0;
  return EXP[LOG[a] + 255 - LOG[b]];
}

/** One share: the x it was evaluated at, and one y per byte of the secret. */
export interface Share {
  /** 1..255. Never 0 — that is where the secret itself sits. */
  index: number;
  y: Uint8Array;
}

/**
 * Split `secret` into `shares` pieces, any `threshold` of which reconstruct it.
 *
 * `rng` exists for the suite alone. Nothing in the ceremony passes it, so the
 * real split always draws from the system CSPRNG.
 */
export function split(
  secret: Uint8Array,
  shares: number,
  threshold: number,
  rng: (n: number) => Uint8Array = (n) => new Uint8Array(randomBytes(n)),
): Share[] {
  if (secret.length === 0) throw new Error('nothing to split');
  if (!Number.isInteger(shares) || shares < 2 || shares > 255) {
    throw new Error('shares must be 2..255');
  }
  if (!Number.isInteger(threshold) || threshold < 2 || threshold > shares) {
    throw new Error('threshold must be 2..shares');
  }
  const out: Share[] = [];
  for (let i = 1; i <= shares; i++) out.push({ index: i, y: new Uint8Array(secret.length) });
  for (let b = 0; b < secret.length; b++) {
    // The polynomial for this byte: a0 is the secret byte, the rest random.
    const coeffs = new Uint8Array(threshold);
    coeffs[0] = secret[b]!;
    const noise = rng(threshold - 1);
    for (let c = 1; c < threshold; c++) coeffs[c] = noise[c - 1]!;
    for (const share of out) {
      // Horner, from the top coefficient down.
      let acc = 0;
      for (let c = threshold - 1; c >= 0; c--) acc = gfMul(acc, share.index) ^ coeffs[c]!;
      share.y[b] = acc;
    }
  }
  return out;
}

/**
 * Interpolate the secret back from any `threshold` shares. Extra shares are
 * harmless; duplicated indices are not, and are refused rather than silently
 * producing a wrong answer.
 */
export function combine(shares: Share[]): Uint8Array {
  if (shares.length < 2) throw new Error('two shares at least');
  const len = shares[0]!.y.length;
  const seen = new Set<number>();
  for (const s of shares) {
    if (s.index < 1 || s.index > 255) throw new Error(`bad share index ${s.index}`);
    if (seen.has(s.index)) throw new Error(`share ${s.index} given twice`);
    seen.add(s.index);
    if (s.y.length !== len) throw new Error('shares are of different lengths');
  }
  const out = new Uint8Array(len);
  for (let b = 0; b < len; b++) {
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      // Lagrange basis at x = 0: product over j != i of xj / (xj - xi), and
      // subtraction in this field is xor.
      let basis = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        basis = gfMul(basis, gfDiv(shares[j]!.index, shares[i]!.index ^ shares[j]!.index));
      }
      acc ^= gfMul(shares[i]!.y[b]!, basis);
    }
    out[b] = acc;
  }
  return out;
}
