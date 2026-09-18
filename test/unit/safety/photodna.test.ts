/**
 * The two halves of the known-image check (src/safety/photodna.ts), and the
 * migration behind it.
 *
 * What is asserted here:
 *
 *  - THE LOADER REFUSES A FILE THAT IS NOT THE PUBLISHED ONE. A byte changed
 *    in either file and the module does not come up: it reports itself off
 *    rather than hashing people's photographs with something nobody licensed.
 *  - THE HASHES ARE REAL ONES, on an image this test makes for itself — and
 *    this whole block SKIPS ITSELF where the licensed files are absent, which
 *    is every checkout of this repository and every CI run. It looks for them
 *    in vendor/photodna and NOWHERE ELSE: never in a downloads directory,
 *    never anywhere outside the tree.
 *  - THE REQUEST IS THE ONE THE SERVICE TAKES: the header name, the body
 *    shape, five hashes at most, and a key that is in the header and in
 *    nothing else.
 *  - THE RESPONSE IS READ AS THE SERVICE ACTUALLY ANSWERS IT, in both
 *    directions, against the shape observed on 18 September 2026. A per-result
 *    status that is not OK throws, because half an answer about a picture is
 *    not an answer.
 *  - MIGRATION 045 CREATES EVERY COLUMN THE CODE READS AND WRITES. A column
 *    the code reads and the migration never created is a green suite and a
 *    broken deployment.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_HASH_DIMENSION,
  PHOTODNA_ENDPOINT,
  PHOTODNA_MAX_HASHES,
  PHOTODNA_SDK_DIGESTS,
  PHOTODNA_STATUS_OK,
  PHOTODNA_TEST_HASH,
  PHOTODNA_TIMEOUT_MS,
  edgeHashes,
  matchHashes,
  photoDnaAvailable,
  readMatchResponse,
  resetPhotoDnaForTests,
  warnIfPhotoDnaDisabled,
} from '../../../src/safety/photodna.js';
import type { Config } from '../../../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = join(__dirname, '..', '..', '..');

/**
 * Where the licensed files live when somebody has put them there, and the only
 * place this suite will ever look. They are Microsoft confidential and are not
 * in this repository; a checkout without them runs everything else here and
 * skips the hashing block.
 */
const SDK_DIR = join(repo, 'vendor', 'photodna');
const SDK_PRESENT = Object.keys(PHOTODNA_SDK_DIGESTS).every((n) =>
  existsSync(join(SDK_DIR, n)),
);

const cfgWith = (over: Partial<Config> = {}): Config =>
  ({
    photoDnaSdkDir: SDK_DIR,
    photoDnaSecretArn: 'arn:aws:secretsmanager:us-east-1:1:secret:osb/dev/photodna',
    photoDnaEndpoint: PHOTODNA_ENDPOINT,
    ...over,
  }) as unknown as Config;

beforeEach(() => {
  resetPhotoDnaForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPhotoDnaForTests();
});

