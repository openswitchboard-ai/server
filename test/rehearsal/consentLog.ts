/**
 * THE LOCKED LOG'S OWN LINE ABOUT AN ACCEPTED OFFER.
 *
 * Every acceptance writes one `offer-accepted-by-human` event to the consent
 * log bucket (server src/crypto.ts, writeConsentEvent), and since migration
 * 066 that event carries the fingerprint of the record of the deal. This
 * reads that one event back, so a check can hold the fingerprint in the log
 * against the one on the offer.
 *
 * The bucket's name is different on every deployment and is read from
 * OSB_CONSENT_BUCKET. Where it is unset this answers `unread`, and the check
 * that asked goes by the offer row alone and says so. Read-only: one list and
 * a few gets, under the day's own prefix.
 */
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { ENV_NAME, REGION } from './config.js';

export interface ConsentEventRead {
  /** 'found' with the event, 'absent' where the day holds none for this offer, 'unread' where it could not be looked for. */
  outcome: 'found' | 'absent' | 'unread';
  recordSha256?: string;
  key?: string;
  why?: string;
}

/** The key prefix an event written at this moment sorts after. */
export function consentKeyFloor(env: string, atMs: number): { prefix: string; startAfter: string } {
  const iso = new Date(atMs).toISOString();
  const prefix = `consent-events/${env}/${iso.slice(0, 10)}/`;
  return { prefix, startAfter: `${prefix}${iso.replace(/[:.]/g, '-')}` };
}

export async function acceptEventFor(offerId: string, acceptedAtMs: number): Promise<ConsentEventRead> {
  const bucket = process.env.OSB_CONSENT_BUCKET;
  if (!bucket) return { outcome: 'unread', why: 'OSB_CONSENT_BUCKET is not set' };
  try {
    const s3 = new S3Client({ region: REGION });
    // Two minutes of slack before the row's time: the event is written inside
    // the transaction whose start is the row's time, on another machine's clock.
    // Two days' prefixes where the slack reaches back over midnight UTC.
    const floors = [consentKeyFloor(ENV_NAME, acceptedAtMs - 120_000), consentKeyFloor(ENV_NAME, acceptedAtMs + 120_000)];
    if (floors[0].prefix === floors[1].prefix) floors.pop();
    else floors[1].startAfter = floors[1].prefix;
    let looked = 0;
    for (const { prefix, startAfter } of floors) {
      const listed = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, StartAfter: startAfter, MaxKeys: 200 }),
      );
      for (const o of listed.Contents ?? []) {
        if (!o.Key) continue;
        looked += 1;
        const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: o.Key }));
        const body = JSON.parse((await got.Body?.transformToString()) ?? '{}');
        if (body.event === 'offer-accepted-by-human' && body.offer_id === offerId) {
          return {
            outcome: 'found',
            key: o.Key,
            ...(typeof body.receipt_sha256 === 'string' ? { recordSha256: body.receipt_sha256 } : {}),
          };
        }
      }
    }
    return { outcome: 'absent', why: `no offer-accepted-by-human event for this offer among the ${looked} written around that time` };
  } catch (e) {
    return { outcome: 'unread', why: `the bucket could not be read (${(e as Error)?.name ?? 'error'})` };
  }
}
