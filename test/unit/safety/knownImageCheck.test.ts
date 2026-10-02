/**
 * The door to the known-image check (src/safety/knownImageCheck.ts), and the
 * migration behind it.
 *
 * The check itself is an optional module that is not in this repository.
 * Every test here writes a FAKE module into a temporary directory: nothing
 * real is needed or read, and this suite passes with no module present.
 *
 * What is asserted here:
 *
 *  - THE THREE STATES: off with no secret, ready with a module that says it
 *    is, unavailable with a secret and a module that is missing, broken, on
 *    another contract, or not ready.
 *  - A FAILED LOAD IS LOOKED AT AGAIN after a minute, and its line carries a
 *    class and a code and no path.
 *  - A CHECK THROWS on anything short of a clean answer.
 *  - THE BOOT LINE says which half is missing.
 *  - THE BUILD CHECK allows an empty directory and refuses a bad module.
 *  - MIGRATION 045 CREATES EVERY COLUMN THE CODE READS AND WRITES.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KNOWN_IMAGE_CONTRACT,
  KNOWN_IMAGE_MODULE_FILE,
  KNOWN_IMAGE_RETRY_MS,
  checkKnownImage,
  knownImageState,
  resetKnownImageCheckForTests,
  verifyKnownImageModule,
  warnIfKnownImageCheckOff,
} from '../../../src/safety/knownImageCheck.js';
import type { Config } from '../../../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = join(__dirname, '..', '..', '..');

/**
 * A stand-in module. It answers from the secret it is handed, so a test can
 * see that the host's secret is the one that reached it, and from the first
 * byte of the image: 1 matches, 2 answers nonsense, 3 throws.
 */
function fakeModule(over: { contract?: number; ready?: boolean; verify?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'osb-known-image-fake-'));
  writeFileSync(
    join(dir, KNOWN_IMAGE_MODULE_FILE),
    `export const contract = ${over.contract ?? KNOWN_IMAGE_CONTRACT};
export function create(host) {
  return {
    ready: async () => ${over.ready ?? true},
    check: async (image) => {
      const secret = await host.secret();
      if (image[0] === 3) throw new Error('could not answer');
      if (image[0] === 2) return { sure: 'yes' };
      return image[0] === 1
        ? { matched: true, sources: ['Test'], ref: 'ref-' + secret }
        : { matched: false, sources: [] };
    },
  };
}
export async function verify() { ${over.verify ?? "return 'fake 0.0.0';"} }
`,
  );
  return dir;
}

const cfgWith = (over: Partial<Config> = {}): Config =>
  ({
    knownImageModuleDir: 'knownImageModuleDir' in over ? over.knownImageModuleDir : fakeModule(),
    knownImageSecretArn: 'arn:aws:secretsmanager:us-east-1:1:secret:osb/test/known-image',
    ...over,
  }) as unknown as Config;

const NOWHERE = join(tmpdir(), 'osb-known-image-nothing-here');

beforeEach(async () => {
  resetKnownImageCheckForTests();
  const aws = await import('../../../src/aws.js');
  vi.spyOn(aws.secretsManager, 'send').mockResolvedValue({ SecretString: 's1' } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetKnownImageCheckForTests();
});

describe('the three states', () => {
  it('is off with no secret, whether or not a module is there', async () => {
    expect(await knownImageState(cfgWith({ knownImageSecretArn: undefined }))).toBe('off');
    expect(
      await knownImageState(cfgWith({ knownImageSecretArn: undefined, knownImageModuleDir: NOWHERE })),
    ).toBe('off');
  });

  it('is ready with a secret and a module that says it is', async () => {
    expect(await knownImageState(cfgWith())).toBe('ready');
  });

  it('is unavailable with a secret and no module', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await knownImageState(cfgWith({ knownImageModuleDir: NOWHERE }))).toBe('unavailable');
  });

  it('is unavailable with a module that is not ready, is broken, or says another contract', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await knownImageState(cfgWith({ knownImageModuleDir: fakeModule({ ready: false }) }))).toBe(
      'unavailable',
    );
    expect(
      await knownImageState(cfgWith({ knownImageModuleDir: fakeModule({ contract: 99 }) })),
    ).toBe('unavailable');
    const broken = mkdtempSync(join(tmpdir(), 'osb-known-image-broken-'));
    writeFileSync(join(broken, KNOWN_IMAGE_MODULE_FILE), 'export const contract = ;');
    expect(await knownImageState(cfgWith({ knownImageModuleDir: broken }))).toBe('unavailable');
  });

  it('does not settle a failed load for the process: it tries again after a minute, and logs class and code only', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => void logs.push(String(m)));
    const dir = mkdtempSync(join(tmpdir(), 'osb-known-image-later-'));
    const cfg = cfgWith({ knownImageModuleDir: dir });
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    expect(await knownImageState(cfg)).toBe('unavailable');
    const failed = logs
      .map((l) => JSON.parse(l))
      .filter((l) => l.event === 'known-image-module-failed');
    expect(failed).toHaveLength(1);
    expect(Object.keys(failed[0]).sort()).toEqual(['error_class', 'error_code', 'event', 'retry_in_s']);
    expect(JSON.stringify(failed[0])).not.toContain(dir);
    // Inside the window: no second attempt, no second line.
    now.mockReturnValue(t0 + KNOWN_IMAGE_RETRY_MS - 1);
    expect(await knownImageState(cfg)).toBe('unavailable');
    expect(logs.filter((l) => l.includes('known-image-module-failed'))).toHaveLength(1);
    // Past it: tried again.
    now.mockReturnValue(t0 + KNOWN_IMAGE_RETRY_MS + 1);
    expect(await knownImageState(cfg)).toBe('unavailable');
    expect(logs.filter((l) => l.includes('known-image-module-failed'))).toHaveLength(2);
    // And a module that arrives in the meantime is picked up on the next look.
    writeFileSync(
      join(dir, KNOWN_IMAGE_MODULE_FILE),
      readFileSync(join(fakeModule(), KNOWN_IMAGE_MODULE_FILE)),
    );
    now.mockReturnValue(t0 + 2 * KNOWN_IMAGE_RETRY_MS + 2);
    expect(await knownImageState(cfg)).toBe('ready');
  });
});

