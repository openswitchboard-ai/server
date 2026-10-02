/**
 * KNOWN ABUSE IMAGES (src/intake/checks/photoHashMatch.ts;
 * docs/trust-and-safety.md, "A known-image match").
 *
 * OpenSwitchboard uses PhotoDNA technology licensed by Microsoft at no cost.
 *
 * THIS FILE IS A DOOR AND NOTHING BEHIND IT. The check itself is an optional
 * module that is not in this repository: a deployment that has one puts it in
 * the module directory (vendor/known-image by default, KNOWN_IMAGE_MODULE_DIR
 * otherwise) and this file loads it. How that module does its work is its
 * own business; what this repository knows is the contract below. A fork
 * writes its own module to the same contract, or runs without one.
 *
 * THE THREE STATES are decided here, because what a photo does in each of
 * them is this switchboard's rule and not the module's (knownImageState).
 *
 * WHAT IS NEVER LOGGED: the secret, the image, and anything the module
 * derives from the image. The one thing carried forward from an answer is its
 * reference, which is what a referral quotes.
 */
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { secretsManager } from '../aws.js';
import type { Config } from '../config.js';

// ---------------------------------------------------------------------------
// The contract.

/** The number a module must say. A change to the shapes below changes it. */
export const KNOWN_IMAGE_CONTRACT = 1;

/** The module's file inside the module directory. It is never in git. */
export const KNOWN_IMAGE_MODULE_FILE = 'index.mjs';

/** What this server hands a module, and all it hands it. */
export interface KnownImageHost {
  /** The SecretString of the secret this deployment configured
   *  (KNOWN_IMAGE_SECRET_ARN). It throws where none is configured. */
  secret(): Promise<string>;
}

/** One image's answer. */
export interface KnownImageOutcome {
  /** True when the image is a known one. */
  matched: boolean;
  /** Who says so, by name. Empty on no match. */
  sources: string[];
  /** The module's reference for the answer. It is what a referral quotes. */
  ref?: string;
}

export interface KnownImageChecker {
  /** Whether the module is able to answer right now. */
  ready(): Promise<boolean>;
  /** One image in, one answer out. It THROWS on anything short of a clean
   *  answer, and the caller holds the photo on a throw. */
  check(image: Uint8Array): Promise<KnownImageOutcome>;
}

