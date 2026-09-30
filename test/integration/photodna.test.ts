/**
 * One real round trip to the PhotoDNA match service (src/safety/photodna.ts).
 * OpenSwitchboard uses PhotoDNA technology licensed by Microsoft at no cost.
 *
 * It needs the licensed deployment's manifest in vendor/photodna (or
 * PHOTODNA_SDK_DIR): the endpoint and the service's test value come from
 * there, never from this repository. Without it, and without RUN_INTEGRATION,
 * the whole file skips.
 *
 *   RUN_INTEGRATION=1 AWS_PROFILE=<profile> AWS_REGION=us-east-1 \
 *     npx vitest run test/integration/photodna.test.ts
 *
 * It reads the subscription key out of Secrets Manager in process, and it
 * never prints it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PHOTODNA_MANIFEST,
  edgeHashes,
  matchHashes,
  parsePhotoDnaManifest,
  type PhotoDnaManifest,
} from '../../src/safety/photodna.js';
import type { Config } from '../../src/config.js';

/** vendor/photodna unless named. Absent in CI and in a fresh checkout. */
const SDK_DIR =
  process.env.PHOTODNA_SDK_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'photodna');

function manifestOrNull(): PhotoDnaManifest | null {
  try {
    return parsePhotoDnaManifest(readFileSync(join(SDK_DIR, PHOTODNA_MANIFEST), 'utf8'));
  } catch {
    return null;
  }
}
const MANIFEST = manifestOrNull();
const TEST_HASH = MANIFEST?.testHash ?? '';
const RUN = process.env.RUN_INTEGRATION === '1' && !!MANIFEST?.testHash;
if (process.env.RUN_INTEGRATION === '1' && !RUN) {
  console.warn(
    `photodna integration skipped: no ${PHOTODNA_MANIFEST} with a testHash in ${SDK_DIR}`,
  );
}
const SDK_PRESENT =
  !!MANIFEST &&
  existsSync(join(SDK_DIR, MANIFEST.glue.file)) &&
  existsSync(join(SDK_DIR, MANIFEST.wasm.file));

const cfg = {
  photoDnaSecretArn: process.env.PHOTODNA_SECRET_ID ?? 'osb/dev/photodna',
  photoDnaSdkDir: SDK_DIR,
} as unknown as Config;
const sdkCfg = cfg;

describe.skipIf(!RUN)('the real match service', () => {
  it('matches the service\'s test value, and says which list holds it', async () => {
    const outcome = await matchHashes([TEST_HASH], cfg);
    expect(outcome.match).toBe(true);
    expect(outcome.sources).toContain('Test');
    // The tracking id is the thing a referral quotes, so it has to come back.
    expect(outcome.trackingId).toBeTruthy();
  }, 30_000);

  it('refuses to read an answer about a hash the service would not accept', async () => {
    // Still the right length, and no longer a hash the service will take.
    // That has to reach the check as an error, because a picture nobody could
    // ask about is not a picture anybody has said is unknown.
    const broken =
      TEST_HASH.slice(0, -8) +
      (TEST_HASH.charAt(TEST_HASH.length - 8) === '4' ? '5' : '4') +
      TEST_HASH.slice(-7);
    await expect(matchHashes([broken], cfg)).rejects.toThrow('status code 3002');
  }, 30_000);

  // Only where the licensed files are there too: a genuine no-match needs a
  // genuine hash, and that needs the SDK.
  it.skipIf(!SDK_PRESENT)('answers no match for a picture drawn by this test', async () => {
    const { default: sharp } = await import('sharp');
    const patch = await sharp({
      create: { width: 150, height: 90, channels: 3, background: { r: 250, g: 250, b: 20 } },
    })
      .png()
      .toBuffer();
    const png = await sharp({
      create: { width: 500, height: 320, channels: 3, background: { r: 33, g: 120, b: 77 } },
    })
      .composite([{ input: patch, top: 30, left: 50 }])
      .png()
      .toBuffer();

    const outcome = await matchHashes(await edgeHashes(png, sdkCfg), sdkCfg);
    expect(outcome.match).toBe(false);
    expect(outcome.sources).toEqual([]);
    expect(outcome.trackingId).toBeTruthy();
  }, 30_000);

});
