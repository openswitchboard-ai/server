/**
 * The ceremony, end to end, with no database and no server anywhere near it:
 * make a key, split it three ways, write entries the way the pipe would, then
 * put the key back from TWO share files and export a bundle.
 *
 * The keys here are made in the test process and live and die in it; the only
 * thing written to disk is a bundle under the OS temp directory, deleted at
 * the end. No real key is created anywhere.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash, createPublicKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SHARES,
  THRESHOLD,
  exportBundle,
  parseShareFile,
  privateKeyFromShares,
  rowQuery,
  shareFile,
  splitPrivateKey,
  type LedgerRow,
  type RowSource,
} from '../../../src/safety/ceremony.js';
import { entryParams } from '../../../src/safety/ledger.js';
import { generateSafetyKeypair, zeroize } from '../../../src/safety/keys.js';
import type { IntakeItem, Verdict } from '../../../src/intake/types.js';

const tmp = mkdtempSync(join(tmpdir(), 'osb-ceremony-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const MATCH = 'cccccccc-3333-4333-8333-cccccccccccc';

/** The keypair the whole file works from, made the way the script makes it. */
const key = generateSafetyKeypair();
const publicKey = createPublicKey(key.publicPem);
const shareTexts = splitPrivateKey(key.privateRaw).map((s) => shareFile(s, key.fingerprint));
zeroize(key.privateRaw);

/** A row exactly as the insert would have built it, without the insert. */
function rowFor(item: IntakeItem, verdict: Verdict, id: string): LedgerRow {
  const p = entryParams(publicKey, item, verdict);
  return {
    id,
    door: p[1] as string,
    outcome: p[2] as string,
    reason_code: (p[3] as string) ?? null,
    sender_account: p[4] as string,
    recipient_account: (p[5] as string) ?? null,
    match_id: (p[6] as string) ?? null,
    intent_id: (p[7] as string) ?? null,
    created_at: new Date('2026-09-17T01:00:00Z'),
    expires_at: new Date('2026-10-17T01:00:00Z'),
    preserved_until: null,
    wrapped_key: p[9] as Buffer | null,
    body_enc: p[10] as Buffer | null,
    nonce: p[11] as Buffer | null,
    checks: JSON.parse(p[12] as string),
  };
}

const passed = rowFor(
  {
    door: 'message',
    sender_account: ACCOUNT,
    recipient_account: OTHER,
    match_id: MATCH,
    text: 'I can drop it round on Saturday if that suits',
  },
  { outcome: 'pass', checks: [{ name: 'moneyFigure', outcome: 'pass' }] },
  '11111111-1111-4111-8111-111111111111',
);
const refused = rowFor(
  {
    door: 'message',
    sender_account: ACCOUNT,
    recipient_account: OTHER,
    match_id: MATCH,
    text: 'I could go to 450 if you deliver',
  },
  {
    outcome: 'refuse',
    reason_code: 'MONEY_IN_WORDS',
    checks: [{ name: 'moneyFigure', outcome: 'refuse', reason_code: 'MONEY_IN_WORDS' }],
  },
  '22222222-2222-4222-8222-222222222222',
);

/** The injected row source: the whole reason this runs without Postgres. */
const source: RowSource = async (q) => {
  const all = [passed, refused];
  return all.filter((r) => (q.ids ? q.ids.includes(r.id) : r.match_id === q.match_id));
};

// ---------------------------------------------------------------------------
describe('share files', () => {
  it('say which key they open, and nothing about how to open it', () => {
    expect(shareTexts).toHaveLength(SHARES);
    for (const text of shareTexts) {
      expect(text).toContain('OpenSwitchboard safety key share');
      expect(text).toContain(`scheme: shamir-gf256 ${THRESHOLD}-of-${SHARES}`);
      expect(text).toContain(`fingerprint: ${key.fingerprint}`);
      // The private key never appears whole in any one of them.
      expect(text).not.toContain(key.publicPem.trim());
      expect(text).toContain('One of them opens nothing at all');
    }
  });

  it('catch a share that was transcribed wrong before anyone wastes an hour', () => {
    const damaged = shareTexts[0]!.replace(/share: ([0-9a-f]{4})/, 'share: dead');
    expect(() => parseShareFile(damaged)).toThrow(/checksum/);
    expect(() => parseShareFile('hello')).toThrow(/not an OpenSwitchboard share file/);
  });

  it('refuse two shares that belong to different keys', () => {
    const other = generateSafetyKeypair();
    const stranger = shareFile(splitPrivateKey(other.privateRaw)[0]!, other.fingerprint);
    zeroize(other.privateRaw);
    expect(() =>
      privateKeyFromShares([parseShareFile(shareTexts[0]!), parseShareFile(stranger)]),
    ).toThrow(/different keys/);
  });

  it('refuse one share on its own', () => {
    expect(() => privateKeyFromShares([parseShareFile(shareTexts[0]!)])).toThrow(/shares are needed/);
  });
});