describe('the files have to be the ones Microsoft published', () => {
  it('names a SHA-256 for each file it loads', () => {
    expect(Object.keys(PHOTODNA_SDK_DIGESTS).sort()).toEqual([
      'photoDnaEdgeHash.js',
      'photoDnaEdgeHash.wasm',
    ]);
    for (const digest of Object.values(PHOTODNA_SDK_DIGESTS)) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('will not load a file whose digest is not the published one', async () => {
    // Two files with the right NAMES and the wrong contents. Nothing of the
    // SDK is involved, and nothing is read from outside the tree.
    const dir = mkdtempSync(join(tmpdir(), 'osb-photodna-'));
    for (const name of Object.keys(PHOTODNA_SDK_DIGESTS)) {
      writeFileSync(join(dir, name), 'not the file Microsoft published');
    }
    const cfg = cfgWith({ photoDnaSdkDir: dir });
    expect(await photoDnaAvailable(cfg)).toBe(false);
    await expect(edgeHashes(new Uint8Array([1, 2, 3]), cfg)).rejects.toThrow(/not loaded/);
  });

  it('is off, and says which half is missing, with no files and no secret', async () => {
    const said: string[] = [];
    const off = await warnIfPhotoDnaDisabled(
      cfgWith({ photoDnaSdkDir: join(tmpdir(), 'osb-photodna-nothing-here') }) as Config,
      (m) => void said.push(m),
    );
    expect(off).toBe(true);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('known-image hash matching is off');
    // The plain sentence says the photos are still checked, because they are.
    expect(said[0]).toContain('every other check');
  });

  it('is off when the secret is missing even where the files are there', async () => {
    const said: string[] = [];
    await warnIfPhotoDnaDisabled(cfgWith({ photoDnaSecretArn: undefined }), (m) =>
      void said.push(m),
    );
    expect(said[0]).toContain('PHOTODNA_SECRET_ARN');
    expect(await photoDnaAvailable(cfgWith({ photoDnaSecretArn: undefined }))).toBe(false);
  });
});

// The licensed files are absent in CI and in any fresh checkout. This block
// runs only where somebody has put them in vendor/photodna themselves.
describe.skipIf(!SDK_PRESENT)('hashing a picture this test drew', () => {
  it('answers one or two base64 hashes of the length the SDK returns', async () => {
    const { default: sharp } = await import('sharp');
    // A flat rectangle has no edges to hash, so there is a shape on it. Drawn
    // here, from nothing: no sample image from the SDK is in this repository
    // and none is read from anywhere.
    const patch = await sharp({
      create: { width: 180, height: 110, channels: 3, background: { r: 240, g: 32, b: 16 } },
    })
      .png()
      .toBuffer();
    const png = await sharp({
      create: { width: 600, height: 380, channels: 3, background: { r: 12, g: 90, b: 190 } },
    })
      .composite([{ input: patch, top: 50, left: 70 }])
      .png()
      .toBuffer();

    const hashes = await edgeHashes(png, cfgWith());
    // One for the picture, and a second for the picture with its border taken
    // off where there is one to take off.
    expect(hashes.length).toBeGreaterThanOrEqual(1);
    expect(hashes.length).toBeLessThanOrEqual(2);
    for (const h of hashes) {
      expect(h).toMatch(/^[A-Za-z0-9+/]+=*$/);
      // The same length the service's own published test hash is.
      expect(h).toHaveLength(PHOTODNA_TEST_HASH.length);
    }
  });

  it('reports itself available with the files and a secret', async () => {
    expect(await photoDnaAvailable(cfgWith())).toBe(true);
  });

  it('refuses something that is not an image at all', async () => {
    await expect(edgeHashes(new Uint8Array([1, 2, 3, 4]), cfgWith())).rejects.toThrow();
  });
});

describe('what the service is sent', () => {
  const secretValue = JSON.stringify({ api_key: 'not-a-real-key-0000' });

  beforeEach(async () => {
    const aws = await import('../../../src/aws.js');
    vi.spyOn(aws.secretsManager, 'send').mockResolvedValue({
      SecretString: secretValue,
    } as never);
  });

  it('names the header, the representation and the endpoint, and nothing else', async () => {
    let seen: { url: string; init: any } | undefined;
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      seen = { url: String(url), init };
      return {
        ok: true,
        status: 200,
        json: async () => ({ TrackingId: 't-1', MatchResults: [{ IsMatch: false }] }),
      } as any;
    });

    await matchHashes(['aaa', 'bbb'], cfgWith());
    expect(seen!.url).toBe('https://api.microsoftmoderator.com/photodna/v1.0/MatchHash');
    expect(seen!.init.method).toBe('POST');
    expect(seen!.init.headers['Ocp-Apim-Subscription-Key']).toBe('not-a-real-key-0000');
    expect(seen!.init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(seen!.init.body)).toEqual([
      { DataRepresentation: 'PreHashV2', Value: 'aaa' },
      { DataRepresentation: 'PreHashV2', Value: 'bbb' },
    ]);
    // A timeout on every call: a photo the sender is waiting on cannot hang.
    expect(seen!.init.signal).toBeTruthy();
    expect(PHOTODNA_TIMEOUT_MS).toBe(10_000);
  });

  it('never sends more hashes than the service takes', async () => {
    let body: any[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ MatchResults: [{ IsMatch: false }] }) } as any;
    });
    await matchHashes(['1', '2', '3', '4', '5', '6', '7'], cfgWith());
    expect(body).toHaveLength(PHOTODNA_MAX_HASHES);
  });

  it('throws on a status that is not a 2xx, and says nothing about the body', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 403, text: async () => 'k' }) as any);
    await expect(matchHashes(['aaa'], cfgWith())).rejects.toThrow('photodna match answered 403');
  });

  it('throws rather than calling when the deployment has no secret', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return {} as any;
    });
    await expect(matchHashes(['aaa'], cfgWith({ photoDnaSecretArn: undefined }))).rejects.toThrow(
      /not configured/,
    );
    expect(called).toBe(false);
  });

  it('scales a picture down before hashing it, at the SDK\'s own ceiling', () => {
    expect(MAX_HASH_DIMENSION).toBe(2048);
  });
});

