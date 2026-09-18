/**
 * KNOWN ABUSE IMAGES, AND THE TWO HALVES OF FINDING ONE
 * (src/intake/checks/photoHashMatch.ts; docs/trust-and-safety.md,
 * "A known-image match").
 *
 * OpenSwitchboard uses PhotoDNA technology licensed by Microsoft at no cost.
 *
 * Rekognition answers a question about what a picture appears to be. This
 * answers a different question entirely: whether this exact picture is one
 * that has already been found, identified and hashed by the organisations
 * that do that work. It is the only check on this switchboard that can say
 * something true about a child rather than about a category, and it is the
 * reason the photo door has a second machine on it at all.
 *
 * THE TWO HALVES.
 *
 *   HASH    happens here, on this task, from the bytes. The SDK is a small
 *           web-assembly module that turns an image into an edge hash — up to
 *           two of them, because it also hashes the picture with its border
 *           taken off, and a cropped or letterboxed copy of a known image is
 *           exactly the thing a single hash would miss. No image and no hash
 *           leaves this function except to the service below.
 *   MATCH   is Microsoft's own, over HTTPS. It is told hashes and nothing
 *           else: no image, no key, no account, no conversation.
 *
 * THE SDK IS NOT IN THIS REPOSITORY AND CANNOT BE. It is Microsoft
 * confidential under the PhotoDNA licence. vendor/photodna/README.md says
 * what belongs there and where a deployment gets it; a fork has to obtain its
 * own licence from Microsoft. The digests below are Microsoft's published
 * SHA-256 values for version 1.05.003, and a file that does not match one of
 * them is not loaded: a swapped binary turns the check off rather than hashing
 * people's photographs with something nobody licensed.
 *
 * AND NOTHING HERE DESCRIBES HOW ANY OF IT WORKS. Not in this file, not in the
 * public docs. What the hash is made of and how well it holds up are
 * Microsoft's to say, and saying them would help exactly the wrong person.
 *
 * WHAT IS NEVER LOGGED: the subscription key, and the hashes. A hash is a
 * handle on a specific picture, and a log line is the one place in this system
 * that is read casually. The tracking id the service returns is safe and is
 * the only thing carried forward, because it is what a referral quotes.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { secretsManager } from '../aws.js';
import type { Config } from '../config.js';

/** The SDK version these digests belong to, and the one the deploy carries. */
export const PHOTODNA_SDK_VERSION = '1.05.003';

/**
 * Microsoft's own published SHA-256 for each file we load, from the checksum
 * list that ships with the SDK. Embedding them is expressly allowed; the files
 * themselves are not. Both are checked at load, every boot.
 */
export const PHOTODNA_SDK_DIGESTS: Readonly<Record<string, string>> = {
  'photoDnaEdgeHash.js': '71316f7ad5f229d44f334d8ae268e0eb3a608e31139264d975f272ccc1e9d78e',
  'photoDnaEdgeHash.wasm': '4a3a89785a35c8675ac3219d7e7bd4514303de513cb3cdebf6e26be8722e06e3',
};

/** The cloud service the hashes go to. */
export const PHOTODNA_ENDPOINT = 'https://api.microsoftmoderator.com/photodna/v1.0/MatchHash';

/** How many hashes the service takes in one request. */
export const PHOTODNA_MAX_HASHES = 5;

/**
 * Ten seconds. The sender is standing at their own page waiting for the photo
 * to go; a call that has not come back by then has not said the picture is
 * fine, and the hold sentence is a better answer than a spinner.
 */
export const PHOTODNA_TIMEOUT_MS = 10_000;

/**
 * The longer side of the image as it is hashed. A phone photograph is several
 * times this, and scaling down first is what the SDK's own browser entry point
 * does: it costs a large allocation per picture otherwise, and the hash is not
 * a per-pixel thing.
 */
export const MAX_HASH_DIMENSION = 2048;

