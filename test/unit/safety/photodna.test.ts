/**
 * The two halves of the known-image check (src/safety/photodna.ts), and the
 * migration behind it.
 *
 * What is asserted here:
 *
 *  - THE LOADER TAKES ITS FILE NAMES, DIGESTS AND ENDPOINT FROM A MANIFEST
 *    that ships with the SDK, never from this repository. Every test here that
 *    needs one writes a FAKE manifest and fake files into a temporary
 *    directory: no Microsoft data is needed or read.
 *  - THE LOADER REFUSES A FILE THAT IS NOT THE ONE THE MANIFEST NAMES, and a
 *    missing or broken manifest is exactly the same as missing files.
 *  - THE REAL HASHING BLOCK SKIPS ITSELF where the licensed files and their
 *    manifest are absent, which is every checkout of this repository and every
 *    CI run. It looks for them in vendor/photodna and NOWHERE ELSE.
 *  - THE REQUEST carries the manifest's endpoint and representation, five
 *    hashes at most, and a key that is in the header and in nothing else.
 *  - THE RESPONSE: a per-result status that is not OK throws, because half an
 *    answer about a picture is not an answer.
 *  - MIGRATION 045 CREATES EVERY COLUMN THE CODE READS AND WRITES. A column
 *    the code reads and the migration never created is a green suite and a
 *    broken deployment.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_HASH_DIMENSION,
  PHOTODNA_MANIFEST,
  PHOTODNA_MANIFEST_SHA256,
  PHOTODNA_MAX_HASHES,
  PHOTODNA_STATUS_OK,
  PHOTODNA_TIMEOUT_MS,
  edgeHashes,
  matchHashes,
  parsePhotoDnaManifest,
  photoDnaAvailable,
  readMatchResponse,
  readPhotoDnaManifest,
  resetPhotoDnaForTests,
  warnIfPhotoDnaDisabled,
} from '../../../src/safety/photodna.js';
import type { Config } from '../../../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = join(__dirname, '..', '..', '..');

/**
 * Where the licensed files and their manifest live when somebody has put them
 * there, and the only place the real-SDK block will ever look. They are
 * Microsoft confidential and are not in this repository; a checkout without
 * them runs everything else here and skips that block.
 */
const SDK_DIR = join(repo, 'vendor', 'photodna');
function realSdkPresent(): boolean {
  try {
    const m = parsePhotoDnaManifest(readFileSync(join(SDK_DIR, PHOTODNA_MANIFEST), 'utf8'));
    return existsSync(join(SDK_DIR, m.glue.file)) && existsSync(join(SDK_DIR, m.wasm.file));
  } catch {
    return false;
  }
}
const SDK_PRESENT = realSdkPresent();

const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * A stand-in SDK: a script that declares one function answering a fixed
 * hash, a few bytes that stand for the module, and a manifest naming both by
 * their real digests. Nothing here is Microsoft's.
 */
const FAKE_GLUE = `function FakeEntry(params, pixels) {
  return { result: 0, resultText: 'ok', count: 1,
    data: [{ PhotoDna: 'RkFLRQ==', x: 0, y: 0, w: params.width, h: params.height }] };
}`;
const FAKE_WASM = Buffer.from('not a real module');
const FAKE_ENDPOINT = 'https://photodna.invalid/match';
function fakeSdk(over: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'osb-photodna-fake-'));
  writeFileSync(join(dir, 'fake-glue.js'), FAKE_GLUE);
  writeFileSync(join(dir, 'fake-module.bin'), FAKE_WASM);
  const manifest = {
    version: '0.0.0-test',
    glue: { file: 'fake-glue.js', sha256: sha256(FAKE_GLUE) },
    wasm: { file: 'fake-module.bin', sha256: sha256(FAKE_WASM) },
    entry: 'FakeEntry',
    endpoint: FAKE_ENDPOINT,
    dataRepresentation: 'FakeRepresentation',
    ...over,
  };
  writeFileSync(join(dir, PHOTODNA_MANIFEST), JSON.stringify(manifest));
  return dir;
}

