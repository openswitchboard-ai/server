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
  /** 'open': anyone can register on the human pages with a verified email.
   *  'closed': the pages show "registration opens at launch".
   *  'dev-bootstrap': open, and the ops queue may also mint accounts (dev only). */
  registrationMode: 'open' | 'dev-bootstrap' | 'closed';
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
  /** The bucket photos cross in, on an open conversation and nowhere else: no
   *  Object Lock and no versions, because these delete themselves (see
   *  domain/channelPhoto.ts). Unset means photos are off in this deployment,
   *  and the page says so rather than failing. */
  photoBucket?: string;
  /** Whether a photo is looked at by Rekognition before it is delivered
   *  (intake/checks/photoModeration.ts). Derived, not its own switch: it is on
   *  exactly where photos are on, because a deployment that carries photos
   *  without the look is not a deployment this code offers. */
  photoModeration: boolean;
  /** Whether the words of a message are read for grooming, exploitation and
   *  threats before they go on (intake/checks/messageSafety.ts). ON unless
   *  `MESSAGE_SAFETY=off`, which is the one way to stop paying for a Haiku
   *  call per message. It never blocks a conversation either way: the check
   *  only ever holds for review, and a hold at that door still delivers. */
  messageSafety: boolean;
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
  /** PEM of the PUBLIC half of the safety key, and only ever the public half.
   *  It is what lets the service write the thirty-day ledger it cannot read
   *  (src/safety/, docs/trust-and-safety.md). Unset = the ledger is off for
   *  this deployment: everything is still checked and refused as it always
   *  was, but nothing that passes is kept, so a report has no evidence behind
   *  it. The service says so once at startup rather than failing to boot. */
  safetyPublicKey?: string;
  /** HTTP Basic credential for the operator metrics page, as `user:password`.
   *  Unset = the /ops/metrics routes are never registered and the path 404s,
   *  the same spirit as the Stripe webhook on a deployment without Stripe. */
  opsMetricsBasicAuth?: string;
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
    registrationMode: registrationModeFrom(process.env.REGISTRATION_MODE, envName),
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
    photoBucket: process.env.PHOTO_BUCKET || undefined,
    photoModeration: !!(process.env.PHOTO_BUCKET || ''),
    messageSafety: (process.env.MESSAGE_SAFETY ?? 'on').trim().toLowerCase() !== 'off',
    settlementFeePercent: Number(process.env.SETTLEMENT_FEE_PERCENT ?? 0),
    settlementFeeFlatMinor: Number(process.env.SETTLEMENT_FEE_FLAT_MINOR ?? 100),
    settlementProcessingPercent: Number(process.env.SETTLEMENT_PROCESSING_PERCENT ?? 1.7),
    settlementProcessingFixedMinor: Number(process.env.SETTLEMENT_PROCESSING_FIXED_MINOR ?? 30),
    settlementAutoReleaseDays: Number(process.env.SETTLEMENT_AUTO_RELEASE_DAYS ?? 7),
    settlementDisputeDeadlockDays: Number(process.env.SETTLEMENT_DISPUTE_DEADLOCK_DAYS ?? 14),
    settlementReturnSilenceDays: Number(process.env.SETTLEMENT_RETURN_SILENCE_DAYS ?? 7),
    settlementTrackingGraceDays: Number(process.env.SETTLEMENT_TRACKING_GRACE_DAYS ?? 7),
    safetyPublicKey: safetyPublicKeyFrom(process.env.SAFETY_PUBLIC_KEY),
    opsMetricsBasicAuth: opsMetricsBasicAuthFrom(process.env.OPS_METRICS_BASIC_AUTH),
  };
}

/**
 * Settlement handling is on only when the deployment has a Stripe secret AND
 * an evidence bucket. Half-configured is a hard boot failure (NO-FALLBACKS):
 * a deployment that could take payments while unable to lock evidence must
 * not start.
 */
/** REGISTRATION_MODE wins when set to a known value; otherwise prod is closed
 *  and every other environment bootstraps. Opening prod is one env change. */
export function registrationModeFrom(
  raw: string | undefined,
  envName: string,
): 'open' | 'dev-bootstrap' | 'closed' {
  if (raw === 'open' || raw === 'closed' || raw === 'dev-bootstrap') return raw;
  return envName === 'prod' ? 'closed' : 'dev-bootstrap';
}

/**
 * The operator page's credential, as `user:password`. Absent is fine and means
 * the page does not exist. Present but malformed is a boot failure rather than
 * a page that quietly accepts anything: a colon is required, and so is a
 * password after it.
 */
export function opsMetricsBasicAuthFrom(raw: string | undefined): string | undefined {
  const v = (raw ?? '').trim();
  if (!v) return undefined;
  const i = v.indexOf(':');
  if (i === -1) {
    throw new Error('OPS_METRICS_BASIC_AUTH must be user:password');
  }
  if (!v.slice(0, i) || !v.slice(i + 1)) {
    throw new Error('OPS_METRICS_BASIC_AUTH must be user:password with both halves set');
  }
  return v;
}

/**
 * The safety key's public half, as it arrives. Absent is fine and means the
 * ledger is off. A PEM that has been through a parameter store often comes
 * back with its line breaks written out as `\n`, so those are put back; a
 * value that is not a PEM at all is left alone and refused later, by the
 * crypto, with a message that says what it got.
 */
export function safetyPublicKeyFrom(raw: string | undefined): string | undefined {
  const v = (raw ?? '').trim();
  if (!v) return undefined;
  return v.includes('\\n') ? v.replace(/\\n/g, '\n') : v;
}

export function settlementsConfigured(cfg: Config): boolean {
  if (cfg.stripeSecretArn && !cfg.evidenceBucket) {
    throw new Error('STRIPE_SECRET_ARN is set but EVIDENCE_BUCKET is missing');
  }
  return !!cfg.stripeSecretArn;
}
