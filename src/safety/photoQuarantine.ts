/**
 * WHAT HAPPENS TO A PHOTO REFUSED FOR SEXUAL CONTENT
 * (migrations/038_photo_quarantine.sql; docs/trust-and-safety.md, the
 * "Sexual content" row).
 *
 * THE RULE THIS FILE EXISTS FOR. Every other refused label is a photo the
 * switchboard has no reason to keep, and it is deleted in the same breath as
 * the refusal. The sexual family is the one exception, and the reason is s
 * 474.25 of the Criminal Code (Cth): a host that becomes aware of child abuse
 * material must refer it to the Australian Federal Police. Rekognition cannot
 * tell an adult from a child — it says "Explicit", not "a child" — so the
 * switchboard cannot know which refusals are the ones that must be referred.
 * Deleting on sight destroys the referrable thing, fastest in exactly the
 * cases where destroying it is worst.
 *
 * SO THE BYTES MOVE RATHER THAN DIE. Copy to the quarantine prefix, then
 * delete the original. In that order, and never the other way: if the copy
 * does not succeed the original stays where it is and the operator gets a
 * line, because there is no version of this where the switchboard deletes
 * something it could not first put somewhere safe.
 *
 * NOBODY SEES ANYTHING. Not the sender, not the recipient, not the operator.
 * The sender's assistant reads the same plain sentence it read when the object
 * was deleted; there is no second sentence, no appeal, no hint that anything
 * was kept. The operator gets two ids. No path in this repository displays or
 * fetches a quarantined image, and scripts/safety/quarantine.mts says so in
 * its own banner.
 *
 * AND NOTHING HERE CAN FAIL AN INTAKE. The verdict was reached before this
 * file was asked for anything. A bucket that will not copy, a database that is
 * down — all of it is a log line, and the refusal still goes back.
 */
import { randomUUID } from 'node:crypto';
import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from '../aws.js';
import { getPool } from '../db.js';

/** The same ninety days a report and a safety review hold their evidence for. */
export const QUARANTINE_WINDOW_DAYS = 90;

/** The prefix, which is inside the task role's existing grant on the photo bucket. */
export const QUARANTINE_PREFIX = 'conversation-photos/quarantine';

function quarantineLog(event: string, fields: Record<string, string | number> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

const uuidOrNull = (v: string | undefined): string | null =>
  v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;

/**
 * Where a held object goes: the prefix, the introduction it belonged to, and
 * the last segment of the key it arrived under. The introduction is what an
 * operator has to go on, and the basename keeps two photos from the same
 * conversation apart. A press with no introduction id behind it (which the
 * photo door does not make, but the type allows) files under `unknown`.
 */
export function quarantineKey(originalKey: string, matchId: string | undefined): string {
  const base = originalKey.split('/').filter(Boolean).pop() ?? 'object';
  return `${QUARANTINE_PREFIX}/${matchId || 'unknown'}/${base}`;
}

export interface QuarantineOutcome {
  /** The row id, where a row was written. */
  quarantine_id?: string;
  /** Where the bytes now are, where the copy succeeded. */
  key?: string;
  /** False when the copy did not happen: the original is still where it was. */
  held: boolean;
}

/**
 * Move one refused object into quarantine and write the row that says where it
 * went. Called from the photo check on a sexual-label refusal, and from
 * nowhere else.
 *
 * COPY FIRST. A failed copy means the original stays: the refusal stands, the
 * photo is not delivered, and a person gets a line saying a thing that should
 * have been held was not. Never a delete on the back of a copy that did not
 * happen.
 */
export async function quarantinePhoto(args: {
  bucket: string;
  key: string;
  match_id?: string;
  sender_account?: string;
  labels: string[];
}): Promise<QuarantineOutcome> {
  const { bucket, key, match_id, sender_account, labels } = args;
  const destination = quarantineKey(key, match_id);

  try {
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: destination,
        CopySource: `${bucket}/${key}`,
      }),
    );
  } catch {
    // The one thing that must never follow a failed copy is a delete. No key
    // and no label in the line: which introduction is enough to go looking.
    quarantineLog('photo-quarantine-failed', { match_id: match_id ?? 'unknown' });
    return { held: false };
  }

  // The original goes now that the bytes exist somewhere else. Best-effort, in
  // the same spirit as the old delete: a copy that landed is the thing that
  // mattered, and the photo sweep comes past for anything left behind.
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    /* the refusal stands and the bytes are held; the sweep will come past */
  }

  // And the row. A row that will not insert does not un-hold the object, so
  // this is a line rather than a throw — but it is a loud one, because bytes
  // in quarantine with nothing pointing at them are bytes nobody will find.
  const id = randomUUID();
  try {
    await getPool().query(
      `INSERT INTO photo_quarantine
         (id, match_id, sender_account, bucket, key, labels, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], now() + ($7 || ' days')::interval)`,
      [
        id,
        uuidOrNull(match_id),
        uuidOrNull(sender_account),
        bucket,
        destination,
        labels,
        String(QUARANTINE_WINDOW_DAYS),
      ],
    );
  } catch (e: any) {
    quarantineLog('photo-quarantine-row-failed', {
      match_id: match_id ?? 'unknown',
      code: typeof e?.code === 'string' ? e.code : 'unknown',
    });
    return { held: true, key: destination };
  }

  // THE ONE OPERATOR LINE. Two ids: no key, no label, nothing about a picture.
  quarantineLog('photo-quarantined', { quarantine_id: id, match_id: match_id ?? 'unknown' });
  return { held: true, quarantine_id: id, key: destination };
}

