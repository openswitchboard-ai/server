/**
 * Settlement evidence vault (phase 1.A). Photos go straight from the
 * seller's browser to the WORM evidence bucket via short-lived presigned
 * URLs; the bucket has Object Lock with a 90-day retention default, so
 * every object is frozen the moment it lands. At evidence-lock the server
 * verifies each object exists and writes a JSON manifest beside them —
 * the manifest key is what the settlement row records.
 */
import { randomUUID, createHash } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3 } from '../aws.js';
import { getPool } from '../db.js';
import type { Config } from '../config.js';
import type { SettlementRow } from './settlements.js';

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
export const MAX_EVIDENCE_BYTES = 15 * 1024 * 1024;
export const MAX_EVIDENCE_OBJECTS = 12;
const UPLOAD_URL_TTL_S = 10 * 60;
const VIEW_URL_TTL_S = 15 * 60;

function mustBucket(cfg: Config): string {
  if (!cfg.evidenceBucket) throw new Error('evidence bucket is not configured');
  return cfg.evidenceBucket;
}

export interface PresignedUpload {
  url: string;
  key: string;
}

/** Presign one photo upload for the seller. Registers the pending object. */
export async function presignEvidenceUpload(
  cfg: Config,
  s: SettlementRow,
  uploadedBy: string,
  input: { filename: string; content_type: string; size: number },
): Promise<PresignedUpload> {
  const ext = ALLOWED_TYPES[input.content_type];
  if (!ext) throw Object.assign(new Error('only JPEG, PNG or WebP photos are accepted'), { validation: true });
  if (!Number.isFinite(input.size) || input.size <= 0 || input.size > MAX_EVIDENCE_BYTES) {
    throw Object.assign(new Error('each photo must be 15 MB or smaller'), { validation: true });
  }
  const count = await getPool().query(
    'SELECT count(*)::int AS n FROM settlement_evidence WHERE settlement_id = $1',
    [s.id],
  );
  if (count.rows[0].n >= MAX_EVIDENCE_OBJECTS) {
    throw Object.assign(new Error(`at most ${MAX_EVIDENCE_OBJECTS} photos per settlement`), {
      validation: true,
    });
  }
  const key = `settlement-evidence/${cfg.envName}/${s.id}/${randomUUID()}.${ext}`;
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: mustBucket(cfg),
      Key: key,
      ContentType: input.content_type,
      ContentLength: input.size, // signed: the browser cannot send a different size
    }),
    { expiresIn: UPLOAD_URL_TTL_S },
  );
  await getPool().query(
    `INSERT INTO settlement_evidence (settlement_id, s3_key, content_type, size_bytes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [s.id, key, input.content_type, input.size, uploadedBy],
  );
  return { url, key };
}

export interface EvidenceObject {
  key: string;
  content_type: string;
  size_bytes: number;
  etag?: string;
}

/**
 * Verify the uploaded objects and write the manifest snapshot into the WORM
 * bucket. Returns the manifest key. Objects that were presigned but never
 * uploaded are dropped from the manifest (and their rows deleted).
 */
export async function writeEvidenceManifest(
  cfg: Config,
  s: SettlementRow,
  lockedBy: string,
): Promise<{ manifestKey: string; objects: EvidenceObject[] }> {
  const bucket = mustBucket(cfg);
  const rows = await getPool().query(
    'SELECT s3_key, content_type, size_bytes FROM settlement_evidence WHERE settlement_id = $1 ORDER BY created_at',
    [s.id],
  );
  const objects: EvidenceObject[] = [];
  for (const r of rows.rows) {
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: r.s3_key }));
      objects.push({
        key: r.s3_key,
        content_type: r.content_type,
        size_bytes: Number(head.ContentLength ?? r.size_bytes),
        etag: head.ETag?.replaceAll('"', ''),
      });
    } catch {
      await getPool().query('DELETE FROM settlement_evidence WHERE s3_key = $1', [r.s3_key]);
    }
  }
  if (!objects.length) {
    throw Object.assign(new Error('add at least one photo before locking'), { validation: true });
  }
  const manifest = {
    kind: 'settlement-evidence-manifest',
    env: cfg.envName,
    settlement_id: s.id,
    match_id: s.match_id,
    locked_by: lockedBy,
    locked_at: new Date().toISOString(),
    objects,
  };
  const body = JSON.stringify(manifest, null, 2);
  const manifestKey = `settlement-evidence/${cfg.envName}/${s.id}/manifest-${Date.now()}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: manifestKey,
      ContentType: 'application/json',
      Body: body,
      ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
    }),
  );
  return { manifestKey, objects };
}

/** Presigned, short-lived view links for the frozen evidence. */
export async function evidenceViewLinks(
  cfg: Config,
  settlementId: string,
): Promise<{ label: string; url: string }[]> {
  const bucket = mustBucket(cfg);
  const rows = await getPool().query(
    'SELECT s3_key, content_type FROM settlement_evidence WHERE settlement_id = $1 ORDER BY created_at',
    [settlementId],
  );
  const out: { label: string; url: string }[] = [];
  let i = 1;
  for (const r of rows.rows) {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: r.s3_key }),
      { expiresIn: VIEW_URL_TTL_S },
    );
    out.push({ label: `Photo ${i++}`, url });
  }
  return out;
}