describe('one image, one answer', () => {
  it('reads a match, its sources and its reference, with the secret the host read', async () => {
    expect(await checkKnownImage(new Uint8Array([1]), cfgWith())).toEqual({
      matched: true,
      sources: ['Test'],
      ref: 'ref-s1',
    });
  });

  it('reads a clean answer as no match', async () => {
    expect(await checkKnownImage(new Uint8Array([0]), cfgWith())).toEqual({
      matched: false,
      sources: [],
    });
  });

  it('throws when the module throws, answers nonsense, or is not there', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(checkKnownImage(new Uint8Array([3]), cfgWith())).rejects.toThrow('could not answer');
    await expect(checkKnownImage(new Uint8Array([2]), cfgWith())).rejects.toThrow(/unreadable/);
    await expect(
      checkKnownImage(new Uint8Array([0]), cfgWith({ knownImageModuleDir: NOWHERE })),
    ).rejects.toThrow(/not loaded/);
  });

  it('throws rather than answering when the deployment has no secret', async () => {
    await expect(
      checkKnownImage(new Uint8Array([1]), cfgWith({ knownImageSecretArn: undefined })),
    ).rejects.toThrow(/not configured/);
  });
});

describe('the one line at boot', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('says nothing where the module and the secret are both there', async () => {
    const said: string[] = [];
    expect(await warnIfKnownImageCheckOff(cfgWith(), (m) => void said.push(m))).toBe(false);
    expect(said).toEqual([]);
  });

  it('is off, and says which half is missing, with no module and no secret', async () => {
    const said: string[] = [];
    const off = await warnIfKnownImageCheckOff(
      cfgWith({ knownImageModuleDir: NOWHERE, knownImageSecretArn: undefined }),
      (m) => void said.push(m),
    );
    expect(off).toBe(true);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('the known-image check is off');
    expect(said[0]).toContain('KNOWN_IMAGE_SECRET_ARN');
    // The plain sentence says the photos are still checked, because they are.
    expect(said[0]).toContain('every other check');
  });

  it('with a secret configured and no module, says photos are held', async () => {
    const said: string[] = [];
    await warnIfKnownImageCheckOff(cfgWith({ knownImageModuleDir: NOWHERE }), (m) => void said.push(m));
    expect(said[0]).toContain('HELD');
    expect(said[0]).not.toContain('KNOWN_IMAGE_SECRET_ARN');
  });

  it('names the secret alone where the module is there', async () => {
    const said: string[] = [];
    await warnIfKnownImageCheckOff(cfgWith({ knownImageSecretArn: undefined }), (m) => void said.push(m));
    expect(said[0]).toContain('KNOWN_IMAGE_SECRET_ARN');
    expect(said[0]).not.toContain('module in');
  });
});

describe('the image build', () => {
  it('allows a directory with nothing in it but a README', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osb-known-image-empty-'));
    writeFileSync(join(dir, 'README.md'), 'nothing here');
    expect(await verifyKnownImageModule(dir)).toEqual({ present: false });
    expect(await verifyKnownImageModule(NOWHERE)).toEqual({ present: false });
  });

  it('passes a module that verifies, and says its label', async () => {
    expect(await verifyKnownImageModule(fakeModule())).toEqual({ present: true, label: 'fake 0.0.0' });
  });

  it('refuses a module whose self-check throws, files with no module, and another contract', async () => {
    await expect(
      verifyKnownImageModule(fakeModule({ verify: "throw new Error('no');" })),
    ).rejects.toThrow('no');
    const stray = mkdtempSync(join(tmpdir(), 'osb-known-image-stray-'));
    writeFileSync(join(stray, 'something.bin'), 'x');
    await expect(verifyKnownImageModule(stray)).rejects.toThrow();
    await expect(verifyKnownImageModule(fakeModule({ contract: 2 }))).rejects.toThrow(/contract/);
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

  it('adds the reference a referral quotes to the review row', () => {
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