/**
 * Microsoft's published test hash. It matches a source named "Test" and
 * nothing else, so it is the one way to prove the whole round trip — key,
 * endpoint, request shape, response shape — without any real image existing
 * anywhere near it. scripts/safety/photodna-probe.mts and the live integration
 * test both use it.
 */
export const PHOTODNA_TEST_HASH =
  'UEROQQABAgAIT58oAAAAAAAAAADgAAAA4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAw4AAAAAAAAAAAAAxv8F/3Gc/1j2zEqsPFD/JND/VcwjHf8jT8wGs88EjrgcfYYRDP8HSYUrtrj/OLwhVoYjOz6ty/9m8f//MsaXsjnFI/+SK+JEB/8DTtQiGrJXOvEMXNEdI6go/wg/X1arzlw6cPAOYP8B/54D8iYAhCc4jvJiRnEeJ4YjLKoWuJZ0///UlGlfY+6Hwf8IiEUL7rQR2ZO5KmH2XP+GywqczXp+LhT0zyz/Y+2+UUo+761nf7X1xdAo0eD6+U3k9n3LD3Hzw/zxDOt+JFAz/vNhlSz3Ru8Bv8w2zgo6/+4ifLHipIWjk82qg4z48qv+68vrUzyWM/ufh40q+sb1vCPSy5ZYYvshtwG/+S9ZCRTmC5sl/f7zCoxb6hbVAaDgS01ASP8+gnbV4PpYAyXnX7b9iv6HKNwD5zGQ+irlGHX2evgHNW/6/ufmIEfWYmCTSP832BMO/Z1vnCPs0psZHft7LxZb7njklCrqO+Yi9tEFJPyT+v7aT+XrdJQVUvu1ILOD9vQarQvxuWlNaPtLpfPD+ApA+ErxzNdvae8LW2Ak9qLMU+nbrVCt+fNziGN540wXtjXahAZJxKBlFYDX+s+4pIvnuzrrSe+RHVxj7APBDK776bhXH+cisbj2+BOw2ZfDD1o8wfRHHXih/2MOyYraBNfgGfl9osJy+67EtejZnvbwMP+EAkW27bpWddLpS1uWmfed0V3e+ynR/C/pUsrAlPEGcs2v8mDBsiTkGku1PP3+zMyJ8qgRFrHrp/DJRPwzDF7T+uDoz7Tn8ftiTfpkFfwmva6Rd/r/QWWMCPowEcR27NruceT2wl4fzPJhgZ9M4iLEoOL102+jDfm0712f6eTEFA7p2sPEIv3JUxm78i1TR9vO5BRjiv+B2mkTxbfB9xnngvKSCP+qBqpa6IDzP57+Oj3s6//WI6Cb9FAHvvT8b4eMW/XJ0BCX7Ax+ZE7jZgjywuwJOrqs9oH6nJv1uBnkxvsbOtYH+gr8nkzwFf8Odvsbj6zy984VzLnq4iyhHP1OeUll8F6mWxbsY9MVUOuZIYug0eyR1pqG5dsbqN1KDpdx7x2ac/H0MeBDavJpSoM18SkWB7TlFWm+Sutwf1+C5Y4cQarleEWGqf8qzqxS7uRNKn73GWHi1P5zfvT4';

