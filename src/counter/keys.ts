/**
 * Counter key material: the approval-link HMAC key, and a second key the
 * deployment carries that nothing reads.
 *
 * COUNTER_COOKIE_KEY / cookie_key was for signing the session cookie, and the
 * session has not been a signed cookie for some time — it is a row, looked up
 * by an opaque id (counter/session.ts). Nothing in the codebase used the key,
 * so what it was doing was sitting in a secret and in the environment of every
 * task, looking as though something depended on it. A key nobody uses is not
 * harmless: it is a thing an operator rotates carefully, and a thing a reader
 * assumes is load-bearing.
 *
 * It is gone from the interface. It is still REQUIRED to be present and valid,
 * because the secret and the task definitions still carry it and a boot that
 * silently accepted its absence would be the fallback this file exists to
 * refuse. Infra can drop it whenever infra likes; this file stops caring what
 * is in it.
 *
 * Loaded once at boot from Secrets Manager (osb/<env>/counter/keys), or from
 * COUNTER_LINK_HMAC_KEY / COUNTER_COOKIE_KEY env vars in the local test
 * harness only. Missing keys are a hard boot failure (NO-FALLBACKS).
 *
 * The link key does one more job than its name says: the pepper on every
 * hashed email address is derived from it with HKDF (domain/accounts.ts). It
 * is the deployment's one long-lived symmetric secret, and it is not rotatable
 * without a rehash — which is written down in docs/trust-and-safety.md.
 */
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { secretsManager } from '../aws.js';
import type { Config } from '../config.js';

export interface CounterKeys {
  linkHmacKey: Buffer;
}

let keys: CounterKeys | undefined;

/**
 * Key material, checked before it is used rather than after.
 *
 * Buffer.from(x, 'hex') does not complain: it stops at the first character
 * that is not a hex digit and hands back whatever it had, so 'not-a-key'
 * becomes a zero-byte Buffer and every HMAC and every cookie after it is
 * keyed on nothing at all. A misconfigured deployment has to fail at boot,
 * loudly, rather than run with no key and look fine.
 */
function hexKey(name: string, raw: unknown): Buffer {
  if (typeof raw !== 'string' || !/^[0-9a-f]+$/i.test(raw) || raw.length % 2 !== 0) {
    throw new Error(`${name} must be hex`);
  }
  const b = Buffer.from(raw, 'hex');
  if (b.length < 32) throw new Error(`${name} must be at least 32 bytes (64 hex characters)`);
  return b;
}

export async function initCounterKeys(cfg: Config): Promise<void> {
  if (process.env.COUNTER_LINK_HMAC_KEY && process.env.COUNTER_COOKIE_KEY) {
    // Both are still checked: a deployment that carries a malformed key
    // should hear about it at boot, whether or not this process reads it.
    hexKey('COUNTER_COOKIE_KEY', process.env.COUNTER_COOKIE_KEY);
    keys = {
      linkHmacKey: hexKey('COUNTER_LINK_HMAC_KEY', process.env.COUNTER_LINK_HMAC_KEY),
    };
    return;
  }
  if (!cfg.counterKeysSecretArn) throw new Error('COUNTER_KEYS_SECRET_ARN missing');
  const r = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: cfg.counterKeysSecretArn }),
  );
  const s = JSON.parse(r.SecretString ?? '{}');
  if (!s.link_hmac_key || !s.cookie_key) {
    throw new Error('counter keys secret is missing link_hmac_key/cookie_key');
  }
  hexKey('cookie_key', s.cookie_key);
  keys = {
    linkHmacKey: hexKey('link_hmac_key', s.link_hmac_key),
  };
}

export function counterKeys(): CounterKeys {
  if (!keys) throw new Error('counter keys not initialised');
  return keys;
}