// ---------------------------------------------------------------------------
// The sweep (src/workers/opsWorker.ts, on the same daily tick as the others).

/**
 * WHAT THE DAILY SWEEP MAY TAKE, as one predicate, in one place.
 *
 * ONLY `cleared`, AND ONLY PAST ITS NINETY DAYS. The other two states are not
 * a slower version of this one:
 *
 *   held      nobody has decided. A sweep that deleted these would be the
 *             original defect on a timer — the thing that must be referred,
 *             destroyed, ninety days later, by a cron. Past expiry it is
 *             logged as overdue and left exactly where it is.
 *   referred  the AFP have it. It is never swept at any age.
 */
export const QUARANTINE_SWEEP_PREDICATE = `status = 'cleared' AND expires_at < now()`;

export const QUARANTINE_DUE_SQL = `SELECT id, bucket, key FROM photo_quarantine
   WHERE ${QUARANTINE_SWEEP_PREDICATE} LIMIT 200`;

export const QUARANTINE_OVERDUE_SQL = `SELECT count(*)::int AS n FROM photo_quarantine
   WHERE status = 'held' AND expires_at < now()`;

export interface QuarantineRow {
  status: string;
  expires_at: Date;
}

/** The same rule in JavaScript, so the suite can state it against rows. */
export function isDueForQuarantineSweep(row: QuarantineRow, now: Date): boolean {
  if (row.status !== 'cleared') return false;
  return row.expires_at < now;
}

/**
 * The other half of the same rule: a held item whose ninety days are up is a
 * person's decision that nobody has made. It is counted and said out loud, and
 * nothing happens to it.
 */
export function isOverdueInQuarantine(row: QuarantineRow, now: Date): boolean {
  return row.status === 'held' && row.expires_at < now;
}

/**
 * Delete what has run out and may go; count what has run out and may not.
 * Counts only — the sweep never looks at what it deletes, and could not.
 */
export async function sweepPhotoQuarantine(): Promise<{ items: number; overdue: number }> {
  const pool = getPool();
  const due = await pool.query(QUARANTINE_DUE_SQL);
  let gone = 0;
  for (const row of due.rows as Array<{ id: string; bucket: string; key: string }>) {
    try {
      // Already gone in the ordinary case — an operator clearing an item
      // deletes the object there and then — and a second delete costs nothing.
      await s3.send(new DeleteObjectCommand({ Bucket: row.bucket, Key: row.key }));
    } catch {
      /* the row still goes; the bytes are a photo-bucket lifecycle matter */
    }
    await pool.query('DELETE FROM photo_quarantine WHERE id = $1', [row.id]);
    gone += 1;
  }
  if (gone) quarantineLog('photo-quarantine-swept', { count: gone });

  const overdue = (await pool.query(QUARANTINE_OVERDUE_SQL)).rows[0]?.n ?? 0;
  if (overdue) quarantineLog('photo-quarantine-overdue', { count: overdue });

  return { items: gone, overdue };
}

// ---------------------------------------------------------------------------
// What the operator's script reads and writes (scripts/safety/quarantine.mts).
// Ids, labels and ages. There is no image here to return and no query in this
// module that could reach one.

export interface HeldQuarantineRow {
  id: string;
  match_id: string | null;
  sender_account: string | null;
  labels: string[];
  created_at: Date;
  expires_at: Date;
}

/** Oldest first: what has been waiting longest for a person is what matters. */
export async function listHeldQuarantine(limit = 50): Promise<HeldQuarantineRow[]> {
  const r = await getPool().query(
    `SELECT id, match_id, sender_account, labels, created_at, expires_at
       FROM photo_quarantine WHERE status = 'held'
      ORDER BY created_at ASC LIMIT $1`,
    [limit],
  );
  return r.rows as HeldQuarantineRow[];
}

/**
 * An operator has decided there is nothing here to refer. The object goes at
 * that moment — there is no reason to hold bytes nobody wants — and the row
 * stays until its expiry so the count is honest, then the sweep takes it.
 */
export async function clearQuarantineItem(id: string): Promise<boolean> {
  const pool = getPool();
  const found = await pool.query(
    `SELECT bucket, key FROM photo_quarantine WHERE id = $1 AND status = 'held'`,
    [id],
  );
  const row = found.rows[0] as { bucket: string; key: string } | undefined;
  if (!row) return false;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: row.bucket, Key: row.key }));
  } catch {
    /* the mark still goes on; the sweep comes past for the bytes */
  }
  const done = await pool.query(
    `UPDATE photo_quarantine SET status = 'cleared', resolved_at = now()
      WHERE id = $1 AND status = 'held'`,
    [id],
  );
  return (done.rowCount ?? 0) > 0;
}

/**
 * An operator has referred it. THE REFERRAL IS THEIR ACT, not this software's:
 * nothing in this repository talks to the AFP or the ACCCE, and this only
 * writes down that a person did. The object is not touched, now or ever — it
 * has to still be there when it is asked for.
 */
export async function referQuarantineItem(id: string): Promise<boolean> {
  const r = await getPool().query(
    `UPDATE photo_quarantine SET status = 'referred', resolved_at = now()
      WHERE id = $1 AND status = 'held'`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}
