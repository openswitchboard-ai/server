import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../aws.js';
import { getPool } from '../db.js';
import { encryptField } from '../crypto.js';
import { getAccount } from './accounts.js';
import { checkPublishQuota } from './quotas.js';
import {
  OsbError,
  SCHEMA_VERSION,
  checkSchemaVersion,
  validatePayload,
} from '../protocol.js';
import { categoryDenied, categoryKnownAndOpen } from '../denylist.js';
import { normaliseGeo } from '../geo/normalise.js';
import type { Config } from '../config.js';

export interface CardRow {
  id: string;
  account_id: string;
  schema_version: string;
  type: 'WANT' | 'HAVE';
  category: string;
  geo: any;
  geo_lat: number | null;
  geo_lon: number | null;
  geo_radius_km: number | null;
  attributes: any;
  ask: any;
  urgency: string;
  visibility: string;
  protocol_status: 'active' | 'latent';
  lifecycle_state: string;
  price_enc: Buffer | null;
  ttl_days: number;
  expires_at: Date;
  screening: any;
}

/**
 * Publish an intent card.
 * Order of gates: schema validation -> schema_version -> taxonomy/deny-list
 * (CATEGORY_PROHIBITED) -> quota (QUOTA_EXCEEDED) -> stored PENDING_SCREENING
 * with the price band envelope-encrypted -> screening queue. The card is NOT
 * matchable until the screening pipeline passes it.
 */
export async function publishIntent(
  cfg: Config,
  accountId: string,
  card: any,
): Promise<{ intent_id: string; state: string }> {
  const v = validatePayload('intent-card', card);
  if (!v.valid) {
    throw Object.assign(new Error(`invalid intent card: ${v.reasons.join('; ')}`), {
      validation: v.reasons,
    });
  }
  checkSchemaVersion(card.schema_version);

  const known = categoryKnownAndOpen(card.category, cfg.categoryPolicy);
  if (!known.ok) {
    throw new OsbError('CATEGORY_PROHIBITED', {
      human_action: `Category not available: ${known.reason}.`,
    });
  }
  const denied = categoryDenied(card.category);
  if (denied) {
    throw new OsbError('CATEGORY_PROHIBITED', {
      human_action:
        denied.status === 'vertical-policy-pending'
          ? `The '${card.category}' vertical is not open yet (${denied.reason_code}).`
          : undefined,
    });
  }

  // Location resolution: a named place becomes a centre point and a
  // canonical cell before the card is stored (LOCATION_UNRESOLVED otherwise).
  const geo = normaliseGeo(card.geo);

  await checkPublishQuota(accountId, cfg.quotas);

  const account = await getAccount(accountId);
  if (!account) throw new Error('account not found');

  const ttl = card.ttl_days ?? 60;
  // The price band is a PRIVATE matching input: encrypted before it touches a
  // row, decrypted only inside the matching engine, never serialised outbound.
  const priceEnc = card.price
    ? await encryptField(accountId, account.data_key_enc, JSON.stringify(card.price))
    : null;

  const r = await getPool().query(
    `INSERT INTO cards (account_id, schema_version, type, category, geo, geo_lat, geo_lon,
                        geo_radius_km, attributes, ask, urgency, visibility, protocol_status,
                        price_enc, ttl_days, expires_at)
     VALUES ($1,$2,$3,$4,$5,$13,$14,$15,$6,$7,$8,$9,$10,$11,$12::int,
             now() + make_interval(days => $12::int))
     RETURNING id`,
    [
      accountId,
      card.schema_version,
      card.type,
      card.category,
      JSON.stringify(geo.geo),
      JSON.stringify(card.attributes ?? {}),
      card.ask ? JSON.stringify(card.ask) : null,
      card.urgency ?? 'none',
      card.visibility ?? 'anonymous-until-match',
      card.status ?? 'active',
      priceEnc,
      ttl,
      geo.lat,
      geo.lon,
      geo.radius_km,
    ],
  );
  const id = r.rows[0].id as string;
  await getPool().query(
    'INSERT INTO publish_events (account_id, card_id) VALUES ($1,$2)',
    [accountId, id],
  );
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: cfg.screeningQueueUrl,
      MessageBody: JSON.stringify({ kind: 'screen-card', card_id: id }),
    }),
  );
  return { intent_id: id, state: 'PENDING_SCREENING' };
}

export async function getCard(id: string): Promise<CardRow | undefined> {
  const r = await getPool().query('SELECT * FROM cards WHERE id = $1', [id]);
  return r.rows[0];
}