// ---------------------------------------------------------------------------
describe('two keyholders, one bundle', () => {
  it('any two of the three rebuild the key that opens the ledger', async () => {
    for (const pair of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      const priv = privateKeyFromShares(pair.map((i) => parseShareFile(shareTexts[i]!)));
      const dir = join(tmp, `pair-${pair.join('')}`);
      const bundle = await exportBundle({
        rows: await source({ match_id: MATCH }),
        privateKey: priv,
        outDir: dir,
        query: { match_id: MATCH },
        shareIndices: pair.map((i) => i + 1),
      });
      expect(bundle.entries).toBe(2);
      const entry = JSON.parse(
        readFileSync(join(dir, 'entries', `${passed.id}.json`), 'utf8'),
      );
      expect(entry.body).toEqual({
        door: 'message',
        text: 'I can drop it round on Saturday if that suits',
      });
    }
  });

  it('writes a manifest, a file per entry, and sums that check out', async () => {
    const priv = privateKeyFromShares([parseShareFile(shareTexts[0]!), parseShareFile(shareTexts[1]!)]);
    const dir = join(tmp, 'bundle');
    const bundle = await exportBundle({
      rows: await source({ match_id: MATCH }),
      privateKey: priv,
      outDir: dir,
      query: { match_id: MATCH },
      shareIndices: [1, 2],
      now: new Date('2026-09-18T00:00:00Z'),
    });

    expect(readdirSync(dir).sort()).toEqual(['SHA256SUMS', 'entries', 'manifest.json']);
    expect(readdirSync(join(dir, 'entries')).sort()).toEqual([
      `${passed.id}.json`,
      `${refused.id}.json`,
    ]);

    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.key_fingerprint).toBe(key.fingerprint);
    expect(manifest.keyholder_shares).toEqual([1, 2]);
    expect(manifest.entry_count).toBe(2);
    expect(manifest.asked_for.match_id).toBe(MATCH);
    expect(manifest.produced_at).toBe('2026-09-18T00:00:00.000Z');

    // Every line of SHA256SUMS is the hash of the file it names, and the
    // bundle hash is the hash of that file: one number standing for the whole,
    // for two keyholders to sign.
    const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8');
    for (const line of sums.trim().split('\n')) {
      const [sha, name] = line.split('  ');
      expect(createHash('sha256').update(readFileSync(join(dir, name!))).digest('hex')).toBe(sha);
    }
    expect(createHash('sha256').update(sums).digest('hex')).toBe(bundle.hash);
    expect(sums).toContain('manifest.json');
  });

  it('a refused entry comes out with its reason and no words, and says why', async () => {
    const priv = privateKeyFromShares([parseShareFile(shareTexts[0]!), parseShareFile(shareTexts[2]!)]);
    const dir = join(tmp, 'refused');
    await exportBundle({
      rows: await source({ ids: [refused.id] }),
      privateKey: priv,
      outDir: dir,
      query: { ids: [refused.id] },
      shareIndices: [1, 3],
    });
    const entry = JSON.parse(readFileSync(join(dir, 'entries', `${refused.id}.json`), 'utf8'));
    expect(entry.outcome).toBe('refuse');
    expect(entry.reason_code).toBe('MONEY_IN_WORDS');
    expect(entry.body).toBeNull();
    expect(entry.note).toMatch(/nothing of what was sent was kept/);
    expect(JSON.stringify(entry)).not.toContain('450');
  });

  it('an entry sealed to another key is marked, not fatal', async () => {
    const stranger = generateSafetyKeypair();
    const strangerRow = {
      ...passed,
      id: '33333333-3333-4333-8333-333333333333',
      ...(() => {
        const p = entryParams(
          createPublicKey(stranger.publicPem),
          { door: 'message', sender_account: ACCOUNT, text: 'sealed elsewhere' },
          { outcome: 'pass', checks: [] },
        );
        return { wrapped_key: p[9] as Buffer, body_enc: p[10] as Buffer, nonce: p[11] as Buffer };
      })(),
    };
    zeroize(stranger.privateRaw);
    const priv = privateKeyFromShares([parseShareFile(shareTexts[1]!), parseShareFile(shareTexts[2]!)]);
    const dir = join(tmp, 'stranger');
    const bundle = await exportBundle({
      rows: [passed, strangerRow],
      privateKey: priv,
      outDir: dir,
      query: { ids: [passed.id, strangerRow.id] },
      shareIndices: [2, 3],
    });
    expect(bundle.entries).toBe(2);
    const bad = JSON.parse(readFileSync(join(dir, 'entries', `${strangerRow.id}.json`), 'utf8'));
    expect(bad.body).toBeNull();
    expect(bad.note).toMatch(/could not be decrypted/);
    // The one that could be read still was.
    const good = JSON.parse(readFileSync(join(dir, 'entries', `${passed.id}.json`), 'utf8'));
    expect(good.body.text).toContain('Saturday');
  });
});

