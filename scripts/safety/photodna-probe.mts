/**
 * One round trip to the PhotoDNA match service with the service's own test
 * value (src/safety/photodna.ts). OpenSwitchboard uses PhotoDNA technology
 * licensed by Microsoft at no cost.
 *
 *   AWS_PROFILE=<profile> AWS_REGION=us-east-1 \
 *     npx tsx scripts/safety/photodna-probe.mts
 *
 * The endpoint, the representation and the test value come from the manifest
 * that ships with the licensed SDK (vendor/photodna/manifest.json, or
 * PHOTODNA_SDK_DIR), never from this repository. Without one it stops and
 * says so.
 *
 * NO IMAGE IS INVOLVED. Nothing is uploaded, nothing is hashed, and no
 * photograph is read.
 *
 * THE KEY IS NEVER PRINTED. It is read from Secrets Manager in this process,
 * handed to the request, and that is all; the response is printed with any
 * field that looks like key material taken out first.
 *
 * DEV HELPER, like the rest of scripts/safety: it reads osb/dev/photodna
 * unless PHOTODNA_SECRET_ID names another secret.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  PHOTODNA_MANIFEST,
  PHOTODNA_TIMEOUT_MS,
  parsePhotoDnaManifest,
} from '../../src/safety/photodna.js';

const sdkDir = process.env.PHOTODNA_SDK_DIR ?? 'vendor/photodna';
const manifest = await readFile(join(sdkDir, PHOTODNA_MANIFEST), 'utf8')
  .then(parsePhotoDnaManifest)
  .catch(() => {
    console.error(`No readable ${PHOTODNA_MANIFEST} in ${sdkDir}. It ships with the licensed SDK.`);
    process.exit(2);
  });
if (!manifest.testHash) {
  console.error(`${PHOTODNA_MANIFEST} carries no testHash, so there is nothing safe to send.`);
  process.exit(2);
}
const secretId = process.env.PHOTODNA_SECRET_ID ?? 'osb/dev/photodna';
const endpoint = process.env.PHOTODNA_ENDPOINT ?? manifest.endpoint;

console.error('OpenSwitchboard PhotoDNA probe');
console.error('------------------------------');
console.error(`secret ${secretId}`);
console.error(`endpoint ${endpoint}`);
console.error('Sending the service\'s test value. No image is read or sent.');
console.error('');

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const got = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
const key = JSON.parse(got.SecretString ?? '{}').api_key as string | undefined;
if (!key) {
  console.error(`${secretId} has no api_key in it.`);
  process.exit(2);
}

const res = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': key },
  body: JSON.stringify([{ DataRepresentation: manifest.dataRepresentation, Value: manifest.testHash }]),
  signal: AbortSignal.timeout(PHOTODNA_TIMEOUT_MS),
});

/**
 * Anything whose NAME suggests a credential goes, whatever is in it, and so
 * does anything whose value happens to be the key. A response is not supposed
 * to carry either; this is here so that nobody has to trust that.
 */
const CREDENTIAL_NAME = /key|secret|token|authorization|subscription/i;
function redact(value: unknown): unknown {
  if (typeof value === 'string') return value === key ? '[redacted]' : value;
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        CREDENTIAL_NAME.test(k) ? '[redacted]' : redact(v),
      ]),
    );
  }
  return value;
}

const text = await res.text();
let parsed: unknown;
try {
  parsed = JSON.parse(text);
} catch {
  console.error(`status ${res.status}; the body was not JSON`);
  process.exit(1);
}
console.error(`status ${res.status}`);
console.log(JSON.stringify(redact(parsed), null, 2));