/** Ids and counts, the same rule every other line in this service follows. */
function photoDnaLog(event: string, fields: Record<string, string | number> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

// ---------------------------------------------------------------------------
// HALF ONE: the hash, from the bytes, on this task.

/**
 * One image's hashes, as the SDK returns them: a base64 string per hash, and
 * where in the picture each one came from. The rectangles are not used and not
 * kept — they are here because the SDK answers with them.
 */
interface SdkHash {
  PhotoDna: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SdkResult {
  result: number;
  resultText: string;
  count: number;
  data?: SdkHash[];
}

type RawHasher = (
  params: { width: number; height: number; format: string; id: number; scale: { w: number } },
  pixels: Uint8Array,
) => SdkResult;

interface Loaded {
  hash: RawHasher;
}

/**
 * The module, loaded once. `null` means we looked and it is not there, which
 * is a settled answer rather than something to retry per photo.
 */
let loaded: Loaded | null | undefined;
let loadedFrom: string | undefined;

/** Where the two files are. Relative paths hang off the process's directory,
 *  which in the image is /app, next to dist and migrations. */
function sdkDir(cfg: Config | undefined): string {
  return cfg?.photoDnaSdkDir ?? 'vendor/photodna';
}

/**
 * Read one file and prove it is the one Microsoft published. A digest that
 * does not match is not a thing to warn about and use anyway: it is either a
 * different version, in which case the constants above are stale and somebody
 * has to look, or it is not the file at all.
 */
async function readVerified(dir: string, name: string): Promise<Buffer> {
  const bytes = await readFile(join(dir, name));
  const got = createHash('sha256').update(bytes).digest('hex');
  const want = PHOTODNA_SDK_DIGESTS[name];
  if (got !== want) {
    throw new Error(`${name} is not the file this build expects (sha256 ${got})`);
  }
  return bytes;
}

/**
 * Bring the web-assembly module up in this process.
 *
 * The glue Microsoft ships is a browser script: it declares its own `Module`
 * object, reaches for `document`, and instantiates the web assembly
 * synchronously from `Module.wasmBinary` — which a browser would have preloaded
 * and Node has not. So it runs in a small vm context where `Module` is an
 * accessor property holding OUR object, already carrying the bytes: the
 * script's own `var Module = {...}` lands in the setter, its one property is
 * merged in, and instantiation finds the binary where it expects it. `document`
 * is a two-field stand-in, which is all the script actually reads from it.
 *
 * NOTHING OF THE SDK IS COPIED OR REWRITTEN. The script is loaded as it was
 * shipped, its own function does the hashing and its own code reads the result
 * buffer back. This file supplies a Node-shaped room for it to run in and
 * nothing else, which is also why none of the layout or sizing constants the
 * SDK uses appear anywhere in this repository.
 */
async function load(cfg: Config | undefined): Promise<Loaded | null> {
  const dir = sdkDir(cfg);
  if (loaded !== undefined && loadedFrom === dir) return loaded;
  loadedFrom = dir;
  try {
    const [glue, wasm] = await Promise.all([
      readVerified(dir, 'photoDnaEdgeHash.js').then((b) => b.toString('utf8')),
      readVerified(dir, 'photoDnaEdgeHash.wasm'),
    ]);
    const emscripten: Record<string, unknown> = { wasmBinary: wasm };
    const ctx: Record<string, unknown> = {
      console,
      TextDecoder,
      URL,
      // Reached through globalThis because this project's lib does not declare
      // the name, not because there is anything unusual about it.
      WebAssembly: (globalThis as any).WebAssembly,
      // The glue asks a browser which script tag it came from. It only wants a
      // URL to resolve the .wasm against, and it never gets that far here
      // because the bytes are already in hand.
      document: { currentScript: { src: '' } },
    };
    vm.createContext(ctx);
    Object.defineProperty(ctx, 'Module', {
      configurable: true,
      get: () => emscripten,
      set: (v: Record<string, unknown>) => {
        if (v && v !== emscripten) Object.assign(emscripten, v);
      },
    });
    vm.runInContext(glue, ctx, { filename: 'photoDnaEdgeHash.js' });
    const hash = vm.runInContext(
      '(params, pixels) => CreateChrysalisHash(params, pixels)',
      ctx,
    ) as RawHasher;
    loaded = { hash };
    photoDnaLog('photodna-ready', { version: PHOTODNA_SDK_VERSION });
  } catch {
    // No reason in the line. The interesting cases are "not there" (the
    // ordinary state of a deployment without the licence in place) and "not
    // the published file", and warnIfPhotoDnaDisabled has already said which.
    loaded = null;
  }
  return loaded;
}

/**
 * The hashes for one image, base64, one or two of them.
 *
 * Decoding happens here with sharp, because the SDK wants raw pixels and this
 * service receives a JPEG, a PNG or a WebP. `rotate()` with no argument
 * applies the orientation the file declares, so a photograph taken sideways
 * hashes as the picture a person would see rather than as its rotation; the
 * resize is the same ceiling the SDK's own browser path uses.
 *
 * It THROWS on anything that went wrong, including the SDK's own negative
 * results. The caller turns that into a hold, because a hash that was not
 * computed has not said anything about the picture.
 */
export async function edgeHashes(bytes: Uint8Array, cfg?: Config): Promise<string[]> {
  const mod = await load(cfg ?? current);
  if (!mod) throw new Error('photodna sdk is not loaded');
  // Imported here rather than at the top: sharp is a native module, and a
  // process that never sees a photo should not pay to open it.
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(bytes)
    .rotate()
    .resize({
      width: MAX_HASH_DIMENSION,
      height: MAX_HASH_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const r = mod.hash(
    { width: info.width, height: info.height, format: 'RGBA', id: 0, scale: { w: -1 } },
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  );
  if (r.result < 0 || !r.data?.length) {
    throw new Error(`photodna hashing failed: ${r.resultText || 'no hash'}`);
  }
  return r.data.map((h) => h.PhotoDna).filter(Boolean);
}

// ---------------------------------------------------------------------------
// HALF TWO: the match, at Microsoft.

export interface MatchOutcome {
  /** True when any hash in the request matched anything at all. */
  match: boolean;
  /** Which lists said so, by name. Empty on no match. */
  sources: string[];
  /** The service's own id for the call. It is what a referral quotes. */
  trackingId?: string;
}

/** The one request body shape the service takes. */
export interface MatchHashRequestItem {
  DataRepresentation: 'PreHashV2';
  Value: string;
}

interface PhotoDnaState {
  cfg: Config;
  key?: string;
  keyFetchedAt?: number;
}

let current: Config | undefined;
let state: PhotoDnaState | undefined;

/** Called once at boot, the same shape initStripe uses. */
export function initPhotoDna(cfg: Config): void {
  current = cfg;
  state = { cfg };
}

/** For the suite: forget the loaded module and the cached key. */
export function resetPhotoDnaForTests(): void {
  loaded = undefined;
  loadedFrom = undefined;
  state = undefined;
  current = undefined;
}

/**
 * The subscription key, from Secrets Manager, held five minutes — the same
 * window and the same reasoning as the Stripe key in src/stripe.ts. It is
 * returned and never logged, never put in an error, and never written down.
 */
async function subscriptionKey(cfg: Config): Promise<string> {
  const s = state?.cfg === cfg ? state : (state = { cfg });
  if (s.key && Date.now() - (s.keyFetchedAt ?? 0) < 5 * 60_000) return s.key;
  if (!cfg.photoDnaSecretArn) throw new Error('photodna secret is not configured');
  const r = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: cfg.photoDnaSecretArn }),
  );
  const json = JSON.parse(r.SecretString ?? '{}');
  if (!json.api_key) throw new Error('photodna secret is missing api_key');
  s.key = String(json.api_key);
  s.keyFetchedAt = Date.now();
  return s.key;
}

/**
 * Ask whether any of these hashes is a known one.
 *
 * THROWS on anything short of a clean answer: a timeout, a refusal, a status
 * that is not a 2xx, a body that will not parse. The caller holds the photo on
 * every one of them. Nothing about the request or the response is logged.
 */
export async function matchHashes(hashes: string[], cfg?: Config): Promise<MatchOutcome> {
  const conf = cfg ?? current;
  if (!conf) throw new Error('photodna is not configured');
  const key = await subscriptionKey(conf);
  const body: MatchHashRequestItem[] = hashes
    .slice(0, PHOTODNA_MAX_HASHES)
    .map((Value) => ({ DataRepresentation: 'PreHashV2', Value }));

  const res = await fetch(conf.photoDnaEndpoint ?? PHOTODNA_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Ocp-Apim-Subscription-Key': key,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PHOTODNA_TIMEOUT_MS),
  });
  if (!res.ok) {
    // The status and nothing else. A body from a service that has just been
    // handed a key is not a thing to put in a log line.
    throw new Error(`photodna match answered ${res.status}`);
  }
  return readMatchResponse(await res.json());
}

