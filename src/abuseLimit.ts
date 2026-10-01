/**
 * Per-IP (and, for two of them, per-account) fixed-window limiters for the
 * abuse-prone doors: dynamic client registration, verification-email
 * requests, sessions made for nobody yet, area lookups, PIN tries and the kill
 * switch.
 *
 * SHARED ACROSS TASKS (N11, 30 September 2026). These used to be a Map in
 * each process, so with several ECS tasks behind the load balancer every limit
 * was really "the limit times the number of tasks", and every deploy wiped
 * them. The count now lives in Postgres (src/rateLimitStore.ts, migration
 * 062): one row per limiter and key, incremented atomically, so every task
 * reads and writes the same window. The window itself is unchanged: it opens
 * at the first hit and runs for windowMs, the (limit + 1)th hit inside it is
 * refused, and the first hit after it opens a new one.
 *
 * THE KEY IS NEVER STORED. An IP or an account id is HMAC'd under a key
 * derived from the counter's link key before it reaches the table, and a row
 * is deleted once its window is over (the ttl-expiry sweep).
 *
 * FAIL-OPEN, NEVER LOCK EVERYONE OUT. Before N11 these limiters could not
 * fail at all. A store error (the database having a bad moment) must not
 * turn into "nobody can sign in", so on any error the limiter falls back to
 * the per-task in-memory window it keeps alongside, for that hit, and logs
 * the error (throttled). That is the behaviour these doors had before, not
 * no limit.
 *
 * The same store backs the public pulse/stats limiter (src/publicApi.ts) and
 * the ops page's failed-sign-in limiter (src/opsMetrics.ts).
 *
 * The shared store is switched on at boot (src/index.ts, after the database
 * and counter keys are up). A process that never switches it on — the unit
 * suites, the harnesses — counts in memory exactly as before.
 */

import { timingSafeEqual } from 'node:crypto';

interface Window {
  windowStart: number;
  n: number;
}

/** Where a shared count lives. */
export interface LimiterStore {
  /** Record one hit and return the count in the live window. */
  hit(limiter: string, key: string, windowMs: number): Promise<number>;
  /** The count in the live window without recording anything (0 when there is none). */
  count(limiter: string, key: string): Promise<number>;
}

let sharedStore: LimiterStore | undefined;
let onStoreError: (msg: string, extra: Record<string, unknown>) => void = (msg, extra) =>
  console.error(msg, extra);
const lastErrorLogAt = new Map<string, number>();
const ERROR_LOG_EVERY_MS = 60_000;

/**
 * Count in a shared store from now on. Called once at boot; `log` receives a
 * store error (never a key), at most once a minute per limiter.
 */
export function useSharedLimiterStore(
  store: LimiterStore,
  log?: (msg: string, extra: Record<string, unknown>) => void,
): void {
  sharedStore = store;
  if (log) onStoreError = log;
}

/** Back to per-process counting. For tests. */
export function useLocalLimiterStore(): void {
  sharedStore = undefined;
  lastErrorLogAt.clear();
}

function reportStoreError(limiter: string, e: unknown): void {
  const now = Date.now();
  const last = lastErrorLogAt.get(limiter) ?? 0;
  if (now - last < ERROR_LOG_EVERY_MS) return;
  lastErrorLogAt.set(limiter, now);
  try {
    onStoreError('rate-limit store failed; counting this task alone (fail-open)', {
      limiter,
      error: (e as any)?.message ?? String(e),
    });
  } catch {
    // A logger that throws must not take the request down with it.
  }
}

export interface IpLimiter {
  /** Records a hit; resolves true when it exceeds the limit and should be refused. */
  limited(key: string): Promise<boolean>;
  /** The count in the live window, recording nothing. For a check that only counts failures. */
  peek(key: string): Promise<number>;
  /** Forget every in-memory window. For tests, which press the same account all day. */
  reset(): void;
}

/** The old per-process window: kept alongside the shared count, and the whole of it where no store is set. */
function makeLocalWindow(windowMs: number) {
  const hits = new Map<string, Window>();
  return {
    hit(key: string): number {
      const now = Date.now();
      const h = hits.get(key);
      if (!h || now - h.windowStart >= windowMs) {
        hits.set(key, { windowStart: now, n: 1 });
        if (hits.size > 10_000) {
          for (const [k, v] of hits) if (now - v.windowStart >= windowMs) hits.delete(k);
        }
        return 1;
      }
      h.n += 1;
      return h.n;
    },
    count(key: string): number {
      const h = hits.get(key);
      return !h || Date.now() - h.windowStart >= windowMs ? 0 : h.n;
    },
    clear(): void {
      hits.clear();
    },
  };
}