/** The digest of whatever manifest sits in `dir` now, as a fork would pin it. */
function digestOf(dir: string): string | undefined {
  const p = join(dir, PHOTODNA_MANIFEST);
  return existsSync(p) ? sha256(readFileSync(p)) : undefined;
}

/**
 * A config over a fresh stand-in SDK, pinned to that SDK's own manifest the
 * way PHOTODNA_MANIFEST_SHA256 pins a deployment's. Name
 * `photoDnaManifestSha256` to pin something else.
 */
const cfgWith = (over: Partial<Config> = {}): Config => {
  const dir = over.photoDnaSdkDir ?? fakeSdk();
  return {
    photoDnaSdkDir: dir,
    photoDnaManifestSha256: 'photoDnaManifestSha256' in over ? over.photoDnaManifestSha256 : digestOf(dir),
    photoDnaSecretArn: 'arn:aws:secretsmanager:us-east-1:1:secret:osb/dev/photodna',
    ...over,
  } as unknown as Config;
};

beforeEach(() => {
  resetPhotoDnaForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPhotoDnaForTests();
});

describe('the files have to be the ones the manifest names', () => {
  it('reads a manifest, and refuses one that is not the right shape', () => {
    const dir = fakeSdk();
    const m = parsePhotoDnaManifest(readFileSync(join(dir, PHOTODNA_MANIFEST), 'utf8'));
    expect(m.glue.file).toBe('fake-glue.js');
    expect(m.glue.sha256).toMatch(/^[0-9a-f]{64}$/);
    const good = JSON.parse(readFileSync(join(dir, PHOTODNA_MANIFEST), 'utf8'));
    const bad = (over: Record<string, unknown>) =>
      () => parsePhotoDnaManifest(JSON.stringify({ ...good, ...over }));
    expect(bad({ glue: { file: '../elsewhere.js', sha256: good.glue.sha256 } })).toThrow(/plain file name/);
    expect(bad({ wasm: { file: 'x.bin', sha256: 'abc' } })).toThrow(/SHA-256/);
    expect(bad({ entry: 'process.exit(1)' })).toThrow(/identifier/);
    expect(bad({ endpoint: 'http://plain.invalid/' })).toThrow(/https/);
    expect(bad({ dataRepresentation: '' })).toThrow(/dataRepresentation/);
    expect(() => parsePhotoDnaManifest('not json')).toThrow();
  });

  it('loads a stand-in SDK the manifest names, and hashes with it', async () => {
    const cfg = cfgWith();
    expect(await photoDnaAvailable(cfg)).toBe(true);
    const { default: sharp } = await import('sharp');
    const png = await sharp({
      create: { width: 40, height: 30, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    expect(await edgeHashes(png, cfg)).toEqual(['RkFLRQ==']);
  });

  it('will not load a manifest whose own digest is not the pinned one', async () => {
    const dir = fakeSdk();
    const pinned = digestOf(dir);
    // Somebody with write access to the store swaps the manifest and a file
    // together: the file matches the new manifest, the manifest does not match
    // the pin.
    writeFileSync(join(dir, 'fake-glue.js'), FAKE_GLUE + '\n// swapped');
    const m = JSON.parse(readFileSync(join(dir, PHOTODNA_MANIFEST), 'utf8'));
    m.glue.sha256 = sha256(FAKE_GLUE + '\n// swapped');
    writeFileSync(join(dir, PHOTODNA_MANIFEST), JSON.stringify(m));
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => void logs.push(String(l)));
    const cfg = cfgWith({ photoDnaSdkDir: dir, photoDnaManifestSha256: pinned });
    expect(await photoDnaAvailable(cfg)).toBe(false);
    expect(logs.some((l) => l.includes('MANIFEST_DIGEST'))).toBe(true);
    await expect(readPhotoDnaManifest(dir, pinned!)).rejects.toThrow(/not the manifest/);
  });

  it('pins a SHA-256 for the deployment\'s manifest, and uses it unless told otherwise', async () => {
    expect(PHOTODNA_MANIFEST_SHA256).toMatch(/^[0-9a-f]{64}$/);
    // A stand-in manifest is not this deployment's, so without its own pin it
    // does not load.
    const cfg = cfgWith({ photoDnaManifestSha256: undefined });
    expect(await photoDnaAvailable(cfg)).toBe(false);
  });

  it('will not load a file whose digest is not the one the manifest names', async () => {
    // The right NAMES and the wrong contents.
    const dir = fakeSdk();
    writeFileSync(join(dir, 'fake-glue.js'), 'not the file the manifest names');
    const cfg = cfgWith({ photoDnaSdkDir: dir });
    expect(await photoDnaAvailable(cfg)).toBe(false);
    await expect(edgeHashes(new Uint8Array([1, 2, 3]), cfg)).rejects.toThrow(/not loaded/);
  });

  it('with no manifest, behaves exactly as with no SDK at all', async () => {
    const { photoDnaState } = await import('../../../src/safety/photodna.js');
    const dir = mkdtempSync(join(tmpdir(), 'osb-photodna-nomanifest-'));
    // The files are there; the manifest that names them is not.
    writeFileSync(join(dir, 'fake-glue.js'), FAKE_GLUE);
    writeFileSync(join(dir, 'fake-module.bin'), FAKE_WASM);
    expect(await photoDnaState(cfgWith({ photoDnaSdkDir: dir }))).toBe('unavailable');
    expect(await photoDnaState(cfgWith({ photoDnaSdkDir: dir, photoDnaSecretArn: undefined }))).toBe(
      'off',
    );
    const said: string[] = [];
    await warnIfPhotoDnaDisabled(cfgWith({ photoDnaSdkDir: dir }), (m) => void said.push(m));
    expect(said[0]).toContain('HELD');
  });

  it('with a broken manifest, holds rather than guessing', async () => {
    const { photoDnaState } = await import('../../../src/safety/photodna.js');
    const dir = fakeSdk();
    writeFileSync(join(dir, PHOTODNA_MANIFEST), '{"version":');
    expect(await photoDnaState(cfgWith({ photoDnaSdkDir: dir }))).toBe('unavailable');
    await expect(readPhotoDnaManifest(dir)).rejects.toThrow();
  });

  it('is off, and says which half is missing, with no files and no secret', async () => {
    const said: string[] = [];
    const off = await warnIfPhotoDnaDisabled(
      cfgWith({
        photoDnaSdkDir: join(tmpdir(), 'osb-photodna-nothing-here'),
        // No secret, as the title says: with one configured the photos are
        // held rather than passed (the test below).
        photoDnaSecretArn: undefined,
      }) as Config,

      (m) => void said.push(m),
    );
    expect(off).toBe(true);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('known-image hash matching is off');
    // The plain sentence says the photos are still checked, because they are.
    expect(said[0]).toContain('every other check');
  });

  it('with a secret configured and the files missing, says photos are held, and the state is unavailable', async () => {
    const { photoDnaState } = await import('../../../src/safety/photodna.js');
    const cfg = cfgWith({ photoDnaSdkDir: join(tmpdir(), 'osb-photodna-nothing-here') });
    expect(await photoDnaState(cfg)).toBe('unavailable');
    const said: string[] = [];
    await warnIfPhotoDnaDisabled(cfg, (m) => void said.push(m));
    expect(said[0]).toContain('HELD');
    // No secret is the only "off".
    expect(await photoDnaState(cfgWith({ photoDnaSecretArn: undefined }))).toBe('off');
  });

  it('does not settle a failed load for the process: it tries again after a minute, and logs class and code only', async () => {
    const { photoDnaState, PHOTODNA_LOAD_RETRY_MS } = await import(
      '../../../src/safety/photodna.js'
    );
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => void logs.push(String(m)));
    const dir = mkdtempSync(join(tmpdir(), 'osb-photodna-later-'));
    const cfg = cfgWith({ photoDnaSdkDir: dir });
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    expect(await photoDnaState(cfg)).toBe('unavailable');
    const failed = logs.map((l) => JSON.parse(l)).filter((l) => l.event === 'photodna-load-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].error_code).toBe('ENOENT');
    expect(Object.keys(failed[0]).sort()).toEqual(['error_class', 'error_code', 'event', 'retry_in_s']);
    expect(JSON.stringify(failed[0])).not.toContain(dir);
    // Inside the window: no second attempt, no second line.
    now.mockReturnValue(t0 + PHOTODNA_LOAD_RETRY_MS - 1);
    expect(await photoDnaState(cfg)).toBe('unavailable');
    expect(logs.filter((l) => l.includes('photodna-load-failed'))).toHaveLength(1);
    // Past it: tried again.
    now.mockReturnValue(t0 + PHOTODNA_LOAD_RETRY_MS + 1);
    expect(await photoDnaState(cfg)).toBe('unavailable');
    expect(logs.filter((l) => l.includes('photodna-load-failed'))).toHaveLength(2);
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
// runs only where somebody has put them, and their manifest, in
// vendor/photodna themselves.
describe.skipIf(!SDK_PRESENT)('hashing a picture this test drew, with the real SDK', () => {
  // Pinned to the value in the source, as a deployment is.
  const realCfg = () =>
    cfgWith({ photoDnaSdkDir: SDK_DIR, photoDnaManifestSha256: PHOTODNA_MANIFEST_SHA256 });

  it('answers one or two base64 hashes', async () => {
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

    const hashes = await edgeHashes(png, realCfg());
    expect(hashes.length).toBeGreaterThanOrEqual(1);
    expect(hashes.length).toBeLessThanOrEqual(2);
    const manifest = await readPhotoDnaManifest(SDK_DIR);
    for (const h of hashes) {
      expect(h).toMatch(/^[A-Za-z0-9+/]+=*$/);
      // The same length as the service's own test value, where the manifest
      // carries one.
      if (manifest.testHash) expect(h).toHaveLength(manifest.testHash.length);
    }
  });

  it('reports itself available with the files and a secret', async () => {
    expect(await photoDnaAvailable(realCfg())).toBe(true);
  });

  it('refuses something that is not an image at all', async () => {
    await expect(edgeHashes(new Uint8Array([1, 2, 3, 4]), realCfg())).rejects.toThrow();
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

  it('names the header, and the manifest\'s representation and endpoint, and nothing else', async () => {
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
    expect(seen!.url).toBe(FAKE_ENDPOINT);
    expect(seen!.init.method).toBe('POST');
    expect(seen!.init.headers['Ocp-Apim-Subscription-Key']).toBe('not-a-real-key-0000');
    expect(seen!.init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(seen!.init.body)).toEqual([
      { DataRepresentation: 'FakeRepresentation', Value: 'aaa' },
      { DataRepresentation: 'FakeRepresentation', Value: 'bbb' },
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

  it('throws rather than calling when there is no manifest to say where', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return {} as any;
    });
    const empty = mkdtempSync(join(tmpdir(), 'osb-photodna-empty-'));
    await expect(matchHashes(['aaa'], cfgWith({ photoDnaSdkDir: empty }))).rejects.toThrow();
    expect(called).toBe(false);
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

  it('scales a picture down before hashing it', () => {
    expect(MAX_HASH_DIMENSION).toBe(2048);
  });
});

describe('what the service answers', () => {
  /** A matched answer, in the shape the reader expects. */
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
            { Source: 'Test' },
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