// ---------------------------------------------------------------------------
describe('the generate script itself', () => {
  // The script is the thing an operator actually runs, so it is run: its
  // argument handling, its three files, and the public key on stdout. Keys
  // made here are made in a temp directory and thrown away with it.
  it('prints a public key, writes three shares, and two of them open an entry', async () => {
    const dir = join(tmp, 'script');
    mkdirSync(dir, { recursive: true });
    const files = ['a', 'b', 'c'].map((n) => join(dir, `share-${n}.txt`));
    const run = spawnSync('npx', ['tsx', 'scripts/safety/generate.mts', ...files], {
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    const pem = run.stdout;
    expect(pem).toContain('BEGIN PUBLIC KEY');
    expect(pem).not.toContain('PRIVATE');
    // The private key is nowhere on disk, whole or in part beyond the shares.
    expect(readdirSync(dir).sort()).toEqual(['share-a.txt', 'share-b.txt', 'share-c.txt']);
    expect(run.stderr).toMatch(/Fingerprint: ([0-9a-f]{2}:){7}[0-9a-f]{2}/);
    expect(run.stderr).not.toMatch(/PRIVATE KEY/);

    // It refuses to overwrite a share that already exists.
    const again = spawnSync('npx', ['tsx', 'scripts/safety/generate.mts', ...files], {
      encoding: 'utf8',
    });
    expect(again.status).toBe(2);
    expect(again.stderr).toContain('Refusing to overwrite');

    // An entry written to THAT public key — the one the script just printed —
    // and opened by two of the shares it just wrote.
    const p = entryParams(
      createPublicKey(pem),
      { door: 'posting', sender_account: ACCOUNT, text: 'a mountain bike, barely ridden' },
      { outcome: 'pass', checks: [] },
    );
    const sealedRow: LedgerRow = {
      ...passed,
      id: '44444444-4444-4444-8444-444444444444',
      door: 'posting',
      wrapped_key: p[9] as Buffer,
      body_enc: p[10] as Buffer,
      nonce: p[11] as Buffer,
    };
    const priv = privateKeyFromShares([
      parseShareFile(readFileSync(files[0]!, 'utf8')),
      parseShareFile(readFileSync(files[2]!, 'utf8')),
    ]);
    const out = join(dir, 'bundle');
    const bundle = await exportBundle({
      rows: [sealedRow],
      privateKey: priv,
      outDir: out,
      query: { ids: [sealedRow.id] },
      shareIndices: [1, 3],
    });
    expect(bundle.entries).toBe(1);
    const entry = JSON.parse(readFileSync(join(out, 'entries', `${sealedRow.id}.json`), 'utf8'));
    expect(entry.body).toEqual({ door: 'posting', text: 'a mountain bike, barely ridden' });
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('what an export may ask for', () => {
  it('entries, an introduction, or a span of days', () => {
    expect(rowQuery({ ids: ['x'] }).sql).toContain('id = ANY($1::uuid[])');
    expect(rowQuery({ match_id: MATCH }).params).toEqual([MATCH]);
    const span = rowQuery({ from: new Date('2026-09-01'), to: new Date('2026-09-17') });
    expect(span.sql).toContain('created_at >= $1');
    expect(span.sql).toContain('created_at <= $2');
    expect(span.sql).toContain('LIMIT 5000');
  });

  it('refuses an export of everything', () => {
    expect(() => rowQuery({})).toThrow(/name entries, an introduction, or dates/);
  });
});
