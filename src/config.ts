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
  /** Region the SES client talks to. Defaults to the app region; prod points
   *  at us-west-2, which is where this account holds SES production access
   *  (us-east-1 is still sandboxed). */
  sesRegion: string;
  /** Role in another account of the organisation (holds SES production
   *  access, has openswitchboard.ai verified) that the SES client assumes.
   *  SES enforces the sandbox on the CALLING account, so on that path the
   *  call itself must come from the host's credentials; sending authorization
   *  alone is not enough. Unset — dev, and prod since 2026-09-06 — means our
   *  own credentials on our own identity (see infra/host-ses/README.md). */
  sesAssumeRoleArn?: string;
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
  /** Platform fee, percent of the settlement amount. Kept as a parameter and
   *  SET TO 0: the introductory fee is the flat one below. */
  settlementFeePercent: number;
  /** Flat introductory fee, in the settlement currency's minor unit (100 =
   *  $1.00). The BUYER pays it, itemised on the payment page as a line of its
   *  own; the seller receives the agreed amount in full. */
  settlementFeeFlatMinor: number;
  /** Stripe's percentage rate on a domestic card, as a percent (1.7 = 1.7%).
   *  The buyer's third line recovers this so the agreed amount plus our fee
   *  arrives whole. */
  settlementProcessingPercent: number;
  /** Stripe's fixed per-charge amount, in the settlement currency's minor
   *  unit (30 = $0.30). The other half of the same recovery. */
  settlementProcessingFixedMinor: number;
  /** How long the buyer has to confirm receipt or dispute after the seller
   *  declares handover. When the window runs out the held payment goes to the
   *  seller on the server's own clock. Both humans are told the date at
   *  handover and see it on the settlement page throughout. */
  settlementAutoReleaseDays: number;
  /** How long a frozen payment waits for the two humans to sort it out before
   *  the default rule decides it. Measured from the moment the dispute landed,
   *  and never restarted, so adding delivery tracking on day six leaves eight
   *  days rather than winding the clock back. */
  settlementDisputeDeadlockDays: number;
  /** How long the seller has to confirm they got a returned item back before
   *  silence refunds the buyer. Measured from the buyer marking it sent. */
  settlementReturnSilenceDays: number;
  /** How long a seller has to add delivery tracking after a dispute on the
   *  ground that a posted item never arrived. No tracking by then refunds the
   *  buyer the agreed amount. */
  settlementTrackingGraceDays: number;
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
    sesRegion: process.env.SES_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
    sesAssumeRoleArn: process.env.SES_ASSUME_ROLE_ARN || undefined,
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
    settlementFeeFlatMinor: Number(process.env.SETTLEMENT_FEE_FLAT_MINOR ?? 100),
    settlementProcessingPercent: Number(process.env.SETTLEMENT_PROCESSING_PERCENT ?? 1.7),
    settlementProcessingFixedMinor: Number(process.env.SETTLEMENT_PROCESSING_FIXED_MINOR ?? 30),
    settlementAutoReleaseDays: Number(process.env.SETTLEMENT_AUTO_RELEASE_DAYS ?? 7),
    settlementDisputeDeadlockDays: Number(process.env.SETTLEMENT_DISPUTE_DEADLOCK_DAYS ?? 14),
    settlementReturnSilenceDays: Number(process.env.SETTLEMENT_RETURN_SILENCE_DAYS ?? 7),
    settlementTrackingGraceDays: Number(process.env.SETTLEMENT_TRACKING_GRACE_DAYS ?? 7),
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
