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
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

/** DCR: 5 client registrations per IP per hour. */
export const clientRegistrationLimiter = makeIpLimiter(5, 60 * 60 * 1000);

/** Verification emails: 5 sends per IP per hour, on top of the per-email cap. */
export const verificationEmailLimiter = makeIpLimiter(5, 60 * 60 * 1000);
