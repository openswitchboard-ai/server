/**
 * One real round trip to PhotoDNA's match service, with Microsoft's own
 * published test hash (src/safety/photodna.ts).
 *
 * WHAT THIS PROVES that the unit suite cannot. The request shape, the header
 * name, the endpoint and the response shape are all somebody else's, and the
 * code that reads them has to be right the first time it ever sees a real
 * match — a moment there is no way to rehearse. The test hash matches a source
 * named "Test" and nothing else, so the whole path can be proved without any
 * real image existing anywhere near it.
 *
 * NO IMAGE IS INVOLVED. Nothing is hashed, nothing is uploaded, and no
 * photograph is read. The licensed files are not needed either: this is the
 * client half only.
 *
 *   RUN_INTEGRATION=1 AWS_PROFILE=openswitchboard AWS_REGION=us-east-1 \
 *     npx vitest run test/integration/photodna.test.ts
 *
 * It reads the dev subscription key out of Secrets Manager in process, and it
 * never prints it.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PHOTODNA_ENDPOINT,
  PHOTODNA_SDK_DIGESTS,
  PHOTODNA_TEST_HASH,
  edgeHashes,
  matchHashes,
} from '../../src/safety/photodna.js';
import type { Config } from '../../src/config.js';

const RUN = process.env.RUN_INTEGRATION === '1';

const cfg = {
  photoDnaSecretArn: process.env.PHOTODNA_SECRET_ID ?? 'osb/dev/photodna',
  photoDnaEndpoint: PHOTODNA_ENDPOINT,
} as unknown as Config;

/** vendor/photodna, and nowhere else. Absent in CI and in a fresh checkout. */
const SDK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'photodna');
const SDK_PRESENT = Object.keys(PHOTODNA_SDK_DIGESTS).every((n) => existsSync(join(SDK_DIR, n)));
const sdkCfg = { ...cfg, photoDnaSdkDir: SDK_DIR } as unknown as Config;

describe.skipIf(!RUN)('the real match service', () => {
  it('matches the published test hash, and says which list holds it', async () => {
    const outcome = await matchHashes([PHOTODNA_TEST_HASH], cfg);
    expect(outcome.match).toBe(true);
    expect(outcome.sources).toContain('Test');
    // The tracking id is the thing a referral quotes, so it has to come back.
    expect(outcome.trackingId).toBeTruthy();
  }, 30_000);

  it('refuses to read an answer about a hash the service would not accept', async () => {
    // Still the right length, and no longer a hash the service will take: it
    // answers 3002 rather than "no match". That has to reach the check as an
    // error, because a picture nobody could ask about is not a picture anybody
    // has said is unknown. Observed 18 September 2026.
    const broken =
      PHOTODNA_TEST_HASH.slice(0, -8) +
      (PHOTODNA_TEST_HASH.endsWith('4') ? '5' : '4') +
      PHOTODNA_TEST_HASH.slice(-7);
    await expect(matchHashes([broken], cfg)).rejects.toThrow('status code 3002');
  }, 30_000);

  // Only where somebody has put the licensed files in vendor/photodna: a
  // genuine no-match needs a genuine hash, and that needs the SDK.
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
