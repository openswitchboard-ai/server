/**
 * One round trip to PhotoDNA's MatchHash service, with Microsoft's own test
 * hash (src/safety/photodna.ts; docs/trust-and-safety.md, "A known-image
 * match").
 *
 *   AWS_PROFILE=openswitchboard AWS_REGION=us-east-1 \
 *     npx tsx scripts/safety/photodna-probe.mts
 *
 * WHAT IT IS FOR. The response shape is somebody else's, it is not written
 * down anywhere we control, and the code that reads it has to be right the
 * first time it ever sees a real match — there is no second chance at that
 * moment and no way to rehearse it with a real image. Microsoft publish a test
 * hash that matches a source named "Test" and nothing else, so this sends that
 * and prints what comes back.
 *
 * NO IMAGE IS INVOLVED, here or anywhere near here. The thing sent is a hash
 * Microsoft published for this purpose. Nothing is uploaded, nothing is
 * hashed, and no photograph is read.
 *
 * THE KEY IS NEVER PRINTED. It is read from Secrets Manager in this process,
 * handed to the request, and that is all; the response is printed with any
 * field that looks like key material taken out first, so the output of this
 * script is safe to paste into a report.
 *
 * DEV HELPER, like the rest of scripts/safety: it reads osb/dev/photodna, and
 * against anything else an operator names the secret themselves.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  PHOTODNA_ENDPOINT,
  PHOTODNA_TEST_HASH,
  PHOTODNA_TIMEOUT_MS,
} from '../../src/safety/photodna.js';

const secretId = process.env.PHOTODNA_SECRET_ID ?? 'osb/dev/photodna';
const endpoint = process.env.PHOTODNA_ENDPOINT ?? PHOTODNA_ENDPOINT;

console.error('OpenSwitchboard PhotoDNA probe');
console.error('------------------------------');
console.error(`secret ${secretId}`);
console.error(`endpoint ${endpoint}`);
console.error('Sending Microsoft\'s published test hash. No image is read or sent.');
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
  body: JSON.stringify([{ DataRepresentation: 'PreHashV2', Value: PHOTODNA_TEST_HASH }]),
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
