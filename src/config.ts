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
  /** Origin of the human-facing pages (separate hostname, same service). */
  counterOrigin: string;
  /** Hostnames this service used to serve the human pages on. A request
   *  arriving on one is 308'd to the same path on counterOrigin, so links
   *  already sent out keep working. */
  legacyCounterHosts: string[];
  /** Secrets Manager secret holding {link_hmac_key, cookie_key}; unset only
   *  when both COUNTER_LINK_HMAC_KEY and COUNTER_COOKIE_KEY are provided
   *  directly (local test harness). */
  counterKeysSecretArn?: string;
  /** From address for all emails (SES; domain identity is verified). */
  sesFrom: string;
  /** Reply-to for all emails (a monitored human mailbox). */
  sesReplyTo: string;
  /** SES configuration set — carries every send so bounce/complaint events
   *  reach the SNS -> SQS pipeline (0.E). */
  sesConfigurationSet: string;
  /** SQS queue receiving SES bounce/complaint/delivery events (0.E). */
  emailEventsQueueUrl: string;
  dbSecretArn: string;
  screeningQueueUrl: string;
  matchingQueueUrl: string;
  opsQueueUrl: string;
  consentLogBucket: string;
  identityKeyArn: string;
  bedrockModelId: string;
  /** Titan Text Embeddings v2 (1024-dim) - the matching engine's embedder. */
  bedrockEmbedModelId: string;
  registrationMode: 'dev-bootstrap' | 'closed';
  region: string;
  quotas: Quotas;
  docsBase: string;
  /** Secrets Manager secret holding {secret_key, webhook_secret?} for the
   *  env's Stripe account. Unset = settlement handling is OFF for this
   *  deployment (the service runs normally; `settle` answers
   *  SETTLEMENT_UNAVAILABLE). Prod stays unset until a prod Stripe account
   *  exists. */
  stripeSecretArn?: string;
  /** WORM evidence bucket (Object Lock; 90-day retention) for settlement
   *  evidence snapshots. Required whenever stripeSecretArn is set. */
  evidenceBucket?: string;
  /** Platform fee, percent of the settlement amount. Present in config by
   *  design and SET TO 0 — no fee is charged in phase 1. */
  settlementFeePercent: number;
}

export function loadConfig(): Config {
  const envName = required('OSB_ENV');
  if (envName !== 'dev' && envName !== 'prod') throw new Error(`bad OSB_ENV ${envName}`);
  return {
    envName,
    port: Number(process.env.PORT ?? 8080),
    publicOrigin: required('PUBLIC_ORIGIN'),
    counterOrigin: required('COUNTER_ORIGIN'),
    legacyCounterHosts: (process.env.LEGACY_COUNTER_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    counterKeysSecretArn:
      process.env.COUNTER_LINK_HMAC_KEY && process.env.COUNTER_COOKIE_KEY
        ? process.env.COUNTER_KEYS_SECRET_ARN
        : required('COUNTER_KEYS_SECRET_ARN'),
    sesFrom: process.env.SES_FROM ?? 'OpenSwitchboard <board@openswitchboard.ai>',
    sesReplyTo: process.env.SES_REPLY_TO ?? 'info@openswitchboard.ai',
    sesConfigurationSet: required('SES_CONFIGURATION_SET'),
    emailEventsQueueUrl: required('EMAIL_EVENTS_QUEUE_URL'),
    dbSecretArn: required('DB_SECRET_ARN'),
    screeningQueueUrl: required('SCREENING_QUEUE_URL'),
    matchingQueueUrl: required('MATCHING_QUEUE_URL'),
    opsQueueUrl: required('OPS_QUEUE_URL'),
    consentLogBucket: required('CONSENT_LOG_BUCKET'),
    identityKeyArn: required('IDENTITY_KEY_ARN'),
    bedrockModelId: required('BEDROCK_MODEL_ID'),
    bedrockEmbedModelId: process.env.BEDROCK_EMBED_MODEL_ID ?? 'amazon.titan-embed-text-v2:0',
    registrationMode: envName === 'prod' ? 'closed' : 'dev-bootstrap',
    region: process.env.AWS_REGION ?? 'us-east-1',
    quotas: {
      // Newcomer defaults; config-driven via env overrides.
      maxOpenCards: Number(process.env.QUOTA_MAX_OPEN_CARDS ?? 5),
      maxPublishesPerDay: Number(process.env.QUOTA_MAX_PUBLISHES_PER_DAY ?? 10),
      maxOffersPerHour: Number(process.env.QUOTA_MAX_OFFERS_PER_HOUR ?? 6),
    },
    docsBase: 'https://openswitchboard.ai/docs',
    stripeSecretArn: process.env.STRIPE_SECRET_ARN || undefined,
    evidenceBucket: process.env.EVIDENCE_BUCKET || undefined,
    settlementFeePercent: Number(process.env.SETTLEMENT_FEE_PERCENT ?? 0),
  };
}

/**
 * Settlement handling is on only when the deployment has a Stripe secret AND
 * an evidence bucket. Half-configured is a hard boot failure (NO-FALLBACKS):
 * a deployment that could take payments while unable to lock evidence must
 * not start.
 */
export function settlementsConfigured(cfg: Config): boolean {
  if (cfg.stripeSecretArn && !cfg.evidenceBucket) {
    throw new Error('STRIPE_SECRET_ARN is set but EVIDENCE_BUCKET is missing');
  }
  return !!cfg.stripeSecretArn;
}
