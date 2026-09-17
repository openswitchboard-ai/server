/**
 * Per-IP sliding-window limiter for abuse-prone unauthenticated endpoints
 * (dynamic client registration, verification-email requests). In-memory and
 * per-instance on purpose: the goal is blunting bot bursts that drain the SES
 * quota and poison the bounce rate, not precise global accounting.
 */

import { timingSafeEqual } from 'node:crypto';

interface Window {
  windowStart: number;
  n: number;
}

export interface IpLimiter {
  /** Returns true when this hit exceeds the limit and should be refused. */
  limited(ip: string): boolean;
}

export function makeIpLimiter(maxPerWindow: number, windowMs: number): IpLimiter {
  const hits = new Map<string, Window>();
  return {
    limited(ip: string): boolean {
      const now = Date.now();
      const h = hits.get(ip);
      if (!h || now - h.windowStart >= windowMs) {
        hits.set(ip, { windowStart: now, n: 1 });
        if (hits.size > 10_000) {
          for (const [k, v] of hits) if (now - v.windowStart >= windowMs) hits.delete(k);
        }
        return false;
      }
      h.n += 1;
      return h.n > maxPerWindow;
    },
  };
}

/**
 * CI exemption: when RATELIMIT_BYPASS_TOKEN is set in the environment (dev
 * only — infra injects it from an SSM SecureString), a request carrying the
 * matching x-osb-ratelimit-bypass header skips the per-IP limiters so the
 * e2e suite can bootstrap several actors from one runner IP. It exempts
 * nothing else: screening, consent gates and quotas still apply.
 */
export function rateLimitBypassed(headers: Record<string, unknown>): boolean {
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
 * the process: two hundred an hour. It is deliberately far above what an
 * ordinary hour of registrations looks like, and far below what a burst does.
 *
 * Per-process, for the reason in this file's header: the job is blunting a
 * burst, not precise global accounting, and prod runs a small number of tasks.
 *
 * A refusal says the same non-enumerating thing every other refusal on this
 * door says — an address that exists and one that does not get the same
 * sentence, because saying otherwise IS the enumeration.
 */
export const ACCOUNTLESS_VERIFICATIONS_PER_HOUR = 200;

function makeGlobalLimiter(maxPerWindow: number, windowMs: number) {
  let windowStart = 0;
  let n = 0;
  return {
    /** True when this hit exceeds the ceiling and should be refused. */
    limited(): boolean {
      const now = Date.now();
      if (now - windowStart >= windowMs) {
        windowStart = now;
        n = 1;
        return false;
      }
      n += 1;
      return n > maxPerWindow;
    },
    /** How many hits are in the live window. For the log line beside a refusal. */
    depth(): number {
      return Date.now() - windowStart >= windowMs ? 0 : n;
    },
  };
}

export const accountlessVerificationCeiling = makeGlobalLimiter(
  ACCOUNTLESS_VERIFICATIONS_PER_HOUR,
  60 * 60 * 1000,
);

/** DCR: 5 client registrations per IP per hour. */
export const clientRegistrationLimiter = makeIpLimiter(5, 60 * 60 * 1000);

/** Verification emails: 5 sends per IP per hour, on top of the per-email cap. */
export const verificationEmailLimiter = makeIpLimiter(5, 60 * 60 * 1000);

/**
 * Area suggestions: 60 lookups per IP per minute, behind a signed-in session.
 *
 * One person typing a suburb fires a handful of these — the box waits for a
 * pause in the typing and asks once. The cap is what stops the box being used
 * to walk the gazetteer out of the service a few names at a time; the minimum
 * query length and the eight-answer ceiling are the rest of that.
 */
export const areaSuggestLimiter = makeIpLimiter(60, 60 * 1000);

/**
 * The kill switch, ON: 5 taps per ACCOUNT per hour.
 *
 * The odd one out in this file, because it is keyed on an account rather than
 * an IP and it sits behind a signed-in session. It is here all the same, and
 * with the same caveat the header gives: the job is blunting a burst, not
 * precise global accounting.
 *
 * Turning the switch on is one tap and stays one tap — a brake somebody has to
 * find a credential for is a brake that fails when it matters. What this stops
 * is the other thing a loop of taps does: one confirmation email each, into the
 * inbox of the person who just paused everything.
 */
export const killSwitchLimiter = makeIpLimiter(5, 60 * 60 * 1000);
