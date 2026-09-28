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
  /** True where a known abuse-image hash matched (src/safety/photodna.ts).
   *  A different kind of row entirely: nothing was guessed at, and what is in
   *  front of the operator is a referral rather than a decision. */
  hash_match?: boolean;
  /** The names of the lists that held the matching hash. Never the hash. */
  hash_sources?: string[];
}): Promise<QuarantineOutcome> {
  const { bucket, key, match_id, sender_account, labels } = args;
  const hashMatch = args.hash_match === true;
  const hashSources = args.hash_sources ?? [];
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
         (id, match_id, sender_account, bucket, key, labels, hash_match, hash_sources, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8::text[], now() + ($9 || ' days')::interval)`,
      [
        id,
        uuidOrNull(match_id),
        uuidOrNull(sender_account),
        bucket,
        destination,
        labels,
        hashMatch,
        hashSources,
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
  quarantineLog('photo-quarantined', {
    quarantine_id: id,
    match_id: match_id ?? 'unknown',
    // Which kind of row this is, and nothing about the picture either way.
    ...(hashMatch ? { hash_match: 'true' } : {}),
  });
  return { held: true, quarantine_id: id, key: destination };
}

// ---------------------------------------------------------------------------
// The sweep (src/workers/opsWorker.ts, on the same tick as the others).

/**
 * WHAT KEEPS A HELD PHOTO PAST ITS NINETY DAYS (founder decision, 28 September
 * 2026). A held photo nobody has decided about is deleted at its expiry, unless
 * one of these is true. Each one means there is something a person still has
 * to act on, so the photo stays held for them:
 *
 *   hash_match    it matched a known abuse image. The next act is a referral.
 *   report        a report names its introduction, or names its sender.
 *   safety flag   a safety review (minor_involved, grooming,
 *                 sexual_exploitation, known_abuse_image and the rest) names
 *                 its introduction or its sender.
 *   lawful hold   a preservation date is on the row itself, or on any ledger
 *                 entry behind the same introduction.
 *
 * A referred row is never swept at any age. A cleared row goes at its expiry,
 * as before. Nobody views anything to decide any of this: it is ids and dates.
 */
export const QUARANTINE_KEEP_SQL = `(q.hash_match
    OR (q.preserved_until IS NOT NULL AND q.preserved_until >= now())
    OR EXISTS (SELECT 1 FROM reports r
                WHERE (q.match_id IS NOT NULL AND r.match_id = q.match_id)
                   OR (q.sender_account IS NOT NULL AND r.reported_account = q.sender_account))
    OR EXISTS (SELECT 1 FROM safety_reviews s
                WHERE (q.match_id IS NOT NULL AND s.match_id = q.match_id)
                   OR (q.sender_account IS NOT NULL AND s.sender_account = q.sender_account))
    OR EXISTS (SELECT 1 FROM ledger_entries l
                WHERE q.match_id IS NOT NULL AND l.match_id = q.match_id
                  AND l.preserved_until IS NOT NULL AND l.preserved_until >= now()))`;

/**
 * WHAT THE SWEEP MAY TAKE, as one predicate, in one place: a cleared row past
 * its ninety days, and a held row past its ninety days that nothing keeps.
 */
export const QUARANTINE_SWEEP_PREDICATE = `q.expires_at < now() AND (q.status = 'cleared'
    OR (q.status = 'held' AND NOT ${QUARANTINE_KEEP_SQL}))`;

export const QUARANTINE_DUE_SQL = `SELECT q.id, q.bucket, q.key, q.status FROM photo_quarantine q
   WHERE ${QUARANTINE_SWEEP_PREDICATE} LIMIT 200`;

/** Held past expiry and kept for a person: counted and said out loud. */
export const QUARANTINE_OVERDUE_SQL = `SELECT count(*)::int AS n FROM photo_quarantine q
   WHERE q.status = 'held' AND q.expires_at < now() AND ${QUARANTINE_KEEP_SQL}`;

export interface QuarantineRow {
  status: string;
  expires_at: Date;
  hash_match?: boolean;
  preserved_until?: Date | null;
  /** A report names its introduction or its sender. */
  has_report?: boolean;
  /** A safety review names its introduction or its sender. */
  has_safety_flag?: boolean;
  /** A ledger entry behind the same introduction is under a preservation date. */
  has_ledger_hold?: boolean;
}

/** Whether something keeps this row for a person. The same rule as QUARANTINE_KEEP_SQL. */
export function isKeptForAPerson(row: QuarantineRow, now: Date): boolean {
  if (row.hash_match) return true;
  if (row.preserved_until && row.preserved_until >= now) return true;
  return Boolean(row.has_report || row.has_safety_flag || row.has_ledger_hold);
}

/** The same rule as the SQL, in JavaScript, so the suite can state it against rows. */
export function isDueForQuarantineSweep(row: QuarantineRow, now: Date): boolean {
  if (row.expires_at >= now) return false;
  if (row.status === 'cleared') return true;
  if (row.status === 'held') return !isKeptForAPerson(row, now);
  return false;
}

/**
 * A held item past its ninety days that something keeps: a person's decision
 * nobody has made yet. It is counted and said out loud, and nothing happens
 * to it.
 */
export function isOverdueInQuarantine(row: QuarantineRow, now: Date): boolean {
  return row.status === 'held' && row.expires_at < now && isKeptForAPerson(row, now);
}

/**
 * Delete what has run out and may go; count what has run out and is kept.
 * Counts only: the sweep never looks at what it deletes, and could not.
 * `items` is every row deleted; `expired` is the held ones among them.
 */
export async function sweepPhotoQuarantine(): Promise<{
  items: number;
  expired: number;
  overdue: number;
}> {
  const pool = getPool();
  const due = await pool.query(QUARANTINE_DUE_SQL);
  let gone = 0;
  let expired = 0;
  for (const row of due.rows as Array<{ id: string; bucket: string; key: string; status: string }>) {
    try {
      // A cleared object is already gone in the ordinary case, and a second
      // delete costs nothing. A held one is deleted here for the first time.
      await s3.send(new DeleteObjectCommand({ Bucket: row.bucket, Key: row.key }));
    } catch {
      // A held object that will not delete keeps its row, so the next tick
      // tries again and nothing is left in the bucket with no row pointing at
      // it. A cleared row still goes: its bytes went when it was cleared.
      if (row.status === 'held') continue;
    }
    await pool.query('DELETE FROM photo_quarantine WHERE id = $1', [row.id]);
    gone += 1;
    if (row.status === 'held') expired += 1;
  }
  if (gone) quarantineLog('photo-quarantine-swept', { count: gone, expired });

  const overdue = (await pool.query(QUARANTINE_OVERDUE_SQL)).rows[0]?.n ?? 0;
  if (overdue) quarantineLog('photo-quarantine-overdue', { count: overdue });

  return { items: gone, expired, overdue };
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
  hash_match: boolean;
  hash_sources: string[];
  created_at: Date;
  expires_at: Date;
}

/**
 * A HASH MATCH COMES FIRST, then oldest first inside each group. Everything
 * else in this queue is a person deciding whether there is anything here at
 * all; a match is a picture somebody has already identified, and it should
 * never be waiting behind a week of maybes.
 */
export async function listHeldQuarantine(limit = 50): Promise<HeldQuarantineRow[]> {
  const r = await getPool().query(
    `SELECT id, match_id, sender_account, labels, hash_match, hash_sources, created_at, expires_at
       FROM photo_quarantine WHERE status = 'held'
      ORDER BY hash_match DESC, created_at ASC LIMIT $1`,
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
 * A lawful request asks for a held item to be kept. The freeze half only: a
 * date moves, nothing is viewed, and the sweep leaves the row until the date
 * has passed. A cleared item has no object left to keep, so it is not touched.
 */
export async function preserveQuarantineItem(id: string, until: Date): Promise<boolean> {
  const r = await getPool().query(
    `UPDATE photo_quarantine SET preserved_until = $2
      WHERE id = $1 AND status IN ('held', 'referred')
        AND (preserved_until IS NULL OR preserved_until < $2)`,
    [id, until],
  );
  return (r.rowCount ?? 0) > 0;
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
