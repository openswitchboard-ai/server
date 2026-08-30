/** Environment-driven configuration. Fails fast when a required value is missing. */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

export interface Quotas {
  /** Max simultaneously non-terminal (pending/active/latent) cards per account. */
  maxOpenCards: number;
  /** Max publishes (publish_intent + amend_intent re-screens) per rolling 24h. */
  maxPublishesPerDay: number;
  /** Max offers proposed per rolling hour per account (RATE_LIMITED_OFFERS). */
  maxOffersPerHour: number;
}

export interface Config {
  envName: 'dev' | 'prod';
  port: number;
  publicOrigin: string;
  /** Origin of the human-facing counter (separate hostname, same service). */
  counterOrigin: string;
  /** Secrets Manager secret holding {link_hmac_key, cookie_key}; unset only
   *  when both COUNTER_LINK_HMAC_KEY and COUNTER_COOKIE_KEY are provided
   *  directly (local test harness). */
  counterKeysSecretArn?: string;
  /** From address for counter emails (SES; domain identity is verified). */
  sesFrom: string;
  dbSecretArn: string;
  screeningQueueUrl: string;
  matchingQueueUrl: string;
  opsQueueUrl: string;
  consentLogBucket: string;
  identityKeyArn: string;
  bedrockModelId: string;
  registrationMode: 'dev-bootstrap' | 'closed';
  region: string;
  quotas: Quotas;
  docsBase: string;
}

export function loadConfig(): Config {
  const envName = required('OSB_ENV');
  if (envName !== 'dev' && envName !== 'prod') throw new Error(`bad OSB_ENV ${envName}`);
  return {
    envName,
    port: Number(process.env.PORT ?? 8080),
    publicOrigin: required('PUBLIC_ORIGIN'),
    counterOrigin: required('COUNTER_ORIGIN'),
    counterKeysSecretArn:
      process.env.COUNTER_LINK_HMAC_KEY && process.env.COUNTER_COOKIE_KEY
        ? process.env.COUNTER_KEYS_SECRET_ARN
        : required('COUNTER_KEYS_SECRET_ARN'),
    sesFrom: process.env.SES_FROM ?? 'OpenSwitchboard <counter@openswitchboard.ai>',
    dbSecretArn: required('DB_SECRET_ARN'),
    screeningQueueUrl: required('SCREENING_QUEUE_URL'),
    matchingQueueUrl: required('MATCHING_QUEUE_URL'),
    opsQueueUrl: required('OPS_QUEUE_URL'),
    consentLogBucket: required('CONSENT_LOG_BUCKET'),
    identityKeyArn: required('IDENTITY_KEY_ARN'),
    bedrockModelId: required('BEDROCK_MODEL_ID'),
    registrationMode: envName === 'prod' ? 'closed' : 'dev-bootstrap',
    region: process.env.AWS_REGION ?? 'us-east-1',
    quotas: {
      // Newcomer defaults; config-driven via env overrides.
      maxOpenCards: Number(process.env.QUOTA_MAX_OPEN_CARDS ?? 5),
      maxPublishesPerDay: Number(process.env.QUOTA_MAX_PUBLISHES_PER_DAY ?? 10),
      maxOffersPerHour: Number(process.env.QUOTA_MAX_OFFERS_PER_HOUR ?? 6),
    },
    docsBase: 'https://openswitchboard.ai/docs',
  };
}
