/**
 * The ledger: what is written, what is never written, and what the thirty days
 * mean.
 *
 * The four claims held here are the four the privacy page will rest on:
 *
 *   - an item that PASSED is kept, encrypted, and the words of it are nowhere
 *     in the row but the sealed body;
 *   - an item that was REFUSED keeps its sender, its door and its reason code
 *     and nothing else at all;
 *   - the server that wrote it cannot read it back — there is no decrypt path
 *     in the module, and the key it holds is a public key;
 *   - a ledger write can never fail an intake, and never puts the words of an
 *     item into a log line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as db from '../../../src/db.js';
import { generateSafetyKeypair, open, privateKeyFromRaw } from '../../../src/safety/keys.js';
import {
  INSERT_SQL,
  LEDGER_WINDOW_DAYS,
  SWEEP_PREDICATE,
  SWEEP_SQL,
  bodyOf,
  entryParams,
  isDueForSweep,
  ledgerFor,
  ledgerFromConfig,
  preserveEntries,
  reasonCodesOnly,
  resetLedgerCache,
  sweepLedgerEntries,
  warnIfLedgerDisabled,
} from '../../../src/safety/ledger.js';
import { noLedger } from '../../../src/intake/types.js';
import { runIntake } from '../../../src/intake/pipe.js';
import type { Config } from '../../../src/config.js';
import type { Check, IntakeItem, Verdict } from '../../../src/intake/types.js';

const KEYS = generateSafetyKeypair();
const PUB = createPublicKey(KEYS.publicPem);
const PRIV = privateKeyFromRaw(KEYS.privateRaw);

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const MATCH = 'cccccccc-3333-4333-8333-cccccccccccc';

const SECRET = 'meet me at 14 Arundel Street, my number is 0400 111 222';

const item = (over: Partial<IntakeItem> = {}): IntakeItem => ({
  door: 'message',
  sender_account: ACCOUNT,
  recipient_account: OTHER,
  match_id: MATCH,
  text: SECRET,
  ...over,
});

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  outcome: 'pass',
  checks: [{ name: 'modelScreen', outcome: 'pass', model_id: 'haiku', detail: SECRET }],
  ...over,
});

/** A pool that remembers every statement, and answers nothing. */
function recordingPool() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  } as any;
  return { pool, calls };
}

