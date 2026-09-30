/**
 * KNOWN ABUSE IMAGES (src/intake/checks/photoHashMatch.ts;
 * docs/trust-and-safety.md, "A known-image match").
 *
 * OpenSwitchboard uses PhotoDNA technology licensed by Microsoft at no cost.
 * The PhotoDNA licence covers this deployment only; a fork needs its own
 * licence from Microsoft, and without one the known-image check is off.
 *
 * NOTHING OF THE SDK IS IN THIS REPOSITORY, and nothing about it either. The
 * licensed files, and a manifest that names them, carries their expected
 * SHA-256 digests, the SDK version, the service endpoint and the service's
 * test value, all arrive together in the SDK directory (vendor/photodna by
 * default, PHOTODNA_SDK_DIR otherwise) from the private place a deployment
 * gets them.
 *
 * TWO LINKS, BOTH CHECKED ON EVERY LOAD. The manifest's own SHA-256 is pinned
 * here (PHOTODNA_MANIFEST_SHA256), so whoever can write the private store
 * cannot swap the manifest and the files together; then each file has to
 * match the digest the manifest gives it. A mismatch anywhere, or a missing
 * or unreadable manifest, is the same as missing files: the check is off, or
 * holds photos where a secret says it is meant to be on (photoDnaState).
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

/** The manifest's name inside the SDK directory. It is never in git. */
export const PHOTODNA_MANIFEST = 'manifest.json';

/**
 * The SHA-256 of this deployment's manifest.json, byte for byte. It says
 * nothing about the licensed files; it ties the manifest to this source. A new
 * SDK version means a new manifest and a new value here, in the same change.
 * A fork with its own licence sets PHOTODNA_MANIFEST_SHA256 in its task's
 * environment (config.photoDnaManifestSha256) instead of editing this.
 */
export const PHOTODNA_MANIFEST_SHA256 =
  '7a7bc2b14809aaf53dd17ab8bd57a0813f4c0ce5df28552adb6b138f5a084bc6';

/**
 * What the manifest carries. Every value in it is the licensed
 * deployment's, not this repository's; a fork with its own licence writes its
 * own.
 */
export interface PhotoDnaManifest {
  /** The SDK version, said once at boot. */
  version: string;
  /** The script and the web-assembly module, each by file name and SHA-256. */
  glue: { file: string; sha256: string };
  wasm: { file: string; sha256: string };
  /** The name of the SDK's hashing function, as the script declares it. */
  entry: string;
  /** Where hashes are sent, and the representation the service is told. */
  endpoint: string;
  dataRepresentation: string;
  /** A value the service publishes for proving a round trip. Optional: only
   *  the probe script and the live integration test read it. */
  testHash?: string;
}

