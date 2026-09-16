/**
 * The sweep that must not sweep (src/safety/photoQuarantine.ts).
 *
 * A photo refused for sexual content is held rather than deleted, because
 * Rekognition cannot tell an adult from a child and s 474.25 of the Criminal
 * Code (Cth) says what a host becomes aware of must be referred to the AFP.
 * The whole point is undone by a cron that deletes it ninety days later, so
 * what is asserted here is mostly what the sweep REFUSES to touch:
 *
 *  - ONLY `cleared`, AND ONLY PAST EXPIRY, is ever deleted.
 *  - A `held` row past its ninety days is OVERDUE, not due: it is counted and
 *    said out loud, and nothing happens to it. A person decides.
 *  - A `referred` row is never swept at any age. The AFP have been told it
 *    exists; it has to still exist.
 *  - The predicate the database runs and the predicate the suite states are
 *    the same predicate.
 *  - Where a held object goes, and that the key carries the introduction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { s3 } from '../../../src/aws.js';
import * as db from '../../../src/db.js';
import {
  QUARANTINE_DUE_SQL,
  QUARANTINE_PREFIX,
  QUARANTINE_SWEEP_PREDICATE,
  QUARANTINE_WINDOW_DAYS,
  isDueForQuarantineSweep,
  isOverdueInQuarantine,
  quarantineKey,
  sweepPhotoQuarantine,
} from '../../../src/safety/photoQuarantine.js';

const now = new Date('2026-09-17T00:00:00Z');
const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
const hence = (d: number) => new Date(now.getTime() + d * 86_400_000);

describe('what the sweep may take', () => {
  it('takes a cleared row whose ninety days are behind it', () => {
    expect(isDueForQuarantineSweep({ status: 'cleared', expires_at: ago(1) }, now)).toBe(true);
  });

  it('leaves a cleared row that is still inside its window', () => {
    expect(isDueForQuarantineSweep({ status: 'cleared', expires_at: hence(1) }, now)).toBe(false);
  });

  it('NEVER takes a held row, however old — a person has not decided yet', () => {
    expect(isDueForQuarantineSweep({ status: 'held', expires_at: ago(400) }, now)).toBe(false);
    expect(isOverdueInQuarantine({ status: 'held', expires_at: ago(400) }, now)).toBe(true);
    expect(isOverdueInQuarantine({ status: 'held', expires_at: hence(1) }, now)).toBe(false);
  });

  it('NEVER takes a referred row, at any age — it was referred to police', () => {
    expect(isDueForQuarantineSweep({ status: 'referred', expires_at: ago(4000) }, now)).toBe(false);
    expect(isOverdueInQuarantine({ status: 'referred', expires_at: ago(4000) }, now)).toBe(false);
  });

  it('says the same thing in SQL as it says in JavaScript', () => {
    expect(QUARANTINE_SWEEP_PREDICATE).toContain(`status = 'cleared'`);
    expect(QUARANTINE_SWEEP_PREDICATE).toContain('expires_at < now()');
    expect(QUARANTINE_DUE_SQL).toContain(QUARANTINE_SWEEP_PREDICATE);
    // The one thing that must not be in it, in any form.
    expect(QUARANTINE_DUE_SQL).not.toContain(`'held'`);
    expect(QUARANTINE_DUE_SQL).not.toContain(`'referred'`);
  });

  it('holds for the same ninety days a report and a review hold for', () => {
    expect(QUARANTINE_WINDOW_DAYS).toBe(90);
  });
});

describe('where a held object goes', () => {
  it('is the quarantine prefix, the introduction, and the name it arrived under', () => {
    expect(quarantineKey('conversation-photos/dev/ch_1/abc.jpg', 'm-1')).toBe(
      `${QUARANTINE_PREFIX}/m-1/abc.jpg`,
    );
  });

  it('files a press with no introduction behind it somewhere findable', () => {
    expect(quarantineKey('conversation-photos/dev/ch_1/abc.jpg', undefined)).toBe(
      `${QUARANTINE_PREFIX}/unknown/abc.jpg`,
    );
  });
});

describe('the sweep against a stood-in database', () => {
  let deleted: string[];
  let logged: string[];
  let removed: string[];

  const poolWith = (due: Array<{ id: string; bucket: string; key: string }>, overdue: number) => ({
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT id, bucket, key')) return { rows: due, rowCount: due.length };
      if (sql.includes('count(*)')) return { rows: [{ n: overdue }], rowCount: 1 };
      removed.push(String(params[0]));
      return { rows: [], rowCount: 1 };
    },
  });

  beforeEach(() => {
    deleted = [];
    logged = [];
    removed = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => void logged.push(String(l)));
    vi.spyOn(s3, 'send').mockImplementation(async (command: any) => {
      if (command.constructor.name === 'DeleteObjectCommand') deleted.push(command.input.Key);
      return {} as any;
    });
  });

  it('deletes the object and the row for what it may take', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(
      poolWith([{ id: 'q-1', bucket: 'b', key: 'conversation-photos/quarantine/m/x.jpg' }], 0) as any,
    );
    const r = await sweepPhotoQuarantine();
    expect(r).toEqual({ items: 1, overdue: 0 });
    expect(deleted).toEqual(['conversation-photos/quarantine/m/x.jpg']);
    expect(removed).toEqual(['q-1']);
    expect(logged.join('\n')).toContain('photo-quarantine-swept');
  });

  it('says overdue out loud and deletes nothing for it', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(poolWith([], 3) as any);
    const r = await sweepPhotoQuarantine();
    expect(r).toEqual({ items: 0, overdue: 3 });
    expect(deleted).toEqual([]);
    expect(removed).toEqual([]);
    expect(JSON.parse(logged.find((l) => l.includes('overdue'))!)).toEqual({
      event: 'photo-quarantine-overdue',
      count: 3,
    });
  });

  it('says nothing at all on a quiet day', async () => {
    vi.spyOn(db, 'getPool').mockReturnValue(poolWith([], 0) as any);
    expect(await sweepPhotoQuarantine()).toEqual({ items: 0, overdue: 0 });
    expect(logged).toEqual([]);
  });
});
