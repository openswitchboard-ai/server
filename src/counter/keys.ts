/**
 * Counter key material: the approval-link HMAC key and the session-cookie
 * key. Loaded once at boot from Secrets Manager (osb/<env>/counter/keys),
 * or from COUNTER_LINK_HMAC_KEY / COUNTER_COOKIE_KEY env vars in the local
 * test harness only. Missing keys are a hard boot failure (NO-FALLBACKS).
 */
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { secretsManager } from '../aws.js';
import type { Config } from '../config.js';

export interface CounterKeys {
  linkHmacKey: Buffer;
  cookieKey: Buffer;
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
    keys = {
      linkHmacKey: hexKey('COUNTER_LINK_HMAC_KEY', process.env.COUNTER_LINK_HMAC_KEY),
      cookieKey: hexKey('COUNTER_COOKIE_KEY', process.env.COUNTER_COOKIE_KEY),
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
  keys = {
    linkHmacKey: hexKey('link_hmac_key', s.link_hmac_key),
    cookieKey: hexKey('cookie_key', s.cookie_key),
  };
}

export function counterKeys(): CounterKeys {
  if (!keys) throw new Error('counter keys not initialised');
  return keys;
}