const PLAIN_FILE = /^[A-Za-z0-9._-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Read and check a manifest. It THROWS on anything that is not exactly the
 * shape above, so a bad manifest is a failed load and never a guess: a file
 * name with a path in it, a digest that is not a digest, or an entry name that
 * is not a bare identifier (it is evaluated in the SDK's context).
 */
export function parsePhotoDnaManifest(text: string): PhotoDnaManifest {
  const m = JSON.parse(text) as Record<string, any>;
  const file = (f: any, what: string) => {
    if (!f || typeof f.file !== 'string' || !PLAIN_FILE.test(f.file) || f.file === PHOTODNA_MANIFEST) {
      throw new Error(`manifest ${what}.file is not a plain file name`);
    }
    if (typeof f.sha256 !== 'string' || !SHA256.test(f.sha256)) {
      throw new Error(`manifest ${what}.sha256 is not a SHA-256`);
    }
    return { file: f.file as string, sha256: f.sha256 as string };
  };
  if (!m || typeof m !== 'object') throw new Error('manifest is not an object');
  if (typeof m.version !== 'string' || !m.version) throw new Error('manifest version is missing');
  if (typeof m.entry !== 'string' || !IDENTIFIER.test(m.entry)) {
    throw new Error('manifest entry is not an identifier');
  }
  if (typeof m.endpoint !== 'string' || !/^https:\/\//.test(m.endpoint)) {
    throw new Error('manifest endpoint is not an https URL');
  }
  if (typeof m.dataRepresentation !== 'string' || !m.dataRepresentation) {
    throw new Error('manifest dataRepresentation is missing');
  }
  if (m.testHash !== undefined && typeof m.testHash !== 'string') {
    throw new Error('manifest testHash is not a string');
  }
  return {
    version: m.version,
    glue: file(m.glue, 'glue'),
    wasm: file(m.wasm, 'wasm'),
    entry: m.entry,
    endpoint: m.endpoint,
    dataRepresentation: m.dataRepresentation,
    ...(m.testHash !== undefined ? { testHash: m.testHash } : {}),
  };
}

let manifestCache: { dir: string; want: string; manifest: PhotoDnaManifest } | undefined;

/**
 * The manifest in this SDK directory, proved against the pinned digest and
 * then read, and kept once it has read cleanly. A failure is not kept: the
 * next caller looks again. `expectSha256` defaults to the pinned value.
 */
export async function readPhotoDnaManifest(
  dir: string,
  expectSha256: string = PHOTODNA_MANIFEST_SHA256,
): Promise<PhotoDnaManifest> {
  if (manifestCache?.dir === dir && manifestCache.want === expectSha256) {
    return manifestCache.manifest;
  }
  const bytes = await readFile(join(dir, PHOTODNA_MANIFEST));
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== expectSha256) {
    throw Object.assign(
      new Error(`${PHOTODNA_MANIFEST} is not the manifest this build expects (sha256 ${got})`),
      { code: 'MANIFEST_DIGEST' },
    );
  }
  const manifest = parsePhotoDnaManifest(bytes.toString('utf8'));
  manifestCache = { dir, want: expectSha256, manifest };
  return manifest;
}

/** The digest a config expects of its manifest. */
function manifestDigest(cfg: Config | undefined): string {
  return cfg?.photoDnaManifestSha256 || PHOTODNA_MANIFEST_SHA256;
}

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
 * times this; scaling down first saves a large allocation per picture.
 */
export const MAX_HASH_DIMENSION = 2048;

/** Ids and counts, the same rule every other line in this service follows. */
function photoDnaLog(event: string, fields: Record<string, string | number> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

// ---------------------------------------------------------------------------
// Hashing.

/** One image's hashes, as the SDK returns them. Only the hash is used. */
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
 * The module, loaded once. `null` means the last look failed.
 *
 * A FAILED LOAD IS NOT SETTLED FOR THE LIFE OF THE PROCESS (2026-09-28
 * review). It used to be: one read error at boot — a slow volume, a file
 * mid-copy — and `null` stood until the task was replaced, and every photo in
 * between passed this check as "switched off". Now a failure is looked at
 * again after LOAD_RETRY_MS, and while a secret is configured the check HOLDS
 * photos rather than passing them (photoDnaState, and photoHashMatch.ts).
 */
let loaded: Loaded | null | undefined;
let loadedFrom: string | undefined;
let loadFailedAt: number | undefined;

/** How long a failed load stands before the next photo tries again. */
export const PHOTODNA_LOAD_RETRY_MS = 60_000;

/** Where the SDK files and their manifest are. Relative paths hang off the
 *  process's directory, which in the image is /app, next to dist. */
function sdkDir(cfg: Config | undefined): string {
  return cfg?.photoDnaSdkDir ?? 'vendor/photodna';
}

/**
 * Read one file and prove it is the one the manifest names. A digest that
 * does not match is not a thing to warn about and use anyway: it is either a
 * different version, in which case the manifest is stale and somebody has to
 * look, or it is not the file at all.
 */
async function readVerified(dir: string, f: { file: string; sha256: string }): Promise<Buffer> {
  const bytes = await readFile(join(dir, f.file));
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== f.sha256) {
    throw Object.assign(
      new Error(`${f.file} is not the file the manifest expects (sha256 ${got})`),
      { code: 'SDK_DIGEST' },
    );
  }
  return bytes;
}

/**
 * Both links, without loading anything: the manifest against its pinned
 * digest, then each file against the manifest. THROWS on the first thing that
 * is wrong. The image build runs this (scripts/safety/photodna-verify.mts) so
 * that a deployment carrying the SDK without a good manifest fails at build
 * time rather than holding every photo at run time.
 */
export async function verifyPhotoDnaSdk(
  dir: string,
  expectSha256: string = PHOTODNA_MANIFEST_SHA256,
): Promise<PhotoDnaManifest> {
  const manifest = await readPhotoDnaManifest(dir, expectSha256);
  await readVerified(dir, manifest.glue);
  await readVerified(dir, manifest.wasm);
  return manifest;
}

/**
 * Bring the licensed module up in this process, in a small vm context shaped
 * the way the SDK's script expects. Nothing of the SDK is copied or rewritten:
 * the script is loaded as it was shipped and its own function does the
 * hashing.
 */
async function load(cfg: Config | undefined): Promise<Loaded | null> {
  const dir = sdkDir(cfg);
  const from = `${dir}\n${manifestDigest(cfg)}`;
  if (loaded && loadedFrom === from) return loaded;
  if (
    loaded === null &&
    loadedFrom === from &&
    loadFailedAt !== undefined &&
    Date.now() - loadFailedAt < PHOTODNA_LOAD_RETRY_MS
  ) {
    return null;
  }
  loadedFrom = from;
  try {
    const manifest = await readPhotoDnaManifest(dir, manifestDigest(cfg));
    const [glue, wasm] = await Promise.all([
      readVerified(dir, manifest.glue).then((b) => b.toString('utf8')),
      readVerified(dir, manifest.wasm),
    ]);
    const emscripten: Record<string, unknown> = { wasmBinary: wasm };
    const ctx: Record<string, unknown> = {
      console,
      TextDecoder,
      URL,
      // Reached through globalThis because this project's lib does not declare
      // the name, not because there is anything unusual about it.
      WebAssembly: (globalThis as any).WebAssembly,
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
    vm.runInContext(glue, ctx, { filename: manifest.glue.file });
    // The entry name was checked to be a bare identifier when the manifest
    // was read, so this is a lookup and nothing more.
    const hash = vm.runInContext(
      `(params, pixels) => ${manifest.entry}(params, pixels)`,
      ctx,
    ) as RawHasher;
    loaded = { hash };
    loadFailedAt = undefined;
    photoDnaLog('photodna-ready', { version: manifest.version });
  } catch (e: any) {
    // The error's class and code, and never its message: a message on this
    // path can carry a path, and one day something that reads a key. Said
    // once per retry window, not once per photo.
    loaded = null;
    loadFailedAt = Date.now();
    photoDnaLog('photodna-load-failed', {
      error_class: String(e?.name ?? e?.constructor?.name ?? 'Error').slice(0, 60),
      error_code: String(e?.code ?? 'none').slice(0, 40),
      retry_in_s: PHOTODNA_LOAD_RETRY_MS / 1000,
    });
  }
  return loaded;
}

/**
 * The hashes for one image, base64, one or two of them.
 *
 * Decoding happens here with sharp, because the SDK wants raw pixels and this
 * service receives a JPEG, a PNG or a WebP. `rotate()` with no argument
 * applies the orientation the file declares, so a photograph taken sideways
 * hashes as the picture a person would see rather than as its rotation.
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
// Matching.

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
  DataRepresentation: string;
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

/** For the suite: forget the loaded module, the manifest and the cached key. */
export function resetPhotoDnaForTests(): void {
  manifestCache = undefined;
  loaded = undefined;
  loadedFrom = undefined;
  loadFailedAt = undefined;
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
  // The endpoint and the representation come from the manifest that ships
  // with the SDK. No manifest, no call: the caller holds on the throw.
  const manifest = await readPhotoDnaManifest(sdkDir(conf), manifestDigest(conf));
  const body: MatchHashRequestItem[] = hashes
    .slice(0, PHOTODNA_MAX_HASHES)
    .map((Value) => ({ DataRepresentation: manifest.dataRepresentation, Value }));

  const res = await fetch(conf.photoDnaEndpoint || manifest.endpoint, {
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
 * The service's answer, reduced to the three things this switchboard acts on:
 * whether anything matched, which lists said so, and the tracking id.
 *
 * A PER-RESULT STATUS THAT IS NOT OK IS AN ERROR, not a no-match: half an
 * answer about a picture is not an answer, and the caller holds on a throw.
 * It is read defensively for the rest: this is somebody else's API, and code
 * that could not read the response has to hold rather than pass.
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
    // The name of the list that holds the picture, and nothing else: this
    // switchboard acts the same way whatever the rest of the flag says.
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
 * Both have to be there: the SDK (its files and manifest), and a secret to
 * call the service with. Either one missing is the same answer, because half
 * of this check is no check.
 */
export async function photoDnaAvailable(cfg?: Config): Promise<boolean> {
  return (await photoDnaState(cfg)) === 'ready';
}

/**
 * The three states, which photoHashMatch.ts acts on differently:
 *
 *   off          no secret configured: this deployment has no hash matching
 *                at all (a dev checkout without the licensed files). Photos
 *                pass this check, as they always have there.
 *   ready        the manifest and files loaded and a secret is configured.
 *   unavailable  a secret IS configured — this deployment is meant to match —
 *                and the manifest or the files did not load. Photos HOLD until they do; the
 *                load is tried again after PHOTODNA_LOAD_RETRY_MS.
 */
export type PhotoDnaReadiness = 'off' | 'ready' | 'unavailable';

export async function photoDnaState(cfg?: Config): Promise<PhotoDnaReadiness> {
  const conf = cfg ?? current;
  if (!conf?.photoDnaSecretArn) return 'off';
  return (await load(conf)) !== null ? 'ready' : 'unavailable';
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
    ...(files ? [] : [`the SDK files and manifest in ${sdkDir(cfg)}`]),
    ...(secret ? [] : ['PHOTODNA_SECRET_ARN']),
  ].join(' and ');
  log(
    `known-image hash matching is off for this deployment: ${missing} missing. ` +
      (secret
        ? 'A secret is configured, so photos are HELD, not delivered, until the files load; the load is retried every minute.'
        : 'Photos still go through every other check before they are delivered.'),
  );
  return true;

}