/** What `index.mjs` exports. */
export interface KnownImageModule {
  contract: number;
  create(host: KnownImageHost): KnownImageChecker;
  /** A self-check for the image build. It throws where the module could not
   *  work, and answers a short label to print. */
  verify?(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Loading.

/** How long a failed load stands before the next photo tries again. */
export const KNOWN_IMAGE_RETRY_MS = 60_000;

/** Ids and counts, the same rule every other line in this service follows. */
function knownImageLog(event: string, fields: Record<string, string | number> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

/** Where the module is. Relative paths hang off the process's directory,
 *  which in the image is /app, next to dist. */
function moduleDir(cfg: Config | undefined): string {
  return cfg?.knownImageModuleDir ?? 'vendor/known-image';
}

let importCount = 0;

/** Import the module from a directory and check it says the contract. */
async function importModule(dir: string): Promise<KnownImageModule> {
  const url = pathToFileURL(resolve(dir, KNOWN_IMAGE_MODULE_FILE));
  // A second look at the same path has to be a second read, so each attempt
  // after the first carries its own query.
  if (importCount++) url.searchParams.set('look', String(importCount));
  const mod = (await import(/* @vite-ignore */ url.href)) as Partial<KnownImageModule>;
  if (mod.contract !== KNOWN_IMAGE_CONTRACT || typeof mod.create !== 'function') {
    throw Object.assign(new Error('the known-image module does not say this contract'), {
      code: 'MODULE_CONTRACT',
    });
  }
  return mod as KnownImageModule;
}

let current: Config | undefined;

/**
 * The checker, made once. `null` means the last look failed.
 *
 * A FAILED LOAD IS NOT SETTLED FOR THE LIFE OF THE PROCESS (2026-09-28
 * review): it is looked at again after KNOWN_IMAGE_RETRY_MS, and while a
 * secret is configured the check HOLDS photos rather than passing them
 * (knownImageState, and photoHashMatch.ts).
 */
let slot: { from: string; checker: KnownImageChecker | null; failedAt?: number } | undefined;

/** The secret this deployment configured, as the module's host reads it. */
function hostFor(cfg: Config): KnownImageHost {
  return {
    async secret() {
      if (!cfg.knownImageSecretArn) throw new Error('the known-image secret is not configured');
      const r = await secretsManager.send(
        new GetSecretValueCommand({ SecretId: cfg.knownImageSecretArn }),
      );
      return r.SecretString ?? '';
    },
  };
}

async function checkerFor(cfg: Config | undefined): Promise<KnownImageChecker | null> {
  const dir = moduleDir(cfg);
  const from = `${dir}\n${cfg?.knownImageSecretArn ?? ''}`;
  if (slot?.from === from) {
    if (slot.checker) return slot.checker;
    if (slot.failedAt !== undefined && Date.now() - slot.failedAt < KNOWN_IMAGE_RETRY_MS) {
      return null;
    }
  }
  try {
    const mod = await importModule(dir);
    slot = { from, checker: mod.create(hostFor(cfg ?? ({} as Config))) };
  } catch (e: any) {
    // The error's class and code, and never its message: a message on this
    // path can carry a path. Said once per retry window, not once per photo.
    slot = { from, checker: null, failedAt: Date.now() };
    knownImageLog('known-image-module-failed', {
      error_class: String(e?.name ?? e?.constructor?.name ?? 'Error').slice(0, 60),
      error_code: String(e?.code ?? 'none').slice(0, 40),
      retry_in_s: KNOWN_IMAGE_RETRY_MS / 1000,
    });
  }
  return slot.checker;
}

/** The module is there and says it can answer. Never throws. */
async function moduleReady(cfg: Config | undefined): Promise<boolean> {
  const checker = await checkerFor(cfg);
  if (!checker) return false;
  try {
    return (await checker.ready()) === true;
  } catch {
    return false;
  }
}

/** Called once at boot, the same shape initStripe uses. */
export function initKnownImageCheck(cfg: Config): void {
  current = cfg;
}

/** For the suite: forget the loaded module and the config. */
export function resetKnownImageCheckForTests(): void {
  slot = undefined;
  current = undefined;
}

// ---------------------------------------------------------------------------
// Whether this deployment has it at all.

/**
 * The three states, which photoHashMatch.ts acts on differently:
 *
 *   off          no secret configured: this deployment has no known-image
 *                check at all (a checkout without a module). Photos pass this
 *                check, as they always have there.
 *   ready        the module loaded and says it can answer, and a secret is
 *                configured.
 *   unavailable  a secret IS configured — this deployment is meant to check —
 *                and the module did not load or cannot answer. Photos HOLD
 *                until it can; it is tried again after KNOWN_IMAGE_RETRY_MS.
 */
export type KnownImageReadiness = 'off' | 'ready' | 'unavailable';

export async function knownImageState(cfg?: Config): Promise<KnownImageReadiness> {
  const conf = cfg ?? current;
  if (!conf?.knownImageSecretArn) return 'off';
  return (await moduleReady(conf)) ? 'ready' : 'unavailable';
}

/**
 * Ask whether this image is a known one.
 *
 * THROWS on anything short of a clean answer, including a module that is not
 * loaded and an answer that is not in the contract's shape. The caller holds
 * the photo on every one of them.
 */
export async function checkKnownImage(image: Uint8Array, cfg?: Config): Promise<KnownImageOutcome> {
  const checker = await checkerFor(cfg ?? current);
  if (!checker) throw new Error('the known-image module is not loaded');
  const answer = (await checker.check(image)) as Partial<KnownImageOutcome> | undefined;
  if (!answer || typeof answer.matched !== 'boolean') {
    throw new Error('the known-image module answered something unreadable');
  }
  return {
    matched: answer.matched,
    sources: Array.isArray(answer.sources) ? answer.sources.map(String) : [],
    ...(answer.ref ? { ref: String(answer.ref) } : {}),
  };
}

/**
 * The one line at boot where this is off, in the shape warnIfLedgerDisabled
 * uses. It says WHICH half is missing, because "no module in this deployment"
 * and "the secret was never created" are different things to go and fix.
 */
export async function warnIfKnownImageCheckOff(
  cfg: Config,
  log: (msg: string) => void,
): Promise<boolean> {
  const module = await moduleReady(cfg);
  const secret = !!cfg.knownImageSecretArn;
  if (module && secret) return false;
  const missing = [
    ...(module ? [] : [`a working module in ${moduleDir(cfg)}`]),
    ...(secret ? [] : ['KNOWN_IMAGE_SECRET_ARN']),
  ].join(' and ');
  log(
    `the known-image check is off for this deployment: ${missing} missing. ` +
      (secret
        ? 'A secret is configured, so photos are HELD, not delivered, until the module comes up; it is retried every minute.'
        : 'Photos still go through every other check before they are delivered.'),
  );
  return true;
}

// ---------------------------------------------------------------------------
// The image build.

/**
 * What the image build asks (scripts/safety/known-image-verify.mts).
 *
 * NOTHING THERE but a README: `{ present: false }`, a build without a module,
 * such as a fork's, and it is allowed. ANYTHING THERE: the module must load,
 * say the contract and pass its own self-check, or this THROWS. A deployment
 * that carries a module that cannot work would hold every photo, so that has
 * to stop the build instead.
 */
export async function verifyKnownImageModule(
  dir: string,
): Promise<{ present: false } | { present: true; label: string }> {
  const there = (await readdir(dir).catch(() => [] as string[])).filter(
    (n) => n.toLowerCase() !== 'readme.md',
  );
  if (!there.length) return { present: false };
  const mod = await importModule(dir);
  const label = mod.verify ? await mod.verify() : '';
  return { present: true, label: String(label ?? '') };
}
