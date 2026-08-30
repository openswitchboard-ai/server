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

export async function initCounterKeys(cfg: Config): Promise<void> {
  if (process.env.COUNTER_LINK_HMAC_KEY && process.env.COUNTER_COOKIE_KEY) {
    keys = {
      linkHmacKey: Buffer.from(process.env.COUNTER_LINK_HMAC_KEY, 'hex'),
      cookieKey: Buffer.from(process.env.COUNTER_COOKIE_KEY, 'hex'),
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
    linkHmacKey: Buffer.from(s.link_hmac_key, 'hex'),
    cookieKey: Buffer.from(s.cookie_key, 'hex'),
  };
}

export function counterKeys(): CounterKeys {
  if (!keys) throw new Error('counter keys not initialised');
  return keys;
}