/**
 * One limiter. `name` is its row prefix in the shared store and must be unique
 * per limiter; the unnamed form (tests) only ever counts in memory.
 *
 * Every hit is counted in this task as well as in the store. A key this task
 * alone has already taken past the limit is refused without asking the store
 * — the old per-task rule, which the shared count can only be stricter than —
 * so a flood from one address costs the database at most limit + 1 writes a
 * window per task rather than one per request.
 */
export function makeIpLimiter(maxPerWindow: number, windowMs: number, name?: string): IpLimiter & {
  /** The count the last hit saw, in this process. For the log line beside a refusal. */
  lastCount(): number;
} {
  const local = makeLocalWindow(windowMs);
  let last = 0;
  return {
    async limited(key: string): Promise<boolean> {
      const mine = local.hit(key);
      let n = mine;
      const store = name ? sharedStore : undefined;
      if (store && mine <= maxPerWindow) {
        try {
          const shared = await store.hit(name!, key, windowMs);
          if (!Number.isInteger(shared) || shared < 1) throw new Error('store returned no count');
          n = Math.max(shared, mine);
        } catch (e) {
          reportStoreError(name!, e);
        }
      }
      last = n;
      return n > maxPerWindow;
    },
    async peek(key: string): Promise<number> {
      const mine = local.count(key);
      const store = name ? sharedStore : undefined;
      if (!store) return mine;
      try {
        const shared = await store.count(name!, key);
        if (!Number.isInteger(shared) || shared < 0) throw new Error('store returned no count');
        return Math.max(shared, mine);
      } catch (e) {
        reportStoreError(name!, e);
        return mine;
      }
    },
    reset(): void {
      local.clear();
      last = 0;
    },
    lastCount(): number {
      return last;
    },
  };
}

/**
 * CI exemption: when RATELIMIT_BYPASS_TOKEN is set in the environment (dev
 * only — infra injects it from an SSM SecureString), a request carrying the
 * matching x-osb-ratelimit-bypass header skips the per-IP limiters so the
 * e2e suite can bootstrap several actors from one runner IP. It exempts
 * nothing else: screening, consent gates and quotas still apply.
 *
 * NEVER IN PROD, IN CODE (28 September 2026). "Infra only sets it in dev" was
 * the whole of the guard, so one stray variable on a prod task would have
 * switched every per-IP limit off for whoever held the token. The environment
 * name comes from the config the process booted with, the same way the Jev
 * shadow refuses prod, and prod answers no whatever the token says.
 */