export async function listIntents(accountId: string): Promise<any[]> {
  const r = await getPool().query(
    `SELECT id, schema_version, type, category, geo, attributes, ask, urgency, visibility,
            protocol_status, lifecycle_state, ttl_days, expires_at, created_at, updated_at
     FROM cards WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [accountId],
  );
  // Own-card view for the owning agent. The private price band is not stored
  // in plaintext and is not echoed back; agents keep their own record of it.
  return r.rows.map((row) => ({
    intent_id: row.id,
    state: row.lifecycle_state,
    card: {
      schema_version: row.schema_version,
      type: row.type,
      category: row.category,
      geo: row.geo,
      ...(row.attributes && Object.keys(row.attributes).length
        ? { attributes: row.attributes }
        : {}),
      ...(row.ask ? { ask: row.ask } : {}),
      urgency: row.urgency,
      visibility: row.visibility,
      status: row.protocol_status,
      ttl_days: row.ttl_days,
    },
    expires_at: row.expires_at,
    created_at: row.created_at,
  }));
}

function assertOwnUsableCard(card: CardRow | undefined, accountId: string): CardRow {
  if (!card || card.account_id !== accountId) {
    throw Object.assign(new Error('intent not found'), { notFound: true });
  }
  if (card.lifecycle_state === 'EXPIRED') throw new OsbError('INTENT_EXPIRED');
  return card;
}

/** Amend = re-validate + re-screen. Amendable fields only; type/category fixed. */
export async function amendIntent(
  cfg: Config,
  accountId: string,
  intentId: string,
  patch: any,
): Promise<{ intent_id: string; state: string }> {
  const card = assertOwnUsableCard(await getCard(intentId), accountId);
  if (card.lifecycle_state === 'WITHDRAWN') {
    throw Object.assign(new Error('intent is withdrawn'), { notFound: true });
  }
  const account = await getAccount(accountId);
  if (!account) throw new Error('account not found');

  // Rebuild the full card, apply the patch, and re-validate as a whole card.
  const current: any = {
    schema_version: card.schema_version,
    type: card.type,
    category: card.category,
    geo: card.geo,
    ...(card.attributes && Object.keys(card.attributes).length
      ? { attributes: card.attributes }
      : {}),
    ...(card.ask ? { ask: card.ask } : {}),
    urgency: card.urgency,
    visibility: card.visibility,
    status: card.protocol_status,
    ttl_days: card.ttl_days,
  };
  const allowed = ['geo', 'attributes', 'ask', 'urgency', 'status', 'ttl_days', 'price'];
  for (const k of Object.keys(patch ?? {})) {
    if (!allowed.includes(k)) {
      throw Object.assign(new Error(`field '${k}' cannot be amended`), { validation: [k] });
    }
  }
  const next: any = { ...current, ...patch };
  if (next.price === null || next.price === undefined) delete next.price;
  if (next.ask === null || next.ask === undefined) delete next.ask;
  const v = validatePayload('intent-card', next);
  if (!v.valid) {
    throw Object.assign(new Error(`invalid amended card: ${v.reasons.join('; ')}`), {
      validation: v.reasons,
    });
  }
  const geo = normaliseGeo(next.geo);

  await checkPublishQuota(accountId, cfg.quotas);

  const priceEnc =
    'price' in (patch ?? {})
      ? patch.price
        ? await encryptField(accountId, account.data_key_enc, JSON.stringify(patch.price))
        : null
      : card.price_enc;

  await getPool().query(
    `UPDATE cards SET geo=$2, geo_lat=$9, geo_lon=$10, geo_radius_km=$11,
        attributes=$3, ask=$4, urgency=$5, protocol_status=$6,
        ttl_days=$7::int, expires_at = created_at + make_interval(days => $7::int),
        renewal_notified_at = NULL,
        price_enc=$8, lifecycle_state='PENDING_SCREENING', screening=NULL, updated_at=now()
     WHERE id=$1`,
    [
      intentId,
      JSON.stringify(geo.geo),
      JSON.stringify(next.attributes ?? {}),
      next.ask ? JSON.stringify(next.ask) : null,
      next.urgency ?? 'none',
      next.status ?? 'active',
      next.ttl_days ?? 60,
      priceEnc,
      geo.lat,
      geo.lon,
      geo.radius_km,
    ],
  );
  await getPool().query('INSERT INTO publish_events (account_id, card_id) VALUES ($1,$2)', [
    accountId,
    intentId,
  ]);
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: cfg.screeningQueueUrl,
      MessageBody: JSON.stringify({ kind: 'screen-card', card_id: intentId }),
    }),
  );
  return { intent_id: intentId, state: 'PENDING_SCREENING' };
}

export async function withdrawIntent(
  accountId: string,
  intentId: string,
): Promise<{ intent_id: string; state: string }> {
  const card = await getCard(intentId);
  if (!card || card.account_id !== accountId) {
    throw Object.assign(new Error('intent not found'), { notFound: true });
  }
  await getPool().query(
    `UPDATE cards SET lifecycle_state='WITHDRAWN', updated_at=now() WHERE id=$1`,
    [intentId],
  );
  return { intent_id: intentId, state: 'WITHDRAWN' };
}

/** TTL expiry sweep (EventBridge schedule -> ops queue -> here). */
export async function expireDueCards(): Promise<number> {
  const r = await getPool().query(
    `UPDATE cards SET lifecycle_state='EXPIRED', updated_at=now()
     WHERE expires_at < now() AND lifecycle_state IN ('PENDING_SCREENING','PUBLISHED')
     RETURNING id`,
  );
  return r.rowCount ?? 0;
}

void SCHEMA_VERSION;