let logged: string[] = [];
beforeEach(() => {
  resetLedgerCache();
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((line: any) => void logged.push(String(line)));
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe('what a passed item leaves behind', () => {
  it('writes the row, and the words are only inside the sealed body', async () => {
    const { pool, calls } = recordingPool();
    vi.spyOn(db, 'getPool').mockReturnValue(pool);
    await ledgerFor(PUB).recordVerdict(item(), verdict());

    expect(calls).toHaveLength(1);
    const [{ sql, params }] = calls;
    expect(sql).toBe(INSERT_SQL);
    expect(sql).toContain("now() + ($9 || ' days')::interval");
    expect(params[8]).toBe(String(LEDGER_WINDOW_DAYS));
    expect(LEDGER_WINDOW_DAYS).toBe(30);

    // Who, which door, which introduction: all in the clear, all needed to
    // find an entry again without reading one.
    expect(params[1]).toBe('message');
    expect(params[2]).toBe('pass');
    expect(params[4]).toBe(ACCOUNT);
    expect(params[5]).toBe(OTHER);
    expect(params[6]).toBe(MATCH);

    // And nothing that was said is anywhere in the row except the ciphertext.
    const clear = params
      .filter((p) => !(p instanceof Buffer))
      .map((p) => String(p))
      .join(' ');
    expect(clear).not.toContain('Arundel');
    expect(clear).not.toContain('0400');
  });

  it('seals the body so that only the private half opens it', async () => {
    const params = entryParams(PUB, item(), verdict());
    const [wrapped, body, nonce] = [params[9] as Buffer, params[10] as Buffer, params[11] as Buffer];
    expect(wrapped).toBeInstanceOf(Buffer);
    expect(wrapped.length).toBe(92); // ephemeral public, nonce, key, tag
    expect(body.toString('binary')).not.toContain('Arundel');

    const plain = JSON.parse(
      open(PRIV, { wrapped_key: wrapped, body_enc: body, nonce }).toString('utf8'),
    );
    expect(plain).toEqual({ door: 'message', text: SECRET });
  });

  it('gives every entry a key of its own', () => {
    const a = entryParams(PUB, item(), verdict())[9] as Buffer;
    const b = entryParams(PUB, item(), verdict())[9] as Buffer;
    expect(a.equals(b)).toBe(false);
    // The same words twice do not produce the same ciphertext either.
    const ca = entryParams(PUB, item(), verdict())[10] as Buffer;
    const cb = entryParams(PUB, item(), verdict())[10] as Buffer;
    expect(ca.equals(cb)).toBe(false);
  });

  it('keeps a held item whole, because a review with the words out is not a review', () => {
    const params = entryParams(PUB, item(), verdict({ outcome: 'hold', reason_code: 'grooming' }));
    expect(params[2]).toBe('hold');
    expect(params[3]).toBe('grooming');
    expect(params[10]).toBeInstanceOf(Buffer);
  });

  it('carries a photo by where its bytes are, never the bytes', () => {
    const body = JSON.parse(
      bodyOf(
        item({
          door: 'photo',
          text: undefined,
          object: { bucket: 'photos', key: 'k/1', content_type: 'image/jpeg' },
        }),
      ).toString('utf8'),
    );
    expect(body).toEqual({
      door: 'photo',
      object: { bucket: 'photos', key: 'k/1', content_type: 'image/jpeg' },
    });
  });
});

// ---------------------------------------------------------------------------
describe('what a refused item leaves behind', () => {
  it('the sender, the door, the reason, and nothing else', () => {
    const params = entryParams(
      PUB,
      item(),
      verdict({ outcome: 'refuse', reason_code: 'MONEY_IN_WORDS', plain_words: SECRET }),
    );
    expect(params[2]).toBe('refuse');
    expect(params[3]).toBe('MONEY_IN_WORDS');
    expect(params[4]).toBe(ACCOUNT);
    expect(params[9]).toBeNull();
    expect(params[10]).toBeNull();
    expect(params[11]).toBeNull();
    expect(JSON.stringify(params)).not.toContain('Arundel');
  });

  it('keeps reason codes out of the checks column and nothing that quotes the item', () => {
    const checks = reasonCodesOnly([
      {
        name: 'modelScreen',
        outcome: 'refuse',
        reason_code: 'PII',
        detail: SECRET,
        plain_words: `there is an address in this: ${SECRET}`,
        model_id: 'haiku',
        error: new Error(SECRET),
      },
    ]);
    expect(checks).toEqual([
      { name: 'modelScreen', outcome: 'refuse', reason_code: 'PII', model_id: 'haiku' },
    ]);
    expect(JSON.stringify(checks)).not.toContain('Arundel');
  });
});

// ---------------------------------------------------------------------------
describe('a ledger write can never fail an intake', () => {
  const alwaysPasses: Check = {
    name: 'nothing',
    doors: ['message'],
    run: async () => ({ name: 'nothing', outcome: 'pass' }),
  };

  it('a database that is down leaves the verdict standing', async () => {
    vi.spyOn(db, 'getPool').mockImplementation(() => {
      throw Object.assign(new Error(`connection refused writing ${SECRET}`), { code: 'ECONNREFUSED' });
    });
    const v = await runIntake({ safetyPublicKey: KEYS.publicPem } as Config, item(), {
      checks: [alwaysPasses],
    });
    expect(v.outcome).toBe('pass');
    // Logged as a code and a door. Never as the item, and never as the error's
    // own message, which had the words of it in this case.
    const line = logged.find((l) => l.includes('ledger-write-failed'));
    expect(line).toBeTruthy();
    expect(JSON.parse(line!)).toEqual({
      event: 'ledger-write-failed',
      door: 'message',
      outcome: 'pass',
      code: 'ECONNREFUSED',
    });
    expect(logged.join('\n')).not.toContain('Arundel');
  });

  it('a public key that will not parse turns the ledger off rather than the switchboard', async () => {
    const led = ledgerFromConfig({ safetyPublicKey: 'not a key' } as Config);
    expect(led).toBe(noLedger);
    expect(logged.join('\n')).toContain('ledger-key-unreadable');
    const v = await runIntake({ safetyPublicKey: 'not a key' } as Config, item(), {
      checks: [alwaysPasses],
    });
    expect(v.outcome).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
describe('which ledger a deployment gets', () => {
  it('none at all without a safety public key, and one plain line to say so', () => {
    expect(ledgerFromConfig(undefined)).toBe(noLedger);
    expect(ledgerFromConfig({} as Config)).toBe(noLedger);
    const said: string[] = [];
    expect(warnIfLedgerDisabled({} as Config, (m) => said.push(m))).toBe(true);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/SAFETY_PUBLIC_KEY/);
    expect(said[0]).toMatch(/nothing that passes intake is kept/i);
    expect(warnIfLedgerDisabled({ safetyPublicKey: KEYS.publicPem } as Config, () => {})).toBe(false);
  });

  it('the real one with a key, parsed once and reused', () => {
    const cfg = { safetyPublicKey: KEYS.publicPem } as Config;
    const a = ledgerFromConfig(cfg);
    expect(a).not.toBe(noLedger);
    expect(ledgerFromConfig(cfg)).toBe(a);
  });

  it('goes through the pipe when a deployment has one', async () => {
    const { pool, calls } = recordingPool();
    vi.spyOn(db, 'getPool').mockReturnValue(pool);
    await runIntake({ safetyPublicKey: KEYS.publicPem } as Config, item(), {
      checks: [{ name: 'n', doors: ['message'], run: async () => ({ name: 'n', outcome: 'pass' }) }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe(INSERT_SQL);
  });

  it('writes nothing where there is no key', async () => {
    const { pool, calls } = recordingPool();
    vi.spyOn(db, 'getPool').mockReturnValue(pool);
    await runIntake({} as Config, item(), {
      checks: [{ name: 'n', doors: ['message'], run: async () => ({ name: 'n', outcome: 'pass' }) }],
    });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('thirty days, and the freeze that outlasts them', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = new Date('2026-10-17T00:00:00Z');
  const ago = (d: number) => new Date(now.getTime() - d * day);
  const hence = (d: number) => new Date(now.getTime() + d * day);

  it('the predicate: past expiry, and not held by lawful process', () => {
    // Inside the window: stays.
    expect(isDueForSweep({ expires_at: hence(1), preserved_until: null }, now)).toBe(false);
    // Past the window, nothing holding it: goes.
    expect(isDueForSweep({ expires_at: ago(1), preserved_until: null }, now)).toBe(true);
    // Past the window, but preserved into the future: stays, however far past
    // the thirty days that puts it.
    expect(isDueForSweep({ expires_at: ago(40), preserved_until: hence(60) }, now)).toBe(false);
    // A preservation that has itself run out: the ordinary rule takes over.
    expect(isDueForSweep({ expires_at: ago(40), preserved_until: ago(1) }, now)).toBe(true);
    // Inside the window AND preserved: stays, plainly.
    expect(isDueForSweep({ expires_at: hence(10), preserved_until: hence(60) }, now)).toBe(false);
  });

  it('the SQL says the same thing, clause for clause', () => {
    expect(SWEEP_PREDICATE).toContain('expires_at < now()');
    expect(SWEEP_PREDICATE).toContain('preserved_until IS NULL OR preserved_until < now()');
    expect(SWEEP_SQL).toContain('DELETE FROM ledger_entries');
    expect(SWEEP_SQL).toContain(SWEEP_PREDICATE);
    // Bounded, so one tick can never take the table out for minutes.
    expect(SWEEP_SQL).toContain('LIMIT 1000');
    // And it deletes; it never selects a body out on the way.
    expect(SWEEP_SQL).not.toMatch(/body_enc|wrapped_key/);
  });

  it('the sweep counts what it deleted and looks at nothing', async () => {
    const seen: string[] = [];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string) => {
        seen.push(sql);
        return { rows: [], rowCount: 4 };
      },
    } as any);
    expect(await sweepLedgerEntries()).toEqual({ entries: 4 });
    expect(seen).toEqual([SWEEP_SQL]);
    expect(JSON.parse(logged.find((l) => l.includes('ledger-swept'))!)).toEqual({
      event: 'ledger-swept',
      count: 4,
    });
  });

  it('preserving moves a date and reads nothing', async () => {
    const { pool, calls } = recordingPool();
    vi.spyOn(db, 'getPool').mockReturnValue(pool);
    const until = hence(90);
    await preserveEntries(['id-1', 'id-2'], until);
    expect(calls[0]!.sql).toContain('UPDATE ledger_entries SET preserved_until');
    expect(calls[0]!.sql).not.toMatch(/SELECT|body_enc/);
    expect(calls[0]!.params).toEqual([['id-1', 'id-2'], until]);
    // Never shortens a preservation already in place.
    expect(calls[0]!.sql).toContain('preserved_until IS NULL OR preserved_until < $2');
    expect(await preserveEntries([], until)).toEqual({ preserved: 0 });
  });
});

// ---------------------------------------------------------------------------
describe('the server cannot read what it wrote', () => {
  it('holds a public key and has no way to open an entry', () => {
    expect(PUB.type).toBe('public');
    expect(PUB.asymmetricKeyType).toBe('x25519');
    // Stated mechanically: nothing in the module that the service runs opens
    // anything. The only decrypt in the repository is the export ceremony,
    // which takes two share files.
    const source = readFileSync(
      new URL('../../../src/safety/ledger.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/\bopen\(|createDecipheriv|privateKey/);
  });
});