export function rateLimitBypassed(
  headers: Record<string, unknown>,
  cfg: { envName: string },
): boolean {
  if (cfg.envName !== 'dev') return false;
  const token = process.env.RATELIMIT_BYPASS_TOKEN;
  if (!token || token.length < 32) return false;
  const given = headers['x-osb-ratelimit-bypass'];
  if (typeof given !== 'string') return false;
  // Byte lengths, not string lengths: a header carrying anything outside ASCII
  // is longer as bytes than as characters, so two strings of equal length can
  // become two buffers of different length and timingSafeEqual throws.
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(token, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * THE CEILING OVER ALL OF THEM (2026-09-17 audit).
 *
 * Every limiter above is per IP, and a verification send needs no account. A
 * botnet is a thousand IPs, so a thousand addresses an hour could be mailed
 * inside every rule the switchboard had: the SES quota gone, the bounce rate
 * poisoned by a thousand addresses nobody typed, and the switchboard unable to
 * send anything to anybody. A per-IP cap cannot see that, because no IP did
 * anything wrong.
 *
 * So there is one ceiling over accountless verification sends together, across
 * every task: two hundred an hour. It is deliberately far above what an
 * ordinary hour of registrations looks like, and far below what a burst does.
 *
 * Shared across tasks like the rest (see this file's header), and with the
 * same fail-open fallback to a per-task count if the store is unreachable.
 *
 * A refusal says the same non-enumerating thing every other refusal on this
 * door says — an address that exists and one that does not get the same
 * sentence, because saying otherwise IS the enumeration.
 */
export const ACCOUNTLESS_VERIFICATIONS_PER_HOUR = 200;

/**
 * The ceiling is one limiter with one key: nothing a caller sends picks the
 * row, so nothing a caller sends can spread the count.
 */
function makeGlobalLimiter(maxPerWindow: number, windowMs: number, name: string) {
  const lim = makeIpLimiter(maxPerWindow, windowMs, name);
  return {
    /** Resolves true when this hit exceeds the ceiling and should be refused. */
    limited(): Promise<boolean> {
      return lim.limited('all');
    },
    /** How many hits the last check saw in the live window. For the log line beside a refusal. */
    depth(): number {
      return lim.lastCount();
    },
    /** Forget the in-memory window. For tests. */
    reset(): void {
      lim.reset();
    },
  };
}

export const accountlessVerificationCeiling = makeGlobalLimiter(
  ACCOUNTLESS_VERIFICATIONS_PER_HOUR,
  60 * 60 * 1000,
  'accountless-verification',
);

/** DCR: 5 client registrations per IP per hour. */
export const clientRegistrationLimiter = makeIpLimiter(5, 60 * 60 * 1000, 'client-registration');

/**
 * Verification emails: 15 sends per IP per hour, on top of the per-email cap.
 *
 * It was 5, and 5 is one household on one evening: two people signing up on a
 * phone and a laptop behind the same router, one mistyped address and one
 * code that arrived late, and the third person is told to wait an hour. The
 * per-email cap (verificationRateLimited) is what stops codes being sprayed
 * at one victim and it is unchanged; so is the global ceiling on accountless
 * sends above. This one only has to stop a single connection mailing
 * strangers in bulk, and 15 an hour still does.
 */
export const verificationEmailLimiter = makeIpLimiter(15, 60 * 60 * 1000, 'verification-email');

/**
 * Area suggestions: 60 lookups per IP per minute, behind a signed-in session.
 *
 * One person typing a suburb fires a handful of these — the box waits for a
 * pause in the typing and asks once. The cap is what stops the box being used
 * to walk the gazetteer out of the service a few names at a time; the minimum
 * query length and the eight-answer ceiling are the rest of that.
 */
export const areaSuggestLimiter = makeIpLimiter(60, 60 * 1000, 'area-suggest');

/**
 * The kill switch, ON: 5 taps per ACCOUNT per hour.
 *
 * The odd one out in this file, because it is keyed on an account rather than
 * an IP and it sits behind a signed-in session. It is here all the same, and
 * shares the same store; the account id is hashed before it is stored, the
 * same as an IP.
 *
 * Turning the switch on is one tap and stays one tap — a brake somebody has to
 * find a credential for is a brake that fails when it matters. What this stops
 * is the other thing a loop of taps does: one confirmation email each, into the
 * inbox of the person who just paused everything.
 */
export const killSwitchLimiter = makeIpLimiter(5, 60 * 60 * 1000, 'kill-switch');

/**
 * Disconnecting an assistant: 20 per ACCOUNT per hour. Like Stop it only takes
 * access away, so it asks for no PIN; this is what keeps a script on a stolen
 * session from hammering the revoke and the consent log behind it. Twenty is
 * far more assistants than anybody connects.
 */
export const assistantDisconnectLimiter = makeIpLimiter(20, 60 * 60 * 1000, 'assistant-disconnect');


/**
 * PIN tries: 10 per ACCOUNT per minute, on top of the lockout in the database.
 *
 * The lockout counts every attempt atomically and locks on the fifth wrong one
 * (counter/pin.ts). This sits in front of it so a burst never reaches argon2
 * or the lockout at all (one small upsert is all it costs): a person typing their own PIN makes one or two
 * tries a minute, and anything past ten is a script. Keyed on the account, so
 * it follows the account across connections.
 */
export const pinAttemptLimiter = makeIpLimiter(10, 60 * 1000, 'pin-attempt');

/**
 * Sessions made for nobody yet: 10 per IP per minute.
 *
 * The passkey sign-in button and the start of an assistant's authorisation
 * both need a session row before anybody is signed in, and each request that
 * arrives without a cookie makes one. A person makes one of these and then
 * carries its cookie; a loop without cookies makes a row per request.
 */
export const anonymousSessionLimiter = makeIpLimiter(10, 60 * 1000, 'anonymous-session');