describe('what the service answers', () => {
  /**
   * The shape observed against Microsoft's published test hash on 18 September
   * 2026, with the key material taken out. It is written down here so that a
   * change at the other end fails a test rather than a refusal.
   */
  const MATCHED = {
    TrackingId: 'EUS_aaa_bbb_ccc',
    MatchResults: [
      {
        Status: { Code: PHOTODNA_STATUS_OK, Description: 'OK', Exception: null },
        ContentId: null,
        IsMatch: true,
        MatchDetails: {
          AdvancedInfo: [],
          MatchFlags: [
            {
              AdvancedInfo: [{ Key: 'MatchId', Value: '7469692' }],
              Source: 'Test',
              Violations: ['A1'],
              MatchDistance: 182,
            },
          ],
        },
        XPartnerCustomerId: null,
        TrackingId: 'EUS_aaa_bbb_ccc',
      },
    ],
  };

  it('reads a match, its source and its tracking id', () => {
    expect(readMatchResponse(MATCHED)).toEqual({
      match: true,
      sources: ['Test'],
      trackingId: 'EUS_aaa_bbb_ccc',
    });
  });

  it('reads a clean answer as no match, and keeps the tracking id', () => {
    const clean = {
      TrackingId: 'WUS_x',
      MatchResults: [
        {
          Status: { Code: PHOTODNA_STATUS_OK, Description: 'OK', Exception: null },
          IsMatch: false,
          MatchDetails: { AdvancedInfo: [], MatchFlags: [] },
        },
        {
          Status: { Code: PHOTODNA_STATUS_OK, Description: 'OK', Exception: null },
          IsMatch: false,
          MatchDetails: { AdvancedInfo: [], MatchFlags: [] },
        },
      ],
    };
    expect(readMatchResponse(clean)).toEqual({ match: false, sources: [], trackingId: 'WUS_x' });
  });

  it('matches when either hash of the same picture matched', () => {
    const one = {
      TrackingId: 't',
      MatchResults: [
        { Status: { Code: PHOTODNA_STATUS_OK }, IsMatch: false, MatchDetails: { MatchFlags: [] } },
        MATCHED.MatchResults[0],
      ],
    };
    expect(readMatchResponse(one).match).toBe(true);
  });

  it('throws on a per-result status that is not OK', () => {
    const bad = {
      TrackingId: 't',
      MatchResults: [{ Status: { Code: 3002, Description: 'Invalid' }, IsMatch: false }],
    };
    expect(() => readMatchResponse(bad)).toThrow('status code 3002');
  });

  it('throws on an answer it cannot read at all', () => {
    expect(() => readMatchResponse(undefined)).toThrow();
    expect(() => readMatchResponse('yes')).toThrow();
    expect(() => readMatchResponse({ TrackingId: 't' })).toThrow('no match results');
  });
});

// ---------------------------------------------------------------------------
// The migration, read as text. A column the code reads and the migration never
// created is a green suite and a broken deployment (see
// test/unit/linkActionsMigrated.test.ts, which exists for exactly that reason).
describe('migration 045', () => {
  const sql = readFileSync(join(repo, 'migrations', '045_known_image_match.sql'), 'utf8');

  it('adds both quarantine columns the code reads and writes', () => {
    expect(sql).toMatch(/ALTER TABLE photo_quarantine/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS hash_match boolean NOT NULL DEFAULT false/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS hash_sources text\[\] NOT NULL DEFAULT '\{\}'/);
  });

  it('adds the tracking id a referral quotes to the review row', () => {
    expect(sql).toMatch(/ALTER TABLE safety_reviews/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS tracking_id text/);
  });

  it('indexes the read that puts a match in front of everything else', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS photo_quarantine_hash_match_idx/);
    expect(sql).toContain('(hash_match, status, created_at)');
  });

  it('says in the table comments that the hash itself is never kept', () => {
    expect(sql).toContain('Never the hash itself.');
  });

  it('re-runs without complaint, like every migration here', () => {
    for (const add of sql.match(/ADD COLUMN/g) ?? []) expect(add).toBe('ADD COLUMN');
    expect((sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length).toBe(
      (sql.match(/ADD COLUMN/g) ?? []).length,
    );
  });
});