/** The service's own "this result is good" code. Anything else is not an answer. */
export const PHOTODNA_STATUS_OK = 3000;

/**
 * The service's answer, reduced to the three things this switchboard acts on.
 *
 * The shape, observed against the published test hash on 18 September 2026:
 *
 *   { TrackingId, MatchResults: [ { Status: { Code, Description, Exception },
 *     ContentId, IsMatch, MatchDetails: { AdvancedInfo, MatchFlags: [ {
 *     AdvancedInfo, Source, Violations, MatchDistance } ] }, TrackingId } ] }
 *
 * One entry in MatchResults per hash sent. A PER-RESULT STATUS THAT IS NOT OK
 * IS AN ERROR, not a no-match: the request carried two hashes of one picture
 * and half an answer about it is not an answer. The caller holds on a throw,
 * which is the right end of that.
 *
 * It is read defensively for the rest: this is somebody else's API, the field
 * names are theirs to change, and code that could not read the response has to
 * hold rather than pass.
 */
export function readMatchResponse(payload: unknown): MatchOutcome {
  const body = payload as Record<string, any> | undefined;
  if (!body || typeof body !== 'object') throw new Error('photodna answered something unreadable');
  const results: any[] = Array.isArray(body.MatchResults) ? body.MatchResults : [];
  if (!results.length) throw new Error('photodna answered with no match results');

  const sources = new Set<string>();
  let match = false;
  for (const r of results) {
    const code = r?.Status?.Code;
    if (code !== undefined && code !== PHOTODNA_STATUS_OK) {
      throw new Error(`photodna answered status code ${code}`);
    }
    if (r?.IsMatch === true) match = true;
    const flags: any[] = Array.isArray(r?.MatchDetails?.MatchFlags)
      ? r.MatchDetails.MatchFlags
      : [];
    // The name of the list that holds the picture. Nothing else out of the
    // flag: the distance and the violation codes are Microsoft's business and
    // this switchboard acts the same way whatever they say.
    for (const f of flags) if (f?.Source) sources.add(String(f.Source));
  }
  if (sources.size) match = true;

  const trackingId = body.TrackingId ?? results.find((r) => r?.TrackingId)?.TrackingId;
  return {
    match,
    sources: [...sources],
    ...(trackingId ? { trackingId: String(trackingId) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Whether this deployment has it at all.

/**
 * Both halves have to be there: the files, and a secret to call the service
 * with. Either one missing is the same answer, because half of this check is
 * no check.
 *
 * It is async because finding out means reading two files. The result is
 * settled after the first call.
 */
export async function photoDnaAvailable(cfg?: Config): Promise<boolean> {
  const conf = cfg ?? current;
  if (!conf?.photoDnaSecretArn) return false;
  return (await load(conf)) !== null;
}

/**
 * The one line at boot where this is off, in the shape warnIfLedgerDisabled
 * uses. It says WHICH half is missing, because "no licence in this deployment"
 * and "the secret was never created" are different things to go and fix.
 */
export async function warnIfPhotoDnaDisabled(
  cfg: Config,
  log: (msg: string) => void,
): Promise<boolean> {
  const files = (await load(cfg)) !== null;
  const secret = !!cfg.photoDnaSecretArn;
  if (files && secret) return false;
  const missing = [
    ...(files ? [] : [`the SDK files in ${sdkDir(cfg)}`]),
    ...(secret ? [] : ['PHOTODNA_SECRET_ARN']),
  ].join(' and ');
  log(
    `known-image hash matching is off for this deployment: ${missing} missing. ` +
      'Photos still go through every other check before they are delivered.',
  );
  return true;
}
